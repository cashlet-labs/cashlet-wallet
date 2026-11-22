import type { BchNetwork } from "@cashlet-labs/bnd";
import { decodeKeyExchangeURI, type SignTransactionRequest } from "@wizardconnect/core";
import { DerivationPath, WalletConnectionManager, type WalletAdapter } from "@wizardconnect/wallet";
import { parseDappRequest, signDappRequest, summarize } from "../wallet/dapp-sign";
import type { HdWallet } from "../wallet/hd";
import type { SiteGate } from "./sites";

/**
 * WizardConnect: dApps reach the wallet through a Nostr relay, after the user
 * pastes the dApp's wiz:// link. The wallet shares its receive, change and
 * DeFi xpubs with the dApp, and signs a transaction only after the user
 * approves it on the same approval screen as website requests.
 */

/** The only relay the extension's security policy lets it reach for WizardConnect. */
export const WIZARD_RELAY = "wss://relay.riften.net";

/** The part of WalletConnectionManager the wallet uses, so tests can provide their own. */
export interface WizardManager {
  connect(uri: string): string;
  disconnect(id: string): void;
  disconnectAll(): void;
  getConnections(): Record<
    string,
    { id: string; status: { status: string }; dappName: string | null; connectedAt: number }
  >;
  sendSignResponse(id: string, sequence: number, hex: string): Promise<void>;
  sendSignError(id: string, sequence: number, message: string): Promise<void>;
  on(
    event: "pendingSignRequest",
    fn: (p: { connectionId: string; request: SignTransactionRequest }) => void,
  ): unknown;
  on(event: "signCancelled", fn: (id: string, sequence: number) => void): unknown;
  on(event: "remoteDisconnect", fn: (id: string) => void): unknown;
}

export type CreateWizardManager = (adapter: WalletAdapter) => WizardManager;

export const createWizardManager: CreateWizardManager = (adapter) =>
  new WalletConnectionManager(adapter) as unknown as WizardManager;

/** Check a pasted wiz:// link. Only the default relay is allowed. */
export function checkWizardUri(uri: string): string {
  const value = uri.trim();
  let decoded;
  try {
    decoded = decodeKeyExchangeURI(value);
  } catch {
    throw new Error("this is not a WizardConnect link");
  }
  if (decoded.protocol !== "wss" || decoded.hostname !== "relay.riften.net" || decoded.port !== 443)
    throw new Error("this link uses a relay Cashlet does not connect to");
  return value;
}

export interface WizardConnectionView {
  id: string;
  /** The name the dApp gives itself. Not verified. */
  name: string | null;
  status: string;
  connectedAt: number;
  /** The site whose link the user approved, or null when the user pasted the link. */
  origin: string | null;
}

const CHAINS = {
  [DerivationPath.Receive]: 0,
  [DerivationPath.Change]: 1,
  [DerivationPath.Cauldron]: 7,
} as const;

export class WizardConnections {
  private readonly manager: WizardManager;
  /** `${connectionId}:${sequence}` → approval ID, so a cancelled request leaves the screen. */
  private readonly approvals = new Map<string, string>();
  /** Connection ID → the site that showed the link, for links found on a page. */
  private readonly origins = new Map<string, string>();

  constructor(
    private readonly wallet: HdWallet,
    private readonly network: BchNetwork,
    private readonly gate: SiteGate,
    private readonly broadcast: (hex: string, txid: string) => Promise<string>,
    create: CreateWizardManager = createWizardManager,
  ) {
    const adapter: WalletAdapter = {
      walletName: "Cashlet",
      walletIcon: "",
      getRelayPrivateKey: (uri) => wallet.relayKey(uri),
      getPublicKey: (path, index) => wallet.addressKey(CHAINS[path], Number(index)).publicKey,
      getXpub: (path) => wallet.xpub(CHAINS[path]),
      // Requests are answered from the pendingSignRequest event, after the user approves.
      signTransaction: () => Promise.reject(new Error("not used")),
    };
    this.manager = create(adapter);
    this.manager.on("pendingSignRequest", ({ connectionId, request }) =>
      this.onRequest(connectionId, request),
    );
    this.manager.on("signCancelled", (id, sequence) => {
      const approval = this.approvals.get(`${id}:${sequence}`);
      if (approval) this.gate.cancel(approval, "the app cancelled the request");
    });
    this.manager.on("remoteDisconnect", (id) => this.dropRequests(id));
  }

  connect(uri: string, origin: string | null = null): string {
    const id = this.manager.connect(checkWizardUri(uri));
    if (origin !== null) this.origins.set(id, origin);
    return id;
  }

  list(): WizardConnectionView[] {
    return Object.values(this.manager.getConnections()).map((c) => ({
      id: c.id,
      name: c.dappName,
      status: c.status.status,
      connectedAt: c.connectedAt,
      origin: this.origins.get(c.id) ?? null,
    }));
  }

  disconnect(id: string): void {
    this.dropRequests(id);
    this.origins.delete(id);
    this.manager.disconnect(id);
  }

  close(): void {
    for (const { id } of this.list()) this.dropRequests(id);
    this.manager.disconnectAll();
  }

  private dropRequests(connectionId: string): void {
    for (const [key, approval] of this.approvals) {
      if (key.startsWith(`${connectionId}:`)) this.gate.cancel(approval, "the app disconnected");
    }
  }

  private onRequest(connectionId: string, request: SignTransactionRequest): void {
    const { sequence } = request;
    const fail = (error: unknown) =>
      void this.manager
        .sendSignError(connectionId, sequence, error instanceof Error ? error.message : "refused")
        .catch(() => undefined);
    let parsed;
    let summary;
    try {
      parsed = parseDappRequest(this.wallet, request.transaction, request.inputPaths);
      summary = summarize(parsed, this.wallet, this.network);
    } catch (error) {
      // A malformed or unsafe request never reaches the user.
      fail(error);
      return;
    }
    const name = this.manager.getConnections()[connectionId]?.dappName ?? null;
    const signing = parsed;
    const queued = this.gate.queue(
      {
        origin: `WizardConnect: ${name ?? "unnamed app"}`,
        type: "transaction",
        transaction: summary,
      },
      async () => {
        const signed = signDappRequest(signing, this.wallet);
        // The app asked the wallet to broadcast; only a fully signed transaction can be.
        if (signing.broadcast && signed.complete) await this.broadcast(signed.hex, signed.txid);
        return signed.hex;
      },
    );
    if (!queued.ok) {
      fail(new Error(queued.error));
      return;
    }
    const key = `${connectionId}:${sequence}`;
    this.approvals.set(key, queued.id);
    queued.result.then(
      (hex) => {
        this.approvals.delete(key);
        void this.manager
          .sendSignResponse(connectionId, sequence, hex as string)
          .catch(() => undefined);
      },
      (error: unknown) => {
        this.approvals.delete(key);
        fail(error);
      },
    );
  }
}
