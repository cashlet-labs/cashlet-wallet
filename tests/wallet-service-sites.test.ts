import { checkLoginResponse, verifyEventSignature, type LoginResponse } from "@cashlet-labs/bnd";
import { discoverBinding, publishBinding } from "@cashlet-labs/bnd/nostr";
import { createMemoryWebSocket, MemoryRelay } from "@cashlet-labs/bnd/testing";
import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { allRelayUrls, type RelayApi } from "../src/wallet/identity";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

// Published BIP39 test vector. Never use it for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse";
const SITE = "https://app.example";
const note = { kind: 1, content: "hello", tags: [], created_at: 1_795_200_000 };

class EmptyConnection implements Connection {
  currentServer = "wss://fake.test";
  async request<T>(method: string): Promise<T> {
    if (method === "blockchain.relayfee") return 0.00001 as T;
    return [] as T;
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

async function setup() {
  const relays: Record<string, MemoryRelay> = {};
  for (const url of allRelayUrls()) relays[url] = new MemoryRelay();
  const WebSocket = createMemoryWebSocket({ relays });
  const api: RelayApi = {
    discover: (key, urls) => discoverBinding(key, { relays: urls, WebSocket }),
    publish: (event, urls) => publishBinding(event, { relays: urls, WebSocket }),
  };
  const waiting: number[] = [];
  const service = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings: new MemoryKeyValue(),
    connect: () => new EmptyConnection(),
    openStore: async () => new MemoryStore(),
    relays: api,
    onApprovals: (n) => waiting.push(n),
  });
  await service.handle({
    type: "IMPORT_WALLET",
    mnemonic: VECTOR,
    password: PASSWORD,
    network: "chipnet",
  });
  return { service, waiting };
}

/** The first waiting request, once it is queued. */
async function next(service: WalletService) {
  for (let i = 0; i < 50; i++) {
    const list = await service.handle({ type: "APPROVALS_LIST" });
    if (list.ok && list.approvals[0]) return list.approvals[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("nothing is waiting");
}

describe("WalletService site requests", () => {
  it("asks before giving a site the Nostr key, then remembers the site", async () => {
    const { service, waiting } = await setup();
    const asked = service.page(SITE, { method: "nostr.getPublicKey" });
    const approval = await next(service);
    expect(approval).toMatchObject({ origin: SITE, type: "connect", rememberable: true });
    expect(waiting.at(-1)).toBe(1);
    await service.handle({
      type: "APPROVAL_DECIDE",
      id: approval.id,
      approve: true,
      remember: true,
    });
    const key = await asked;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(waiting.at(-1)).toBe(0);

    // Remembered: answered without asking, and listed under connected sites.
    expect(await service.page(SITE, { method: "nostr.getPublicKey" })).toBe(key);
    expect(await service.handle({ type: "SITES_LIST" })).toMatchObject({
      sites: [{ origin: SITE, kinds: [] }],
    });
    // Another site still has to ask.
    void service.page("https://other.example", { method: "nostr.getPublicKey" }).catch(() => 0);
    expect(await next(service)).toMatchObject({ origin: "https://other.example" });
  });

  it("signs the exact event only after approval, and a rejection reaches the page", async () => {
    const { service } = await setup();
    const rejected = service.page(SITE, { method: "nostr.signEvent", event: note });
    const first = await next(service);
    expect(first).toMatchObject({ type: "sign", event: note, rememberable: true });
    await service.handle({
      type: "APPROVAL_DECIDE",
      id: first.id,
      approve: false,
      remember: false,
    });
    await expect(rejected).rejects.toThrow("the user rejected the request");

    const signed = service.page(SITE, { method: "nostr.signEvent", event: note });
    const second = await next(service);
    await service.handle({ type: "APPROVAL_DECIDE", id: second.id, approve: true, remember: true });
    const event = (await signed) as { kind: number; content: string; pubkey: string };
    expect(verifyEventSignature(event)).toBe(true);
    expect(event).toMatchObject({ kind: 1, content: "hello" });
    // Kind 1 is now allowed for this site without asking.
    expect(
      verifyEventSignature(await service.page(SITE, { method: "nostr.signEvent", event: note })),
    ).toBe(true);
  });

  it("never remembers a profile change", async () => {
    const { service } = await setup();
    const profile = { ...note, kind: 0, content: "{}" };
    void service.page(SITE, { method: "nostr.signEvent", event: profile });
    const approval = await next(service);
    expect(approval.rememberable).toBe(false);
    await service.handle({
      type: "APPROVAL_DECIDE",
      id: approval.id,
      approve: true,
      remember: true,
    });
    void service.page(SITE, { method: "nostr.signEvent", event: profile }).catch(() => 0);
    expect(await next(service)).toMatchObject({ type: "sign" });
  });

  it("drops a request when the page closes, and limits how many wait", async () => {
    const { service } = await setup();
    const closed = new AbortController();
    const asked = service.page(SITE, { method: "nostr.getPublicKey" }, closed.signal);
    await next(service);
    closed.abort();
    await expect(asked).rejects.toThrow("the page was closed");
    expect(await service.handle({ type: "APPROVALS_LIST" })).toMatchObject({ approvals: [] });

    const many = Array.from({ length: 6 }, () =>
      service.page(SITE, { method: "nostr.getPublicKey" }).catch((e: Error) => e.message),
    );
    expect(await many[5]).toBe("this site has too many requests waiting");
  });

  it("answers a BND login challenge with a response the site can verify", async () => {
    const { service } = await setup();
    await service.handle({ type: "IDENTITY_BIND" });
    const now = Math.floor(Date.now() / 1000);
    const challenge = {
      nonce: "ab".repeat(32),
      audience: `${SITE}/login`,
      level: "dual" as const,
      issuedAt: now,
      expiresAt: now + 300,
    };
    const answered = service.page(SITE, { method: "bnd.login", challenge });
    const approval = await next(service);
    expect(approval).toMatchObject({
      type: "login",
      rememberable: false,
      login: { audience: `${SITE}/login`, level: "dual" },
    });
    await service.handle({
      type: "APPROVAL_DECIDE",
      id: approval.id,
      approve: true,
      remember: true,
    });
    const response = (await answered) as LoginResponse;
    expect(checkLoginResponse(challenge, response, now)).toMatchObject({ ok: true });
    expect(response.bchProof?.type).toBe("message");
  });

  it("keeps a request waiting while locked and asks again after unlocking", async () => {
    const { service } = await setup();
    await service.handle({ type: "LOCK" });
    const asked = service.page(SITE, { method: "nostr.getPublicKey" });
    const approval = await next(service);
    expect(
      await service.handle({
        type: "APPROVAL_DECIDE",
        id: approval.id,
        approve: true,
        remember: false,
      }),
    ).toMatchObject({ ok: false, code: "LOCKED" });
    await service.handle({ type: "UNLOCK", password: PASSWORD });
    await service.handle({
      type: "APPROVAL_DECIDE",
      id: approval.id,
      approve: true,
      remember: false,
    });
    expect(await asked).toMatch(/^[0-9a-f]{64}$/);
  });
});
