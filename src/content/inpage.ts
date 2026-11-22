/**
 * Runs in the page's own JavaScript world and defines `window.nostr` (NIP-07)
 * and `window.bnd`. It holds nothing secret and decides nothing: every call is
 * passed to the extension, which asks the user and answers.
 *
 * The page can read and forge these messages. That gains it nothing it could
 * not do by calling the API itself, because the extension takes the site's
 * origin from the browser, never from the message.
 */
(() => {
  const CHANNEL = "cashlet:v1";
  type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
  const waiting = new Map<number, Pending>();
  let next = 1;

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      channel?: unknown;
      direction?: unknown;
      id?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    } | null;
    if (event.source !== window || typeof data !== "object" || data === null) return;
    if (data.channel !== CHANNEL || data.direction !== "response" || typeof data.id !== "number")
      return;
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.ok === true) pending.resolve(data.result);
    else pending.reject(new Error(typeof data.error === "string" ? data.error : "request failed"));
  });

  const call = (method: string, params: unknown = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      window.postMessage({ channel: CHANNEL, direction: "request", id, method, params }, "*");
    });

  const nostr = Object.freeze({
    getPublicKey: () => call("nostr.getPublicKey"),
    signEvent: (event: unknown) => call("nostr.signEvent", { event }),
    getRelays: () => call("nostr.getRelays"),
    nip04: Object.freeze({
      encrypt: (pubkey: unknown, plaintext: unknown) =>
        call("nostr.nip04.encrypt", { pubkey, plaintext }),
      decrypt: (pubkey: unknown, ciphertext: unknown) =>
        call("nostr.nip04.decrypt", { pubkey, ciphertext }),
    }),
    nip44: Object.freeze({
      encrypt: (pubkey: unknown, plaintext: unknown) =>
        call("nostr.nip44.encrypt", { pubkey, plaintext }),
      decrypt: (pubkey: unknown, ciphertext: unknown) =>
        call("nostr.nip44.decrypt", { pubkey, ciphertext }),
    }),
  });

  const bnd = Object.freeze({
    version: 1,
    /** Answer a BND login challenge (BND-1 section 8) with this wallet's identity. */
    login: (challenge: unknown) => call("bnd.login", { challenge }),
  });

  // Another Nostr extension may already provide window.nostr; the first one keeps it.
  for (const [name, value] of [
    ["nostr", nostr],
    ["bnd", bnd],
  ] as const) {
    if (!(name in window)) Object.defineProperty(window, name, { value, enumerable: true });
  }
})();
