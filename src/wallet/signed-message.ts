import { decodeBase58Address, decodeCashAddress } from "@bitauth/libauth";
import { keyHashFromPublicKey } from "@cashlet-labs/bnd";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";

/**
 * Bitcoin Signed Message: the signature that proves a key owns an address
 * without spending from it. The signed hash is double SHA-256 of the
 * length-prefixed text "Bitcoin Signed Message:\n" and the message. The
 * signature is 65 bytes (a header byte, then r and s) in base64; the header
 * carries the recovery id, so a verifier needs only the address.
 *
 * Only the wallet's own screens use this. Web pages cannot ask for it.
 */

export const MAX_MESSAGE_CHARS = 64 * 1024;
const PREFIX = utf8ToBytes("Bitcoin Signed Message:\n");

function varint(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

/** The 32-byte hash that is signed for a message. */
export function signedMessageHash(message: string): Uint8Array {
  const body = utf8ToBytes(message);
  return sha256(sha256(concatBytes(varint(PREFIX.length), PREFIX, varint(body.length), body)));
}

/** Sign with the private key of a P2PKH address (compressed public key). Returns base64. */
export function signMessage(privateKey: Uint8Array, message: string): string {
  if (message.length === 0 || message.length > MAX_MESSAGE_CHARS)
    throw new TypeError("the message must be 1 to 65536 characters");
  // noble returns the recovery id first, then r and s.
  const recovered = secp256k1.sign(signedMessageHash(message), privateKey, {
    prehash: false,
    format: "recovered",
  });
  // 27 is the base header; 4 more says the address uses the compressed public key.
  const header = 27 + 4 + (recovered[0] as number);
  return base64.encode(concatBytes(Uint8Array.of(header), recovered.subarray(1)));
}

/** The 20-byte key hash a P2PKH address (cashaddr or legacy) names. */
export function keyHashOfAddress(input: string): Uint8Array {
  const text = input.trim();
  const legacy = decodeBase58Address(text);
  if (typeof legacy !== "string") {
    // Version 0 is mainnet and 111 is the test network.
    if ((legacy.version === 0 || legacy.version === 111) && legacy.payload.length === 20)
      return legacy.payload;
    throw new TypeError("only addresses that start with q, p2pkh or 1 can sign messages");
  }
  const lower = text.toLowerCase();
  if (text !== lower && text !== text.toUpperCase())
    throw new TypeError("an address must be all lowercase or all uppercase");
  for (const candidate of lower.includes(":")
    ? [lower]
    : [`bitcoincash:${lower}`, `bchtest:${lower}`]) {
    const decoded = decodeCashAddress(candidate);
    if (typeof decoded === "string") continue;
    if (decoded.type === "p2pkh" || decoded.type === "p2pkhWithTokens") return decoded.payload;
    throw new TypeError("only a single-key (p2pkh) address can sign messages");
  }
  throw new TypeError("not a valid Bitcoin Cash address");
}

/**
 * True when `signature` is a valid signature of `message` by the key behind
 * `address`. Throws a TypeError for an address that cannot sign; a malformed
 * or wrong signature is `false`.
 */
export function verifyMessage(address: string, message: string, signature: string): boolean {
  const keyHash = keyHashOfAddress(address);
  if (message.length > MAX_MESSAGE_CHARS) return false;
  try {
    const bytes = base64.decode(signature.trim());
    const header = bytes[0] as number;
    if (bytes.length !== 65 || header < 27 || header > 34) return false;
    const compressed = header >= 31;
    const recovery = (header - 27) & 3;
    const publicKey = secp256k1.Signature.fromBytes(bytes.subarray(1), "compact")
      .addRecoveryBit(recovery)
      .recoverPublicKey(signedMessageHash(message))
      .toBytes(compressed);
    const found = keyHashFromPublicKey(publicKey);
    return found.length === keyHash.length && found.every((b, i) => b === keyHash[i]);
  } catch {
    return false;
  }
}
