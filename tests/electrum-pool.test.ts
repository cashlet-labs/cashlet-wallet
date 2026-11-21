import { describe, expect, it } from "vitest";
import { ElectrumRpcError } from "../src/electrum/errors";
import { ElectrumPool } from "../src/electrum/pool";
import { FakeNetwork, makeHeader, type FakeServer } from "./fake-electrum";

const GOOD = makeHeader(1);
const OTHER_CHAIN = makeHeader(2);
const [A, B, C] = ["wss://a.test", "wss://b.test", "wss://c.test"] as const;
const TXID = "11".repeat(32);
const SCRIPTHASH = "ab".repeat(32);

const RPC_DISABLED = {
  code: 2,
  message: "daemon error: DaemonError({'code': -100, 'message': 'RPC is disabled. ... expire=0.'})",
};

function setup(servers: Record<string, Partial<FakeServer>>, clock?: { now: number }) {
  const network = new FakeNetwork();
  for (const [url, server] of Object.entries(servers)) {
    network.add(url, { tip: 1000, header: GOOD.hex, ...server });
  }
  const pool = new ElectrumPool({
    servers: Object.keys(servers),
    checkpoint: { height: 100, hash: GOOD.hash },
    createSocket: network.factory,
    timing: { connectTimeoutMs: 200, requestTimeoutMs: 100 },
    ...(clock ? { now: () => clock.now } : {}),
  });
  return { network, pool };
}

const answer = (method: string, result: unknown) => (m: string) =>
  m === method ? { result } : undefined;

