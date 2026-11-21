import type { BchNetwork } from "@cashlet-labs/bnd";
import type { Chain, HdWallet } from "./hd";
import {
  headerTimestamp,
  p2pkhLockingBytecode,
  parseHistory,
  parseUtxos,
  scripthashOf,
} from "./indexer";
import type { WalletStore } from "./store";
import type { AddressRecord, Balance, HistoryEntry, Utxo } from "./types";

/** The part of ElectrumPool the scanner uses, so tests can supply a fake. */
export interface IndexerSource {
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  subscribe(scripthash: string): Promise<string | null>;
  onStatus(listener: (scripthash: string, status: string | null) => void): () => void;
}

export interface ScanOptions {
  /** Unused addresses in a row before a chain is considered finished (BIP44 uses 20). */
  gapLimit?: number;
}

export interface TimedHistoryEntry extends HistoryEntry {
  /** Unix seconds of the block, or null while unconfirmed. */
  time: number | null;
}

/**
 * Finds and follows the wallet's addresses.
 *
 * `scan` walks both chains until `gapLimit` unused addresses in a row, subscribing
 * to each address so the server reports any change. Whenever an address's status
 * changes, its outputs and history are fetched again and replace what was stored.
 */
export class Scanner {
  private readonly gapLimit: number;
  private readonly byScripthash = new Map<string, AddressRecord>();
  private stopListening: (() => void) | null = null;
  private readonly refreshing = new Map<string, Promise<void>>();

  /** Called after an address's data was refreshed because its status changed. */
  onChange: ((address: AddressRecord) => void) | null = null;

  constructor(
    private readonly wallet: HdWallet,
    private readonly network: BchNetwork,
    private readonly source: IndexerSource,
    private readonly store: WalletStore,
    options: ScanOptions = {},
  ) {
    this.gapLimit = options.gapLimit ?? 20;
    if (!Number.isInteger(this.gapLimit) || this.gapLimit < 1 || this.gapLimit > 100) {
      throw new RangeError("gap limit must be between 1 and 100");
    }
  }

  scripthash(chain: Chain, index: number): string {
    return scripthashOf(p2pkhLockingBytecode(this.wallet.addressKey(chain, index).keyHash));
  }

  /** Scan both chains. Safe to call again; known addresses are re-subscribed. */
  async scan(): Promise<{ used: number; watched: number }> {
    for (const stored of await this.store.addresses())
      this.byScripthash.set(stored.scripthash, stored);
    this.stopListening ??= this.source.onStatus((scripthash, status) => {
      void this.statusChanged(scripthash, status);
    });
    let used = 0;
    for (const chain of [0, 1] as const) used += await this.scanChain(chain);
    return { used, watched: this.byScripthash.size };
  }

  stop(): void {
    this.stopListening?.();
    this.stopListening = null;
  }

  /** The address record for a scripthash this scanner watches. */
  addressFor(scripthash: string): AddressRecord | undefined {
    return this.byScripthash.get(scripthash);
  }

  /** The first receive address after the last used one, for showing to the user. */
  async nextAddress(chain: Chain, tokenAware = false): Promise<{ index: number; address: string }> {
    const used = [...this.byScripthash.values()].filter(
      (a) => a.chain === chain && a.status !== null,
    );
    const index = used.length > 0 ? Math.max(...used.map((a) => a.index)) + 1 : 0;
    return { index, address: this.wallet.address(chain, index, this.network, tokenAware) };
  }

  async balance(): Promise<Balance> {
    return balanceOf(await this.store.utxos());
  }

  /** History, newest first, with block times. Times are cached per block height. */
  async history(): Promise<TimedHistoryEntry[]> {
    const entries = new Map<string, HistoryEntry>();
    for (const entry of await this.store.history()) {
      // A transaction touching several of our addresses is one entry.
      const known = entries.get(entry.txid);
      if (!known || (known.height <= 0 && entry.height > 0)) entries.set(entry.txid, entry);
    }
    const timed: TimedHistoryEntry[] = [];
    for (const entry of entries.values()) {
      timed.push({ ...entry, time: entry.height > 0 ? await this.blockTime(entry.height) : null });
    }
    const order = (h: number) => (h <= 0 ? Number.MAX_SAFE_INTEGER : h);
    return timed.sort((a, b) => order(b.height) - order(a.height) || a.txid.localeCompare(b.txid));
  }

