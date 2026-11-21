import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { WebSocketFactory, WebSocketLike } from "../src/electrum/client";

/** An 80-byte header and its block hash, used as the test checkpoint. */
export function makeHeader(seed: number): { hex: string; hash: string } {
  const bytes = new Uint8Array(80).map((_, i) => (i * 31 + seed) & 0xff);
  return { hex: bytesToHex(bytes), hash: bytesToHex(sha256(sha256(bytes)).reverse()) };
}

export type Reply = { result: unknown } | { error: unknown } | "silent";

export interface FakeServer {
  tip: number;
  header: string;
  down?: boolean;
  /** Overrides for specific methods; return undefined to use the default. */
  handle?: (method: string, params: unknown[]) => Reply | undefined;
  statuses?: Map<string, string | null>;
}

/** In-memory Electrum servers reachable through a fake WebSocket. */
export class FakeNetwork {
  readonly servers = new Map<string, FakeServer>();
  readonly connects = new Map<string, number>();
  readonly calls: { url: string; method: string; params: unknown[] }[] = [];
  private readonly sockets = new Map<string, FakeSocket[]>();

  add(url: string, server: FakeServer): this {
    this.servers.set(url, { statuses: new Map(), ...server });
    return this;
  }

  readonly factory: WebSocketFactory = (url) => {
    this.connects.set(url, (this.connects.get(url) ?? 0) + 1);
    const socket = new FakeSocket(url, this);
    this.sockets.set(url, [...(this.sockets.get(url) ?? []), socket]);
    return socket;
  };

  callsTo(url: string, method?: string): number {
    return this.calls.filter((c) => c.url === url && (method === undefined || c.method === method))
      .length;
  }

  /** Server-side push to every open connection to `url`. */
  push(url: string, method: string, params: unknown[]): void {
    for (const socket of this.sockets.get(url) ?? []) socket.deliver({ method, params });
  }

  /** Server-side close of every connection to `url`. */
  drop(url: string): void {
    for (const socket of this.sockets.get(url) ?? []) socket.serverClose();
  }

  reply(url: string, method: string, params: unknown[]): Reply {
    const server = this.servers.get(url);
    if (!server) return { error: { code: -32601, message: "no server" } };
    this.calls.push({ url, method, params });
    const custom = server.handle?.(method, params);
    if (custom !== undefined) return custom;
    switch (method) {
      case "server.version":
        return { result: ["FakeFulcrum 1.0", "1.5"] };
      case "blockchain.block.header":
        return { result: server.header };
      case "blockchain.headers.subscribe":
        return { result: { height: server.tip, hex: server.header } };
      case "blockchain.scripthash.subscribe":
        return { result: server.statuses?.get(params[0] as string) ?? null };
      default:
        return { error: { code: -32601, message: `Unsupported request: ${method}` } };
    }
  }
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  constructor(
    private readonly url: string,
    private readonly network: FakeNetwork,
  ) {
    setTimeout(() => {
      if (network.servers.get(url)?.down || !network.servers.has(url)) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    }, 0);
  }

  send(data: string): void {
    const { id, method, params } = JSON.parse(data) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const reply = this.network.reply(this.url, method, params);
    if (reply === "silent") return;
    setTimeout(() => this.deliver({ id, ...reply }), 0);
  }

  deliver(message: unknown): void {
    if (this.readyState === 1) this.onmessage?.({ data: `${JSON.stringify(message)}\n` });
  }

  serverClose(): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.onclose?.({});
  }

  close(): void {
    this.readyState = 3;
  }
}
