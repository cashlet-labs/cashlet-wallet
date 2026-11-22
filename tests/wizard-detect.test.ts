import { encodeKeyExchangeURI, generateKeyExchangeCredentials } from "@wizardconnect/core";
import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import type { WizardManager } from "../src/background/wizard";
import { MAX_PROMPTS_PER_WINDOW, WINDOW_MS } from "../src/background/wizard-detect";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

// Published BIP39 test vector. Never use it for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SITE = "https://app.example";

const newLink = () => {
  const { publicKey, secret } = generateKeyExchangeCredentials();
  return encodeKeyExchangeURI(publicKey, secret).uri;
};

class FakeManager implements WizardManager {
  readonly uris: string[] = [];
  connect(uri: string): string {
    this.uris.push(uri);
    return `c${this.uris.length}`;
  }
  disconnect(): void {}
  disconnectAll(): void {}
  getConnections() {
    return Object.fromEntries(
      this.uris.map((_, i) => [
        `c${i + 1}`,
        { id: `c${i + 1}`, status: { status: "connecting" }, dappName: null, connectedAt: 1 },
      ]),
    );
  }
  async sendSignResponse() {}
  async sendSignError() {}
  on() {
    return this;
  }
}

class EmptyConnection implements Connection {
  currentServer = "wss://fake.test";
  async request<T>(): Promise<T> {
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
  let manager!: FakeManager;
  let time = 1_000_000;
  const svc = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings: new MemoryKeyValue(),
    connect: () => new EmptyConnection(),
    openStore: async () => new MemoryStore(),
    wizardManager: () => (manager = new FakeManager()),
    now: () => time,
  });
  await svc.handle({
    type: "IMPORT_WALLET",
    mnemonic: VECTOR,
    password: "correct horse",
    network: "chipnet",
  });
  const approvals = async () => {
    const list = await svc.handle({ type: "APPROVALS_LIST" });
    if (!list.ok) throw new Error(list.error);
    return list.approvals;
  };
  const decide = async (approve: boolean) => {
    const [first] = await approvals();
    await svc.handle({ type: "APPROVAL_DECIDE", id: first!.id, approve, remember: false });
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    svc,
    approvals,
    decide,
    manager: () => manager,
    advance: (ms: number) => (time += ms),
  };
}

describe("WizardConnect links found on pages", () => {
  it("connects nothing until the user approves, then records the site", async () => {
    const { svc, approvals, decide, manager } = await setup();
    const uri = newLink();
    void svc.detectWizard(SITE, uri);
    await new Promise((r) => setTimeout(r, 0));
    expect(await approvals()).toMatchObject([{ origin: SITE, type: "wizard" }]);
    expect(manager()).toBeUndefined();

    await decide(true);
    expect(manager().uris).toEqual([uri]);
    const list = await svc.handle({ type: "WIZARD_LIST" });
    expect(list).toMatchObject({ ok: true, connections: [{ id: "c1", origin: SITE }] });
    expect(await approvals()).toEqual([]);
  });

  it("connects nothing when the user rejects, and does not ask again about the same link", async () => {
    const { svc, approvals, decide, manager } = await setup();
    const uri = newLink();
    const first = svc.detectWizard(SITE, uri);
    await new Promise((r) => setTimeout(r, 0));
    await decide(false);
    await first;
    expect(manager()).toBeUndefined();
    await svc.detectWizard(SITE, uri);
    expect(await approvals()).toEqual([]);
  });

  it("ignores links that are invalid, too long, not text, or for another relay", async () => {
    const { svc, approvals } = await setup();
    const { publicKey, secret } = generateKeyExchangeCredentials();
    const elsewhere = encodeKeyExchangeURI(publicKey, secret, { hostname: "relay.example" }).uri;
    for (const bad of [
      "wiz://nonsense",
      "https://example.com",
      `${newLink()}&x=${"a".repeat(3_000)}`,
      elsewhere,
      42,
      null,
    ])
      await svc.detectWizard(SITE, bad);
    expect(await approvals()).toEqual([]);
  });

  it("keeps one request waiting per site and limits how many a site can cause", async () => {
    const { svc, approvals, decide, advance } = await setup();
    void svc.detectWizard(SITE, newLink());
    await new Promise((r) => setTimeout(r, 0));
    // A second link while one waits is dropped; other sites are unaffected.
    await svc.detectWizard(SITE, newLink());
    void svc.detectWizard("https://other.example", newLink());
    await new Promise((r) => setTimeout(r, 0));
    expect((await approvals()).map((a) => a.origin)).toEqual([SITE, "https://other.example"]);
    await decide(false);
    await decide(false);

    for (let i = 1; i < MAX_PROMPTS_PER_WINDOW; i++) {
      void svc.detectWizard(SITE, newLink());
      await new Promise((r) => setTimeout(r, 0));
      await decide(false);
    }
    await svc.detectWizard(SITE, newLink());
    expect(await approvals()).toEqual([]);

    // After the window the site may ask again.
    advance(WINDOW_MS + 1);
    void svc.detectWizard(SITE, newLink());
    await new Promise((r) => setTimeout(r, 0));
    expect(await approvals()).toHaveLength(1);
  });

  it("withdraws the request when the page closes", async () => {
    const { svc, approvals } = await setup();
    const closed = new AbortController();
    const done = svc.detectWizard(SITE, newLink(), closed.signal);
    await new Promise((r) => setTimeout(r, 0));
    expect(await approvals()).toHaveLength(1);
    closed.abort();
    await done;
    expect(await approvals()).toEqual([]);
  });

  it("does not ask for a link seen after the page closed", async () => {
    const { svc, approvals } = await setup();
    const closed = new AbortController();
    closed.abort();
    await svc.detectWizard(SITE, newLink(), closed.signal);
    expect(await approvals()).toEqual([]);
  });
});
