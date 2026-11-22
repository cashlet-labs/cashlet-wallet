import {
  binToHex,
  decodeTransaction,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import { addressPrefix, type BchNetwork } from "@cashlet-labs/bnd";
import { scripthashOf } from "./indexer";

/**
 * What a transaction means for this wallet: did it receive, send or move coins
 * between its own addresses, how much changed, and what the fee was.
 *
 * Servers are not trusted: a transaction is used only if it hashes to the txid
 * that was asked for, and an input's source output is used only if its parent
 * transaction does the same.
 */

/** Where raw transactions come from (an ElectrumPool in the extension). */
export interface TxSource {
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export type Direction = "received" | "sent" | "self";

export interface TokenChange {
  category: string;
  /** Change in the fungible amount; negative when the wallet gave tokens away. */
  amount: bigint;
  /** Change in the number of NFTs the wallet holds. */
  nfts: number;
}

export interface Counterparty {
  /** Null for a script with no address, such as a data output. */
  address: string | null;
  value: number;
}

export interface TxAnalysis {
  txid: string;
  direction: Direction;
  /** Satoshis the wallet gained (positive) or lost (negative), fee included. */
  net: number;
  /** Inputs minus outputs; null when a source output is unknown or for a coinbase. */
  fee: number | null;
  /** Bytes. */
  size: number;
  tokens: TokenChange[];
  /** Outputs that are not the wallet's: where a send went. */
  counterparties: Counterparty[];
  /** The wallet's own addresses that were paid. */
  receivedOn: string[];
  /** False when some source outputs could not be fetched, so the totals may be short. */
  complete: boolean;
}

const MAX_RAW_HEX = 2_100_000;
/** Source transactions fetched for one detail; inputs beyond this are left unknown. */
const MAX_PARENTS = 64;
const FETCH_BATCH = 8;
const CACHE_SIZE = 500;
const NO_OUTPOINT = "00".repeat(32);

/** `blockchain.transaction.get` without verbose: the raw transaction as hex. */
async function fetchRaw(source: TxSource, txid: string): Promise<Uint8Array> {
  const hex = await source.request<unknown>("blockchain.transaction.get", [txid]);
  if (typeof hex !== "string" || hex.length > MAX_RAW_HEX || !/^([0-9a-f]{2})+$/.test(hex))
    throw new Error("the server sent a malformed transaction");
  const raw = hexToBin(hex);
  if (hashTransaction(raw) !== txid) throw new Error("the server sent a different transaction");
  return raw;
}

function decode(raw: Uint8Array): Transaction {
  const decoded = decodeTransaction(raw);
  if (typeof decoded === "string") throw new Error("the server sent a malformed transaction");
  return decoded;
}

function addressOf(output: Output, network: BchNetwork): string | null {
  const encoded = lockingBytecodeToCashAddress({
    bytecode: output.lockingBytecode,
    prefix: addressPrefix(network),
    tokenSupport: output.token !== undefined,
  });
  return typeof encoded === "string" ? null : encoded.address;
}

/**
 * Work out what a decoded transaction means for the wallet. `prevouts` holds the
 * output each input spends, or null where it is unknown; `isOurs` says whether a
 * locking script belongs to one of the wallet's addresses.
 */
export function analyseTransaction(
  txid: string,
  size: number,
  transaction: Transaction,
  prevouts: readonly (Output | null)[],
  isOurs: (lockingBytecode: Uint8Array) => boolean,
  network: BchNetwork,
): TxAnalysis {
  const coinbase =
    transaction.inputs.length === 1 &&
    binToHex(transaction.inputs[0]!.outpointTransactionHash) === NO_OUTPOINT;
  const known = prevouts.filter((p): p is Output => p !== null);
  const complete = coinbase || known.length === transaction.inputs.length;

  let ownIn = 0;
  let ownOut = 0;
  let totalIn = 0;
  let totalOut = 0;
  const tokens = new Map<string, TokenChange>();
  const change = (category: string) => {
    const entry = tokens.get(category) ?? { category, amount: 0n, nfts: 0 };
    tokens.set(category, entry);
    return entry;
  };
  let ownInputs = 0;
  for (const prevout of known) {
    totalIn += Number(prevout.valueSatoshis);
    if (!isOurs(prevout.lockingBytecode)) continue;
    ownInputs += 1;
    ownIn += Number(prevout.valueSatoshis);
    if (prevout.token) {
      const entry = change(binToHex(prevout.token.category));
      entry.amount -= prevout.token.amount;
      if (prevout.token.nft) entry.nfts -= 1;
    }
  }

  const counterparties: Counterparty[] = [];
  const receivedOn: string[] = [];
  for (const output of transaction.outputs) {
    const value = Number(output.valueSatoshis);
    totalOut += value;
    if (isOurs(output.lockingBytecode)) {
      ownOut += value;
      const address = addressOf(output, network);
      if (address && !receivedOn.includes(address)) receivedOn.push(address);
      if (output.token) {
        const entry = change(binToHex(output.token.category));
        entry.amount += output.token.amount;
        if (output.token.nft) entry.nfts += 1;
      }
    } else if (value > 0 || output.token) {
      counterparties.push({ address: addressOf(output, network), value });
    }
  }

  let direction: Direction = "received";
  if (ownInputs > 0) direction = counterparties.length === 0 ? "self" : "sent";
  return {
    txid,
    direction,
    net: ownOut - ownIn,
    fee: complete && !coinbase ? totalIn - totalOut : null,
    size,
    tokens: [...tokens.values()].filter((t) => t.amount !== 0n || t.nfts !== 0),
    counterparties,
    receivedOn,
    complete,
  };
}

/**
 * Fetches and analyses transactions for one wallet. A transaction never changes
 * once it has its txid, so a finished analysis is kept in memory until the
 * wallet locks. Incomplete ones are not kept, so they are tried again.
 */
export class TxDetails {
  private readonly cache = new Map<string, TxAnalysis>();
  private readonly running = new Map<string, Promise<TxAnalysis>>();

  /** `ownsScripthash` says whether an Electrum scripthash is one of the wallet's addresses. */
  constructor(
    private readonly source: TxSource,
    private readonly network: BchNetwork,
    private readonly ownsScripthash: (scripthash: string) => boolean,
  ) {}

  get(txid: string): Promise<TxAnalysis> {
    const cached = this.cache.get(txid);
    if (cached) return Promise.resolve(cached);
    const running = this.running.get(txid);
    if (running) return running;
    const job = this.load(txid).finally(() => this.running.delete(txid));
    this.running.set(txid, job);
    return job;
  }

  private async load(txid: string): Promise<TxAnalysis> {
    const raw = await fetchRaw(this.source, txid);
    const transaction = decode(raw);
    const prevouts = await this.prevouts(transaction);
    const analysis = analyseTransaction(
      txid,
      raw.length,
      transaction,
      prevouts,
      (bytecode) => this.ownsScripthash(scripthashOf(bytecode)),
      this.network,
    );
    if (analysis.complete) {
      if (this.cache.size >= CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(txid, analysis);
    }
    return analysis;
  }

  /** The output each input spends. One that cannot be fetched or checked stays null. */
  private async prevouts(transaction: Transaction): Promise<(Output | null)[]> {
    const parents = new Map<string, Transaction | null>();
    for (const input of transaction.inputs) {
      const parent = binToHex(input.outpointTransactionHash);
      if (parent !== NO_OUTPOINT && parents.size < MAX_PARENTS) parents.set(parent, null);
    }
    const ids = [...parents.keys()];
    for (let i = 0; i < ids.length; i += FETCH_BATCH) {
      await Promise.all(
        ids.slice(i, i + FETCH_BATCH).map(async (id) => {
          try {
            parents.set(id, decode(await fetchRaw(this.source, id)));
          } catch {
            parents.set(id, null);
          }
        }),
      );
    }
    return transaction.inputs.map(
      (input) =>
        parents.get(binToHex(input.outpointTransactionHash))?.outputs[input.outpointIndex] ?? null,
    );
  }
}
