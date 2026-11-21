import { verifyBinding, type NostrEvent } from "@cashlet-labs/bnd";
import { resolveDidFromEvents } from "@cashlet-labs/bnd/did";
import { discoverBinding, publishBinding } from "@cashlet-labs/bnd/nostr";
import { createMemoryWebSocket, MemoryRelay } from "@cashlet-labs/bnd/testing";
import { describe, expect, it } from "vitest";
import { HdWallet } from "../src/wallet/hd";
import { ENFORCING_RELAYS, Identity, type RelayApi } from "../src/wallet/identity";
import { MemoryKeyValue } from "../src/wallet/session";

// Published BIP39 test vector. Never use it for funds.
const wallet = HdWallet.fromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const PUBLIC = "wss://public.test";

/** BND's own relay client against in-memory relays: the code the extension runs. */
function setup(options: { down?: string[] } = {}) {
  const relays: Record<string, MemoryRelay | "refuse"> = {};
  for (const url of [...ENFORCING_RELAYS, PUBLIC])
    relays[url] = options.down?.includes(url) ? "refuse" : new MemoryRelay();
  const WebSocket = createMemoryWebSocket({ relays });
  const api: RelayApi = {
    discover: (key, urls) => discoverBinding(key, { relays: urls, WebSocket }),
    publish: (event, urls) => publishBinding(event, { relays: urls, WebSocket }),
  };
  const clock = { now: 1_795_200_000 };
  const settings = new MemoryKeyValue();
  const identity = new Identity(wallet, "chipnet", "w1", api, settings, [PUBLIC], () => clock.now);
  const events = (url: string) =>
    (relays[url] as MemoryRelay).query([{ kinds: [30078] }]) as NostrEvent[];
  return { identity, clock, settings, events, relays };
}

describe("Identity", () => {
  it("starts unbound, then binds the wallet's Nostr key to receive address 0", async () => {
    const { identity, events } = setup();
    const before = await identity.status();
    expect(before).toMatchObject({
      state: "none",
      did: null,
      address: wallet.address(0, 0, "chipnet"),
    });
    expect(before.npub).toMatch(/^npub1/);

    const { accepted, did } = await identity.bind();
    expect(accepted.sort()).toEqual([...ENFORCING_RELAYS, PUBLIC].sort());
    expect(did).toMatch(/^did:bnd:chipnet:[0-9a-f]{64}:[0-9a-f]{64}$/);
    const after = await identity.status();
    expect(after).toMatchObject({ state: "current", did });

    const [event] = events(ENFORCING_RELAYS[0]);
    const verified = verifyBinding(event);
    expect(verified.ok && verified.proofType).toBe("message");
  });

  it("publishes only to the enforcing relays when public relays are turned off", async () => {
    const { identity, events } = setup();
    await identity.setPublicRelays(false);
    const { accepted } = await identity.bind();
    expect(accepted.sort()).toEqual([...ENFORCING_RELAYS].sort());
    expect(events(PUBLIC)).toHaveLength(0);
  });

  it("refuses to bind twice, or when too few relays answer", async () => {
    const { identity } = setup();
    await identity.bind();
    await expect(identity.bind()).rejects.toThrow("already current");
    const down = setup({ down: [...ENFORCING_RELAYS] });
    await expect(down.identity.status()).resolves.toMatchObject({ state: "unknown" });
    await expect(down.identity.bind()).rejects.toThrow("too few relays");
  });

  it("rotates the BCH key to a new address and keeps the DID", async () => {
    const { identity, clock, events } = setup();
    const { did } = await identity.bind();
    clock.now += 10;
    const rotated = await identity.rotate("bch", 3);
    expect(rotated.did).toBe(did);
    expect(await identity.keys()).toEqual({ bchIndex: 3, nostrAccount: 0 });
    expect(await identity.status()).toMatchObject({
      state: "current",
      did,
      address: wallet.address(0, 3, "chipnet"),
    });
    // The DID resolves to the new address from the relay's events.
    const resolved = resolveDidFromEvents(did, events(ENFORCING_RELAYS[0]));
    expect(JSON.stringify(resolved.didDocument)).toContain(
      wallet.address(0, 3, "chipnet").split(":")[1],
    );
  });

  it("rotates the Nostr key to the next account and keeps the DID", async () => {
    const { identity, clock } = setup();
    const { did } = await identity.bind();
    const oldNpub = (await identity.status()).npub;
    clock.now += 10;
    expect((await identity.rotate("nostr")).did).toBe(did);
    const status = await identity.status();
    expect(status).toMatchObject({ state: "current", did });
    expect(status.npub).not.toBe(oldNpub);
    expect(status.nostrPublicKey).toBe(wallet.nostrKey(1).publicKey);
  });

  it("revokes the identity", async () => {
    const { identity, clock } = setup();
    await identity.bind();
    clock.now += 10;
    await identity.revoke();
    expect(await identity.status()).toMatchObject({ state: "revoked" });
    await expect(identity.revoke()).rejects.toThrow("revoked");
    await expect(identity.rotate("bch")).rejects.toThrow("revoked");
  });

  it("refuses to change an identity it has not bound", async () => {
    const { identity } = setup();
    await expect(identity.rotate("bch")).rejects.toThrow("no identity yet");
  });
});
