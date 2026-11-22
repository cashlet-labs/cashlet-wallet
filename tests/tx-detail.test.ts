import {
  binToHex,
  encodeTransaction,
  hashTransaction,
  hexToBin,
  type Output,
} from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { ElectrumPool } from "../src/electrum/pool";
import { explorerTxUrl } from "../src/popup/explorer";
import { signedBch } from "../src/popup/tx-view";
import { parseRequest } from "../src/shared/messages";
import { HdWallet } from "../src/wallet/hd";
import { p2pkhLockingBytecode, scripthashOf } from "../src/wallet/indexer";
import { TxDetails } from "../src/wallet/tx-detail";
import { FakeNetwork, makeHeader } from "./fake-electrum";

// Published BIP39 test vectors. Never use them for funds.
const wallet = HdWallet.fromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const stranger = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const lock = (w: HdWallet, chain: 0 | 1, index: number) =>
  p2pkhLockingBytecode(w.addressKey(chain, index).keyHash);
const mine = new Set(
  [0, 1].flatMap((chain) => [0, 1, 2].map((i) => scripthashOf(lock(wallet, chain as 0 | 1, i)))),
);
const CATEGORY = "cd".repeat(32);

function makeTx(spends: { txid: string; vout: number }[], outputs: Output[]) {
  const bytes = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: spends.map((s) => ({
      outpointTransactionHash: hexToBin(s.txid),
      outpointIndex: s.vout,
      sequenceNumber: 0,
      unlockingBytecode: Uint8Array.of(),
    })),
    outputs,
  });
  return { hex: binToHex(bytes), txid: hashTransaction(bytes) };
}

const out = (lockingBytecode: Uint8Array, value: number, token?: Output["token"]): Output => ({
  lockingBytecode,
  valueSatoshis: BigInt(value),
  ...(token ? { token } : {}),
});
const fungible = (amount: number) => ({
  category: hexToBin(CATEGORY),
  amount: BigInt(amount),
});

// A chain of four transactions: an outsider pays the wallet (with tokens), the
// wallet pays the outsider part of it, then moves the change to itself.
const funding = makeTx(
  [{ txid: "11".repeat(32), vout: 0 }],
  [out(lock(stranger, 0, 5), 1_000_000)],
);
const received = makeTx(
  [{ txid: funding.txid, vout: 0 }],
  [out(lock(wallet, 0, 0), 100_000, fungible(10)), out(lock(stranger, 0, 6), 899_000)],
);
const sent = makeTx(
  [{ txid: received.txid, vout: 0 }],
  [out(lock(stranger, 0, 7), 30_000, fungible(4)), out(lock(wallet, 1, 0), 69_000, fungible(6))],
);
const moved = makeTx(
  [{ txid: sent.txid, vout: 1 }],
  [out(lock(wallet, 1, 1), 68_000, fungible(6))],
);
const all = [funding, received, sent, moved];

const GOOD = makeHeader(1);
const URL = "wss://a.test";

function setup(transactions: Record<string, string> = {}) {
  const raws = new Map(all.map((t) => [t.txid, t.hex]));
  for (const [id, hex] of Object.entries(transactions)) raws.set(id, hex);
  const network = new FakeNetwork().add(URL, {
    tip: 1000,
    header: GOOD.hex,
    handle: (method, params) =>
      method === "blockchain.transaction.get"
        ? raws.has(params[0] as string)
          ? { result: raws.get(params[0] as string) }
          : {
              error: {
                code: 2,
                message:
                  "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction.'})",
              },
            }
        : undefined,
  });
  const pool = new ElectrumPool({
    servers: [URL],
    checkpoint: { height: 100, hash: GOOD.hash },
    createSocket: network.factory,
    timing: { connectTimeoutMs: 200, requestTimeoutMs: 100 },
  });
  const details = new TxDetails(pool, "chipnet", (sh) => mine.has(sh));
  return { network, pool, details };
}

