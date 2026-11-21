import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbStore, MemoryStore, type WalletStore } from "../src/wallet/store";
import type { HistoryEntry, Utxo } from "../src/wallet/types";

const SH_A = "aa".repeat(32);
const SH_B = "bb".repeat(32);
const utxo = (scripthash: string, vout: number, token = false): Utxo => ({
  txid: "11".repeat(32),
  vout,
  value: 1000 + vout,
  height: 10,
  scripthash,
  token: token ? { category: "ee".repeat(32), amount: 2n ** 63n - 1n, nft: null } : null,
});
const entry = (scripthash: string, height: number): HistoryEntry => ({
  txid: "22".repeat(32),
  height,
  scripthash,
});

let counter = 0;
const stores: [string, () => Promise<WalletStore>][] = [
  ["MemoryStore", async () => new MemoryStore()],
  ["IndexedDbStore", async () => IndexedDbStore.open(`test-${++counter}`)],
];

describe.each(stores)("%s", (_, make) => {
  it("stores addresses by chain and index", async () => {
    const store = await make();
    await store.putAddress({ scripthash: SH_A, chain: 0, index: 0, status: null });
    await store.putAddress({ scripthash: SH_A, chain: 0, index: 0, status: "s" });
    await store.putAddress({ scripthash: SH_B, chain: 1, index: 0, status: null });
    expect((await store.addresses()).sort((a, b) => a.chain - b.chain)).toEqual([
      { scripthash: SH_A, chain: 0, index: 0, status: "s" },
      { scripthash: SH_B, chain: 1, index: 0, status: null },
    ]);
  });

  it("replaces one address's data without touching others, keeping token amounts exact", async () => {
    const store = await make();
    await store.replaceAddressData(SH_A, [utxo(SH_A, 0), utxo(SH_A, 1, true)], [entry(SH_A, 10)]);
    await store.replaceAddressData(SH_B, [utxo(SH_B, 2)], [entry(SH_B, 11)]);
    await store.replaceAddressData(SH_A, [utxo(SH_A, 3)], []);
    const utxos = (await store.utxos()).sort((a, b) => a.vout - b.vout);
    expect(utxos.map((u) => u.vout)).toEqual([2, 3]);
    expect(await store.history()).toEqual([entry(SH_B, 11)]);

    await store.replaceAddressData(SH_B, [utxo(SH_B, 4, true)], []);
    const [withToken] = (await store.utxos()).filter((u) => u.token);
    expect(withToken?.token?.amount).toBe(2n ** 63n - 1n);
  });

  it("caches block times and clears everything", async () => {
    const store = await make();
    expect(await store.blockTime(5)).toBeNull();
    await store.putBlockTime(5, 1_700_000_000);
    expect(await store.blockTime(5)).toBe(1_700_000_000);
    await store.putAddress({ scripthash: SH_A, chain: 0, index: 0, status: null });
    await store.clear();
    expect(await store.addresses()).toEqual([]);
    expect(await store.blockTime(5)).toBeNull();
  });
});

describe("IndexedDbStore.open", () => {
  it("refuses odd wallet ids", async () => {
    await expect(IndexedDbStore.open("../x")).rejects.toThrow("invalid wallet id");
  });
});
