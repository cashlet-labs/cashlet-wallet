import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { HdWallet } from "../src/wallet/hd";
import { p2pkhLockingBytecode, scripthashOf } from "../src/wallet/indexer";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

// Published BIP39 test vectors. Never use them for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const PASSWORD = "correct horse";
const wallet = HdWallet.fromMnemonic(VECTOR);
const receive0 = scripthashOf(p2pkhLockingBytecode(wallet.addressKey(0, 0).keyHash));

/** A network with one funded receive address. */
class FakeConnection implements Connection {
  readonly broadcasts: { hex: string; txid: string }[] = [];
  closed = false;
  currentServer = "wss://fake.test";
  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    if (method === "blockchain.relayfee") return 0.00001 as T;
    if (method === "blockchain.scripthash.listunspent") {
      return (
        params[0] === receive0
          ? [{ tx_hash: "aa".repeat(32), tx_pos: 0, value: 100_000, height: 10 }]
          : []
      ) as T;
    }
    if (method === "blockchain.scripthash.get_history") {
      return (params[0] === receive0 ? [{ tx_hash: "aa".repeat(32), height: 10 }] : []) as T;
    }
    if (method === "blockchain.block.header")
      return ("00".repeat(68) + "00e1f505" + "00".repeat(8)) as T;
    throw new Error(`unexpected ${method}`);
  }
  async subscribe(scripthash: string): Promise<string | null> {
    return scripthash === receive0 ? "status" : null;
  }
  onStatus(): () => void {
    return () => undefined;
  }
  async broadcast(hex: string, txid: string): Promise<string> {
    this.broadcasts.push({ hex, txid });
    return txid;
  }
  health() {
    return [{ url: "wss://fake.test", state: "ok", tip: 100, lastError: null }];
  }
  close(): void {
    this.closed = true;
  }
}

