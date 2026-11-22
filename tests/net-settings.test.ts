import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { NETWORKS } from "../src/electrum/servers";
import { parseRequest } from "../src/shared/messages";
import {
  isBuiltInServer,
  loadFeeRate,
  loadPreferredServer,
  orderServers,
  saveFeeRate,
  savePreferredServer,
} from "../src/wallet/net-settings";
import { HdWallet } from "../src/wallet/hd";
import { p2pkhLockingBytecode, scripthashOf } from "../src/wallet/indexer";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const wallet = HdWallet.fromMnemonic(VECTOR);
const receive0 = scripthashOf(p2pkhLockingBytecode(wallet.addressKey(0, 0).keyHash));
const GOOD = NETWORKS.chipnet.servers[1]!;

describe("messages", () => {
  it("validates the fee rate", () => {
    expect(parseRequest({ type: "SET_FEE_RATE", rate: 5 })).toEqual({
      type: "SET_FEE_RATE",
      rate: 5,
    });
    expect(parseRequest({ type: "SET_FEE_RATE", rate: null })).toEqual({
      type: "SET_FEE_RATE",
      rate: null,
    });
    for (const rate of [0, 11, 1.5, -1, "2", NaN, undefined]) {
      expect(parseRequest({ type: "SET_FEE_RATE", rate })).toHaveProperty("error");
    }
  });

  it("validates the preferred server against the built-in list", () => {
    expect(parseRequest({ type: "SET_PREFERRED_SERVER", network: "chipnet", url: GOOD })).toEqual({
      type: "SET_PREFERRED_SERVER",
      network: "chipnet",
      url: GOOD,
    });
    expect(parseRequest({ type: "SET_PREFERRED_SERVER", network: "mainnet", url: null })).toEqual({
      type: "SET_PREFERRED_SERVER",
      network: "mainnet",
      url: null,
    });
    for (const url of ["wss://evil.example:50004", NETWORKS.mainnet.servers[0], "", 1]) {
      expect(
        parseRequest({ type: "SET_PREFERRED_SERVER", network: "chipnet", url }),
      ).toHaveProperty("error");
    }
    expect(parseRequest({ type: "SET_PREFERRED_SERVER", network: "chipnet" })).toHaveProperty(
      "error",
    );
  });

  it("accepts max only for one plain BCH recipient", () => {
    const address = OTHER.address(0, 0, "chipnet");
    expect(
      parseRequest({ type: "PREPARE_SEND", recipients: [{ address, value: 0 }], max: true }),
    ).toMatchObject({ max: true });
    expect(
      parseRequest({ type: "PREPARE_SEND", recipients: [{ address, value: 0 }], max: false }),
    ).toHaveProperty("error");
    expect(
      parseRequest({
        type: "PREPARE_SEND",
        recipients: [
          { address, value: 0 },
          { address, value: 0 },
        ],
        max: true,
      }),
    ).toHaveProperty("error");
    expect(
      parseRequest({
        type: "PREPARE_SEND",
        recipients: [{ address, value: 0, token: { category: "ab".repeat(32), amount: "1" } }],
        max: true,
      }),
    ).toHaveProperty("error");
    expect(parseRequest({ type: "GET_MAX_SEND", address })).toEqual({
      type: "GET_MAX_SEND",
      address,
    });
    expect(parseRequest({ type: "GET_MAX_SEND" })).toHaveProperty("error");
  });
});

