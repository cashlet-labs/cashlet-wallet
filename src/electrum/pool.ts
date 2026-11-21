import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ElectrumClient, type WebSocketFactory } from "./client";
import {
  ElectrumTransportError,
  ElectrumUnusableError,
  isAlreadyKnown,
  isServerFault,
} from "./errors";
import { ELECTRUM_TIMING, type Checkpoint, type ElectrumTiming } from "./servers";

export interface PoolOptions {
  servers: readonly string[];
  checkpoint: Checkpoint;
  createSocket: WebSocketFactory;
  timing?: Partial<ElectrumTiming>;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}

export interface ServerHealth {
  url: string;
  /** `ok` after a good connection, `cooling` while set aside after a fault. */
  state: "unknown" | "ok" | "cooling";
  failures: number;
  coolingUntil: number | null;
  lastError: string | null;
  tip: number | null;
}

interface HealthRecord {
  failures: number;
  coolingUntil: number;
  lastError: string | null;
  ok: boolean;
  tip: { height: number; at: number } | null;
}

type StatusListener = (scripthash: string, status: string | null) => void;
type TipListener = (height: number) => void;

function blockHash(headerHex: string): string {
  const header = hexToBytes(headerHex);
  if (header.length !== 80) throw new TypeError("a block header is 80 bytes");
  return bytesToHex(sha256(sha256(header)).reverse());
}

function tipHeight(value: unknown): number {
  if (
    typeof value === "object" &&
    value !== null &&
    Number.isInteger((value as { height?: unknown }).height)
  ) {
    return (value as { height: number }).height;
  }
  throw new TypeError("malformed header notification");
}

/**
 * Electrum servers for one network, with failover. Every request goes through
 * here, so every call gets the same rules:
 *
 * - a new connection must be on the right chain (checkpoint header) and within
 *   `maxTipLag` blocks of the best tip seen from other servers;
 * - a server fault (see errors.ts) sets the server aside with a growing wait,
 *   and the request is retried on the next server;
 * - an error about the request itself is returned as it is;
 * - address subscriptions are replayed on every new connection, and addresses
 *   whose status changed meanwhile are reported so they are rescanned.
 */
export class ElectrumPool {
  private client: ElectrumClient | null = null;
  private connecting: Promise<ElectrumClient> | null = null;
  private readonly records = new Map<string, HealthRecord>();
  private readonly subscriptions = new Map<string, string | null>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly tipListeners = new Set<TipListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly timing: ElectrumTiming;
  private readonly now: () => number;

  constructor(private readonly options: PoolOptions) {
    if (options.servers.length === 0) throw new TypeError("no Electrum servers configured");
    this.timing = { ...ELECTRUM_TIMING, ...options.timing };
    this.now = options.now ?? Date.now;
    for (const url of options.servers) {
      this.records.set(url, {
        failures: 0,
        coolingUntil: 0,
        lastError: null,
        ok: false,
        tip: null,
      });
    }
  }

  /** The best chain height known, from the current server and recent peer checks. */
  get bestTip(): number | null {
    const heights = [...this.records.values()].flatMap((r) => (r.tip ? [r.tip.height] : []));
    return heights.length > 0 ? Math.max(...heights) : null;
  }

  get currentServer(): string | null {
    return this.client?.isOpen ? this.client.url : null;
  }

  health(): ServerHealth[] {
    const now = this.now();
    return this.options.servers.map((url) => {
      const r = this.record(url);
      const cooling = r.coolingUntil > now;
      return {
        url,
        state: cooling ? "cooling" : r.ok ? "ok" : "unknown",
        failures: r.failures,
        coolingUntil: cooling ? r.coolingUntil : null,
        lastError: r.lastError,
        tip: r.tip?.height ?? null,
      };
    });
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onTip(listener: TipListener): () => void {
    this.tipListeners.add(listener);
    return () => this.tipListeners.delete(listener);
  }

  /** A read-only request, retried on other servers after a server fault. */
  request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    return this.withFailover((client) => client.request<T>(method, params));
  }

