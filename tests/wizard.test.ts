import { binToHex, createVirtualMachineBCH, decodeTransaction, hexToBin } from "@bitauth/libauth";
import { encodeKeyExchangeURI, generateKeyExchangeCredentials } from "@wizardconnect/core";
import { describe, expect, it } from "vitest";
import { WalletService, type Connection } from "../src/background/wallet-service";
import { checkWizardUri, type WizardManager } from "../src/background/wizard";
import {
  DappSignError,
  parseDappRequest,
  signDappRequest,
  summarize,
} from "../src/wallet/dapp-sign";
import { HdWallet } from "../src/wallet/hd";
import { p2pkhLockingBytecode } from "../src/wallet/indexer";
import { MemoryKeyValue, WalletSession } from "../src/wallet/session";
import { MemoryStore } from "../src/wallet/store";

// Published BIP39 test vectors. Never use them for funds.
const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const wallet = HdWallet.fromMnemonic(VECTOR);
const other = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const own = binToHex(p2pkhLockingBytecode(wallet.addressKey(0, 0).keyHash));
const theirs = binToHex(p2pkhLockingBytecode(other.addressKey(0, 0).keyHash));
const OUTPOINT = "11".repeat(32);

/** A request as it arrives over the relay: plain JSON with libauth's extended values. */
function request(overrides: Record<string, unknown> = {}) {
  return {
    transaction: {
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: `<Uint8Array: 0x${OUTPOINT}>`,
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: "<Uint8Array: 0x>",
        },
      ],
      outputs: [
        { lockingBytecode: `<Uint8Array: 0x${theirs}>`, valueSatoshis: "<bigint: 60000n>" },
        { lockingBytecode: "<Uint8Array: 0x6a0474657374>", valueSatoshis: "<bigint: 0n>" },
        { lockingBytecode: `<Uint8Array: 0x${own}>`, valueSatoshis: "<bigint: 39500n>" },
      ],
    },
    sourceOutputs: [
      {
        outpointTransactionHash: `<Uint8Array: 0x${OUTPOINT}>`,
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: "<Uint8Array: 0x>",
        lockingBytecode: `<Uint8Array: 0x${own}>`,
        valueSatoshis: "<bigint: 100000n>",
      },
    ],
    broadcast: false,
    userPrompt: "Prove you own this address",
    ...overrides,
  };
}

const PATHS = [[0, "receive", 0]];

