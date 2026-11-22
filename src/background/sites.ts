import { npubEncode } from "@cashlet-labs/bnd";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { AuthLevel, UnsignedEvent } from "@cashlet-labs/bnd";
import { cipherScheme, isCipherMethod, isEncrypt, type CipherRequest } from "../shared/page-cipher";
import { rememberable, type PageRequest } from "../shared/page-messages";
import type { DappTxSummary } from "../wallet/dapp-sign";
import type { Identity } from "../wallet/identity";
import type { KeyValueStore } from "../wallet/session";

/** A site request waiting for the user, as the approval screen shows it. */
export interface ApprovalView {
  id: string;
  origin: string;
  type: "connect" | "sign" | "login" | "transaction" | "encrypt" | "decrypt" | "wizard";
  createdAt: number;
  expiresAt: number;
  /** The exact event that will be signed (the wallet adds pubkey, id and signature). */
  event: UnsignedEvent | null;
  login: { audience: string; level: AuthLevel; expiresAt: number } | null;
  /** A dApp transaction (WizardConnect), checked and summarised. */
  transaction: DappTxSummary | null;
  /** Whether "don't ask again" may be offered for this request. */
  rememberable: boolean;
  /** An encrypt or decrypt request: the other side's key, and the text to encrypt. */
  cipher?: { scheme: "nip04" | "nip44"; peer: string; plaintext: string | null };
}

export interface SitePermission {
  /** The Nostr key the site was given. A different current key means the site must ask again. */
  publicKey: string;
  /** Event kinds the site may have signed without asking. */
  kinds: number[];
  /** Encryption methods (for example "nostr.nip44.decrypt") the site may use without asking. */
  ciphers?: string[];
  connectedAt: number;
}

export interface GateDeps {
  settings: KeyValueStore;
  /** The unlocked wallet and its identity. Throws LockedError when locked. */
  unlocked: () => { walletId: string; identity: Identity };
  /** Milliseconds. */
  now: () => number;
  /** Called whenever the number of waiting requests changes. */
  onChange?: (waiting: number) => void;
}

interface Pending {
  view: ApprovalView;
  /** A web page's request, or what to run for any other approval. */
  request: PageRequest | null;
  run: (() => Promise<unknown>) | null;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const APPROVAL_TTL_MS = 5 * 60_000;
export const MAX_WAITING_PER_SITE = 5;
export const MAX_WAITING = 20;

export class SiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteError";
  }
}

/**
 * Everything web pages may ask of the wallet, and the user's answers.
 *
 * A site first asks for the Nostr public key ("connect"). Signing always asks
 * unless the user chose "don't ask again" for that event kind on that site;
 * some kinds are always asked for (see `rememberable`). A BND login always
 * asks. Requests wait in memory for five minutes at most; they never outlive
 * the page that made them.
 */
export class SiteGate {
  private readonly waiting = new Map<string, Pending>();

  constructor(private readonly deps: GateDeps) {}

  private key(walletId: string): string {
    return `sites:${walletId}`;
  }

  private async permissions(walletId: string): Promise<Record<string, SitePermission>> {
    return (await this.deps.settings.get<Record<string, SitePermission>>(this.key(walletId))) ?? {};
  }

  /** Answer a page. Resolves with the result, or rejects with a reason the page may see. */
  async request(origin: string, request: PageRequest, signal?: AbortSignal): Promise<unknown> {
    if (request.method === "nostr.getRelays") return {};
    // Encryption needs a connected site; a locked wallet cannot say, so that is checked on approval.
    if (isCipherMethod(request.method) && (await this.connected(origin)) === false)
      throw new SiteError("this site is not connected; ask for the public key first");
    const allowed = await this.allowedWithoutAsking(origin, request);
    if (allowed) return this.perform(origin, request);
    const view = this.view(origin, request);
    if (signal?.aborted) return Promise.reject(new SiteError("the page was closed"));
    const queued = this.add(view, request, null);
    if (!queued.ok) return Promise.reject(new SiteError(queued.error));
    signal?.addEventListener("abort", () =>
      this.finish(queued.id, new SiteError("the page was closed")),
    );
    return queued.result;
  }

