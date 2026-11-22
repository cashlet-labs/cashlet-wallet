import { secp256k1 } from "@noble/curves/secp256k1.js";
import { equalBytes } from "@noble/curves/utils.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { cipherScheme, isEncrypt, type CipherRequest } from "../shared/page-cipher";

/**
 * Encrypted Nostr messages: NIP-04 (AES-256-CBC) and NIP-44 version 2
 * (ChaCha20 with HMAC-SHA-256). The wallet's Nostr private key is passed in for
 * one call and never kept. Errors are deliberately short and never say which
 * check failed in a way a site could use to probe a ciphertext.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** NIP-44 and the wallet's NIP-04 limit: 65535 bytes of plaintext. */
export const MAX_PLAINTEXT_BYTES = 65_535;

/** The shared point's x coordinate, which both schemes start from. */
function sharedX(privateKey: Uint8Array, peerPublicKey: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(peerPublicKey)) throw new Error("invalid public key");
  try {
    return secp256k1.getSharedSecret(privateKey, hexToBytes(`02${peerPublicKey}`)).subarray(1, 33);
  } catch {
    throw new Error("invalid public key");
  }
}

function plaintextBytes(plaintext: string): Uint8Array {
  const bytes = encoder.encode(plaintext);
  if (bytes.length < 1 || bytes.length > MAX_PLAINTEXT_BYTES)
    throw new Error("the message must be 1 to 65535 bytes");
  return bytes;
}

// NIP-04

/** NIP-04: base64 ciphertext, then "?iv=" and the base64 IV. `iv` is for tests only. */
export async function nip04Encrypt(
  privateKey: Uint8Array,
  peerPublicKey: string,
  plaintext: string,
  iv: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<string> {
  const bytes = plaintextBytes(plaintext);
  const key = await crypto.subtle.importKey(
    "raw",
    sharedX(privateKey, peerPublicKey) as BufferSource,
    "AES-CBC",
    false,
    ["encrypt"],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-CBC", iv: iv as BufferSource },
    key,
    bytes as BufferSource,
  );
  return `${base64.encode(new Uint8Array(encrypted))}?iv=${base64.encode(iv)}`;
}

export async function nip04Decrypt(
  privateKey: Uint8Array,
  peerPublicKey: string,
  ciphertext: string,
): Promise<string> {
  const match = /^([A-Za-z0-9+/]+={0,2})\?iv=([A-Za-z0-9+/]+={0,2})$/.exec(ciphertext);
  const failed = new Error("could not decrypt the message");
  if (!match) throw failed;
  try {
    const iv = base64.decode(match[2] as string);
    const data = base64.decode(match[1] as string);
    if (iv.length !== 16 || data.length === 0 || data.length % 16 !== 0) throw failed;
    const key = await crypto.subtle.importKey(
      "raw",
      sharedX(privateKey, peerPublicKey) as BufferSource,
      "AES-CBC",
      false,
      ["decrypt"],
    );
    const plain = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: iv as BufferSource },
      key,
      data as BufferSource,
    );
    return decoder.decode(plain);
  } catch (error) {
    throw error instanceof Error && error.message === "invalid public key" ? error : failed;
  }
}

// NIP-44 version 2

const rotl = (a: number, b: number) => (a << b) | (a >>> (32 - b));

