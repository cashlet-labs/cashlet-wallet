import { describe, expect, it } from "vitest";
import {
  DEFAULT_ITERATIONS,
  needsUpgrade,
  open,
  parseVault,
  seal,
  WrongPasswordError,
} from "../src/wallet/vault";

// Low iterations keep the tests fast; the default is checked separately.
const FAST = 1_000;
const SECRET =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("vault", () => {
  it("opens with the right password", async () => {
    const vault = await seal(SECRET, "correct horse", FAST);
    expect(await open(vault, "correct horse")).toBe(SECRET);
  });

  it("uses 600,000 PBKDF2 iterations by default and records them", async () => {
    const vault = await seal("x", "pw");
    expect(vault).toMatchObject({ v: 1, kdf: "PBKDF2-SHA256", iterations: DEFAULT_ITERATIONS });
    expect(DEFAULT_ITERATIONS).toBe(600_000);
    expect(needsUpgrade(vault)).toBe(false);
  });

  it("uses a fresh salt and IV every time", async () => {
    const a = await seal(SECRET, "pw", FAST);
    const b = await seal(SECRET, "pw", FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("refuses a wrong password", async () => {
    const vault = await seal(SECRET, "pw", FAST);
    await expect(open(vault, "PW")).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it("refuses altered data or an altered header", async () => {
    const vault = await seal(SECRET, "pw", FAST);
    const flipped = {
      ...vault,
      data: vault.data.slice(0, -4) + (vault.data.endsWith("AAAA") ? "BBBB" : "AAAA"),
    };
    await expect(open(flipped, "pw")).rejects.toBeInstanceOf(WrongPasswordError);
    // The iteration count is bound to the ciphertext, so raising or lowering it fails too.
    await expect(open({ ...vault, iterations: FAST + 1 }, "pw")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
  });

  it("refuses malformed vaults before deriving any key", () => {
    expect(() => parseVault(null)).toThrow("malformed vault");
    expect(() =>
      parseVault({ v: 2, kdf: "PBKDF2-SHA256", iterations: FAST, salt: "", iv: "", data: "" }),
    ).toThrow("unsupported vault version");
    expect(() =>
      parseVault({
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: 100_000_000,
        salt: "",
        iv: "",
        data: "",
      }),
    ).toThrow("iteration count");
    expect(() =>
      parseVault({
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: FAST,
        salt: "",
        iv: "",
        data: "",
        extra: 1,
      }),
    ).toThrow("malformed vault");
  });

  it("refuses an empty password", async () => {
    await expect(seal(SECRET, "")).rejects.toThrow("empty");
  });

  it("says when an older vault should be re-sealed", async () => {
    expect(needsUpgrade(await seal("x", "pw", FAST))).toBe(true);
  });
});
