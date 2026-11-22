import { binToHex, encodeTransaction, hashTransaction, hexToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { HdWallet } from "../src/wallet/hd";
import { p2pkhLockingBytecode, scripthashOf } from "../src/wallet/indexer";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

// Published BIP39 test vectors. Never use them for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = HdWallet.fromMnemonic(VECTOR);
const OTHER = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const mineLock = p2pkhLockingBytecode(wallet.addressKey(0, 0).keyHash);
const receive0 = scripthashOf(mineLock);

function makeTx(spendTxid: string, outputs: { lockingBytecode: Uint8Array; value: number }[]) {
  const bytes = encodeTransaction({
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin(spendTxid),
        outpointIndex: 0,
        sequenceNumber: 0,
        unlockingBytecode: Uint8Array.of(),
      },
    ],
    outputs: outputs.map((o) => ({
      lockingBytecode: o.lockingBytecode,
      valueSatoshis: BigInt(o.value),
    })),
  });
  return { hex: binToHex(bytes), txid: hashTransaction(bytes) };
}

const parent = makeTx("44".repeat(32), [
  { lockingBytecode: p2pkhLockingBytecode(OTHER.addressKey(0, 0).keyHash), value: 200_000 },
]);
const pay = makeTx(parent.txid, [
  { lockingBytecode: mineLock, value: 150_000 },
  { lockingBytecode: p2pkhLockingBytecode(OTHER.addressKey(0, 1).keyHash), value: 49_000 },
]);
const raws = new Map([parent, pay].map((t) => [t.txid, t.hex]));

class FakeConnection implements Connection {
  currentServer = "wss://fake.test";
  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (method === "blockchain.relayfee") return 0.00001 as T;
    if (method === "blockchain.scripthash.listunspent")
      return (
        params[0] === receive0 ? [{ tx_hash: pay.txid, tx_pos: 0, value: 150_000, height: 90 }] : []
      ) as T;
    if (method === "blockchain.scripthash.get_history")
      return (params[0] === receive0 ? [{ tx_hash: pay.txid, height: 90 }] : []) as T;
    if (method === "blockchain.block.header")
      return ("00".repeat(68) + "00e1f505" + "00".repeat(8)) as T;
    if (method === "blockchain.transaction.get") return raws.get(params[0] as string) as T;
    throw new Error(`unexpected ${method}`);
  }
  async subscribe(scripthash: string): Promise<string | null> {
    return scripthash === receive0 ? "status" : null;
  }
  onStatus(): () => void {
    return () => undefined;
  }
  async broadcast(_hex: string, txid: string): Promise<string> {
    return txid;
  }
  health() {
    return [{ url: "wss://fake.test", state: "ok", tip: 100, lastError: null }];
  }
  close(): void {}
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("GET_TRANSACTION", () => {
  it("describes a transaction in the wallet's history", async () => {
    const stores = new Map<string, MemoryStore>();
    const service = new WalletService({
      session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
      settings: new MemoryKeyValue(),
      connect: () => new FakeConnection(),
      openStore: async (id) => stores.get(id) ?? stores.set(id, new MemoryStore()).get(id)!,
    });
    expect(await service.handle({ type: "GET_TRANSACTION", txid: pay.txid })).toMatchObject({
      ok: false,
      code: "LOCKED",
    });
    await service.handle({
      type: "IMPORT_WALLET",
      mnemonic: VECTOR,
      password: "correct horse",
      network: "chipnet",
    });
    await settle();
    expect(await service.handle({ type: "GET_TRANSACTION", txid: pay.txid })).toEqual({
      ok: true,
      txid: pay.txid,
      direction: "received",
      net: 150_000,
      fee: 1_000,
      size: pay.hex.length / 2,
      height: 90,
      time: 100_000_000,
      confirmations: 11,
      tokens: [],
      counterparties: [{ address: OTHER.address(0, 1, "chipnet"), value: 49_000 }],
      receivedOn: [wallet.address(0, 0, "chipnet")],
      complete: true,
    });
    expect(await service.handle({ type: "GET_TRANSACTION", txid: parent.txid })).toMatchObject({
      ok: false,
      error: "this transaction is not in the wallet's history",
    });
  });
});