describe("stored settings", () => {
  it("round-trips and ignores invalid stored values", async () => {
    const kv = new MemoryKeyValue();
    expect(await loadFeeRate(kv)).toBeNull();
    await saveFeeRate(kv, 4);
    expect(await loadFeeRate(kv)).toBe(4);
    await kv.set("feeRate", 999);
    expect(await loadFeeRate(kv)).toBeNull();
    await saveFeeRate(kv, null);
    expect(await loadFeeRate(kv)).toBeNull();

    await savePreferredServer(kv, "chipnet", GOOD);
    expect(await loadPreferredServer(kv, "chipnet")).toBe(GOOD);
    expect(await loadPreferredServer(kv, "mainnet")).toBeNull();
    await kv.set("preferredServer:chipnet", "wss://evil.example:1");
    expect(await loadPreferredServer(kv, "chipnet")).toBeNull();
  });

  it("puts the preferred server first and keeps the others for failover", () => {
    const list = NETWORKS.mainnet.servers;
    expect(orderServers(list, list[2]!)).toEqual([list[2], list[0], list[1], list[3], list[4]]);
    expect(orderServers(list, null)).toEqual([...list]);
    expect(orderServers(list, "wss://unknown")).toEqual([...list]);
    expect(isBuiltInServer("mainnet", GOOD)).toBe(false);
  });
});

class Fake implements Connection {
  broadcasts = 0;
  currentServer = null;
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
  async broadcast(_hex: string, txid: string): Promise<string> {
    this.broadcasts += 1;
    return txid;
  }
  health() {
    return [];
  }
  close(): void {}
}

const settle = () => new Promise((r) => setTimeout(r, 20));

function setup() {
  const preferred: (string | null | undefined)[] = [];
  const settings = new MemoryKeyValue();
  const service = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings,
    connect: (_network, preferredServer) => {
      preferred.push(preferredServer);
      return new Fake();
    },
    openStore: async () => new MemoryStore(),
  });
  return { service, preferred };
}

const create = (service: WalletService) =>
  service.handle({
    type: "IMPORT_WALLET",
    mnemonic: VECTOR,
    password: "correct horse",
    network: "chipnet",
  });

describe("WalletService network settings", () => {
  it("prepares a max send with the fee, no change and the amount from GET_MAX_SEND", async () => {
    const { service } = setup();
    await create(service);
    await settle();
    const address = OTHER.address(0, 0, "chipnet");
    const max = await service.handle({ type: "GET_MAX_SEND", address });
    if (!max.ok) throw new Error(max.error);
    expect(max.value + max.fee).toBe(100_000);
    const prepared = await service.handle({
      type: "PREPARE_SEND",
      recipients: [{ address, value: 0 }],
      max: true,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.fee).toBe(max.fee);
    expect(prepared.outputs).toHaveLength(1);
    expect(prepared.outputs[0]).toMatchObject({ value: max.value, change: false });
    expect(prepared.outgoing).toBe(100_000);
  });

  it("uses the chosen fee rate and falls back to automatic", async () => {
    const { service } = setup();
    await create(service);
    await settle();
    const address = OTHER.address(0, 0, "chipnet");
    const auto = await service.handle({ type: "GET_MAX_SEND", address });
    await service.handle({ type: "SET_FEE_RATE", rate: 4 });
    const chosen = await service.handle({ type: "GET_MAX_SEND", address });
    if (!auto.ok || !chosen.ok) throw new Error("failed");
    expect(chosen.fee).toBe(auto.fee * 4);
    expect(await service.handle({ type: "GET_NETWORK_SETTINGS" })).toMatchObject({
      ok: true,
      network: "chipnet",
      feeRate: 4,
      minFeeRate: 1,
      maxFeeRate: 10,
      servers: NETWORKS.chipnet.servers,
      preferredServer: null,
    });
    await service.handle({ type: "SET_FEE_RATE", rate: null });
    expect(await service.handle({ type: "GET_MAX_SEND", address })).toEqual(auto);
  });

  it("passes the preferred server to the connection on the next unlock", async () => {
    const { service, preferred } = setup();
    await create(service);
    await settle();
    expect(preferred).toEqual([null]);
    await service.handle({ type: "SET_PREFERRED_SERVER", network: "chipnet", url: GOOD });
    expect(await service.handle({ type: "GET_NETWORK_SETTINGS" })).toMatchObject({
      preferredServer: GOOD,
    });
    await service.handle({ type: "LOCK" });
    await service.handle({ type: "UNLOCK", password: "correct horse" });
    await settle();
    expect(preferred).toEqual([null, GOOD]);
  });
});
