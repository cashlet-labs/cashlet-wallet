import type { BchNetwork } from "@cashlet-labs/bnd";

/** A block explorer page for a transaction, on the wallet's network. */
export function explorerTxUrl(network: BchNetwork, txid: string): string {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new TypeError("invalid transaction id");
  return network === "mainnet"
    ? `https://explorer.bch.ninja/tx/${txid}`
    : `https://chipnet.imaginary.cash/tx/${txid}`;
}
