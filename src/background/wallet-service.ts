import { BINDING_EVENT_KIND, npubEncode, verifyBinding } from "@cashlet-labs/bnd";
import { resolvePayee, type PayeeResult } from "@cashlet-labs/bnd/did";
import { discoverBinding, publishBinding } from "@cashlet-labs/bnd/nostr";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ErrorResponse, PlannedOutputMessage, Request, ResponseFor } from "../shared/messages";
import type { PageRequest } from "../shared/page-messages";
import { allRelayUrls, Identity, PUBLIC_RELAYS, type RelayApi } from "../wallet/identity";
import { p2pkhLockingBytecode } from "../wallet/indexer";
import { Scanner, type IndexerSource } from "../wallet/scanner";
import { buildSend, type SendPlan } from "../wallet/send";
import {
  LockedError,
  ThrottledError,
  type KeyValueStore,
  type WalletSession,
} from "../wallet/session";
import type { WalletStore } from "../wallet/store";
import { TxDetails } from "../wallet/tx-detail";
import { WrongPasswordError } from "../wallet/vault";
import { SiteGate } from "./sites";
import { WizardConnections, type CreateWizardManager } from "./wizard";

/** A network connection the service can scan and broadcast through (ElectrumPool in the extension). */
export interface Connection extends IndexerSource {
  broadcast(transactionHex: string, expectedTxid: string): Promise<string>;
  health(): { url: string; state: string; tip: number | null; lastError: string | null }[];
  readonly currentServer: string | null;
  close(): void;
}

export interface ServiceDeps {
  session: WalletSession;
  settings: KeyValueStore;
  connect: (network: "mainnet" | "chipnet") => Connection;
  openStore: (walletId: string) => Promise<WalletStore>;
  now?: () => number;
  /** Called whenever the auto-lock timer should restart. */
  onActivity?: (minutes: number) => void;
  /** Nostr relays, for the wallet's identity. Defaults to real relays over WebSocket. */
  relays?: RelayApi;
  /** Resolves an npub or did:bnd to a verified address. Defaults to real relays. */
  resolvePayee?: (target: string, relays: readonly string[]) => Promise<PayeeResult>;
  /** Called whenever the number of site requests waiting for the user changes. */
  onApprovals?: (waiting: number) => void;
  /** Creates the WizardConnect manager. Defaults to the real one, over the relay. */
  wizardManager?: CreateWizardManager;
}

const realRelays: RelayApi = {
  discover: (nostrPublicKey, relays) => discoverBinding(nostrPublicKey, { relays }),
  publish: (event, relays) => publishBinding(event, { relays }),
};

const realResolvePayee = (target: string, relays: readonly string[]) =>
  resolvePayee(target, { relays });

const PLAN_TTL_MS = 2 * 60_000;
const MIN_FEE_RATE = 1;
const MAX_FEE_RATE = 10;

/** Electrum's relay fee is BCH per kB; the wallet pays at least 1 and at most 10 sat/byte. */
export function feeRateFrom(relayFee: unknown): number {
  const satsPerByte = Math.ceil(
    (typeof relayFee === "number" && Number.isFinite(relayFee) ? relayFee : 0) * 100_000,
  );
  return Math.min(MAX_FEE_RATE, Math.max(MIN_FEE_RATE, satsPerByte));
}
const DEFAULT_AUTO_LOCK_MINUTES = 15;

interface Runtime {
  walletId: string;
  connection: Connection;
  store: WalletStore;
  scanner: Scanner;
  identity: Identity;
  /** WizardConnect dApp connections, opened on first use and closed on lock. */
  wizard: WizardConnections | null;
  /** Decoded transactions for the detail view, opened on first use. */
  txDetails: TxDetails | null;
  scan: "idle" | "scanning" | "ready" | "error";
  scanError: string | null;
  /** Satoshis per byte, from the server's relay fee once it is known. */
  feeRate: number;
}

