import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { HistoryEntry, TokenData, Utxo } from "./types";

/**
 * Turning Electrum answers into wallet data. Servers are not trusted to send
 * well-formed data, so everything is checked here; a malformed entry fails the
 * whole answer rather than being half-read.
 */

const HEX32 = /^[0-9a-f]{64}$/;
const MAX_TOKEN_AMOUNT = 2n ** 63n - 1n;
const MAX_SATS = 21_000_000 * 100_000_000;

/** OP_DUP OP_HASH160 <keyHash> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkhLockingBytecode(keyHash: Uint8Array): Uint8Array {
  if (keyHash.length !== 20) throw new TypeError("expected a 20-byte key hash");
  return Uint8Array.of(0x76, 0xa9, 0x14, ...keyHash, 0x88, 0xac);
}

/** Electrum's address key: SHA-256 of the locking script, byte-reversed, in hex. */
export function scripthashOf(lockingBytecode: Uint8Array): string {
  return bytesToHex(sha256(lockingBytecode).reverse());
}

export class MalformedAnswerError extends Error {
  constructor(what: string) {
    super(`the server sent malformed ${what}`);
    this.name = "MalformedAnswerError";
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MalformedAnswerError(what);
  return value as Record<string, unknown>;
}

function height(value: unknown, what: string): number {
  if (!Number.isInteger(value) || (value as number) < -1) throw new MalformedAnswerError(what);
  return value as number;
}

function token(value: unknown): TokenData | null {
  if (value === undefined || value === null) return null;
  const t = record(value, "token data");
  if (typeof t.category !== "string" || !HEX32.test(t.category))
    throw new MalformedAnswerError("token data");
  let amount = 0n;
  if (t.amount !== undefined) {
    if (typeof t.amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(t.amount))
      throw new MalformedAnswerError("token data");
    amount = BigInt(t.amount);
    if (amount > MAX_TOKEN_AMOUNT) throw new MalformedAnswerError("token data");
  }
  let nft: TokenData["nft"] = null;
  if (t.nft !== undefined && t.nft !== null) {
    const n = record(t.nft, "token data");
    const capability = n.capability ?? "none";
    const commitment = n.commitment ?? "";
    if (
      (capability !== "none" && capability !== "mutable" && capability !== "minting") ||
      typeof commitment !== "string" ||
      !/^([0-9a-f]{2}){0,128}$/.test(commitment)
    ) {
      throw new MalformedAnswerError("token data");
    }
    nft = { capability, commitment };
  }
  if (amount === 0n && nft === null) throw new MalformedAnswerError("token data");
  return { category: t.category, amount, nft };
}

/** `blockchain.scripthash.listunspent` with `include_tokens`. */
export function parseUtxos(value: unknown, scripthash: string): Utxo[] {
  if (!Array.isArray(value)) throw new MalformedAnswerError("unspent outputs");
  return value.map((item) => {
    const u = record(item, "unspent outputs");
    if (typeof u.tx_hash !== "string" || !HEX32.test(u.tx_hash))
      throw new MalformedAnswerError("unspent outputs");
    if (!Number.isInteger(u.tx_pos) || (u.tx_pos as number) < 0)
      throw new MalformedAnswerError("unspent outputs");
    if (!Number.isInteger(u.value) || (u.value as number) < 0 || (u.value as number) > MAX_SATS) {
      throw new MalformedAnswerError("unspent outputs");
    }
    return {
      txid: u.tx_hash,
      vout: u.tx_pos as number,
      value: u.value as number,
      height: Math.max(0, height(u.height, "unspent outputs")),
      scripthash,
      token: token(u.token_data),
    };
  });
}

/** `blockchain.scripthash.get_history`. */
export function parseHistory(value: unknown, scripthash: string): HistoryEntry[] {
  if (!Array.isArray(value)) throw new MalformedAnswerError("history");
  return value.map((item) => {
    const h = record(item, "history");
    if (typeof h.tx_hash !== "string" || !HEX32.test(h.tx_hash))
      throw new MalformedAnswerError("history");
    return { txid: h.tx_hash, height: height(h.height, "history"), scripthash };
  });
}

/** Unix time of a block, from its 80-byte header (bytes 68-71, little-endian). */
export function headerTimestamp(headerHex: string): number {
  if (typeof headerHex !== "string" || !/^[0-9a-f]{160}$/.test(headerHex)) {
    throw new MalformedAnswerError("block header");
  }
  const bytes = hexToBytes(headerHex);
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(68, true);
}