describe("dApp transactions", () => {
  it("summarises the transaction and signs it with 0x61, passing the script engine", () => {
    const parsed = parseDappRequest(wallet, request(), PATHS);
    expect(summarize(parsed, wallet, "chipnet")).toMatchObject({
      inputs: 1,
      signing: { count: 1, value: "100000" },
      fee: "500",
      broadcast: false,
      burns: [],
      userPrompt: "Prove you own this address",
      outputs: [
        { address: other.address(0, 0, "chipnet"), value: "60000", own: false },
        { address: null, script: "6a0474657374", value: "0" },
        { address: wallet.address(0, 0, "chipnet"), own: true },
      ],
    });
    const signed = signDappRequest(parsed, wallet);
    expect(signed.complete).toBe(true);
    const tx = decodeTransaction(hexToBin(signed.hex));
    if (typeof tx === "string") throw new Error(tx);
    expect(tx.inputs[0]!.unlockingBytecode.length).toBe(1 + 65 + 1 + 33);
    expect(tx.inputs[0]!.unlockingBytecode[65]).toBe(0x61);
    expect(
      createVirtualMachineBCH(true).verify({
        transaction: tx,
        sourceOutputs: parsed.sourceOutputs,
      }),
    ).toBe(true);
  });

  it("accepts a transaction sent as hex", () => {
    const parsed = parseDappRequest(wallet, request(), PATHS);
    const hex = signDappRequest(parsed, wallet).hex;
    const again = parseDappRequest(wallet, request({ transaction: hex }), PATHS);
    expect(again.transaction.outputs).toHaveLength(3);
  });

  it("refuses requests whose amounts or keys cannot be checked", () => {
    const cases: [Record<string, unknown>, unknown, string][] = [
      [{ sourceOutputs: [] }, PATHS, "every input needs its source output"],
      [
        { sourceOutputs: [{ ...request().sourceOutputs[0], outpointIndex: 1 }] },
        PATHS,
        "does not match the outpoint",
      ],
      [
        {
          sourceOutputs: [
            {
              ...request().sourceOutputs[0],
              outpointTransactionHash: undefined,
              outpointIndex: undefined,
            },
          ],
        },
        PATHS,
        "does not name its outpoint",
      ],
      [
        { sourceOutputs: [{ ...request().sourceOutputs[0], contract: { redeemScript: "51" } }] },
        PATHS,
        "contract inputs are not supported yet",
      ],
      [{}, [[0, "receive", 1]], "not this wallet's address"],
      [{}, [[0, "stealth", 0]], "unknown key path"],
      [{}, [[3, "receive", 0]], "does not exist"],
      [{}, [], "names no inputs"],
      [
        { sourceOutputs: [{ ...request().sourceOutputs[0], lockingBytecode: theirs }] },
        PATHS,
        "not this wallet's address",
      ],
    ];
    for (const [overrides, paths, message] of cases) {
      expect(() => parseDappRequest(wallet, request(overrides), paths)).toThrow(DappSignError);
      expect(() => parseDappRequest(wallet, request(overrides), paths)).toThrow(message);
    }
    const drain = request();
    drain.transaction.outputs[0]!.valueSatoshis = "<bigint: 1000n>";
    drain.transaction.outputs[2]!.valueSatoshis = "<bigint: 1000n>";
    drain.sourceOutputs[0]!.valueSatoshis = "<bigint: 5000000n>";
    expect(() => summarize(parseDappRequest(wallet, drain, PATHS), wallet, "chipnet")).toThrow(
      "more than half",
    );
    const pricey = request();
    pricey.transaction.outputs[2]!.valueSatoshis = "<bigint: 35000n>";
    expect(summarize(parseDappRequest(wallet, pricey, PATHS), wallet, "chipnet").feeLevel).toBe(
      "high",
    );
    expect(summarize(parseDappRequest(wallet, request(), PATHS), wallet, "chipnet").feeLevel).toBe(
      "ok",
    );
    const tooMuch = request();
    tooMuch.transaction.outputs[0]!.valueSatoshis = "<bigint: 200000n>";
    expect(() => summarize(parseDappRequest(wallet, tooMuch, PATHS), wallet, "chipnet")).toThrow(
      "worth more than the inputs",
    );
  });

  it("shows tokens that are spent and not paid anywhere as destroyed", () => {
    const category = "ab".repeat(32);
    const burning = request();
    (burning.sourceOutputs[0] as Record<string, unknown>).token = {
      category: `<Uint8Array: 0x${category}>`,
      amount: "<bigint: 5n>",
    };
    const parsed = parseDappRequest(wallet, burning, PATHS);
    expect(summarize(parsed, wallet, "chipnet").burns).toEqual([category]);
  });
});

describe("checkWizardUri", () => {
  it("accepts the default relay only", () => {
    const { publicKey, secret } = generateKeyExchangeCredentials();
    const { uri } = encodeKeyExchangeURI(publicKey, secret);
    expect(checkWizardUri(` ${uri} `)).toBe(uri);
    const elsewhere = encodeKeyExchangeURI(publicKey, secret, { hostname: "relay.example" }).uri;
    expect(() => checkWizardUri(elsewhere)).toThrow("a relay Cashlet does not connect to");
  });

  it("refuses links that are not WizardConnect links", () => {
    expect(() => checkWizardUri("https://example.com")).toThrow();
    expect(() => checkWizardUri("bitcoincash:qq")).toThrow();
  });
});