type Result<T extends Request["type"]> = ResponseFor[T] | ErrorResponse;

/**
 * Everything the service worker does for the wallet pages, without Chrome APIs:
 * the session, one network connection and scanner per unlocked wallet, and
 * prepared sends waiting for confirmation.
 */
export class WalletService {
  private runtime: Runtime | null = null;
  private readonly plans = new Map<
    string,
    { plan: SendPlan; walletId: string; expiresAt: number }
  >();

  private readonly gate: SiteGate;

  constructor(private readonly deps: ServiceDeps) {
    this.gate = new SiteGate({
      settings: deps.settings,
      unlocked: () => {
        const runtime = this.active();
        return { walletId: runtime.walletId, identity: runtime.identity };
      },
      now: () => this.now(),
      ...(deps.onApprovals ? { onChange: deps.onApprovals } : {}),
    });
  }

  /**
   * A web page's request, already validated, with the origin the browser
   * reported. Pages never restart the auto-lock timer.
   */
  page(origin: string, request: PageRequest, signal?: AbortSignal): Promise<unknown> {
    return this.gate.request(origin, request, signal);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async autoLockMinutes(): Promise<number> {
    return (await this.deps.settings.get<number>("autoLockMinutes")) ?? DEFAULT_AUTO_LOCK_MINUTES;
  }

  /** Lock the wallet and drop everything held for it. */
  lock(): void {
    this.deps.session.lock();
    this.plans.clear();
    this.runtime?.scanner.stop();
    this.runtime?.wizard?.close();
    this.runtime?.connection.close();
    this.runtime = null;
  }

  async handle<T extends Request["type"]>(
    request: Extract<Request, { type: T }>,
  ): Promise<Result<T>> {
    try {
      const response = await this.dispatch(request as Request);
      if (request.type !== "STATUS" && request.type !== "PING" && this.runtime) {
        this.deps.onActivity?.(await this.autoLockMinutes());
      }
      return response as Result<T>;
    } catch (error) {
      return toError(error);
    }
  }

  private async dispatch(request: Request): Promise<ResponseFor[Request["type"]]> {
    const { session } = this.deps;
    switch (request.type) {
      case "PING":
        return { ok: true, bindingKind: BINDING_EVENT_KIND };
      case "VERIFY_BINDING": {
        const result = verifyBinding(request.event);
        return result.ok
          ? {
              ok: true,
              nostrPublicKey: result.nostrPublicKey,
              address: result.bch.address,
              proofType: result.proofType,
            }
          : { ok: false, reason: result.reason };
      }
      case "STATUS": {
        const status = await session.status();
        const wallets = await Promise.all(
          status.wallets.map(async (wallet) => ({
            ...wallet,
            backedUp: (await this.deps.settings.get<boolean>(`backedUp:${wallet.id}`)) ?? false,
          })),
        );
        return {
          ok: true,
          ...status,
          wallets,
          network: status.unlocked ? session.current().network : null,
          scan: this.runtime?.scan ?? "idle",
          scanError: this.runtime?.scanError ?? null,
          autoLockMinutes: await this.autoLockMinutes(),
          approvals: this.gate.count,
        };
      }
      case "CREATE_WALLET": {
        const created = await session.create(request.password, request.network, request.name);
        await this.start();
        return { ok: true, ...created };
      }
      case "IMPORT_WALLET": {
        const imported = await session.import(
          request.mnemonic,
          request.password,
          request.network,
          request.name,
        );
        // An imported phrase was entered by the user, so it is already written down.
        await this.deps.settings.set(`backedUp:${imported.id}`, true);
        await this.start();
        return { ok: true, ...imported };
      }
      case "UNLOCK":
        this.lock();
        await session.unlock(request.password, request.walletId);
        await this.start();
        return { ok: true };
      case "LOCK":
        this.lock();
        return { ok: true };
      case "GET_RECEIVE_ADDRESS": {
        const { scanner } = this.active();
        return { ok: true, ...(await scanner.nextAddress(0, request.tokenAware)) };
      }
      case "GET_BALANCE": {
        const balance = await this.active().scanner.balance();
        return {
          ok: true,
          confirmed: balance.confirmed,
          unconfirmed: balance.unconfirmed,
          tokens: [...balance.tokens].map(([category, t]) => ({
            category,
            amount: t.amount.toString(),
            nfts: t.nfts,
          })),
        };
      }
      case "GET_HISTORY": {
        const entries = await this.active().scanner.history();
        return {
          ok: true,
          entries: entries.map(({ txid, height, time }) => ({ txid, height, time })),
        };
      }
      case "GET_TRANSACTION":
        return this.transaction(request.txid);
      case "PREPARE_SEND":
        return this.prepareSend(request.recipients);
      case "CONFIRM_SEND":
        return this.confirmSend(request.planId);
      case "REVEAL_MNEMONIC":
        return { ok: true, mnemonic: await session.reveal(request.password) };
      case "CHANGE_PASSWORD":
        await session.changePassword(request.oldPassword, request.newPassword);
        return { ok: true };
      case "REMOVE_WALLET": {
        if (this.runtime?.walletId === request.walletId) this.lock();
        await session.remove(request.walletId, request.password);
        await (await this.deps.openStore(request.walletId)).clear();
        await this.deps.settings.remove(`backedUp:${request.walletId}`);
        await this.gate.forget(request.walletId);
        return { ok: true };
      }
      case "RENAME_WALLET":
        await session.rename(request.walletId, request.name);
        return { ok: true };
      case "SWITCH_WALLET":
        await session.switchTo(request.walletId);
        this.plans.clear();
        await this.start();
        return { ok: true };
      case "ADOPT_WALLET":
        await session.adopt(request.walletId, request.oldPassword, request.password);
        this.plans.clear();
        await this.start();
        return { ok: true };
      case "CONFIRM_BACKUP":
        if (!(await session.status()).wallets.some((wallet) => wallet.id === request.walletId)) {
          throw new Error("no such wallet");
        }
        await this.deps.settings.set(`backedUp:${request.walletId}`, true);
        return { ok: true };
      case "SET_AUTO_LOCK":
        await this.deps.settings.set("autoLockMinutes", request.minutes);
        return { ok: true };
      case "IDENTITY_STATUS":
        return { ok: true, ...(await this.active().identity.status()) };
      case "IDENTITY_BIND":
        return { ok: true, ...(await this.active().identity.bind()) };
      case "IDENTITY_ROTATE": {
        const { identity, scanner } = this.active();
        if (request.key === "nostr") return { ok: true, ...(await identity.rotate("nostr")) };
        // Move to an address nobody has been given yet, never back to an earlier one.
        const current = (await identity.keys()).bchIndex;
        const next = Math.max((await scanner.nextAddress(0)).index, current + 1);
        return { ok: true, ...(await identity.rotate("bch", next)) };
      }
      case "IDENTITY_REVOKE": {
        const { identity } = this.active();
        await session.reveal(request.password);
        return { ok: true, ...(await identity.revoke()) };
      }
      case "IDENTITY_PUBLIC_RELAYS":
        await this.active().identity.setPublicRelays(request.enabled);
        return { ok: true };
      case "RESOLVE_PAYEE": {
        const { network } = session.current();
        this.active();
        const resolve = this.deps.resolvePayee ?? realResolvePayee;
        const payee = await resolve(request.target, allRelayUrls());
        if (!payee.ok) throw new Error(payee.reason);
        if (payee.binding.bch.network !== network) {
          throw new Error(`this identity is on ${payee.binding.bch.network}, not ${network}`);
        }
        return {
          ok: true,
          address: payee.address,
          tokenAddress: payee.tokenAddress,
          did: payee.did,
          npub: npubEncode(payee.binding.nostrPublicKey),
        };
      }
      case "APPROVALS_LIST": {
        const approvals = this.gate.approvals();
        // The key the site would get, shown on the approval screen; unknown while locked.
        let npub: string | null;
        try {
          npub = npubEncode(await this.active().identity.nostrPublicKey());
        } catch {
          npub = null;
        }
        return { ok: true, approvals, npub };
      }
      case "APPROVAL_DECIDE":
        await this.gate.decide(request.id, request.approve, request.remember);
        return { ok: true };
      case "SITES_LIST":
        return {
          ok: true,
          sites: (await this.gate.sites()).map(({ origin, kinds, connectedAt }) => ({
            origin,
            kinds,
            connectedAt,
          })),
        };
      case "SITE_REMOVE":
        await this.gate.removeSite(request.origin);
        return { ok: true };
      case "WIZARD_CONNECT": {
        const runtime = this.active();
        const { wallet, network } = session.current();
        runtime.wizard ??= new WizardConnections(
          wallet,
          network,
          this.gate,
          (hex, txid) => runtime.connection.broadcast(hex, txid),
          this.deps.wizardManager,
        );
        return { ok: true, id: runtime.wizard.connect(request.uri) };
      }
      case "WIZARD_LIST":
        return { ok: true, connections: this.active().wizard?.list() ?? [] };
      case "WIZARD_DISCONNECT":
        this.active().wizard?.disconnect(request.id);
        return { ok: true };
      case "SERVER_HEALTH": {
        const { connection } = this.active();
        return {
          ok: true,
          current: connection.currentServer,
          servers: connection
            .health()
            .map(({ url, state, tip, lastError }) => ({ url, state, tip, lastError })),
        };
      }
    }
  }

  private active(): Runtime {
    const unlocked = this.deps.session.current();
    if (!this.runtime || this.runtime.walletId !== unlocked.id) throw new LockedError();
    return this.runtime;
  }

  /** Connect and scan the unlocked wallet. The scan continues in the background. */
  private async start(): Promise<void> {
    const { id, wallet, network } = this.deps.session.current();
    this.runtime?.scanner.stop();
    this.runtime?.wizard?.close();
    this.runtime?.connection.close();
    const connection = this.deps.connect(network);
    const store = await this.deps.openStore(id);
    const scanner = new Scanner(wallet, network, connection, store);
    const identity = new Identity(
      wallet,
      network,
      id,
      this.deps.relays ?? realRelays,
      this.deps.settings,
      PUBLIC_RELAYS,
    );
    const runtime: Runtime = {
      walletId: id,
      connection,
      store,
      scanner,
      identity,
      wizard: null,
      txDetails: null,
      scan: "scanning",
      scanError: null,
      feeRate: MIN_FEE_RATE,
    };
    this.runtime = runtime;
    scanner.scan().then(
      () => {
        runtime.scan = "ready";
      },
      (error: unknown) => {
        runtime.scan = "error";
        runtime.scanError = error instanceof Error ? error.message : String(error);
      },
    );
    // Site requests that arrived while locked and are already allowed are answered now.
    void this.gate.refresh();
    // The relay fee is read once, in the background, so a send never waits on the network for it.
    connection.request<number>("blockchain.relayfee").then(
      (relayFee) => {
        runtime.feeRate = feeRateFrom(relayFee);
      },
      () => undefined,
    );
  }

  /** What one transaction in the wallet's history means for the wallet. */
  private async transaction(txid: string): Promise<ResponseFor["GET_TRANSACTION"]> {
    const runtime = this.active();
    const entry = (await runtime.scanner.history()).find((e) => e.txid === txid);
    if (!entry) throw new Error("this transaction is not in the wallet's history");
    runtime.txDetails ??= new TxDetails(
      runtime.connection,
      this.deps.session.current().network,
      (scripthash) => runtime.scanner.addressFor(scripthash) !== undefined,
    );
    const analysis = await runtime.txDetails.get(txid);
    const tip = Math.max(0, ...runtime.connection.health().map((s) => s.tip ?? 0));
    const confirmations = entry.height > 0 && tip >= entry.height ? tip - entry.height + 1 : null;
    return {
      ok: true,
      txid,
      direction: analysis.direction,
      net: analysis.net,
      fee: analysis.fee,
      size: analysis.size,
      height: entry.height,
      time: entry.time,
      confirmations,
      tokens: analysis.tokens.map((t) => ({
        category: t.category,
        amount: t.amount.toString(),
        nfts: t.nfts,
      })),
      counterparties: analysis.counterparties,
      receivedOn: analysis.receivedOn,
      complete: analysis.complete,
    };
  }

  private async prepareSend(
    recipients: Extract<Request, { type: "PREPARE_SEND" }>["recipients"],
  ): Promise<ResponseFor["PREPARE_SEND"]> {
    const { wallet, network, id } = this.deps.session.current();
    const runtime = this.active();
    const feeRate = runtime.feeRate;
    const locate = (scripthash: string) => {
      const address = runtime.scanner.addressFor(scripthash);
      if (!address) throw new Error("an output belongs to an address this wallet does not know");
      return address;
    };
    const plan = buildSend({
      network,
      utxos: await runtime.store.utxos(),
      recipients: recipients.map((r) => ({
        address: r.address,
        value: r.value,
        ...(r.token
          ? { token: { category: r.token.category, amount: BigInt(r.token.amount) } }
          : {}),
        ...(r.nft ? { nft: r.nft } : {}),
      })),
      changeAddress: (await runtime.scanner.nextAddress(1, true)).address,
      feeRate,
      keyFor: (utxo) => {
        const { chain, index } = locate(utxo.scripthash);
        return {
          privateKey: wallet.privateKey(chain, index),
          publicKey: wallet.addressKey(chain, index).publicKey,
        };
      },
      lockingBytecodeFor: (utxo) => {
        const { chain, index } = locate(utxo.scripthash);
        return p2pkhLockingBytecode(wallet.addressKey(chain, index).keyHash);
      },
    });
    const planId = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const expiresAt = this.now() + PLAN_TTL_MS;
    this.plans.set(planId, { plan, walletId: id, expiresAt });
    return {
      ok: true,
      planId,
      fee: plan.fee,
      size: plan.size,
      outgoing: plan.outgoing,
      outputs: plan.outputs.map((o): PlannedOutputMessage => ({
        address: o.address,
        value: o.value,
        change: o.change,
        token: o.token
          ? { category: o.token.category, amount: o.token.amount.toString(), nft: o.token.nft }
          : null,
      })),
      expiresAt,
    };
  }

  /** Broadcast exactly the plan the user saw. A plan is used once and expires after two minutes. */
  private async confirmSend(planId: string): Promise<ResponseFor["CONFIRM_SEND"]> {
    const entry = this.plans.get(planId);
    this.plans.delete(planId);
    if (!entry || entry.expiresAt < this.now())
      throw new Error("this send expired; prepare it again");
    const runtime = this.active();
    if (runtime.walletId !== entry.walletId)
      throw new Error("this send was prepared for another wallet");
    const txid = await runtime.connection.broadcast(entry.plan.transactionHex, entry.plan.txid);
    return { ok: true, txid };
  }
}

function toError(error: unknown): ErrorResponse {
  if (error instanceof LockedError) return { ok: false, error: error.message, code: "LOCKED" };
  if (error instanceof WrongPasswordError)
    return { ok: false, error: error.message, code: "WRONG_PASSWORD" };
  if (error instanceof ThrottledError)
    return { ok: false, error: error.message, code: "THROTTLED" };
  return { ok: false, error: error instanceof Error ? error.message : "something went wrong" };
}