  /** Subscribe to an address's status (scripthash). Kept across server switches. */
  async subscribe(scripthash: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(scripthash))
      throw new TypeError("expected a 32-byte scripthash in hex");
    const status = await this.withFailover((client) =>
      client.request<string | null>("blockchain.scripthash.subscribe", [scripthash]),
    );
    // Registered only after the first answer, so a reconnect during that first
    // call is not reported as a change.
    this.subscriptions.set(scripthash, status ?? null);
    return status ?? null;
  }

  /**
   * Broadcast a signed transaction. The server must return the txid the wallet
   * computed. A rebroadcast of the same transaction is harmless, so server faults
   * are retried elsewhere; a rejection by the network is final.
   */
  broadcast(transactionHex: string, expectedTxid: string): Promise<string> {
    if (!/^([0-9a-f]{2})+$/.test(transactionHex))
      throw new TypeError("expected a transaction in hex");
    if (!/^[0-9a-f]{64}$/.test(expectedTxid)) throw new TypeError("expected a txid in hex");
    return this.withFailover(async (client) => {
      let txid: unknown;
      try {
        txid = await client.request<unknown>("blockchain.transaction.broadcast", [transactionHex]);
      } catch (error) {
        if (isAlreadyKnown(error)) return expectedTxid;
        throw error;
      }
      if (txid !== expectedTxid) {
        throw new ElectrumUnusableError(`${client.url} returned a different txid`, client.url);
      }
      return expectedTxid;
    });
  }

  /**
   * Re-check the current server against its peers, for a periodic alarm. A server
   * that fell behind is set aside and the next request moves to another one.
   */
  async checkFreshness(): Promise<void> {
    const client = this.client;
    if (!client?.isOpen) return;
    const own = this.record(client.url).tip?.height;
    if (own === undefined) return;
    await this.refreshPeerTips(client.url, true);
    const best = this.bestTip;
    if (best !== null && own < best - this.timing.maxTipLag) {
      this.fault(
        client.url,
        new ElectrumUnusableError(`${client.url} is ${best - own} blocks behind`, client.url),
      );
      this.dropClient();
      this.keepAlive();
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropClient();
  }

  // ---------------------------------------------------------------------------

  private record(url: string): HealthRecord {
    const record = this.records.get(url);
    if (!record) throw new Error(`unknown server ${url}`);
    return record;
  }

  private fault(url: string, error: unknown): void {
    const r = this.record(url);
    r.failures += 1;
    r.ok = false;
    r.lastError = error instanceof Error ? error.message : String(error);
    const wait = Math.min(
      this.timing.cooldownBaseMs * 2 ** (r.failures - 1),
      this.timing.cooldownMaxMs,
    );
    r.coolingUntil = this.now() + wait;
  }

  private async withFailover<T>(run: (client: ElectrumClient) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    let lastError: unknown = null;
    while (tried.size < this.options.servers.length) {
      let client: ElectrumClient;
      try {
        client = await this.ensureClient(tried);
      } catch (error) {
        throw lastError ?? error;
      }
      try {
        return await run(client);
      } catch (error) {
        if (!isServerFault(error)) throw error;
        lastError = error;
        tried.add(client.url);
        this.fault(client.url, error);
        if (this.client === client) this.dropClient();
      }
    }
    throw lastError ?? new ElectrumTransportError("no Electrum server answered", "");
  }

  private async ensureClient(exclude: ReadonlySet<string> = new Set()): Promise<ElectrumClient> {
    if (this.closed) throw new ElectrumTransportError("the Electrum pool is closed", "");
    if (this.client?.isOpen && !exclude.has(this.client.url)) return this.client;
    if (this.connecting) {
      const client = await this.connecting.catch(() => null);
      if (client?.isOpen && !exclude.has(client.url)) return client;
    }
    this.connecting = this.connectNext(exclude);
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connectNext(exclude: ReadonlySet<string>): Promise<ElectrumClient> {
    this.dropClient();
    const now = this.now();
    const candidates = this.options.servers.filter(
      (url) => !exclude.has(url) && this.record(url).coolingUntil <= now,
    );
    const reasons: string[] = [];
    for (const url of candidates) {
      const client = this.newClient(url);
      try {
        await client.connect();
        await this.checkChain(client);
        const height = tipHeight(await client.request("blockchain.headers.subscribe", []));
        this.record(url).tip = { height, at: this.now() };
        await this.refreshPeerTips(url, false);
        const best = this.bestTip ?? height;
        if (height < best - this.timing.maxTipLag) {
          throw new ElectrumUnusableError(`${url} is ${best - height} blocks behind`, url);
        }
        // Handlers first, so nothing that arrives during the replay is lost.
        client.onNotification = (method, params) => this.notify(client, method, params);
        client.onClose = (error) => this.lost(client, error);
        this.client = client;
        await this.replay(client);
        const r = this.record(url);
        r.failures = 0;
        r.coolingUntil = 0;
        r.ok = true;
        r.lastError = null;
        return client;
      } catch (error) {
        client.onClose = null;
        client.close();
        if (this.client === client) this.client = null;
        this.fault(url, error);
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    this.scheduleReconnect();
    throw new ElectrumTransportError(
      reasons.length > 0
        ? `no usable Electrum server: ${reasons.join("; ")}`
        : "every Electrum server is set aside after recent faults; try again shortly",
      "",
    );
  }

  private newClient(url: string): ElectrumClient {
    return new ElectrumClient(url, this.options.createSocket, {
      connectTimeoutMs: this.timing.connectTimeoutMs,
      requestTimeoutMs: this.timing.requestTimeoutMs,
    });
  }

  private async checkChain(client: ElectrumClient): Promise<void> {
    const { height, hash } = this.options.checkpoint;
    const header = await client.request<unknown>("blockchain.block.header", [height]);
    if (typeof header !== "string" || blockHash(header) !== hash) {
      throw new ElectrumUnusableError(`${client.url} is on another chain`, client.url);
    }
  }

  /** Ask a couple of other servers for their tip, unless a recent one is known. */
  private async refreshPeerTips(except: string, force: boolean): Promise<void> {
    const now = this.now();
    const peers = this.options.servers
      .filter((url) => url !== except && this.record(url).coolingUntil <= now)
      .filter((url) => {
        const tip = this.record(url).tip;
        return force || !tip || now - tip.at > this.timing.peerTipMaxAgeMs;
      })
      .slice(0, 2);
    await Promise.allSettled(
      peers.map(async (url) => {
        const peer = this.newClient(url);
        try {
          await peer.connect();
          await this.checkChain(peer);
          const height = tipHeight(await peer.request("blockchain.headers.subscribe", []));
          this.record(url).tip = { height, at: this.now() };
        } finally {
          peer.close();
        }
      }),
    );
  }

  private async replay(client: ElectrumClient): Promise<void> {
    for (const [scripthash, known] of this.subscriptions) {
      const status =
        (await client.request<string | null>("blockchain.scripthash.subscribe", [scripthash])) ??
        null;
      if (status !== known) {
        this.subscriptions.set(scripthash, status);
        for (const listener of this.statusListeners) listener(scripthash, status);
      }
    }
  }

  private notify(client: ElectrumClient, method: string, params: unknown[]): void {
    if (client !== this.client) return;
    if (method === "blockchain.scripthash.subscribe") {
      const [scripthash, status] = params;
      if (typeof scripthash !== "string" || !this.subscriptions.has(scripthash)) return;
      const value = typeof status === "string" ? status : null;
      this.subscriptions.set(scripthash, value);
      for (const listener of this.statusListeners) listener(scripthash, value);
    } else if (method === "blockchain.headers.subscribe") {
      try {
        const height = tipHeight(params[0]);
        this.record(client.url).tip = { height, at: this.now() };
        for (const listener of this.tipListeners) listener(height);
      } catch {
        // Ignore a malformed notification.
      }
    }
  }

  private lost(client: ElectrumClient, error: ElectrumTransportError): void {
    if (client !== this.client) return;
    this.client = null;
    this.fault(client.url, error);
    this.keepAlive();
  }

  /** Keep subscriptions live: move to another server now rather than on the next request. */
  private keepAlive(): void {
    if (this.subscriptions.size > 0 || this.tipListeners.size > 0) {
      this.ensureClient().catch(() => this.scheduleReconnect());
    }
  }

  private scheduleReconnect(): void {
    if (
      this.closed ||
      this.reconnectTimer ||
      (this.subscriptions.size === 0 && this.tipListeners.size === 0)
    ) {
      return;
    }
    const now = this.now();
    const soonest = Math.min(...[...this.records.values()].map((r) => r.coolingUntil));
    const wait = Math.max(1_000, soonest - now);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureClient().catch(() => this.scheduleReconnect());
    }, wait);
  }

  private dropClient(): void {
    const client = this.client;
    this.client = null;
    if (client) {
      client.onClose = null;
      client.onNotification = null;
      client.close();
    }
  }
}
