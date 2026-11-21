import { BINDING_EVENT_KIND, verifyBinding } from "@cashlet-labs/bnd";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ErrorResponse, PlannedOutputMessage, Request, ResponseFor } from "../shared/messages";
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
import { WrongPasswordError } from "../wallet/vault";

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
}

const PLAN_TTL_MS = 2 * 60_000;
const DEFAULT_AUTO_LOCK_MINUTES = 15;

interface Runtime {
  walletId: string;
  connection: Connection;
  store: WalletStore;
  scanner: Scanner;
  scan: "idle" | "scanning" | "ready" | "error";
  scanError: string | null;
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

  constructor(private readonly deps: ServiceDeps) {}

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
        return {
          ok: true,
          ...status,
          network: status.unlocked ? session.current().network : null,
          scan: this.runtime?.scan ?? "idle",
          scanError: this.runtime?.scanError ?? null,
          autoLockMinutes: await this.autoLockMinutes(),
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
        return { ok: true };
      }
      case "RENAME_WALLET":
        await session.rename(request.walletId, request.name);
        return { ok: true };
      case "SET_AUTO_LOCK":
        await this.deps.settings.set("autoLockMinutes", request.minutes);
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
    this.runtime?.connection.close();
    const connection = this.deps.connect(network);
    const store = await this.deps.openStore(id);
    const scanner = new Scanner(wallet, network, connection, store);
    const runtime: Runtime = {
      walletId: id,
      connection,
      store,
      scanner,
      scan: "scanning",
      scanError: null,
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
  }

  private async prepareSend(
    recipients: Extract<Request, { type: "PREPARE_SEND" }>["recipients"],
  ): Promise<ResponseFor["PREPARE_SEND"]> {
    const { wallet, network, id } = this.deps.session.current();
    const runtime = this.active();
    const relayFee = await runtime.connection
      .request<number>("blockchain.relayfee")
      .catch(() => 0.00001);
    // relayfee is BCH per kB; at least 1 sat/byte, at most 10.
    const feeRate = Math.min(10, Math.max(1, Math.ceil((Number(relayFee) || 0) * 100_000)));
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
