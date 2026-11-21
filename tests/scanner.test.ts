import { describe, expect, it } from "vitest";
import { HdWallet } from "../src/wallet/hd";
import { Scanner, balanceOf, type IndexerSource } from "../src/wallet/scanner";
import { MemoryStore } from "../src/wallet/store";
import type { Utxo } from "../src/wallet/types";

// Published BIP39 test vector. Never use it for funds.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = HdWallet.fromMnemonic(MNEMONIC);
const CATEGORY = "ef".repeat(32);
const tx = (n: number) => n.toString(16).padStart(64, "0");
const header = (time: number) => {
  const bytes = new Uint8Array(80);
  new DataView(bytes.buffer).setUint32(68, time, true);
  return Buffer.from(bytes).toString("hex");
};

interface FakeAddress {
  status: string | null;
  utxos: object[];
  history: object[];
}

/** An indexer that knows a few used addresses; every other address is unused. */
class FakeSource implements IndexerSource {
  readonly data = new Map<string, FakeAddress>();
  readonly headers = new Map<number, string>();
  readonly calls: string[] = [];
  private listener: ((sh: string, status: string | null) => void) | null = null;

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push(method);
    const key = params[0] as string;
    if (method === "blockchain.scripthash.listunspent")
      return (this.data.get(key)?.utxos ?? []) as T;
    if (method === "blockchain.scripthash.get_history")
      return (this.data.get(key)?.history ?? []) as T;
    if (method === "blockchain.block.header") return this.headers.get(params[0] as number) as T;
    throw new Error(`unexpected ${method}`);
  }
  async subscribe(scripthash: string): Promise<string | null> {
    this.calls.push("subscribe");
    return this.data.get(scripthash)?.status ?? null;
  }
  onStatus(listener: (sh: string, status: string | null) => void): () => void {
    this.listener = listener;
    return () => (this.listener = null);
  }
  push(scripthash: string, status: string | null): void {
    this.listener?.(scripthash, status);
  }
}

function setup(gapLimit = 20) {
  const source = new FakeSource();
  const store = new MemoryStore();
  const scanner = new Scanner(wallet, "chipnet", source, store, { gapLimit });
  const use = (chain: 0 | 1, index: number, utxos: object[], history: object[] = []) =>
    source.data.set(scanner.scripthash(chain, index), {
      status: `s${chain}${index}`,
      utxos,
      history,
    });
  return { source, store, scanner, use };
}

describe("Scanner", () => {
  it("finds used addresses up to the gap limit and watches the gap", async () => {
    const { scanner, use } = setup(5);
    use(0, 0, [{ tx_hash: tx(1), tx_pos: 0, value: 1000, height: 10 }]);
    use(0, 4, [{ tx_hash: tx(2), tx_pos: 1, value: 2000, height: 11 }]);
    use(0, 10, [{ tx_hash: tx(3), tx_pos: 0, value: 9999, height: 12 }]); // past the gap after 4
    use(1, 0, [{ tx_hash: tx(4), tx_pos: 0, value: 500, height: 0 }]);
    const result = await scanner.scan();
    expect(result.used).toBe(3);
    // Receive: 0..4 then 5 unused (5..9). Change: 0 then 5 unused (1..5).
    expect(result.watched).toBe(10 + 6);
    expect(await scanner.balance()).toMatchObject({ confirmed: 3000, unconfirmed: 500 });
  });

  it("refreshes an address when its status changes, and extends past the gap", async () => {
    const { source, scanner, use } = setup(5);
    use(0, 0, []);
    await scanner.scan();
    const changed: number[] = [];
    scanner.onChange = (address) => changed.push(address.index);
    // Index 5 is the last watched receive address; it receives a payment.
    use(0, 5, [{ tx_hash: tx(9), tx_pos: 0, value: 7000, height: 0 }]);
    source.push(scanner.scripthash(0, 5), "s05");
    await new Promise((r) => setTimeout(r, 10));
    expect(changed).toEqual([5]);
    expect((await scanner.balance()).unconfirmed).toBe(7000);
    expect((await scanner.nextAddress(0)).index).toBe(6);
    // The gap now extends to index 10.
    const watched = source.calls.filter((c) => c === "subscribe").length;
    expect(watched).toBe(6 + 5 + 5);
  });

  it("ignores status changes for addresses it does not watch", async () => {
    const { source, scanner } = setup(3);
    await scanner.scan();
    const before = source.calls.length;
    source.push("ff".repeat(32), "x");
    await new Promise((r) => setTimeout(r, 5));
    expect(source.calls.length).toBe(before);
  });

  it("gives history newest first, unconfirmed on top, one entry per transaction, with block times", async () => {
    const { source, scanner, use } = setup(3);
    use(
      0,
      0,
      [],
      [
        { tx_hash: tx(1), height: 100 },
        { tx_hash: tx(2), height: 200 },
      ],
    );
    use(
      1,
      0,
      [],
      [
        { tx_hash: tx(2), height: 200 },
        { tx_hash: tx(3), height: 0 },
      ],
    );
    source.headers.set(100, header(1_793_302_819));
    source.headers.set(200, header(1_793_400_000));
    await scanner.scan();
    const history = await scanner.history();
    expect(history.map((h) => [h.txid, h.time])).toEqual([
      [tx(3), null],
      [tx(2), 1_793_400_000],
      [tx(1), 1_793_302_819],
    ]);
    await scanner.history();
    // Block times are cached: each header is fetched once.
    expect(source.calls.filter((c) => c === "blockchain.block.header")).toHaveLength(2);
  });

  it("hands out the address after the last used one", async () => {
    const { scanner, use } = setup(3);
    use(0, 1, []);
    await scanner.scan();
    const next = await scanner.nextAddress(0);
    expect(next).toEqual({ index: 2, address: wallet.address(0, 2, "chipnet") });
    expect((await scanner.nextAddress(0, true)).address).toMatch(/^bchtest:z/);
  });

  it("fails the scan on malformed server data", async () => {
    const { scanner, use } = setup(3);
    use(0, 0, [{ tx_hash: "nope", tx_pos: 0, value: 1, height: 1 }]);
    await expect(scanner.scan()).rejects.toThrow("malformed");
  });
});

describe("balanceOf", () => {
  it("adds up tokens per category", () => {
    const base = { txid: tx(1), height: 5, scripthash: "aa".repeat(32), value: 1000 };
    const utxos: Utxo[] = [
      { ...base, vout: 0, token: { category: CATEGORY, amount: 5n, nft: null } },
      {
        ...base,
        vout: 1,
        token: { category: CATEGORY, amount: 7n, nft: { capability: "none", commitment: "aa" } },
      },
      { ...base, vout: 2, token: null },
    ];
    const balance = balanceOf(utxos);
    expect(balance.confirmed).toBe(3000);
    expect(balance.tokens.get(CATEGORY)).toEqual({
      amount: 12n,
      nfts: [{ capability: "none", commitment: "aa" }],
    });
  });
});