  /**
   * Queue something other than a page request, for example a dApp transaction.
   * `run` signs it once the user approves; nothing is remembered.
   */
  queue(
    view: Pick<ApprovalView, "origin" | "type" | "transaction">,
    run: () => Promise<unknown>,
  ): { ok: true; id: string; result: Promise<unknown> } | { ok: false; error: string } {
    return this.add(
      {
        ...view,
        id: "",
        createdAt: 0,
        expiresAt: 0,
        event: null,
        login: null,
        rememberable: false,
      },
      null,
      run,
    );
  }

  /** Withdraw a waiting request, for example when a dApp cancels it. */
  cancel(id: string, reason: string): void {
    this.finish(id, new SiteError(reason));
  }

  /** Whether the site has the current Nostr key; null while the wallet is locked. */
  private async connected(origin: string): Promise<boolean | null> {
    let unlocked;
    try {
      unlocked = this.deps.unlocked();
    } catch {
      return null;
    }
    const site = (await this.permissions(unlocked.walletId))[origin];
    return !!site && site.publicKey === (await unlocked.identity.nostrPublicKey());
  }

  /** True when the wallet is unlocked and the user already allowed this request for this site. */
  private async allowedWithoutAsking(origin: string, request: PageRequest): Promise<boolean> {
    let unlocked;
    try {
      unlocked = this.deps.unlocked();
    } catch {
      return false;
    }
    const site = (await this.permissions(unlocked.walletId))[origin];
    if (!site || site.publicKey !== (await unlocked.identity.nostrPublicKey())) return false;
    if (request.method === "nostr.getPublicKey") return true;
    if (request.method === "nostr.signEvent")
      return rememberable(request.event.kind) && site.kinds.includes(request.event.kind);
    return site.ciphers?.includes(request.method) ?? false;
  }

  private async perform(origin: string, request: PageRequest): Promise<unknown> {
    const { identity } = this.deps.unlocked();
    switch (request.method) {
      case "nostr.getPublicKey":
        return identity.nostrPublicKey();
      case "nostr.signEvent":
        return identity.signNostrEvent(request.event);
      case "bnd.login":
        return identity.login(request.challenge, origin);
      case "nostr.getRelays":
        return {};
      default:
        if ((await this.connected(origin)) !== true)
          throw new SiteError("this site is not connected; ask for the public key first");
        return identity.cipher(request);
    }
  }

  private view(origin: string, request: PageRequest): ApprovalView {
    if (isCipherMethod(request.method)) {
      const cipher = request as CipherRequest;
      return {
        id: "",
        origin,
        type: isEncrypt(cipher) ? "encrypt" : "decrypt",
        createdAt: 0,
        expiresAt: 0,
        event: null,
        login: null,
        transaction: null,
        rememberable: true,
        cipher: {
          scheme: cipherScheme(cipher.method),
          peer: npubEncode(cipher.pubkey),
          plaintext: isEncrypt(cipher) ? cipher.plaintext : null,
        },
      };
    }
    return {
      id: "",
      origin,
      type:
        request.method === "nostr.signEvent"
          ? "sign"
          : request.method === "bnd.login"
            ? "login"
            : "connect",
      createdAt: 0,
      expiresAt: 0,
      event: request.method === "nostr.signEvent" ? request.event : null,
      login:
        request.method === "bnd.login"
          ? {
              audience: request.challenge.audience,
              level: request.challenge.level,
              expiresAt: request.challenge.expiresAt,
            }
          : null,
      transaction: null,
      rememberable:
        request.method === "nostr.getPublicKey" ||
        (request.method === "nostr.signEvent" && rememberable(request.event.kind)),
    };
  }

