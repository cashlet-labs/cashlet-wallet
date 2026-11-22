import { decodeTransaction, hexToBin } from "@bitauth/libauth";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { TokenMetaEntry } from "../shared/messages";
import {
  fetchUrl,
  MAX_ICON_BYTES,
  MAX_REGISTRY_BYTES,
  parseBcmrOutput,
  parseRegistry,
  type RegistryRef,
  type TokenMeta,
} from "../wallet/bcmr";
import { scripthashOf } from "../wallet/indexer";
import type { KeyValueStore } from "../wallet/session";

/** The part of the network connection that metadata lookups use. */
export interface MetaSource {
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export type FetchLike = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

const FOUND_TTL_MS = 24 * 60 * 60_000;
const NONE_TTL_MS = 6 * 60 * 60_000;
const FAILED_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 10_000;
/** Longest authchain followed, and most transactions looked at to find a spender. */
const MAX_HOPS = 30;
const MAX_CANDIDATES = 50;

interface CacheEntry {
  state: "found" | "none" | "failed";
  expires: number;
  meta: TokenMeta | null;
}

interface IconEntry {
  dataUrl: string | null;
}

const empty = () => ({ name: null, symbol: null, decimals: 0, icon: null, nftTypes: [] });

class FailedLookup extends Error {}

/**
 * Finds token names, symbols, decimals and icons. Answers come from a cache
 * and never wait for the network: a token that is not known yet is reported as
 * pending while it is looked up in the background, one token at a time.
 */
export class TokenMetaService {
  private readonly queued = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: KeyValueStore,
    private readonly fetcher: FetchLike,
    private readonly now: () => number,
  ) {}

  /** What is known now about each category; unknown ones are looked up through `source`. */
  async lookup(source: MetaSource, categories: string[]): Promise<TokenMetaEntry[]> {
    return Promise.all(
      categories.map(async (category): Promise<TokenMetaEntry> => {
        const entry = await this.settings.get<CacheEntry>(`tokenMeta:${category}`);
        if (!entry || entry.expires <= this.now()) this.schedule(source, category);
        if (entry?.state === "found" && entry.meta) {
          const icon = await this.settings.get<IconEntry>(`tokenIcon:${category}`);
          return { category, state: "known", ...entry.meta, icon: icon?.dataUrl ?? null };
        }
        const waiting = !entry || entry.expires <= this.now() || this.queued.has(category);
        return { category, state: waiting ? "pending" : "unknown", ...empty() };
      }),
    );
  }

  private schedule(source: MetaSource, category: string): void {
    if (this.queued.has(category)) return;
    this.queued.add(category);
    this.queue = this.queue.then(async () => {
      try {
        await this.refresh(source, category);
      } finally {
        this.queued.delete(category);
      }
    });
  }

  private async refresh(source: MetaSource, category: string): Promise<void> {
    const key = `tokenMeta:${category}`;
    const before = await this.settings.get<CacheEntry>(key);
    let entry: CacheEntry;
    let icon: IconEntry | null = null;
    try {
      const meta = await this.resolve(source, category);
      if (meta) {
        icon = { dataUrl: await this.fetchIcon(meta.icon) };
        entry = {
          state: "found",
          expires: this.now() + FOUND_TTL_MS,
          meta: { ...meta, icon: null },
        };
      } else {
        entry = { state: "none", expires: this.now() + NONE_TTL_MS, meta: null };
      }
    } catch {
      // Keep what was known before and try again soon.
      entry = { state: "failed", expires: this.now() + FAILED_TTL_MS, meta: null };
      if (before?.state === "found") entry = { ...before, expires: entry.expires };
    }
    try {
      await this.settings.set(key, entry);
      if (icon) await this.settings.set(`tokenIcon:${category}`, icon);
    } catch {
      // A full or unavailable store only means the lookup is repeated later.
    }
  }

