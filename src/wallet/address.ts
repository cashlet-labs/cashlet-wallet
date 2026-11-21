import { addressPrefix, type BchNetwork } from "@cashlet-labs/bnd";
import { cashAddressToLockingBytecode, decodeCashAddress } from "@bitauth/libauth";
import { parseBch } from "./amount";

export interface Destination {
  /** The address as given, with its network prefix. */
  address: string;
  lockingBytecode: Uint8Array;
  /** A token-aware (z… or r…) address, which can receive CashTokens. */
  tokenAware: boolean;
  type: "p2pkh" | "p2sh";
}

/**
 * Check an address for the wallet's network and turn it into a locking script.
 * A missing prefix is added for the wallet's network; a prefix for the other
 * network is refused, so chipnet coins are never "sent" to a mainnet address.
 */
export function parseDestination(input: string, network: BchNetwork): Destination {
  const trimmed = input.trim();
  const prefix = addressPrefix(network);
  const lower = trimmed.toLowerCase();
  if (trimmed !== lower && trimmed !== trimmed.toUpperCase()) {
    throw new TypeError("an address must be all lowercase or all uppercase");
  }
  const address = lower.includes(":") ? lower : `${prefix}:${lower}`;
  const [given] = address.split(":");
  if (given !== prefix) {
    throw new TypeError(
      given === "bitcoincash" || given === "bchtest"
        ? `that is a ${given === "bitcoincash" ? "mainnet" : "test network"} address; this wallet is on ${network}`
        : "not a Bitcoin Cash address",
    );
  }
  const decoded = decodeCashAddress(address);
  if (typeof decoded === "string") throw new TypeError("not a valid Bitcoin Cash address");
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === "string") throw new TypeError("not a valid Bitcoin Cash address");
  const type = decoded.type === "p2pkh" || decoded.type === "p2pkhWithTokens" ? "p2pkh" : "p2sh";
  return {
    address,
    lockingBytecode: locking.bytecode,
    tokenAware: decoded.type === "p2pkhWithTokens" || decoded.type === "p2shWithTokens",
    type,
  };
}

export interface PaymentRequest {
  destination: Destination;
  /** Satoshis, when the request names an amount. */
  amount: number | null;
  label: string | null;
  message: string | null;
}

/**
 * Parse a BIP21 payment URI ("bitcoincash:q…?amount=0.01&label=…") or a bare
 * address. Unknown `req-` parameters make the request unpayable (BIP21), so they
 * are refused instead of ignored.
 */
export function parsePaymentRequest(input: string, network: BchNetwork): PaymentRequest {
  const trimmed = input.trim();
  const queryAt = trimmed.indexOf("?");
  const target = queryAt === -1 ? trimmed : trimmed.slice(0, queryAt);
  const query = queryAt === -1 ? "" : trimmed.slice(queryAt + 1);
  const params = new URLSearchParams(query);
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) throw new TypeError(`the payment request repeats "${key}"`);
    seen.add(key);
    if (key.startsWith("req-"))
      throw new TypeError(`this payment request needs a feature this wallet lacks (${key})`);
  }
  const amountText = params.get("amount");
  return {
    destination: parseDestination(target, network),
    amount: amountText === null ? null : parseBch(amountText),
    label: params.get("label"),
    message: params.get("message"),
  };
}
