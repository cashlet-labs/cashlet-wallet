import { describe, expect, it } from "vitest";
import { isExtensionSender, parseRequest } from "../src/shared/messages";

const ADDRESS = "bchtest:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnqseeszx8x";

describe("parseRequest", () => {
  it("accepts well-formed requests", () => {
    expect(parseRequest({ type: "PING" })).toEqual({ type: "PING" });
    expect(parseRequest({ type: "VERIFY_BINDING", event: { kind: 1 } })).toEqual({
      type: "VERIFY_BINDING",
      event: { kind: 1 },
    });
    expect(
      parseRequest({ type: "CREATE_WALLET", password: "password1", network: "chipnet" }),
    ).toMatchObject({ type: "CREATE_WALLET" });
    expect(parseRequest({ type: "UNLOCK", password: "x", walletId: "abc" })).toEqual({
      type: "UNLOCK",
      password: "x",
      walletId: "abc",
    });
    expect(
      parseRequest({
        type: "PREPARE_SEND",
        recipients: [
          { address: ADDRESS, value: 1000, token: { category: "ab".repeat(32), amount: "5" } },
        ],
      }),
    ).toMatchObject({ type: "PREPARE_SEND" });
    expect(parseRequest({ type: "SET_AUTO_LOCK", minutes: 30 })).toEqual({
      type: "SET_AUTO_LOCK",
      minutes: 30,
    });
  });

  it("refuses unknown types, extra or missing members and wrong types", () => {
    for (const value of [null, 1, "PING", [], {}, { type: 1 }, { type: "NOPE" }]) {
      expect(parseRequest(value)).toHaveProperty("error");
    }
    expect(parseRequest({ type: "PING", extra: true })).toHaveProperty("error");
    expect(parseRequest({ type: "VERIFY_BINDING" })).toHaveProperty("error");
    expect(
      parseRequest({ type: "CREATE_WALLET", password: "p", network: "testnet3" }),
    ).toHaveProperty("error");
    expect(parseRequest({ type: "UNLOCK", password: "" })).toHaveProperty("error");
    expect(parseRequest({ type: "GET_RECEIVE_ADDRESS", tokenAware: "yes" })).toHaveProperty(
      "error",
    );
    expect(parseRequest({ type: "SET_AUTO_LOCK", minutes: 0 })).toHaveProperty("error");
  });

  it("refuses malformed recipients", () => {
    const bad = [
      [],
      [{ address: ADDRESS }],
      [{ address: ADDRESS, value: -1 }],
      [{ address: ADDRESS, value: 1.5 }],
      [{ address: ADDRESS, value: 1, token: { category: "xy", amount: "1" } }],
      [{ address: ADDRESS, value: 1, token: { category: "ab".repeat(32), amount: "01" } }],
      [{ address: ADDRESS, value: 1, nft: { txid: "ab".repeat(32), vout: -1 } }],
      Array.from({ length: 51 }, () => ({ address: ADDRESS, value: 1000 })),
    ];
    for (const recipients of bad)
      expect(parseRequest({ type: "PREPARE_SEND", recipients })).toHaveProperty("error");
  });

  it("refuses an event larger than a relay would accept", () => {
    const event = { content: "x".repeat(70_000) };
    expect(parseRequest({ type: "VERIFY_BINDING", event })).toEqual({ error: "event too large" });
  });
});

describe("isExtensionSender", () => {
  const id = "abcdefghijklmnop";
  const origin = `chrome-extension://${id}/`;

  it("accepts the extension's own pages", () => {
    expect(isExtensionSender({ id, url: `${origin}src/popup/index.html` }, id, origin)).toBe(true);
  });

  it("refuses content scripts, other extensions and missing URLs", () => {
    expect(isExtensionSender({ id, url: "https://example.com/" }, id, origin)).toBe(false);
    expect(isExtensionSender({ id: "other", url: `${origin}x.html` }, id, origin)).toBe(false);
    expect(isExtensionSender({ id }, id, origin)).toBe(false);
  });
});
