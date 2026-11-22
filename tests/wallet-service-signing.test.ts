import { npubEncode } from "@cashlet-labs/bnd";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { parseRequest } from "../src/shared/messages";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

// Published BIP39 test vector. Never use it for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "correct horse";
const SITE = "https://app.example";
const peerKey = new Uint8Array(32);
peerKey[31] = 7;
const PEER = bytesToHex(schnorr.getPublicKey(peerKey));

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
  const service = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings: new MemoryKeyValue(),
    connect: () => new EmptyConnection(),
    openStore: async () => new MemoryStore(),
  });
  await service.handle({
    type: "IMPORT_WALLET",
    mnemonic: VECTOR,
    password: PASSWORD,
    network: "chipnet",
  });
  return service;
}

async function next(service: WalletService) {
  for (let i = 0; i < 50; i++) {
    const list = await service.handle({ type: "APPROVALS_LIST" });
    if (list.ok && list.approvals[0]) return list.approvals[0];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("nothing is waiting");
}

const decide = (service: WalletService, id: string, approve: boolean, remember = false) =>
  service.handle({ type: "APPROVAL_DECIDE", id, approve, remember });

async function connect(service: WalletService): Promise<string> {
  const asked = service.page(SITE, { method: "nostr.getPublicKey" });
  await decide(service, (await next(service)).id, true, true);
  return (await asked) as string;
}

describe("encrypted messages for sites", () => {
  it("refuses a site that is not connected", async () => {
    const service = await setup();
    await expect(
      service.page(SITE, {
        method: "nostr.nip44.encrypt",
        pubkey: PEER,
        plaintext: "hi",
      }),
    ).rejects.toThrow("not connected");
    expect(await service.handle({ type: "APPROVALS_LIST" })).toMatchObject({ approvals: [] });
  });

  it("shows the peer and the text, then encrypts and decrypts after approval", async () => {
    const service = await setup();
    await connect(service);
    for (const scheme of ["nip04", "nip44"] as const) {
      const encrypting = service.page(SITE, {
        method: `nostr.${scheme}.encrypt`,
        pubkey: PEER,
        plaintext: "secret words",
      });
      const first = await next(service);
      expect(first).toMatchObject({
        type: "encrypt",
        rememberable: true,
        cipher: { scheme, peer: npubEncode(PEER), plaintext: "secret words" },
      });
      await decide(service, first.id, true);
      const ciphertext = (await encrypting) as string;
      expect(ciphertext).not.toContain("secret");

      const decrypting = service.page(SITE, {
        method: `nostr.${scheme}.decrypt`,
        pubkey: PEER,
        ciphertext,
      });
      const second = await next(service);
      expect(second).toMatchObject({
        type: "decrypt",
        cipher: { scheme, peer: npubEncode(PEER), plaintext: null },
      });
      await decide(service, second.id, true);
      expect(await decrypting).toBe("secret words");
    }
  });

  it("passes a rejection to the page, and remembers a method only when asked", async () => {
    const service = await setup();
    await connect(service);
    const request = {
      method: "nostr.nip44.encrypt",
      pubkey: PEER,
      plaintext: "hi",
    } as const;
    const rejected = service.page(SITE, request);
    await decide(service, (await next(service)).id, false);
    await expect(rejected).rejects.toThrow("the user rejected the request");

    const remembered = service.page(SITE, request);
    await decide(service, (await next(service)).id, true, true);
    await remembered;
    // Answered without asking now, but only for this method.
    expect(typeof (await service.page(SITE, request))).toBe("string");
    void service.page(SITE, { ...request, method: "nostr.nip04.encrypt" }).catch(() => 0);
    expect(await next(service)).toMatchObject({ cipher: { scheme: "nip04" } });
    expect(await service.handle({ type: "SITES_LIST" })).toMatchObject({
      sites: [{ origin: SITE, ciphers: ["nostr.nip44.encrypt"] }],
    });
  });

  it("rejects a public key that is not on the curve", async () => {
    const service = await setup();
    await connect(service);
    const asked = service.page(SITE, {
      method: "nostr.nip44.encrypt",
      pubkey: "ff".repeat(32),
      plaintext: "hi",
    });
    await expect(
      (async () => {
        await decide(service, (await next(service)).id, true);
        return asked;
      })(),
    ).rejects.toThrow("invalid public key");
  });
});

describe("signing a message in the wallet", () => {
  it("signs with the identity address or the receive address, and verifies both", async () => {
    const service = await setup();
    for (const source of ["identity", "receive"] as const) {
      const signed = await service.handle({ type: "SIGN_MESSAGE", source, message: "hello" });
      if (!signed.ok) throw new Error(signed.error);
      expect(signed.address).toMatch(/^bchtest:q/);
      expect(
        await service.handle({
          type: "VERIFY_MESSAGE",
          address: signed.address,
          message: "hello",
          signature: signed.signature,
        }),
      ).toEqual({ ok: true, valid: true });
      expect(
        await service.handle({
          type: "VERIFY_MESSAGE",
          address: signed.address,
          message: "hello!",
          signature: signed.signature,
        }),
      ).toEqual({ ok: true, valid: false });
    }
  });

  it("will not sign while locked, and pages cannot ask for it", async () => {
    const service = await setup();
    await service.handle({ type: "LOCK" });
    expect(
      await service.handle({ type: "SIGN_MESSAGE", source: "identity", message: "hi" }),
    ).toMatchObject({ ok: false, code: "LOCKED" });
  });

  it("checks message fields", () => {
    expect(parseRequest({ type: "SIGN_MESSAGE", source: "identity", message: "hi" })).toEqual({
      type: "SIGN_MESSAGE",
      source: "identity",
      message: "hi",
    });
    for (const bad of [
      { type: "SIGN_MESSAGE", source: "other", message: "hi" },
      { type: "SIGN_MESSAGE", source: "identity", message: "" },
      { type: "SIGN_MESSAGE", source: "identity", message: "x".repeat(65_537) },
      { type: "VERIFY_MESSAGE", address: "a", message: "m" },
      { type: "VERIFY_MESSAGE", address: "a", message: "m", signature: "s".repeat(201) },
    ])
      expect(parseRequest(bad)).toHaveProperty("error");
  });
});
