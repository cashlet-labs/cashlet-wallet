import { describe, expect, it } from "vitest";
import {
  BCMR_GATEWAY,
  cleanText,
  fetchUrl,
  parseBcmrOutput,
  parseRegistry,
} from "../src/wallet/bcmr";
import { bcmrScript } from "./bcmr-fixtures";
import { formatTokenAmount, parseTokenAmount } from "../src/wallet/token-amount";

const CATEGORY = "ab".repeat(32);
const HASH = "cd".repeat(32);

describe("parseBcmrOutput", () => {
  it("reads the hash and the addresses", () => {
    expect(
      parseBcmrOutput(bcmrScript(HASH, ["ipfs://bafy1234567890", "example.com/r.json"])),
    ).toEqual({
      hash: HASH,
      uris: ["ipfs://bafy1234567890", "example.com/r.json"],
    });
  });

  it("ignores other scripts and malformed BCMR outputs", () => {
    expect(parseBcmrOutput(Uint8Array.of(0x76, 0xa9))).toBeNull();
    expect(parseBcmrOutput(Uint8Array.of(0x6a, 0x04, 0x42, 0x43, 0x4d, 0x52))).toBeNull();
    expect(parseBcmrOutput(bcmrScript(HASH, []))).toBeNull();
    expect(parseBcmrOutput(bcmrScript("cd".repeat(31), ["ipfs://bafy1234567890"]))).toBeNull();
    const truncated = bcmrScript(HASH, ["ipfs://bafy1234567890"]).slice(0, -3);
    expect(parseBcmrOutput(truncated)).toBeNull();
  });
});

describe("fetchUrl", () => {
  it("sends ipfs: addresses to the one gateway", () => {
    expect(fetchUrl("ipfs://bafy1234567890/registry.json")).toBe(
      `${BCMR_GATEWAY}/ipfs/bafy1234567890/registry.json`,
    );
    expect(fetchUrl("ipfs://bafy1234567890/../x")).toBeNull();
    expect(fetchUrl("ipfs://no")).toBeNull();
  });

  it("refuses every other host and scheme", () => {
    expect(fetchUrl("https://example.com/r.json")).toBeNull();
    expect(fetchUrl("example.com/r.json")).toBeNull();
    expect(fetchUrl("http://gateway.pinata.cloud/ipfs/x")).toBeNull();
    expect(fetchUrl("https://gateway.pinata.cloud.evil.test/ipfs/x")).toBeNull();
    expect(fetchUrl("https://user@gateway.pinata.cloud/ipfs/x")).toBeNull();
    expect(fetchUrl("data:text/plain,hi")).toBeNull();
  });

  it("accepts a path on the gateway itself", () => {
    expect(fetchUrl(`${BCMR_GATEWAY}/ipfs/bafy1234567890`)).toBe(
      `${BCMR_GATEWAY}/ipfs/bafy1234567890`,
    );
  });
});

describe("cleanText", () => {
  it("strips control and invisible characters, collapses space and shortens", () => {
    expect(cleanText("  Cash\u202E\u200Bcoin\n\tX ", 64)).toBe("Cashcoin X");
    expect(cleanText("<b>x</b>", 64)).toBe("<b>x</b>");
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("\u0000\u0007", 10)).toBeNull();
    expect(cleanText(5, 10)).toBeNull();
  });
});

describe("parseRegistry", () => {
  const registry = (identity: unknown) => ({ identities: { [CATEGORY]: identity } });

  it("reads name, symbol, decimals, icon and NFT type names", () => {
    const meta = parseRegistry(
      registry({
        "2024-01-01T00:00:00.000Z": { name: "Old" },
        "2024-06-01T00:00:00.000Z": {
          name: "Test Token",
          uris: { icon: "ipfs://bafy1234567890" },
          token: {
            category: CATEGORY,
            symbol: "TST",
            decimals: 2,
            nfts: {
              parse: {
                types: { "": { name: "Plain" }, "0a": { name: "Gold" }, zz: { name: "x" } },
              },
            },
          },
        },
      }),
      CATEGORY,
    );
    expect(meta).toEqual({
      name: "Test Token",
      symbol: "TST",
      decimals: 2,
      icon: "ipfs://bafy1234567890",
      nftTypes: [
        { commitment: "", name: "Plain" },
        { commitment: "0a", name: "Gold" },
      ],
    });
  });

  it("takes the snapshot with the latest begin from a list", () => {
    const meta = parseRegistry(
      registry([
        { name: "New", begin: "2025-01-01T00:00:00.000Z" },
        { name: "Old", begin: "2023-01-01T00:00:00.000Z" },
      ]),
      CATEGORY,
    );
    expect(meta?.name).toBe("New");
  });

  it("rejects bad values and falls back to safe ones", () => {
    const meta = parseRegistry(
      registry([
        {
          name: "T",
          uris: { icon: "javascript:alert(1)" },
          token: { category: CATEGORY, decimals: 99 },
        },
      ]),
      CATEGORY,
    );
    expect(meta).toMatchObject({ name: "T", symbol: null, decimals: 0, icon: null });
    expect(
      parseRegistry(registry([{ name: "T", uris: { icon: "http://example.com/i.png" } }]), CATEGORY)
        ?.icon,
    ).toBeNull();
    expect(parseRegistry(registry([{ token: { category: CATEGORY } }]), CATEGORY)).toBeNull();
    expect(
      parseRegistry(registry([{ name: "T", token: { category: "cd".repeat(32) } }]), CATEGORY),
    ).toBeNull();
    expect(parseRegistry({ identities: {} }, CATEGORY)).toBeNull();
    expect(parseRegistry("nope", CATEGORY)).toBeNull();
    expect(parseRegistry({ identities: { __proto__: [{ name: "T" }] } }, CATEGORY)).toBeNull();
  });
});

describe("token amounts", () => {
  it("formats raw units with decimals, exactly", () => {
    expect(formatTokenAmount("150", 2)).toBe("1.5");
    expect(formatTokenAmount("100", 2)).toBe("1");
    expect(formatTokenAmount("5", 3)).toBe("0.005");
    expect(formatTokenAmount("1234567", 0)).toBe("1,234,567");
    expect(formatTokenAmount("9223372036854775807", 18)).toBe("9.223372036854775807");
  });

  it("parses typed amounts into raw units", () => {
    expect(parseTokenAmount("1.5", 2)).toBe(150n);
    expect(parseTokenAmount(" 2 ", 2)).toBe(200n);
    expect(parseTokenAmount("0.01", 2)).toBe(1n);
    expect(parseTokenAmount("42", 0)).toBe(42n);
    expect(parseTokenAmount("9223372036854775807", 0)).toBe(9223372036854775807n);
    expect(parseTokenAmount("0.123456789012345678", 18)).toBe(123456789012345678n);
  });

  it("rejects too many decimals, zero, signs, exponents and overflow", () => {
    expect(() => parseTokenAmount("1.234", 2)).toThrow(/at most 2 decimals/);
    expect(() => parseTokenAmount("1.5", 0)).toThrow(/whole number/);
    for (const bad of [
      "0",
      "0.00",
      "-1",
      "1e3",
      "1,5",
      ".5",
      "1.",
      "",
      "abc",
      "9223372036854775808",
    ]) {
      expect(() => parseTokenAmount(bad, 2), bad).toThrow(RangeError);
    }
  });
});
