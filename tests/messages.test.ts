import { describe, expect, it } from "vitest";
import { isExtensionSender, parseRequest } from "../src/shared/messages";

describe("parseRequest", () => {
  it("accepts the known requests", () => {
    expect(parseRequest({ type: "PING" })).toEqual({ type: "PING" });
    expect(parseRequest({ type: "VERIFY_BINDING", event: { kind: 1 } })).toEqual({
      type: "VERIFY_BINDING",
      event: { kind: 1 },
    });
  });

  it("refuses anything else", () => {
    for (const value of [null, 1, "PING", [], {}, { type: 1 }, { type: "NOPE" }]) {
      expect(parseRequest(value)).toHaveProperty("error");
    }
  });

  it("refuses extra or missing members", () => {
    expect(parseRequest({ type: "PING", extra: true })).toHaveProperty("error");
    expect(parseRequest({ type: "VERIFY_BINDING" })).toHaveProperty("error");
    expect(parseRequest({ type: "VERIFY_BINDING", event: {}, extra: 1 })).toHaveProperty("error");
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
