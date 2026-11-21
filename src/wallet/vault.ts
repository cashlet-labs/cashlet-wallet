/**
 * Encrypts the wallet's secrets (the mnemonic) with the user's password.
 *
 * Format (version 1), stored as JSON:
 *
 *   { "v": 1, "kdf": "PBKDF2-SHA256", "iterations": 600000,
 *     "salt": <16 bytes, base64>, "iv": <12 bytes, base64>, "data": <AES-256-GCM ciphertext and tag, base64> }
 *
 * The KDF and its parameters travel with the data, so the iteration count can be
 * raised later and old vaults still open. The header is bound to the ciphertext as
 * additional authenticated data, so changing any field makes decryption fail.
 */

export const VAULT_VERSION = 1;
export const DEFAULT_ITERATIONS = 600_000;
/** Refuse vaults that would take minutes to open: a stored value cannot stall the wallet. */
const MAX_ITERATIONS = 10_000_000;
const MIN_ITERATIONS = 1_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface Vault {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("incorrect password");
    this.name = "WrongPasswordError";
  }
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function fromBase64(text: string, length?: number): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  if (length !== undefined && bytes.length !== length) throw new TypeError("malformed vault");
  return bytes;
}

function header(
  vault: Pick<Vault, "v" | "kdf" | "iterations" | "salt" | "iv">,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `cashlet/vault/${vault.v}\n${vault.kdf}\n${vault.iterations}\n${vault.salt}\n${vault.iv}`,
  );
}

async function keyFor(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function parseVault(value: unknown): Vault {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("malformed vault");
  }
  const vault = value as Record<string, unknown>;
  if (Object.keys(vault).sort().join(",") !== "data,iterations,iv,kdf,salt,v") {
    throw new TypeError("malformed vault");
  }
  if (vault.v !== VAULT_VERSION)
    throw new TypeError(`unsupported vault version: ${String(vault.v)}`);
  if (vault.kdf !== "PBKDF2-SHA256") throw new TypeError("unsupported vault KDF");
  if (
    typeof vault.iterations !== "number" ||
    !Number.isInteger(vault.iterations) ||
    vault.iterations < MIN_ITERATIONS ||
    vault.iterations > MAX_ITERATIONS
  ) {
    throw new TypeError("unsupported vault iteration count");
  }
  for (const field of ["salt", "iv", "data"] as const) {
    if (typeof vault[field] !== "string") throw new TypeError("malformed vault");
  }
  return vault as unknown as Vault;
}

/** Encrypt `plaintext`. `iterations` is only lowered in tests. */
export async function seal(
  plaintext: string,
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<Vault> {
  if (password.length === 0) throw new TypeError("the password is empty");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const fields = {
    v: VAULT_VERSION,
    kdf: "PBKDF2-SHA256",
    iterations,
    salt: toBase64(salt),
    iv: toBase64(iv),
  } as const;
  const key = await keyFor(password, salt, iterations);
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: header(fields) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return parseVault({ ...fields, data: toBase64(new Uint8Array(data)) });
}

/** Decrypt a vault. Throws WrongPasswordError for a wrong password or altered data. */
export async function open(value: unknown, password: string): Promise<string> {
  const vault = parseVault(value);
  const salt = fromBase64(vault.salt, SALT_BYTES);
  const iv = fromBase64(vault.iv, IV_BYTES);
  const key = await keyFor(password, salt, vault.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: header(vault) },
      key,
      fromBase64(vault.data),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // AES-GCM cannot tell a wrong key from altered data; both mean the vault does not open.
    throw new WrongPasswordError();
  }
}

/** True when a vault should be re-sealed with today's parameters after it is opened. */
export function needsUpgrade(vault: Vault): boolean {
  return vault.iterations < DEFAULT_ITERATIONS;
}
