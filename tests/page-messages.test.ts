import { describe, expect, it } from "vitest";
import { pageOrigin, parsePageRequest, rememberable } from "../src/shared/page-messages";

const ORIGIN = "https://app.example";
const note = { kind: 1, content: "hello", tags: [["t", "bch"]], created_at: 1_795_200_000 };
const challenge = {
  nonce: "ab".repeat(32),
  audience: "https://app.example/login",
  level: "dual",
  issuedAt: 1_795_200_000,
  expiresAt: 1_795_200_300,
};

describe("parsePageRequest", () => {
  it("accepts the NIP-07 methods and a BND login for this site", () => {
    expect(parsePageRequest({ method: "nostr.getPublicKey", params: {} }, ORIGIN)).toEqual({
      method: "nostr.getPublicKey",
    });
    expect(parsePageRequest({ method: "nostr.getRelays" }, ORIGIN)).toEqual({
      method: "nostr.getRelays",
    });
    expect(
      parsePageRequest({ method: "nostr.signEvent", params: { event: note } }, ORIGIN),
    ).toEqual({ method: "nostr.signEvent", event: note });
    // Pages often pass pubkey/id/sig placeholders; the wallet ignores them.
    expect(
      parsePageRequest(
        { method: "nostr.signEvent", params: { event: { ...note, pubkey: "x", id: "", sig: "" } } },
        ORIGIN,
      ),
    ).toEqual({ method: "nostr.signEvent", event: note });
    expect(parsePageRequest({ method: "bnd.login", params: { challenge } }, ORIGIN)).toEqual({
      method: "bnd.login",
      challenge,
    });
  });

  it("refuses unknown methods, extra parameters and malformed events", () => {
    const bad: unknown[] = [
      null,
      { method: "nostr.nip04.encrypt", params: {} },
      { method: "nostr.getPublicKey", params: { extra: 1 } },
      { method: "nostr.signEvent", params: {} },
      { method: "nostr.signEvent", params: { event: { ...note, kind: 70_000 } } },
      { method: "nostr.signEvent", params: { event: { ...note, kind: 1.5 } } },
      { method: "nostr.signEvent", params: { event: { ...note, content: 5 } } },
      { method: "nostr.signEvent", params: { event: { ...note, tags: [[1]] } } },
      { method: "nostr.signEvent", params: { event: { ...note, tags: [[]] } } },
      { method: "nostr.signEvent", params: { event: { ...note, created_at: "now" } } },
      { method: "nostr.signEvent", params: { event: { ...note, extra: true } } },
      { method: "nostr.signEvent", params: { event: { ...note, content: "x".repeat(70_000) } } },
    ];
    for (const value of bad) expect(parsePageRequest(value, ORIGIN)).toHaveProperty("error");
  });

  it("refuses text whose NIP-01 event ID would disagree with other software", () => {
    for (const content of ["a\u0000b", "bell\u0007", "\ud800 lone", "lone \udc00"]) {
      expect(
        parsePageRequest(
          { method: "nostr.signEvent", params: { event: { ...note, content } } },
          ORIGIN,
        ),
      ).toEqual({ error: "the event contains characters Nostr cannot sign" });
    }
    // Escaped control characters and surrogate pairs are fine.
    expect(
      parsePageRequest(
        { method: "nostr.signEvent", params: { event: { ...note, content: "a\nb\t😀" } } },
        ORIGIN,
      ),
    ).toHaveProperty("method");
  });

  it("refuses BND bindings and approvals: only the Identity screen makes them", () => {
    for (const d of ["bnd1", "bnd1-approval"]) {
      const event = { kind: 30078, content: "{}", tags: [["d", d]], created_at: 1 };
      expect(parsePageRequest({ method: "nostr.signEvent", params: { event } }, ORIGIN)).toEqual({
        error: "sites cannot sign BND bindings; use the wallet's Identity screen",
      });
    }
    // Other kind 30078 application data stays signable.
    const appData = { kind: 30078, content: "{}", tags: [["d", "my-app"]], created_at: 1 };
    expect(
      parsePageRequest({ method: "nostr.signEvent", params: { event: appData } }, ORIGIN),
    ).toHaveProperty("method");
  });

  it("signs a NIP-98 login event only for the site asking", () => {
    const login = (u: string) => ({
      method: "nostr.signEvent",
      params: {
        event: {
          kind: 27235,
          content: "",
          tags: [
            ["u", u],
            ["method", "GET"],
          ],
          created_at: 1,
        },
      },
    });
    expect(parsePageRequest(login("https://app.example/api"), ORIGIN)).toHaveProperty("method");
    expect(parsePageRequest(login("https://bank.example/api"), ORIGIN)).toEqual({
      error: "a login event can only be signed for the site asking for it",
    });
    expect(parsePageRequest(login("not a url"), ORIGIN)).toHaveProperty("error");
  });

  it("refuses a login challenge for another site", () => {
    expect(
      parsePageRequest(
        {
          method: "bnd.login",
          params: { challenge: { ...challenge, audience: "https://bank.example/login" } },
        },
        ORIGIN,
      ),
    ).toEqual({ error: "this login challenge is for a different site" });
    expect(
      parsePageRequest(
        { method: "bnd.login", params: { challenge: { ...challenge, level: "any" } } },
        ORIGIN,
      ),
    ).toHaveProperty("error");
  });
});

describe("rememberable", () => {
  it("never remembers kinds that replace a profile, follows or relays, or log in", () => {
    for (const kind of [0, 3, 5, 10002, 27235, 30078]) expect(rememberable(kind)).toBe(false);
    for (const kind of [1, 7, 22242]) expect(rememberable(kind)).toBe(true);
  });
});

describe("pageOrigin", () => {
  it("allows https pages and local development, nothing else", () => {
    expect(pageOrigin("https://app.example/path?q=1")).toBe("https://app.example");
    expect(pageOrigin("http://localhost:5173/")).toBe("http://localhost:5173");
    expect(pageOrigin("http://127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080");
    for (const url of [
      undefined,
      "http://app.example/",
      "file:///etc/passwd",
      "data:text/html,hi",
      "chrome-extension://abc/page.html",
      "not a url",
    ])
      expect(pageOrigin(url)).toBeNull();
  });
});
