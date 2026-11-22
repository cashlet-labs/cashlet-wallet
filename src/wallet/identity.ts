import {
  createBinding,
  createLoginResponse,
  createKeySigner,
  createNostrKeySigner,
  createRevocation,
  createSuccessor,
  npubEncode,
  signEvent,
  type AuthChallenge,
  type BchNetwork,
  type LoginResponse,
  type IdentityState,
  type NostrEvent,
  type UnsignedEvent,
  type VerifiedBinding,
} from "@cashlet-labs/bnd";
import { didOf } from "@cashlet-labs/bnd/did";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CipherRequest } from "../shared/page-cipher";
import type { HdWallet } from "./hd";
import { runCipher } from "./nostr-crypto";
import type { KeyValueStore } from "./session";

/**
 * The wallet's BND identity (BND-1): its Nostr key and one of its BCH receive
 * keys, bound to each other and published to Nostr relays.
 *
 * The wallet holds both keys, so every change is approved by both of them. A
 * recovery key is not offered: both keys come from the same recovery phrase,
 * so a recovery key from that phrase would protect nothing (BND-1 section 9.4).
 */

/** The relays that refuse a binding's replacement unless two of its keys approve it (BND-1 section 9.8). */
export const ENFORCING_RELAYS = [
  "wss://relay.septemlabs.com",
  "wss://relay.bongacash.co.ke",
] as const;

/** Public relays that index binding events, so others can find the identity without the enforcing ones. */
export const PUBLIC_RELAYS = [
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://offchain.pub",
  "wss://relay.damus.io",
  "wss://nostr.mom",
] as const;

/** Every relay the extension may connect to; the manifest's connect-src lists exactly these plus Electrum servers. */
export function allRelayUrls(): string[] {
  return [...ENFORCING_RELAYS, ...PUBLIC_RELAYS];
}

export interface RelayReportLike {
  url: string;
  complete: boolean;
}

/** What the identity needs from relays; @cashlet-labs/bnd/nostr in the extension. */
export interface RelayApi {
  discover(
    nostrPublicKey: string,
    relays: readonly string[],
  ): Promise<{ state: IdentityState; relays: RelayReportLike[] }>;
  publish(
    event: NostrEvent,
    relays: readonly string[],
  ): Promise<{ ok: boolean; accepted: string[] }>;
}

/** Which of the wallet's keys the identity uses. Changes when a key is rotated. */
export interface IdentityKeys {
  /** Receive address index of the bound BCH key. */
  bchIndex: number;
  /** NIP-06 account of the Nostr key. */
  nostrAccount: number;
}

export interface IdentityStatus {
  npub: string;
  nostrPublicKey: string;
  /** The BCH address this identity names, or would name once bound. */
  address: string;
  state: "none" | "current" | "revoked" | "disputed" | "unknown";
  did: string | null;
  /** How many relays answered completely, of how many asked. */
  relays: { complete: number; asked: number };
  publicRelays: boolean;
}

export const MIN_COMPLETE = 2;

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityError";
  }
}

