import { describe, expect, it } from "vitest";
import { isValidMnemonic } from "../src/wallet/hd";
import { LockedError, MemoryKeyValue, ThrottledError, WalletSession } from "../src/wallet/session";
import { WrongPasswordError } from "../src/wallet/vault";

// Published BIP39 test vector. Never use it for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse";

function setup() {
  const storage = new MemoryKeyValue();
  const clock = { now: 1_000_000 };
  const session = new WalletSession(storage, { iterations: 1_000, now: () => clock.now });
  return { storage, clock, session };
}

describe("WalletSession", () => {
  it("creates a wallet, returns its phrase once and unlocks it", async () => {
    const { storage, session } = setup();
    const { mnemonic } = await session.create(PASSWORD, "chipnet");
    expect(isValidMnemonic(mnemonic)).toBe(true);
    expect(await session.status()).toMatchObject({
      unlocked: true,
      wallets: [{ name: "Wallet", network: "chipnet" }],
    });
    // Nothing in storage contains the phrase or the password.
    const stored = JSON.stringify([...storage.data.values()]);
    expect(stored).not.toContain(mnemonic.split(" ")[0] + " " + mnemonic.split(" ")[1]);
    expect(stored).not.toContain(PASSWORD);
  });

  it("imports a phrase, normalising spacing and case", async () => {
    const { session } = setup();
    await session.import(`  ${VECTOR.toUpperCase()}  `, PASSWORD, "mainnet", "Savings");
    expect(session.current().wallet.address(0, 0, "mainnet")).toMatch(/^bitcoincash:q/);
    expect((await session.status()).wallets[0]).toMatchObject({
      name: "Savings",
      network: "mainnet",
    });
    await expect(session.import("not a phrase", PASSWORD, "mainnet")).rejects.toThrow("not valid");
  });

  it("locks, refuses work while locked, and unlocks with the password", async () => {
    const { session } = setup();
    await session.import(VECTOR, PASSWORD, "chipnet");
    const address = session.current().wallet.address(0, 0, "chipnet");
    session.lock();
    expect(() => session.current()).toThrow(LockedError);
    await expect(session.unlock("wrong password")).rejects.toBeInstanceOf(WrongPasswordError);
    await session.unlock(PASSWORD);
    expect(session.current().wallet.address(0, 0, "chipnet")).toBe(address);
  });

  it("throttles repeated wrong passwords, and resets after a right one", async () => {
    const { session, clock } = setup();
    await session.import(VECTOR, PASSWORD, "chipnet");
    session.lock();
    for (let i = 0; i < 3; i++)
      await expect(session.unlock("nope nope")).rejects.toBeInstanceOf(WrongPasswordError);
    // The third failure starts a 1-second wait, and each further failure doubles it.
    await expect(session.unlock(PASSWORD)).rejects.toBeInstanceOf(ThrottledError);
    expect((await session.status()).retryAfter).toBe(1);
    clock.now += 1_000;
    await expect(session.unlock("nope nope")).rejects.toBeInstanceOf(WrongPasswordError);
    expect((await session.status()).retryAfter).toBe(2);
    clock.now += 2_000;
    await session.unlock(PASSWORD);
    expect((await session.status()).retryAfter).toBe(0);
  });

  it("reveals the phrase and changes the password only with the current password", async () => {
    const { session } = setup();
    await session.import(VECTOR, PASSWORD, "chipnet");
    await expect(session.reveal("wrong password")).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await session.reveal(PASSWORD)).toBe(VECTOR);
    await expect(session.changePassword("wrong password", "new password 1")).rejects.toBeInstanceOf(
      WrongPasswordError,
    );
    await expect(session.changePassword(PASSWORD, "short")).rejects.toThrow("at least 8");
    await session.changePassword(PASSWORD, "new password 1");
    session.lock();
    await expect(session.unlock(PASSWORD)).rejects.toBeInstanceOf(WrongPasswordError);
    await session.unlock("new password 1");
  });

  it("keeps several wallets and switches between them", async () => {
    const { session } = setup();
    const first = await session.import(VECTOR, PASSWORD, "chipnet", "One");
    const second = await session.create("another password", "chipnet", "Two");
    expect((await session.status()).activeId).toBe(second.id);
    session.lock();
    await session.unlock(PASSWORD, first.id);
    expect((await session.status()).activeId).toBe(first.id);
    await session.rename(first.id, "  Daily  ");
    expect((await session.status()).wallets.map((w) => w.name)).toEqual(["Daily", "Two"]);
  });

  it("removes a wallet only with its password", async () => {
    const { session } = setup();
    const { id } = await session.import(VECTOR, PASSWORD, "chipnet");
    await expect(session.remove(id, "wrong password")).rejects.toBeInstanceOf(WrongPasswordError);
    await session.remove(id, PASSWORD);
    expect(await session.status()).toMatchObject({ wallets: [], activeId: null, unlocked: false });
  });

  it("refuses short passwords", async () => {
    const { session } = setup();
    await expect(session.create("short", "chipnet")).rejects.toThrow("at least 8");
  });
});
