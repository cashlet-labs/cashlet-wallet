/**
 * Encrypted-message requests from web pages: NIP-04 and NIP-44 through
 * `window.nostr.nip04` and `window.nostr.nip44`. Pages are untrusted, so each
 * request is checked here, with size limits, before the wallet looks at it.
 */

export type CipherMethod =
  "nostr.nip04.encrypt" | "nostr.nip04.decrypt" | "nostr.nip44.encrypt" | "nostr.nip44.decrypt";

export type CipherRequest =
  | { method: "nostr.nip04.encrypt" | "nostr.nip44.encrypt"; pubkey: string; plaintext: string }
  | { method: "nostr.nip04.decrypt" | "nostr.nip44.decrypt"; pubkey: string; ciphertext: string };

/** Plaintext limit in characters; NIP-44 also limits it to 65535 bytes, which the wallet checks. */
export const MAX_PLAINTEXT_CHARS = 64 * 1024;
/** A NIP-44 payload is at most 87472 characters; a NIP-04 one for 64 KB is a little over 87400. */
export const MAX_CIPHERTEXT_CHARS = 90_000;

const METHODS: readonly string[] = [
  "nostr.nip04.encrypt",
  "nostr.nip04.decrypt",
  "nostr.nip44.encrypt",
  "nostr.nip44.decrypt",
];

export function isCipherMethod(method: string): method is CipherMethod {
  return METHODS.includes(method);
}

export function cipherScheme(method: CipherMethod): "nip04" | "nip44" {
  return method.startsWith("nostr.nip04.") ? "nip04" : "nip44";
}

export function isEncrypt(
  request: CipherRequest,
): request is CipherRequest & { plaintext: string } {
  return request.method.endsWith(".encrypt");
}

/** Validate the parameters of a cipher request. */
export function parseCipherRequest(
  method: CipherMethod,
  params: Record<string, unknown>,
): CipherRequest | { error: string } {
  const encrypt = method.endsWith(".encrypt");
  const field = encrypt ? "plaintext" : "ciphertext";
  const keys = Object.keys(params).sort().join();
  if (keys !== [field, "pubkey"].sort().join()) return { error: "malformed request" };
  const { pubkey } = params;
  if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
    return { error: "the public key must be 64 lowercase hex characters" };
  const value = params[field];
  const max = encrypt ? MAX_PLAINTEXT_CHARS : MAX_CIPHERTEXT_CHARS;
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    return {
      error: `the ${field} must be text of at most ${encrypt ? "64 KB" : "90000 characters"}`,
    };
  // A lone surrogate is not valid UTF-8, so it could not be encrypted as sent.
  if (/\p{Surrogate}/u.test(value)) return { error: `the ${field} is not valid text` };
  return encrypt
    ? { method: method as "nostr.nip04.encrypt" | "nostr.nip44.encrypt", pubkey, plaintext: value }
    : {
        method: method as "nostr.nip04.decrypt" | "nostr.nip44.decrypt",
        pubkey,
        ciphertext: value,
      };
}