  /**
   * The registry for a category, found by following its authchain: the chain
   * of transactions that each spend output 0 of the one before, starting at the
   * transaction named by the category. The newest one that announces a registry
   * wins. The file must match the hash announced on chain.
   */
  private async resolve(source: MetaSource, category: string): Promise<TokenMeta | null> {
    const ref = await this.announced(source, category);
    if (!ref) return null;
    let reachable = false;
    for (const uri of ref.uris) {
      const url = fetchUrl(uri);
      if (!url) continue;
      reachable = true;
      try {
        const body = await this.download(url, MAX_REGISTRY_BYTES);
        if (bytesToHex(sha256(body)) !== ref.hash) continue;
        const json: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        return parseRegistry(json, category);
      } catch {
        // Try the next address.
      }
    }
    // A registry on another site is not reachable under the extension's policy: no metadata.
    if (reachable) throw new FailedLookup("the registry could not be fetched");
    return null;
  }

  private async announced(source: MetaSource, category: string): Promise<RegistryRef | null> {
    const seen = new Set<string>();
    let found: RegistryRef | null = null;
    let txid = category;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      seen.add(txid);
      const tx = await this.transaction(source, txid);
      for (const output of tx.outputs) found = parseBcmrOutput(output.lockingBytecode) ?? found;
      const first = tx.outputs[0];
      if (!first) break;
      const next = await this.spender(source, txid, scripthashOf(first.lockingBytecode));
      if (next === null || seen.has(next)) break;
      txid = next;
    }
    return found;
  }

  /** The transaction that spends output 0 of `txid`, if any. */
  private async spender(
    source: MetaSource,
    txid: string,
    scripthash: string,
  ): Promise<string | null> {
    const history = await source.request<unknown>("blockchain.scripthash.get_history", [
      scripthash,
    ]);
    if (!Array.isArray(history)) throw new FailedLookup("malformed history");
    const ids = history
      .map((h: unknown) => (h as { tx_hash?: unknown } | null)?.tx_hash)
      .filter((id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/.test(id));
    const after = ids.includes(txid) ? ids.slice(ids.indexOf(txid) + 1) : ids;
    for (const id of after.slice(0, MAX_CANDIDATES)) {
      if (id === txid) continue;
      const candidate = await this.transaction(source, id);
      if (
        candidate.inputs.some(
          (i) => bytesToHex(i.outpointTransactionHash) === txid && i.outpointIndex === 0,
        )
      )
        return id;
    }
    return null;
  }

  /** A transaction from the server, checked to be the one asked for. */
  private async transaction(source: MetaSource, txid: string) {
    const hex = await source.request<unknown>("blockchain.transaction.get", [txid]);
    if (typeof hex !== "string" || !/^([0-9a-f]{2})+$/.test(hex))
      throw new FailedLookup("malformed transaction");
    const raw = hexToBin(hex);
    if (bytesToHex(sha256(sha256(raw)).reverse()) !== txid)
      throw new FailedLookup("the server sent the wrong transaction");
    const decoded = decodeTransaction(raw);
    if (typeof decoded === "string") throw new FailedLookup("malformed transaction");
    return decoded;
  }

  /** The icon as a data: address the popup can show without a remote image. */
  private async fetchIcon(uri: string | null): Promise<string | null> {
    const url = uri ? fetchUrl(uri) : null;
    if (!url) return null;
    try {
      const response = await this.get(url);
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      // SVG is left out: it can carry scripts and external references.
      if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
      const body = await readLimited(response, MAX_ICON_BYTES);
      let binary = "";
      for (let i = 0; i < body.length; i += 0x8000)
        binary += String.fromCharCode(...body.subarray(i, i + 0x8000));
      return `data:${type};base64,${btoa(binary)}`;
    } catch {
      return null;
    }
  }

  private async get(url: string): Promise<Response> {
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new FailedLookup(`HTTP ${response.status}`);
    return response;
  }

  private async download(url: string, max: number): Promise<Uint8Array> {
    return readLimited(await this.get(url), max);
  }
}

/** The body of a response, refused once it passes `max` bytes. */
async function readLimited(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > max) throw new FailedLookup("too large");
  const reader = response.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.length > max) throw new FailedLookup("too large");
    return all;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      void reader.cancel();
      throw new FailedLookup("too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