export class Identity {
  constructor(
    private readonly wallet: HdWallet,
    private readonly network: BchNetwork,
    private readonly walletId: string,
    private readonly api: RelayApi,
    private readonly settings: KeyValueStore,
    private readonly publicRelays: readonly string[],
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private get keysKey(): string {
    return `identity:${this.walletId}`;
  }

  async keys(): Promise<IdentityKeys> {
    return (
      (await this.settings.get<IdentityKeys>(this.keysKey)) ?? { bchIndex: 0, nostrAccount: 0 }
    );
  }

  async usesPublicRelays(): Promise<boolean> {
    return (await this.settings.get<boolean>(`publicRelays:${this.walletId}`)) ?? true;
  }

  async setPublicRelays(value: boolean): Promise<void> {
    await this.settings.set(`publicRelays:${this.walletId}`, value);
  }

  /** Relays to read from (all of them) and to publish to (the enforcing ones, plus public ones if chosen). */
  private async relays(): Promise<{ read: string[]; write: string[] }> {
    const all = [...ENFORCING_RELAYS, ...this.publicRelays];
    return { read: all, write: (await this.usesPublicRelays()) ? all : [...ENFORCING_RELAYS] };
  }

  private signers(keys: IdentityKeys) {
    const nostr = this.wallet.nostrKey(keys.nostrAccount);
    const bch = this.wallet.addressKey(0, keys.bchIndex);
    return {
      nostr,
      nostrSigner: createNostrKeySigner(nostr.privateKey),
      bchSigner: createKeySigner(this.wallet.privateKey(0, keys.bchIndex)),
      bchKeyHash: bytesToHex(bch.keyHash),
    };
  }

  async status(): Promise<IdentityStatus> {
    const keys = await this.keys();
    const nostr = this.wallet.nostrKey(keys.nostrAccount);
    const { read } = await this.relays();
    const base = {
      npub: npubEncode(nostr.publicKey),
      nostrPublicKey: nostr.publicKey,
      address: this.wallet.address(0, keys.bchIndex, this.network),
      publicRelays: await this.usesPublicRelays(),
    };
    const found = await this.api.discover(nostr.publicKey, read);
    const complete = found.relays.filter((r) => r.complete).length;
    const relays = { complete, asked: read.length };
    if (complete < MIN_COMPLETE) return { ...base, state: "unknown", did: null, relays };
    const state = found.state;
    const binding = state.status === "current" || state.status === "revoked" ? state.binding : null;
    return { ...base, state: state.status, did: binding ? didOf(binding) : null, relays };
  }

  /** The identity's current binding on relays, which must name this wallet's keys. */
  private async current(): Promise<VerifiedBinding> {
    const keys = await this.keys();
    const { nostr, bchKeyHash } = this.signers(keys);
    const { read } = await this.relays();
    const found = await this.api.discover(nostr.publicKey, read);
    if (found.relays.filter((r) => r.complete).length < MIN_COMPLETE) {
      throw new IdentityError("too few relays answered to check the identity; try again");
    }
    if (found.state.status !== "current") {
      throw new IdentityError(
        found.state.status === "none"
          ? "this wallet has no identity yet"
          : `the identity is ${found.state.status}`,
      );
    }
    const binding = found.state.binding;
    if (binding.nostrPublicKey !== nostr.publicKey || binding.bch.keyHash !== bchKeyHash) {
      throw new IdentityError("the identity on the relays uses keys this wallet is not set up for");
    }
    return binding;
  }

  private async publish(binding: VerifiedBinding): Promise<{ accepted: string[]; did: string }> {
    const { write } = await this.relays();
    const result = await this.api.publish(binding.event, write);
    if (!result.ok)
      throw new IdentityError("no relay accepted the binding; check your connection and try again");
    return { accepted: result.accepted, did: didOf(binding) };
  }

  /** Bind the Nostr key to the BCH key and publish it. */
  async bind(): Promise<{ accepted: string[]; did: string }> {
    const status = await this.status();
    if (status.state === "unknown")
      throw new IdentityError("too few relays answered to check the identity; try again");
    if (status.state !== "none")
      throw new IdentityError(`this wallet's identity is already ${status.state}`);
    const { nostrSigner, bchSigner, bchKeyHash } = this.signers(await this.keys());
    const binding = await createBinding({
      nostrSigner,
      bchSigner,
      bchKeyHash,
      network: this.network,
      proofType: "message",
      createdAt: this.now(),
    });
    return this.publish(binding);
  }

  /**
   * Move the identity to a new BCH address (`bchIndex`) or the next Nostr key.
   * The DID stays the same; both old keys approve the change.
   */
  async rotate(
    key: "bch" | "nostr",
    bchIndex?: number,
  ): Promise<{ accepted: string[]; did: string }> {
    const previous = await this.current();
    const oldKeys = await this.keys();
    const next: IdentityKeys =
      key === "bch"
        ? { ...oldKeys, bchIndex: bchIndex ?? oldKeys.bchIndex + 1 }
        : { ...oldKeys, nostrAccount: oldKeys.nostrAccount + 1 };
    if (key === "bch" && next.bchIndex === oldKeys.bchIndex)
      throw new IdentityError("choose a different address");
    const old = this.signers(oldKeys);
    const fresh = this.signers(next);
    const binding = await createSuccessor({
      previous: previous.event,
      nostrSigner: fresh.nostrSigner,
      bchSigner: fresh.bchSigner,
      bchKeyHash: fresh.bchKeyHash,
      network: this.network,
      proofType: "message",
      createdAt: Math.max(this.now(), previous.record.createdAt + 1),
      // The key that is kept approves implicitly; the one being replaced approves explicitly.
      approvers:
        key === "bch"
          ? { bch: { signer: old.bchSigner, proofType: "message" } }
          : { nostr: old.nostrSigner },
    });
    const published = await this.publish(binding);
    await this.settings.set(this.keysKey, next);
    return published;
  }

  /** The identity's Nostr public key (hex). Needs no network. */
  async nostrPublicKey(): Promise<string> {
    return this.wallet.nostrKey((await this.keys()).nostrAccount).publicKey;
  }

  /** Sign a Nostr event with the identity's current Nostr key, for a site the user approved. */
  async signNostrEvent(template: UnsignedEvent): Promise<NostrEvent> {
    const { nostrAccount } = await this.keys();
    return signEvent(this.wallet.nostrKey(nostrAccount).privateKey, template);
  }

  /** Encrypt or decrypt for a site the user approved, with the identity's Nostr key (NIP-04, NIP-44). */
  async cipher(request: CipherRequest): Promise<string> {
    const { nostrAccount } = await this.keys();
    return runCipher(request, this.wallet.nostrKey(nostrAccount).privateKey);
  }

  /**
   * Answer a site's BND login challenge with the current binding. `origin` is
   * the page's origin as the browser reports it; the challenge must be for it.
   */
  async login(challenge: AuthChallenge, origin: string): Promise<LoginResponse> {
    const binding = await this.current();
    const { nostrSigner, bchSigner } = this.signers(await this.keys());
    return createLoginResponse({
      challenge,
      binding: binding.event,
      nostrSigner,
      ...(challenge.level === "dual" ? { bchSigner, proofType: "message" as const } : {}),
      expectedOrigin: origin,
      now: this.now,
    });
  }

  /** End the identity. After this, logins and payments by this identity are refused. */
  async revoke(): Promise<{ accepted: string[] }> {
    const previous = await this.current();
    const keys = this.signers(await this.keys());
    const revocation = await createRevocation({
      previous: previous.event,
      signer: keys.nostrSigner,
      approvers: { bch: { signer: keys.bchSigner, proofType: "message" } },
      createdAt: Math.max(this.now(), previous.record.createdAt + 1),
    });
    const { write } = await this.relays();
    const result = await this.api.publish(revocation.event, write);
    if (!result.ok) throw new IdentityError("no relay accepted the revocation; try again");
    return { accepted: result.accepted };
  }
}