/** ChaCha20 (RFC 8439) keystream XOR, 32-byte key, 12-byte nonce, block counter from 0. */
export function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("bad ChaCha20 key or nonce");
  const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const k = view(key);
  const n = view(nonce);
  const state = new Uint32Array(16);
  state.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) state[4 + i] = k.getUint32(i * 4, true);
  for (let i = 0; i < 3; i++) state[13 + i] = n.getUint32(i * 4, true);
  const out = new Uint8Array(data.length);
  const block = new Uint32Array(16);
  const quarter = (a: number, b: number, c: number, d: number) => {
    block[a] = (block[a]! + block[b]!) | 0;
    block[d] = rotl(block[d]! ^ block[a]!, 16);
    block[c] = (block[c]! + block[d]!) | 0;
    block[b] = rotl(block[b]! ^ block[c]!, 12);
    block[a] = (block[a]! + block[b]!) | 0;
    block[d] = rotl(block[d]! ^ block[a]!, 8);
    block[c] = (block[c]! + block[d]!) | 0;
    block[b] = rotl(block[b]! ^ block[c]!, 7);
  };
  for (let offset = 0, counter = 0; offset < data.length; offset += 64, counter++) {
    state[12] = counter;
    block.set(state);
    for (let round = 0; round < 10; round++) {
      quarter(0, 4, 8, 12);
      quarter(1, 5, 9, 13);
      quarter(2, 6, 10, 14);
      quarter(3, 7, 11, 15);
      quarter(0, 5, 10, 15);
      quarter(1, 6, 11, 12);
      quarter(2, 7, 8, 13);
      quarter(3, 4, 9, 14);
    }
    const stream = new Uint8Array(64);
    const words = view(stream);
    for (let i = 0; i < 16; i++) words.setUint32(i * 4, (block[i]! + state[i]!) | 0, true);
    for (let i = 0; i < 64 && offset + i < data.length; i++)
      out[offset + i] = data[offset + i]! ^ stream[i]!;
  }
  return out;
}

/** The key two Nostr keys share, the same from either side. */
export function nip44ConversationKey(privateKey: Uint8Array, peerPublicKey: string): Uint8Array {
  return extract(sha256, sharedX(privateKey, peerPublicKey), encoder.encode("nip44-v2"));
}

export function nip44MessageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  const keys = expand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: keys.subarray(0, 32),
    chachaNonce: keys.subarray(32, 44),
    hmacKey: keys.subarray(44, 76),
  };
}

export function nip44PaddedLength(length: number): number {
  if (!Number.isInteger(length) || length < 1) throw new Error("invalid plaintext size");
  if (length <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(length - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((length - 1) / chunk) + 1);
}

function macOf(hmacKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
}

/** `nonce` is for tests only; it must be fresh and random for every message. */
export function nip44Encrypt(
  plaintext: string,
  conversationKey: Uint8Array,
  nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): string {
  const bytes = plaintextBytes(plaintext);
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(conversationKey, nonce);
  const padded = new Uint8Array(2 + nip44PaddedLength(bytes.length));
  new DataView(padded.buffer).setUint16(0, bytes.length);
  padded.set(bytes, 2);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  return base64.encode(
    concatBytes(new Uint8Array([2]), nonce, ciphertext, macOf(hmacKey, nonce, ciphertext)),
  );
}

export function nip44Decrypt(payload: string, conversationKey: Uint8Array): string {
  const failed = new Error("could not decrypt the message");
  if (payload.length < 132 || payload.length > 87_472 || payload.startsWith("#")) throw failed;
  let data: Uint8Array;
  try {
    data = base64.decode(payload);
  } catch {
    throw failed;
  }
  if (data.length < 99 || data.length > 65_603 || data[0] !== 2) throw failed;
  const nonce = data.subarray(1, 33);
  const ciphertext = data.subarray(33, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const { chachaKey, chachaNonce, hmacKey } = nip44MessageKeys(conversationKey, nonce);
  if (!equalBytes(macOf(hmacKey, nonce, ciphertext), mac)) throw failed;
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  const length = new DataView(padded.buffer, padded.byteOffset).getUint16(0);
  if (length < 1 || padded.length !== 2 + nip44PaddedLength(length)) throw failed;
  try {
    return decoder.decode(padded.subarray(2, 2 + length));
  } catch {
    throw failed;
  }
}

/** Run an approved request with the wallet's Nostr private key. */
export async function runCipher(request: CipherRequest, privateKey: Uint8Array): Promise<string> {
  if (cipherScheme(request.method) === "nip04")
    return isEncrypt(request)
      ? nip04Encrypt(privateKey, request.pubkey, request.plaintext)
      : nip04Decrypt(privateKey, request.pubkey, request.ciphertext);
  const key = nip44ConversationKey(privateKey, request.pubkey);
  return isEncrypt(request)
    ? nip44Encrypt(request.plaintext, key)
    : nip44Decrypt(request.ciphertext, key);
}
