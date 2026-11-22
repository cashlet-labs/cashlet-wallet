import { encodeTransaction, hexToBin } from "@bitauth/libauth";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { TokenMetaService, type FetchLike, type MetaSource } from "../src/background/token-meta";
import { scripthashOf } from "../src/wallet/indexer";
import { MemoryKeyValue } from "../src/wallet/session";
import { bcmrScript } from "./bcmr-fixtures";

const LOCK = Uint8Array.of(0x51);
const SCRIPTHASH = scripthashOf(LOCK);

function makeTx(parent: { txid: string } | null, extra: Uint8Array[] = []) {
  const raw = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin(parent?.txid ?? "11".repeat(32)),
        outpointIndex: parent ? 0 : 7,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: Uint8Array.of(),
      },
    ],
    outputs: [LOCK, ...extra].map((lockingBytecode) => ({
      lockingBytecode,
      valueSatoshis: 0n,
    })),
  });
  return { hex: bytesToHex(raw), txid: bytesToHex(sha256(sha256(raw)).reverse()) };
}

/** An Electrum server holding a few transactions that all pay to one script. */
class FakeSource implements MetaSource {
  readonly txs = new Map<string, string>();
  readonly order: string[] = [];
  calls = 0;
  add(tx: { hex: string; txid: string }) {
    this.txs.set(tx.txid, tx.hex);
    this.order.push(tx.txid);
  }
  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls++;
    if (method === "blockchain.transaction.get") return this.txs.get(params[0] as string) as T;
    if (method === "blockchain.scripthash.get_history")
      return (
        params[0] === SCRIPTHASH ? this.order.map((tx_hash) => ({ tx_hash, height: 1 })) : []
      ) as T;
    throw new Error(`unexpected ${method}`);
  }
}

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);

function fakeFetch(
  files: Record<string, { body: Uint8Array; type: string }>,
  seen: string[] = [],
): FetchLike {
  return async (url) => {
    seen.push(url);
    const file = files[url];
    if (!file) return new Response("missing", { status: 404 });
    return new Response(file.body as BodyInit, { headers: { "content-type": file.type } });
  };
}