describe("ElectrumPool", () => {
  it("uses the first good server", async () => {
    const { network, pool } = setup({
      [A]: { handle: answer("blockchain.relayfee", 0.00001) },
      [B]: {},
    });
    expect(await pool.request("blockchain.relayfee")).toBe(0.00001);
    expect(pool.currentServer).toBe(A);
    expect(network.callsTo(A, "blockchain.block.header")).toBeGreaterThan(0);
    pool.close();
  });

  it("refuses a server on another chain", async () => {
    const { pool } = setup({ [A]: { header: OTHER_CHAIN.hex }, [B]: {} });
    await pool.request("server.version", ["x", "1.5"]).catch(() => undefined);
    expect(pool.currentServer).toBe(B);
    expect(pool.health()[0]).toMatchObject({
      url: A,
      state: "cooling",
      lastError: `${A} is on another chain`,
    });
    pool.close();
  });

  it("refuses a server that is far behind the others", async () => {
    const { pool } = setup({ [A]: { tip: 900 }, [B]: { tip: 1000 }, [C]: { tip: 1000 } });
    await pool.subscribe(SCRIPTHASH);
    expect(pool.currentServer).toBe(B);
    expect(pool.health()[0]?.lastError).toBe(`${A} is 100 blocks behind`);
    pool.close();
  });

  it("accepts a server a block or two behind", async () => {
    const { pool } = setup({ [A]: { tip: 998 }, [B]: { tip: 1000 } });
    await pool.subscribe(SCRIPTHASH);
    expect(pool.currentServer).toBe(A);
    pool.close();
  });

  it("fails over when the node's RPC is disabled", async () => {
    const { network, pool } = setup({
      [A]: {
        handle: (m) => (m === "blockchain.transaction.get" ? { error: RPC_DISABLED } : undefined),
      },
      [B]: { handle: answer("blockchain.transaction.get", "0200") },
    });
    expect(await pool.request("blockchain.transaction.get", [TXID])).toBe("0200");
    expect(pool.currentServer).toBe(B);
    expect(network.callsTo(A, "blockchain.transaction.get")).toBe(1);
    expect(pool.health()[0]?.state).toBe("cooling");
    pool.close();
  });

  it("returns an honest answer without failing over", async () => {
    const noSuchTx = {
      code: 2,
      message:
        "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction.'})",
    };
    const { network, pool } = setup({
      [A]: {
        handle: (m) => (m === "blockchain.transaction.get" ? { error: noSuchTx } : undefined),
      },
      [B]: {},
    });
    await expect(pool.request("blockchain.transaction.get", [TXID])).rejects.toBeInstanceOf(
      ElectrumRpcError,
    );
    expect(pool.currentServer).toBe(A);
    expect(network.callsTo(B, "blockchain.transaction.get")).toBe(0);
    pool.close();
  });

  it("fails over when a server stops answering", async () => {
    const { pool } = setup({
      [A]: { handle: (m) => (m === "blockchain.relayfee" ? "silent" : undefined) },
      [B]: { handle: answer("blockchain.relayfee", 0.00001) },
    });
    expect(await pool.request("blockchain.relayfee")).toBe(0.00001);
    expect(pool.currentServer).toBe(B);
    pool.close();
  });

  describe("broadcast", () => {
    const broadcast = (reply: unknown) => (m: string) =>
      m === "blockchain.transaction.broadcast" ? (reply as { result: unknown }) : undefined;

    it("returns the txid when the server agrees", async () => {
      const { pool } = setup({ [A]: { handle: broadcast({ result: TXID }) } });
      expect(await pool.broadcast("0200", TXID)).toBe(TXID);
      pool.close();
    });

    it("moves on when a node with RPC disabled answers with code 1", async () => {
      const rejectedRpcDisabled = {
        code: 1,
        message:
          "the transaction was rejected by network rules.\n\nRPC is disabled. ... expire=0.\n",
      };
      const { pool } = setup({
        [A]: { handle: broadcast({ error: rejectedRpcDisabled }) },
        [B]: { handle: broadcast({ result: TXID }) },
      });
      expect(await pool.broadcast("0200", TXID)).toBe(TXID);
      expect(pool.currentServer).toBe(B);
      pool.close();
    });

    it("stops at a real rejection", async () => {
      const rejected = {
        code: 1,
        message: "the transaction was rejected by network rules.\n\nTX decode failed\n",
      };
      const { network, pool } = setup({ [A]: { handle: broadcast({ error: rejected }) }, [B]: {} });
      await expect(pool.broadcast("0200", TXID)).rejects.toThrow("TX decode failed");
      expect(network.callsTo(B, "blockchain.transaction.broadcast")).toBe(0);
      pool.close();
    });

    it("refuses a different txid and tries another server", async () => {
      const { pool } = setup({
        [A]: { handle: broadcast({ result: "22".repeat(32) }) },
        [B]: { handle: broadcast({ result: TXID }) },
      });
      expect(await pool.broadcast("0200", TXID)).toBe(TXID);
      expect(pool.health()[0]?.lastError).toBe(`${A} returned a different txid`);
      pool.close();
    });

    it("treats an already-known transaction as sent", async () => {
      const known = {
        code: 1,
        message: "the transaction was rejected by network rules.\n\ntxn-already-known\n",
      };
      const { pool } = setup({ [A]: { handle: broadcast({ error: known }) } });
      expect(await pool.broadcast("0200", TXID)).toBe(TXID);
      pool.close();
    });
  });

  describe("subscriptions", () => {
    it("forwards status notifications for subscribed addresses only", async () => {
      const { network, pool } = setup({ [A]: {} });
      const seen: [string, string | null][] = [];
      pool.onStatus((sh, status) => seen.push([sh, status]));
      expect(await pool.subscribe(SCRIPTHASH)).toBeNull();
      network.push(A, "blockchain.scripthash.subscribe", [SCRIPTHASH, "s1"]);
      network.push(A, "blockchain.scripthash.subscribe", ["cd".repeat(32), "x"]);
      await new Promise((r) => setTimeout(r, 5));
      expect(seen).toEqual([[SCRIPTHASH, "s1"]]);
      pool.close();
    });

    it("replays them on a new server after a drop and reports changes", async () => {
      const { network, pool } = setup({ [A]: {}, [B]: {} });
      network.servers.get(A)?.statuses?.set(SCRIPTHASH, "old");
      network.servers.get(B)?.statuses?.set(SCRIPTHASH, "new");
      const seen: (string | null)[] = [];
      pool.onStatus((_, status) => seen.push(status));
      expect(await pool.subscribe(SCRIPTHASH)).toBe("old");
      network.drop(A);
      await new Promise((r) => setTimeout(r, 30));
      expect(pool.currentServer).toBe(B);
      expect(network.callsTo(B, "blockchain.scripthash.subscribe")).toBe(1);
      expect(seen).toEqual(["new"]);
      pool.close();
    });

    it("does not report an unchanged status after a replay", async () => {
      const { network, pool } = setup({ [A]: {}, [B]: {} });
      network.servers.get(A)?.statuses?.set(SCRIPTHASH, "same");
      network.servers.get(B)?.statuses?.set(SCRIPTHASH, "same");
      const seen: (string | null)[] = [];
      pool.onStatus((_, status) => seen.push(status));
      await pool.subscribe(SCRIPTHASH);
      network.drop(A);
      await new Promise((r) => setTimeout(r, 30));
      expect(pool.currentServer).toBe(B);
      expect(seen).toEqual([]);
      pool.close();
    });
  });

  describe("cooling down", () => {
    it("skips a faulty server until its wait is over, then tries it again", async () => {
      const clock = { now: 1_000_000 };
      const { pool } = setup({ [A]: { header: OTHER_CHAIN.hex }, [B]: {} }, clock);
      await pool.subscribe(SCRIPTHASH);
      expect(pool.health()[0]).toMatchObject({
        state: "cooling",
        failures: 1,
        coolingUntil: 1_060_000,
      });
      clock.now += 61_000;
      expect(pool.health()[0]?.state).toBe("unknown");
      pool.close();
    });

    it("doubles the wait after repeated faults", async () => {
      const clock = { now: 0 };
      const { pool } = setup({ [A]: { header: OTHER_CHAIN.hex } }, clock);
      await pool.request("x").catch(() => undefined);
      clock.now = 61_000;
      await pool.request("x").catch(() => undefined);
      expect(pool.health()[0]).toMatchObject({ failures: 2, coolingUntil: 61_000 + 120_000 });
      pool.close();
    });

    it("explains why no server could be used", async () => {
      const { pool } = setup({ [A]: { down: true }, [B]: { header: OTHER_CHAIN.hex } });
      await expect(pool.request("x")).rejects.toThrow(
        /no usable Electrum server: .*cannot connect.*another chain/,
      );
      pool.close();
    });
  });

  it("drops the current server when a periodic check finds it behind", async () => {
    const { network, pool } = setup({ [A]: { tip: 1000 }, [B]: { tip: 1000 } });
    await pool.subscribe(SCRIPTHASH);
    expect(pool.currentServer).toBe(A);
    const b = network.servers.get(B);
    if (b) b.tip = 1010;
    await pool.checkFreshness();
    expect(pool.health()[0]?.lastError).toBe(`${A} is 10 blocks behind`);
    await new Promise((r) => setTimeout(r, 30));
    expect(pool.currentServer).toBe(B);
    pool.close();
  });
});
