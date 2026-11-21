import type { Chain } from "./hd";

/** A CashToken carried by an output: fungible amount, NFT, or both. */
export interface TokenData {
  /** Token category ID, 32 bytes hex, in display order. */
  category: string;
  /** Fungible amount; up to 2^63 - 1, so kept as a bigint. */
  amount: bigint;
  nft: { capability: "none" | "mutable" | "minting"; commitment: string } | null;
}

/** An unspent output owned by one of the wallet's addresses. */
export interface Utxo {
  txid: string;
  vout: number;
  /** Satoshis. Always below 2^53, so a number is exact. */
  value: number;
  /** Block height, or 0 while unconfirmed. */
  height: number;
  scripthash: string;
  token: TokenData | null;
}

export interface HistoryEntry {
  txid: string;
  /** Block height; 0 in the mempool, -1 in the mempool with an unconfirmed parent. */
  height: number;
  scripthash: string;
}

/** One derived address and the last status its server reported. */
export interface AddressRecord {
  scripthash: string;
  chain: Chain;
  index: number;
  /** Electrum status hash; null when the address has no history. */
  status: string | null;
}

export interface Balance {
  confirmed: number;
  unconfirmed: number;
  /** Fungible amounts and NFTs per token category. */
  tokens: Map<string, { amount: bigint; nfts: { capability: string; commitment: string }[] }>;
}