const settle = async (service: TokenMetaService, source: MetaSource, category: string) => {
  for (let i = 0; i < 50; i++) {
    const [entry] = await service.lookup(source, [category]);
    if (entry!.state !== "pending") return entry!;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("still pending");
};

const GATEWAY = "https://gateway.pinata.cloud/ipfs/";

/** An authchain of three transactions; the second announces the registry the first one's category names. */
function scenario(makeRegistry: (category: string) => unknown, uris = ["ipfs://bafy1234567890"]) {
  const authbase = makeTx(null);
  const category = authbase.txid;
  const body = new TextEncoder().encode(JSON.stringify(makeRegistry(category)));
  const source = new FakeSource();
  source.add(authbase);
  const publish = makeTx(authbase, [bcmrScript(bytesToHex(sha256(body)), uris)]);
  source.add(publish);
  source.add(makeTx(publish));
  return { source, body, category };
}

const registry = (category: string) => ({
  identities: {
    [category]: [
      {
        name: "Test Token",
        uris: { icon: "ipfs://bafyicon1234567" },
        token: {
          category,
          symbol: "TST",
          decimals: 2,
          nfts: { parse: { types: { "0a": { name: "Gold" } } } },
        },
      },
    ],
  },
});

function serviceFor(
  files: Record<string, { body: Uint8Array; type: string }>,
  seen: string[] = [],
) {
  const settings = new MemoryKeyValue();
  const clock = { now: 1_000 };
  return {
    settings,
    clock,
    service: new TokenMetaService(settings, fakeFetch(files, seen), () => clock.now),
  };
}

describe("TokenMetaService", () => {
  it("follows the authchain, checks the hash and returns name, symbol, decimals, icon and NFT types", async () => {
    const { source, body, category } = scenario(registry);
    const seen: string[] = [];
    const { service } = serviceFor(
      {
        [`${GATEWAY}bafy1234567890`]: { body, type: "application/json" },
        [`${GATEWAY}bafyicon1234567`]: { body: PNG, type: "image/png" },
      },
      seen,
    );
    // The first answer never waits for the network.
    const [first] = await service.lookup(source, [category]);
    expect(first).toMatchObject({ state: "pending", name: null, decimals: 0, icon: null });
    const known = await settle(service, source, category);
    expect(known).toEqual({
      category,
      state: "known",
      name: "Test Token",
      symbol: "TST",
      decimals: 2,
      icon: `data:image/png;base64,${btoa(String.fromCharCode(...PNG))}`,
      nftTypes: [{ commitment: "0a", name: "Gold" }],
    });
    expect(seen).toEqual([`${GATEWAY}bafy1234567890`, `${GATEWAY}bafyicon1234567`]);
  });

  it("answers from the cache until it expires, then looks again", async () => {
    const { source, body, category } = scenario(registry);
    const files = { [`${GATEWAY}bafy1234567890`]: { body, type: "application/json" } };
    const { service, clock } = serviceFor(files);
    await settle(service, source, category);
    const calls = source.calls;
    expect((await service.lookup(source, [category]))[0]!.state).toBe("known");
    expect(source.calls).toBe(calls);
    clock.now += 25 * 60 * 60_000;
    // Stale data is still shown while it is refreshed.
    expect((await service.lookup(source, [category]))[0]!.state).toBe("known");
    await new Promise((r) => setTimeout(r, 20));
    expect(source.calls).toBeGreaterThan(calls);
  });

  it("refuses a registry whose hash does not match", async () => {
    const { source, category } = scenario(registry);
    const other = new TextEncoder().encode(JSON.stringify(registry("ee".repeat(32))));
    const { service } = serviceFor({
      [`${GATEWAY}bafy1234567890`]: { body: other, type: "application/json" },
    });
    expect((await settle(service, source, category)).state).toBe("unknown");
  });

  it("does not fetch registries from other hosts, and says unknown", async () => {
    const { source, category } = scenario(registry, ["https://example.com/registry.json"]);
    const seen: string[] = [];
    const { service } = serviceFor({}, seen);
    expect((await settle(service, source, category)).state).toBe("unknown");
    expect(seen).toEqual([]);
  });

  it("falls back to the next address", async () => {
    const { source, body, category } = scenario(registry, [
      "https://example.com/registry.json",
      "ipfs://bafy1234567890",
    ]);
    const { service } = serviceFor({
      [`${GATEWAY}bafy1234567890`]: { body, type: "application/json" },
    });
    expect((await settle(service, source, category)).name).toBe("Test Token");
  });

  it("reports no metadata for a token that never announced a registry", async () => {
    const authbase = makeTx(null);
    const source = new FakeSource();
    source.add(authbase);
    const { service } = serviceFor({});
    expect((await settle(service, source, authbase.txid)).state).toBe("unknown");
  });

  it("drops icons that are not small images", async () => {
    for (const icon of [
      { body: PNG, type: "image/svg+xml" },
      { body: PNG, type: "text/html" },
      { body: new Uint8Array(256 * 1024 + 1), type: "image/png" },
    ]) {
      const { source, body, category } = scenario(registry);
      const { service } = serviceFor({
        [`${GATEWAY}bafy1234567890`]: { body, type: "application/json" },
        [`${GATEWAY}bafyicon1234567`]: icon,
      });
      const entry = await settle(service, source, category);
      expect(entry).toMatchObject({ state: "known", name: "Test Token", icon: null });
    }
  });

  it("rejects a transaction the server swapped for another", async () => {
    const { source, category } = scenario(registry);
    source.txs.set(category, makeTx(null, [Uint8Array.of(0x52)]).hex);
    const { service } = serviceFor({});
    expect((await settle(service, source, category)).state).toBe("unknown");
  });

  it("retries a failed lookup after a short wait", async () => {
    const { source, body, category } = scenario(registry);
    const files: Record<string, { body: Uint8Array; type: string }> = {};
    const { service, clock } = serviceFor(files);
    expect((await settle(service, source, category)).state).toBe("unknown");
    files[`${GATEWAY}bafy1234567890`] = { body, type: "application/json" };
    clock.now += 11 * 60_000;
    expect((await settle(service, source, category)).state).toBe("known");
  });
});