/** Stands in for the relay connection; tests drive its events. */
class FakeManager implements WizardManager {
  readonly responses: { id: string; sequence: number; hex: string }[] = [];
  readonly errors: { id: string; sequence: number; message: string }[] = [];
  private handlers: Record<string, ((...args: never[]) => void)[]> = {};
  xpub = "";
  constructor(adapter: { getXpub(path: number): string }) {
    this.xpub = adapter.getXpub(0);
  }
  connect(): string {
    return "c1";
  }
  disconnect(): void {}
  disconnectAll(): void {}
  getConnections() {
    return {
      c1: { id: "c1", status: { status: "connected" }, dappName: "Test app", connectedAt: 1 },
    };
  }
  async sendSignResponse(id: string, sequence: number, hex: string) {
    this.responses.push({ id, sequence, hex });
  }
  async sendSignError(id: string, sequence: number, message: string) {
    this.errors.push({ id, sequence, message });
  }
  on(event: string, fn: (...args: never[]) => void) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    for (const fn of this.handlers[event] ?? []) (fn as (...a: unknown[]) => void)(...args);
  }
}

class EmptyConnection implements Connection {
  currentServer = "wss://fake.test";
  readonly broadcasts: string[] = [];
  async request<T>(method: string): Promise<T> {
    return (method === "blockchain.relayfee" ? 0.00001 : []) as T;
  }
  async subscribe(): Promise<string | null> {
    return null;
  }
  onStatus(): () => void {
    return () => undefined;
  }
  async broadcast(hex: string, txid: string): Promise<string> {
    this.broadcasts.push(hex);
    return txid;
  }
  health() {
    return [];
  }
  close(): void {}
}

async function service() {
  let manager: FakeManager | null = null;
  const connection = new EmptyConnection();
  const svc = new WalletService({
    session: new WalletSession(new MemoryKeyValue(), { iterations: 1_000 }),
    settings: new MemoryKeyValue(),
    connect: () => connection,
    openStore: async () => new MemoryStore(),
    wizardManager: (adapter) => (manager = new FakeManager(adapter)),
  });
  await svc.handle({
    type: "IMPORT_WALLET",
    mnemonic: VECTOR,
    password: "correct horse",
    network: "chipnet",
  });
  const { publicKey, secret } = generateKeyExchangeCredentials();
  const { uri } = encodeKeyExchangeURI(publicKey, secret);
  const connected = await svc.handle({ type: "WIZARD_CONNECT", uri });
  expect(connected).toEqual({ ok: true, id: "c1" });
  return { svc, manager: () => manager, connection, uri };
}

describe("WizardConnect in the wallet service", () => {
  it("hands the dApp this wallet's xpubs and asks before signing", async () => {
    const { svc, manager, connection } = await service();
    // A malformed link is refused before anything connects.
    expect(await svc.handle({ type: "WIZARD_CONNECT", uri: "wiz://nonsense" })).toMatchObject({
      ok: false,
    });
    const m = manager()!;
    expect(m.xpub).toBe(wallet.xpub(0));

    m.emit("pendingSignRequest", {
      connectionId: "c1",
      request: {
        action: "sign_transaction_request",
        sequence: 7,
        inputPaths: PATHS,
        transaction: request(),
      },
    });
    const list = await svc.handle({ type: "APPROVALS_LIST" });
    if (!list.ok) throw new Error(list.error);
    const approval = list.approvals[0]!;
    expect(approval).toMatchObject({
      type: "transaction",
      origin: "WizardConnect: Test app",
      transaction: { fee: "500", broadcast: false },
    });
    await svc.handle({ type: "APPROVAL_DECIDE", id: approval.id, approve: true, remember: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.responses).toHaveLength(1);
    expect(m.responses[0]).toMatchObject({ id: "c1", sequence: 7 });
    // broadcast: false is honoured.
    expect(connection.broadcasts).toHaveLength(0);
  });
});