describe("TxDetails", () => {
  it("reads a receive: net gain, tokens, our address and the fee", async () => {
    const { details, pool } = setup();
    const tx = await details.get(received.txid);
    expect(tx).toMatchObject({
      direction: "received",
      net: 100_000,
      fee: 1_000_000 - 100_000 - 899_000,
      complete: true,
      tokens: [{ category: CATEGORY, amount: 10n, nfts: 0 }],
      receivedOn: [wallet.address(0, 0, "chipnet", true)],
      counterparties: [{ value: 899_000 }],
    });
    expect(tx.size).toBe(received.hex.length / 2);
    pool.close();
  });

  it("reads a send: net loss includes the fee, and lists where it went", async () => {
    const { details, pool } = setup();
    const tx = await details.get(sent.txid);
    expect(tx).toMatchObject({
      direction: "sent",
      net: 69_000 - 100_000,
      fee: 1_000,
      tokens: [{ category: CATEGORY, amount: -4n, nfts: 0 }],
      counterparties: [{ address: stranger.address(0, 7, "chipnet", true), value: 30_000 }],
    });
    pool.close();
  });

  it("reads a move between the wallet's own addresses as a self-transfer", async () => {
    const { details, pool } = setup();
    const tx = await details.get(moved.txid);
    expect(tx).toMatchObject({
      direction: "self",
      net: -1_000,
      fee: 1_000,
      tokens: [],
      counterparties: [],
    });
    pool.close();
  });

  it("counts NFTs and leaves out a data output's address", async () => {
    const nft = {
      category: hexToBin(CATEGORY),
      amount: 0n,
      nft: { capability: "none" as const, commitment: Uint8Array.of(1) },
    };
    const parent = makeTx([{ txid: "22".repeat(32), vout: 0 }], [out(lock(stranger, 0, 0), 5_000)]);
    const tx = makeTx(
      [{ txid: parent.txid, vout: 0 }],
      [out(lock(wallet, 0, 1), 1_000, nft), out(Uint8Array.of(0x6a, 0x01, 0x07), 0)],
    );
    const { details, pool } = setup({ [parent.txid]: parent.hex, [tx.txid]: tx.hex });
    expect(await details.get(tx.txid)).toMatchObject({
      direction: "received",
      tokens: [{ category: CATEGORY, amount: 0n, nfts: 1 }],
      counterparties: [],
    });
    pool.close();
  });

  it("has no fee for a coinbase", async () => {
    const coinbase = makeTx(
      [{ txid: "00".repeat(32), vout: 0xffffffff }],
      [out(lock(wallet, 0, 2), 625_000_000)],
    );
    const { details, pool } = setup({ [coinbase.txid]: coinbase.hex });
    expect(await details.get(coinbase.txid)).toMatchObject({
      direction: "received",
      net: 625_000_000,
      fee: null,
      complete: true,
    });
    pool.close();
  });

  it("keeps the fee unknown, and does not cache, when a source transaction is missing", async () => {
    const orphan = makeTx([{ txid: "33".repeat(32), vout: 0 }], [out(lock(wallet, 0, 0), 1_000)]);
    const { details, network, pool } = setup({ [orphan.txid]: orphan.hex });
    expect(await details.get(orphan.txid)).toMatchObject({
      fee: null,
      complete: false,
      net: 1_000,
    });
    const before = network.callsTo(URL, "blockchain.transaction.get");
    await details.get(orphan.txid);
    expect(network.callsTo(URL, "blockchain.transaction.get")).toBe(before + 2);
    pool.close();
  });

  it("fetches a finished transaction once", async () => {
    const { details, network, pool } = setup();
    await Promise.all([details.get(sent.txid), details.get(sent.txid)]);
    const calls = network.callsTo(URL, "blockchain.transaction.get");
    expect(calls).toBe(2);
    await details.get(sent.txid);
    expect(network.callsTo(URL, "blockchain.transaction.get")).toBe(calls);
    pool.close();
  });

  it("refuses a server that answers with another transaction", async () => {
    const { details, pool } = setup({ [received.txid]: sent.hex });
    await expect(details.get(received.txid)).rejects.toThrow("a different transaction");
    pool.close();
  });

  it("refuses a malformed answer", async () => {
    const { details, pool } = setup({ [received.txid]: "zz" });
    await expect(details.get(received.txid)).rejects.toThrow("malformed");
    pool.close();
  });
});

describe("GET_TRANSACTION request", () => {
  it("accepts only a 64-character lowercase hex txid", () => {
    expect(parseRequest({ type: "GET_TRANSACTION", txid: sent.txid })).toEqual({
      type: "GET_TRANSACTION",
      txid: sent.txid,
    });
    for (const txid of ["", "ab", "AB".repeat(32), "zz".repeat(32), "ab".repeat(33), 5, null]) {
      expect(parseRequest({ type: "GET_TRANSACTION", txid })).toEqual({
        error: "malformed GET_TRANSACTION",
      });
    }
    expect(parseRequest({ type: "GET_TRANSACTION", txid: sent.txid, extra: 1 })).toEqual({
      error: "malformed GET_TRANSACTION",
    });
  });
});

describe("transaction screen helpers", () => {
  it("links to the explorer for the wallet's network", () => {
    expect(explorerTxUrl("mainnet", sent.txid)).toBe(`https://explorer.bch.ninja/tx/${sent.txid}`);
    expect(explorerTxUrl("chipnet", sent.txid)).toBe(
      `https://chipnet.imaginary.cash/tx/${sent.txid}`,
    );
    expect(() => explorerTxUrl("mainnet", "../x")).toThrow();
  });

  it("signs amounts", () => {
    expect(signedBch(150_000_000)).toBe("+1.5");
    expect(signedBch(-1_000)).toBe("−0.00001");
    expect(signedBch(0)).toBe("+0");
  });
});