function setup() {
  const clock = { now: 1_000_000 };
  const connections: FakeConnection[] = [];
  const stores = new Map<string, MemoryStore>();
  const activity: number[] = [];
  const service = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000, now: () => clock.now }),
    settings: new MemoryKeyValue(),
    connect: () => {
      const connection = new FakeConnection();
      connections.push(connection);
      return connection;
    },
    openStore: async (id) => {
      const store = stores.get(id) ?? new MemoryStore();
      stores.set(id, store);
      return store;
    },
    now: () => clock.now,
    onActivity: (minutes) => activity.push(minutes),
  });
  return { service, connections, stores, activity, clock };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("WalletService", () => {
  it("imports a wallet, scans it and reports its balance and history", async () => {
    const { service } = setup();
    expect(
      await service.handle({
        type: "IMPORT_WALLET",
        mnemonic: VECTOR,
        password: PASSWORD,
        network: "chipnet",
      }),
    ).toMatchObject({ ok: true });
    await settle();
    expect(await service.handle({ type: "STATUS" })).toMatchObject({
      unlocked: true,
      network: "chipnet",
      scan: "ready",
    });
    expect(await service.handle({ type: "GET_BALANCE" })).toEqual({
      ok: true,
      confirmed: 100_000,
      unconfirmed: 0,
      tokens: [],
    });
    expect(await service.handle({ type: "GET_HISTORY" })).toEqual({
      ok: true,
      entries: [{ txid: "aa".repeat(32), height: 10, time: 100_000_000 }],
    });
    expect(await service.handle({ type: "GET_RECEIVE_ADDRESS", tokenAware: false })).toEqual({
      ok: true,
      index: 1,
      address: wallet.address(0, 1, "chipnet"),
    });
  });

  it("prepares a send, broadcasts exactly that plan once, and refuses reuse", async () => {
    const { service, connections } = setup();
    await service.handle({
      type: "IMPORT_WALLET",
      mnemonic: VECTOR,
      password: PASSWORD,
      network: "chipnet",
    });
    await settle();
    const prepared = await service.handle({
      type: "PREPARE_SEND",
      recipients: [{ address: OTHER.address(0, 0, "chipnet"), value: 25_000 }],
    });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.outgoing).toBe(25_000 + prepared.fee);
    expect(prepared.outputs.find((o) => !o.change)).toMatchObject({ value: 25_000 });
    const sent = await service.handle({ type: "CONFIRM_SEND", planId: prepared.planId });
    expect(sent).toMatchObject({ ok: true });
    expect(connections[0]?.broadcasts).toHaveLength(1);
    expect(await service.handle({ type: "CONFIRM_SEND", planId: prepared.planId })).toMatchObject({
      ok: false,
      error: "this send expired; prepare it again",
    });
  });

  it("expires a prepared send after two minutes", async () => {
    const { service, clock, connections } = setup();
    await service.handle({
      type: "IMPORT_WALLET",
      mnemonic: VECTOR,
      password: PASSWORD,
      network: "chipnet",
    });
    await settle();
    const prepared = await service.handle({
      type: "PREPARE_SEND",
      recipients: [{ address: OTHER.address(0, 0, "chipnet"), value: 25_000 }],
    });
    if (!prepared.ok) throw new Error(prepared.error);
    clock.now += 2 * 60_000 + 1;
    expect(await service.handle({ type: "CONFIRM_SEND", planId: prepared.planId })).toMatchObject({
      ok: false,
    });
    expect(connections[0]?.broadcasts).toHaveLength(0);
  });

  it("locks: drops plans and the connection, and answers LOCKED until unlocked", async () => {
    const { service, connections } = setup();
    await service.handle({
      type: "IMPORT_WALLET",
      mnemonic: VECTOR,
      password: PASSWORD,
      network: "chipnet",
    });
    await settle();
    const prepared = await service.handle({
      type: "PREPARE_SEND",
      recipients: [{ address: OTHER.address(0, 0, "chipnet"), value: 25_000 }],
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await service.handle({ type: "LOCK" });
    expect(connections[0]?.closed).toBe(true);
    expect(await service.handle({ type: "GET_BALANCE" })).toMatchObject({
      ok: false,
      code: "LOCKED",
    });
    expect(await service.handle({ type: "UNLOCK", password: "wrong password" })).toMatchObject({
      ok: false,
      code: "WRONG_PASSWORD",
    });
    expect(await service.handle({ type: "UNLOCK", password: PASSWORD })).toEqual({ ok: true });
    expect(await service.handle({ type: "CONFIRM_SEND", planId: prepared.planId })).toMatchObject({
      ok: false,
    });
  });

  it("restarts the auto-lock timer on activity, with the configured minutes", async () => {
    const { service, activity } = setup();
    await service.handle({
      type: "IMPORT_WALLET",
      mnemonic: VECTOR,
      password: PASSWORD,
      network: "chipnet",
    });
    await service.handle({ type: "SET_AUTO_LOCK", minutes: 5 });
    await service.handle({ type: "GET_BALANCE" });
    await service.handle({ type: "STATUS" });
    expect(activity).toEqual([15, 5, 5]);
  });

  it("removes a wallet with its password and deletes its scanned data", async () => {
    const { service, stores } = setup();
    const imported = await service.handle({
      type: "IMPORT_WALLET",
      mnemonic: VECTOR,
      password: PASSWORD,
      network: "chipnet",
    });
    if (!imported.ok) throw new Error(imported.error);
    await settle();
    expect((await stores.get(imported.id)?.utxos())?.length).toBe(1);
    expect(
      await service.handle({ type: "REMOVE_WALLET", walletId: imported.id, password: PASSWORD }),
    ).toEqual({ ok: true });
    expect(await stores.get(imported.id)?.utxos()).toEqual([]);
    expect(await service.handle({ type: "STATUS" })).toMatchObject({
      wallets: [],
      unlocked: false,
    });
  });
});

describe("feeRateFrom", () => {
  it("turns BCH per kB into sat/byte, between 1 and 10", async () => {
    const { feeRateFrom } = await import("../src/background/wallet-service");
    expect(feeRateFrom(0.00001)).toBe(1);
    expect(feeRateFrom(0.00002)).toBe(2);
    expect(feeRateFrom(0.000011)).toBe(2);
    expect(feeRateFrom(1)).toBe(10);
    expect(feeRateFrom(0)).toBe(1);
    expect(feeRateFrom("x")).toBe(1);
    expect(feeRateFrom(Number.NaN)).toBe(1);
  });
});