  private async blockTime(height: number): Promise<number | null> {
    const cached = await this.store.blockTime(height);
    if (cached !== null) return cached;
    try {
      const time = headerTimestamp(
        await this.source.request<string>("blockchain.block.header", [height]),
      );
      await this.store.putBlockTime(height, time);
      return time;
    } catch {
      return null;
    }
  }

  private async scanChain(chain: Chain): Promise<number> {
    let used = 0;
    let gap = 0;
    let index = 0;
    while (gap < this.gapLimit) {
      // Subscribe a window at a time: one round trip per window instead of per address.
      const window = Array.from({ length: this.gapLimit - gap }, (_, i) => index + i);
      const statuses = await Promise.all(window.map((i) => this.watch(chain, i)));
      for (const status of statuses) {
        if (status !== null) {
          used += 1;
          gap = 0;
        } else {
          gap += 1;
        }
      }
      index += window.length;
    }
    return used;
  }

  private async watch(chain: Chain, index: number): Promise<string | null> {
    const scripthash = this.scripthash(chain, index);
    const previous = this.byScripthash.get(scripthash);
    const status = await this.source.subscribe(scripthash);
    const address: AddressRecord = { scripthash, chain, index, status };
    this.byScripthash.set(scripthash, address);
    await this.store.putAddress(address);
    if (status !== null && status !== previous?.status) await this.refresh(scripthash);
    if (status === null && previous?.status)
      await this.store.replaceAddressData(scripthash, [], []);
    return status;
  }

  private async statusChanged(scripthash: string, status: string | null): Promise<void> {
    const known = this.byScripthash.get(scripthash);
    if (!known) return;
    const address = { ...known, status };
    this.byScripthash.set(scripthash, address);
    await this.store.putAddress(address);
    await this.refresh(scripthash);
    this.onChange?.(address);
    // A change near the end of a chain may mean addresses past the gap are now in use.
    if (status !== null) await this.extendIfNeeded(address.chain);
  }

  private async extendIfNeeded(chain: Chain): Promise<void> {
    const onChain = [...this.byScripthash.values()].filter((a) => a.chain === chain);
    const lastUsed = Math.max(-1, ...onChain.filter((a) => a.status !== null).map((a) => a.index));
    const highest = Math.max(-1, ...onChain.map((a) => a.index));
    for (let index = highest + 1; index <= lastUsed + this.gapLimit; index++)
      await this.watch(chain, index);
  }

  /** Fetch an address's outputs and history again. Concurrent calls share one fetch. */
  private refresh(scripthash: string): Promise<void> {
    const running = this.refreshing.get(scripthash);
    if (running) return running;
    const job = (async () => {
      const [utxos, history] = await Promise.all([
        this.source.request("blockchain.scripthash.listunspent", [scripthash, "include_tokens"]),
        this.source.request("blockchain.scripthash.get_history", [scripthash]),
      ]);
      await this.store.replaceAddressData(
        scripthash,
        parseUtxos(utxos, scripthash),
        parseHistory(history, scripthash),
      );
    })().finally(() => this.refreshing.delete(scripthash));
    this.refreshing.set(scripthash, job);
    return job;
  }
}

/** Sum outputs into BCH (confirmed and unconfirmed) and token holdings. */
export function balanceOf(utxos: readonly Utxo[]): Balance {
  const balance: Balance = { confirmed: 0, unconfirmed: 0, tokens: new Map() };
  for (const utxo of utxos) {
    if (utxo.height > 0) balance.confirmed += utxo.value;
    else balance.unconfirmed += utxo.value;
    if (!utxo.token) continue;
    const entry = balance.tokens.get(utxo.token.category) ?? { amount: 0n, nfts: [] };
    entry.amount += utxo.token.amount;
    if (utxo.token.nft) entry.nfts.push({ ...utxo.token.nft });
    balance.tokens.set(utxo.token.category, entry);
  }
  return balance;
}