  private add(
    template: ApprovalView,
    request: PageRequest | null,
    run: (() => Promise<unknown>) | null,
  ): { ok: true; id: string; result: Promise<unknown> } | { ok: false; error: string } {
    this.expire();
    if (this.waiting.size >= MAX_WAITING)
      return { ok: false, error: "too many requests are waiting for the user" };
    const fromSite = [...this.waiting.values()].filter(
      (p) => p.view.origin === template.origin,
    ).length;
    if (fromSite >= MAX_WAITING_PER_SITE)
      return { ok: false, error: "this site has too many requests waiting" };

    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const createdAt = this.deps.now();
    const view: ApprovalView = {
      ...template,
      id,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
    };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.finish(id, new SiteError("the request timed out")),
        APPROVAL_TTL_MS,
      );
      this.waiting.set(id, { view, request, run, resolve, reject, timer });
    });
    this.changed();
    return { ok: true, id, result };
  }

  /** Remove a waiting request, answering the page with `error` or `result`. */
  private finish(id: string, error: Error | null, result?: unknown): void {
    const pending = this.waiting.get(id);
    if (!pending) return;
    this.waiting.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(result);
    this.changed();
  }

  private changed(): void {
    this.deps.onChange?.(this.waiting.size);
  }

  private expire(): void {
    const now = this.deps.now();
    for (const [id, pending] of this.waiting) {
      if (pending.view.expiresAt <= now) this.finish(id, new SiteError("the request timed out"));
    }
  }

  get count(): number {
    return this.waiting.size;
  }

  approvals(): ApprovalView[] {
    this.expire();
    return [...this.waiting.values()].map((p) => p.view).sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The user's answer. Approving needs the wallet unlocked; if signing fails
   * the page gets the error and so does the caller.
   */
  async decide(id: string, approve: boolean, remember: boolean): Promise<void> {
    this.expire();
    const pending = this.waiting.get(id);
    if (!pending) throw new SiteError("this request is no longer waiting");
    if (!approve) {
      this.finish(id, new SiteError("the user rejected the request"));
      return;
    }
    const { walletId, identity } = this.deps.unlocked();
    const { origin } = pending.view;
    let result: unknown;
    try {
      result = pending.run
        ? await pending.run()
        : await this.perform(origin, pending.request as PageRequest);
    } catch (error) {
      this.finish(id, error instanceof Error ? error : new SiteError("signing failed"));
      throw error;
    }
    if (remember && pending.view.rememberable && pending.request) {
      const all = await this.permissions(walletId);
      const publicKey = await identity.nostrPublicKey();
      const site =
        all[origin]?.publicKey === publicKey
          ? all[origin]
          : { publicKey, kinds: [], connectedAt: this.deps.now() };
      const kind = pending.request.method === "nostr.signEvent" ? pending.request.event.kind : null;
      const ciphers = site.ciphers ?? [];
      const method = pending.request.method;
      all[origin] = {
        ...site,
        kinds: kind === null || site.kinds.includes(kind) ? site.kinds : [...site.kinds, kind],
        ...(isCipherMethod(method) && !ciphers.includes(method)
          ? { ciphers: [...ciphers, method] }
          : {}),
      };
      await this.deps.settings.set(this.key(walletId), all);
    }
    this.finish(id, null, result);
  }

  /** After an unlock: answer the waiting requests the user already allowed. */
  async refresh(): Promise<void> {
    for (const [id, pending] of [...this.waiting]) {
      if (!pending.request) continue;
      if (await this.allowedWithoutAsking(pending.view.origin, pending.request)) {
        try {
          this.finish(id, null, await this.perform(pending.view.origin, pending.request));
        } catch (error) {
          this.finish(id, error instanceof Error ? error : new SiteError("signing failed"));
        }
      }
    }
  }

  /** Sites the unlocked wallet is connected to. */
  async sites(): Promise<({ origin: string } & SitePermission)[]> {
    const { walletId } = this.deps.unlocked();
    return Object.entries(await this.permissions(walletId))
      .map(([origin, site]) => ({ origin, ...site }))
      .sort((a, b) => a.origin.localeCompare(b.origin));
  }

  async removeSite(origin: string): Promise<void> {
    const { walletId } = this.deps.unlocked();
    const all = await this.permissions(walletId);
    delete all[origin];
    await this.deps.settings.set(this.key(walletId), all);
  }

  /** Forget a removed wallet's sites. */
  async forget(walletId: string): Promise<void> {
    await this.deps.settings.remove(this.key(walletId));
  }
}
