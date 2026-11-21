import { ElectrumRpcError, ElectrumTransportError } from "./errors";

/** The part of the WebSocket API the client uses, so tests can supply a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;
const PROTOCOL = ["1.4", "1.5"] as const;
const CLIENT_NAME = "Cashlet";

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ClientOptions {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
}

/**
 * One JSON-RPC connection to one Electrum server. It knows nothing about other
 * servers: failover is the pool's job. A request that times out closes the
 * connection, because a half-open socket would otherwise time out forever.
 */
export class ElectrumClient {
  private socket: WebSocketLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closedByUs = false;
  /** Server software and protocol version, from the handshake. */
  serverVersion: [string, string] | null = null;

  onNotification: ((method: string, params: unknown[]) => void) | null = null;
  onClose: ((error: ElectrumTransportError) => void) | null = null;

  constructor(
    readonly url: string,
    private readonly createSocket: WebSocketFactory,
    private readonly options: ClientOptions,
  ) {}

  get isOpen(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  /** Open the connection and complete the version handshake. */
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drop(message);
        reject(new ElectrumTransportError(message, this.url));
      };
      const timer = setTimeout(
        () => fail(`timed out connecting to ${this.url}`),
        this.options.connectTimeoutMs,
      );
      let socket: WebSocketLike;
      try {
        socket = this.createSocket(this.url);
      } catch {
        fail(`cannot open ${this.url}`);
        return;
      }
      this.socket = socket;
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => fail(`cannot connect to ${this.url}`);
      socket.onclose = () => {
        if (!settled) fail(`${this.url} closed the connection`);
        else this.drop(`${this.url} closed the connection`);
      };
      socket.onmessage = (event) => this.receive(event.data);
    });
    const version = await this.request<unknown>("server.version", [CLIENT_NAME, [...PROTOCOL]]);
    if (
      !Array.isArray(version) ||
      typeof version[0] !== "string" ||
      typeof version[1] !== "string"
    ) {
      this.close();
      throw new ElectrumTransportError(`${this.url} sent a malformed version`, this.url);
    }
    this.serverVersion = [version[0], version[1]];
  }

  request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN) {
      return Promise.reject(new ElectrumTransportError(`not connected to ${this.url}`, this.url));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ElectrumTransportError(`${this.url} did not answer ${method} in time`, this.url),
        );
        this.drop(`${this.url} stopped answering`);
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        socket.send(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new ElectrumTransportError(`cannot send to ${this.url}`, this.url));
      }
    });
  }

  close(): void {
    this.closedByUs = true;
    this.drop("connection closed");
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") return;
    for (const line of data.split("\n")) {
      if (line.trim() === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message !== "object" || message === null) continue;
      const { id, result, error, method, params } = message as Record<string, unknown>;
      if (typeof id === "number") {
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (error !== undefined && error !== null)
          pending.reject(this.rpcError(error, pending.method));
        else pending.resolve(result);
      } else if (typeof method === "string" && Array.isArray(params)) {
        this.onNotification?.(method, params);
      }
    }
  }

  private rpcError(error: unknown, method: string): ElectrumRpcError {
    if (typeof error === "string") return new ElectrumRpcError(error, null, method, this.url);
    if (typeof error === "object" && error !== null) {
      const { code, message } = error as { code?: unknown; message?: unknown };
      return new ElectrumRpcError(
        typeof message === "string" ? message : JSON.stringify(error),
        typeof code === "number" ? code : null,
        method,
        this.url,
      );
    }
    return new ElectrumRpcError("unknown server error", null, method, this.url);
  }

  private drop(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
    const error = new ElectrumTransportError(reason, this.url);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    if (socket && !this.closedByUs) this.onClose?.(error);
  }
}
