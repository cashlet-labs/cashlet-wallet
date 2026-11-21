import { resolvePayee } from "@cashlet-labs/bnd/did";
import { discoverBinding, publishBinding } from "@cashlet-labs/bnd/nostr";
import { createMemoryWebSocket, MemoryRelay } from "@cashlet-labs/bnd/testing";
import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { HdWallet } from "../src/wallet/hd";
import { allRelayUrls, Identity, PUBLIC_RELAYS, type RelayApi } from "../src/wallet/identity";
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

/** An empty network: every address is unused. */
class EmptyConnection implements Connection {
  currentServer = "wss://fake.test";
  async request<T>(method: string): Promise<T> {
    if (method === "blockchain.relayfee") return 0.00001 as T;
    if (method.startsWith("blockchain.scripthash.")) return [] as T;
    throw new Error(`unexpected ${method}`);
  }
  async subscribe(): Promise<string | null> {
    return null;
  }
  onStatus(): () => void {
    return () => undefined;
  }
  async broadcast(_hex: string, txid: string): Promise<string> {
    return txid;
  }
  health() {
    return [];
  }
  close(): void {}
}

/** The service against in-memory relays at every URL the extension may reach. */
function setup() {
  const relays: Record<string, MemoryRelay> = {};
  for (const url of allRelayUrls()) relays[url] = new MemoryRelay();
  const WebSocket = createMemoryWebSocket({ relays });
  const api: RelayApi = {
    discover: (key, urls) => discoverBinding(key, { relays: urls, WebSocket }),
    publish: (event, urls) => publishBinding(event, { relays: urls, WebSocket }),
  };
  const service = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings: new MemoryKeyValue(),
    connect: () => new EmptyConnection(),
    openStore: async () => new MemoryStore(),
    relays: api,
    resolvePayee: (target, urls) => resolvePayee(target, { relays: urls, WebSocket }),
  });
  /** Another wallet's identity on the same relays. */
  const other = (network: "mainnet" | "chipnet") =>
    new Identity(OTHER, network, "other", api, new MemoryKeyValue(), PUBLIC_RELAYS);
  return { service, other };
}

async function imported() {
  const { service, other } = setup();
  await service.handle({
    type: "IMPORT_WALLET",
    mnemonic: VECTOR,
    password: PASSWORD,
    network: "chipnet",
  });
  await new Promise((r) => setTimeout(r, 20));
  return { service, other };
}

describe("WalletService identity", () => {
  it("binds, rotates to an unused address, and keeps the DID", async () => {
    const { service } = await imported();
    expect(await service.handle({ type: "IDENTITY_STATUS" })).toMatchObject({
      ok: true,
      state: "none",
      address: wallet.address(0, 0, "chipnet"),
      relays: { complete: allRelayUrls().length, asked: allRelayUrls().length },
      publicRelays: true,
    });
    const bound = await service.handle({ type: "IDENTITY_BIND" });
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.accepted.sort()).toEqual(allRelayUrls().sort());

    const rotated = await service.handle({ type: "IDENTITY_ROTATE", key: "bch" });
    expect(rotated).toMatchObject({ ok: true, did: bound.did });
    expect(await service.handle({ type: "IDENTITY_STATUS" })).toMatchObject({
      state: "current",
      did: bound.did,
      address: wallet.address(0, 1, "chipnet"),
    });

    const before = await service.handle({ type: "IDENTITY_STATUS" });
    if (!before.ok) throw new Error(before.error);
    expect(await service.handle({ type: "IDENTITY_ROTATE", key: "nostr" })).toMatchObject({
      ok: true,
      did: bound.did,
    });
    const after = await service.handle({ type: "IDENTITY_STATUS" });
    expect(after).toMatchObject({ state: "current", did: bound.did });
    expect(after.ok && after.npub).not.toBe(before.npub);
  });

  it("revokes only with the right password", async () => {
    const { service } = await imported();
    await service.handle({ type: "IDENTITY_BIND" });
    expect(
      await service.handle({ type: "IDENTITY_REVOKE", password: "wrong password" }),
    ).toMatchObject({ ok: false, code: "WRONG_PASSWORD" });
    expect(await service.handle({ type: "IDENTITY_STATUS" })).toMatchObject({ state: "current" });
    expect(await service.handle({ type: "IDENTITY_REVOKE", password: PASSWORD })).toMatchObject({
      ok: true,
    });
    expect(await service.handle({ type: "IDENTITY_STATUS" })).toMatchObject({ state: "revoked" });
  });

  it("publishes to the enforcing relays only when public relays are off", async () => {
    const { service } = await imported();
    expect(await service.handle({ type: "IDENTITY_PUBLIC_RELAYS", enabled: false })).toMatchObject({
      ok: true,
    });
    const bound = await service.handle({ type: "IDENTITY_BIND" });
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.accepted.sort()).toEqual(
      ["wss://relay.bongacash.co.ke", "wss://relay.septemlabs.com"].sort(),
    );
  });

  it("resolves an npub or DID to its verified address", async () => {
    const { service, other } = await imported();
    const { did } = await other("chipnet").bind();
    const { npub } = await other("chipnet").status();
    const expected = {
      ok: true,
      address: OTHER.address(0, 0, "chipnet"),
      tokenAddress: OTHER.address(0, 0, "chipnet", true),
      did,
      npub,
    };
    expect(await service.handle({ type: "RESOLVE_PAYEE", target: npub })).toEqual(expected);
    expect(await service.handle({ type: "RESOLVE_PAYEE", target: did })).toEqual(expected);
  });

  it("refuses to resolve an identity on another network, or one with no binding", async () => {
    const { service, other } = await imported();
    const { npub } = await other("mainnet").status();
    expect(await service.handle({ type: "RESOLVE_PAYEE", target: npub })).toMatchObject({
      ok: false,
      error: "no verified binding was found for this key",
    });
    await other("mainnet").bind();
    expect(await service.handle({ type: "RESOLVE_PAYEE", target: npub })).toMatchObject({
      ok: false,
      error: "this identity is on mainnet, not chipnet",
    });
  });
});
