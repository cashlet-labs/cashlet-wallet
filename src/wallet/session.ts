import type { BchNetwork } from "@cashlet-labs/bnd";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HdWallet, isValidMnemonic, newMnemonic, normalizeMnemonic } from "./hd";
import {
  DEFAULT_ITERATIONS,
  needsUpgrade,
  open,
  parseVault,
  seal,
  WrongPasswordError,
  type Vault,
} from "./vault";

/** Persistent key-value storage: chrome.storage.local in the extension, a Map in tests. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface WalletRecord {
  id: string;
  name: string;
  network: BchNetwork;
  createdAt: number;
  vault: Vault;
}

export interface WalletSummary {
  id: string;
  name: string;
  network: BchNetwork;
}

export interface SessionStatus {
  wallets: WalletSummary[];
  activeId: string | null;
  unlocked: boolean;
  /** Seconds until another unlock attempt is allowed, after repeated wrong passwords. */
  retryAfter: number;
}

export class LockedError extends Error {
  constructor() {
    super("the wallet is locked");
    this.name = "LockedError";
  }
}

export class ThrottledError extends Error {
  constructor(readonly retryAfter: number) {
    super(`too many wrong passwords; try again in ${retryAfter} seconds`);
    this.name = "ThrottledError";
  }
}

const WALLETS = "wallets";
const ACTIVE = "activeWalletId";
const FAILURES = "unlockFailures";
export const MIN_PASSWORD_LENGTH = 8;
const FREE_ATTEMPTS = 3;
const MAX_WAIT_SECONDS = 300;

interface Failures {
  count: number;
  until: number;
}

function checkPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new RangeError(`use a password of at least ${MIN_PASSWORD_LENGTH} characters`);
  }
}

function newWalletId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

/**
 * Wallets and the unlocked session. While unlocked, only the derived HD keys are
 * held in memory: never the password or the recovery phrase. Anything that needs
 * the phrase again (revealing it, changing the password) asks for the password.
 */
export class WalletSession {
  private unlocked: { id: string; wallet: HdWallet; network: BchNetwork } | null = null;

  constructor(
    private readonly storage: KeyValueStore,
    private readonly options: { iterations?: number; now?: () => number } = {},
  ) {}

  private get iterations(): number {
    return this.options.iterations ?? DEFAULT_ITERATIONS;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async records(): Promise<WalletRecord[]> {
    const stored = (await this.storage.get<WalletRecord[]>(WALLETS)) ?? [];
    return stored.map((r) => ({ ...r, vault: parseVault(r.vault) }));
  }

  private async record(id: string): Promise<WalletRecord> {
    const found = (await this.records()).find((r) => r.id === id);
    if (!found) throw new Error("no such wallet");
    return found;
  }

  async status(): Promise<SessionStatus> {
    const failures = (await this.storage.get<Failures>(FAILURES)) ?? { count: 0, until: 0 };
    return {
      wallets: (await this.records()).map(({ id, name, network }) => ({ id, name, network })),
      activeId: (await this.storage.get<string>(ACTIVE)) ?? null,
      unlocked: this.unlocked !== null,
      retryAfter: Math.max(0, Math.ceil((failures.until - this.now()) / 1000)),
    };
  }

  /** The unlocked wallet. Throws LockedError when locked. */
  current(): { id: string; wallet: HdWallet; network: BchNetwork } {
    if (!this.unlocked) throw new LockedError();
    return this.unlocked;
  }

  /**
   * Create a wallet with a new recovery phrase and unlock it. The phrase is
   * returned once so the user can write it down; it is not kept in memory.
   */
  async create(
    password: string,
    network: BchNetwork,
    name = "Wallet",
  ): Promise<{ id: string; mnemonic: string }> {
    const mnemonic = newMnemonic();
    const id = await this.add(mnemonic, password, network, name);
    return { id, mnemonic };
  }

  /** Restore a wallet from its recovery phrase and unlock it. */
  async import(
    mnemonic: string,
    password: string,
    network: BchNetwork,
    name = "Wallet",
  ): Promise<{ id: string }> {
    if (!isValidMnemonic(mnemonic)) throw new TypeError("that recovery phrase is not valid");
    return { id: await this.add(normalizeMnemonic(mnemonic), password, network, name) };
  }

  private async add(
    mnemonic: string,
    password: string,
    network: BchNetwork,
    name: string,
  ): Promise<string> {
    checkPassword(password);
    const cleanName = name.trim().slice(0, 40) || "Wallet";
    const records = await this.records();
    const id = newWalletId();
    const vault = await seal(JSON.stringify({ mnemonic }), password, this.iterations);
    await this.storage.set(WALLETS, [
      ...records,
      { id, name: cleanName, network, createdAt: this.now(), vault },
    ]);
    await this.storage.set(ACTIVE, id);
    this.unlocked = { id, wallet: HdWallet.fromMnemonic(mnemonic), network };
    return id;
  }

  /** Unlock the active wallet (or `id`). Wrong passwords are throttled. */
  async unlock(password: string, id?: string): Promise<void> {
    const failures = (await this.storage.get<Failures>(FAILURES)) ?? { count: 0, until: 0 };
    if (failures.until > this.now())
      throw new ThrottledError(Math.ceil((failures.until - this.now()) / 1000));
    const walletId = id ?? (await this.storage.get<string>(ACTIVE));
    if (!walletId) throw new Error("there is no wallet yet");
    const record = await this.record(walletId);
    let mnemonic: string;
    try {
      mnemonic = await this.openVault(record, password);
    } catch (error) {
      if (error instanceof WrongPasswordError) {
        const count = failures.count + 1;
        const wait =
          count < FREE_ATTEMPTS ? 0 : Math.min(MAX_WAIT_SECONDS, 2 ** (count - FREE_ATTEMPTS));
        await this.storage.set(FAILURES, { count, until: this.now() + wait * 1000 });
      }
      throw error;
    }
    await this.storage.remove(FAILURES);
    await this.storage.set(ACTIVE, record.id);
    this.unlocked = {
      id: record.id,
      wallet: HdWallet.fromMnemonic(mnemonic),
      network: record.network,
    };
  }

  lock(): void {
    this.unlocked = null;
  }

  /** The recovery phrase, after the password is entered again. */
  async reveal(password: string): Promise<string> {
    const { id } = this.current();
    return this.openVault(await this.record(id), password);
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    checkPassword(newPassword);
    const { id } = this.current();
    const record = await this.record(id);
    const mnemonic = await this.openVault(record, oldPassword);
    await this.replaceVault(
      id,
      await seal(JSON.stringify({ mnemonic }), newPassword, this.iterations),
    );
  }

  /** Delete a wallet after its password is entered. Its scanned data is the caller's to delete. */
  async remove(id: string, password: string): Promise<void> {
    const record = await this.record(id);
    await this.openVault(record, password);
    const remaining = (await this.records()).filter((r) => r.id !== id);
    await this.storage.set(WALLETS, remaining);
    if ((await this.storage.get<string>(ACTIVE)) === id) {
      if (remaining[0]) await this.storage.set(ACTIVE, remaining[0].id);
      else await this.storage.remove(ACTIVE);
    }
    if (this.unlocked?.id === id) this.lock();
  }

  async rename(id: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 40);
    if (!clean) throw new RangeError("enter a name");
    const records = await this.records();
    if (!records.some((r) => r.id === id)) throw new Error("no such wallet");
    await this.storage.set(
      WALLETS,
      records.map((r) => (r.id === id ? { ...r, name: clean } : r)),
    );
  }

  private async openVault(record: WalletRecord, password: string): Promise<string> {
    const content = JSON.parse(await open(record.vault, password)) as { mnemonic?: unknown };
    if (typeof content.mnemonic !== "string" || !isValidMnemonic(content.mnemonic)) {
      throw new Error("the stored wallet is damaged");
    }
    // Vaults sealed with older parameters are re-sealed with today's on first use.
    if (needsUpgrade(record.vault) && this.iterations >= DEFAULT_ITERATIONS) {
      await this.replaceVault(
        record.id,
        await seal(JSON.stringify({ mnemonic: content.mnemonic }), password),
      );
    }
    return content.mnemonic;
  }

  private async replaceVault(id: string, vault: Vault): Promise<void> {
    const records = await this.records();
    await this.storage.set(
      WALLETS,
      records.map((r) => (r.id === id ? { ...r, vault } : r)),
    );
  }
}

/** A KeyValueStore in memory, for tests. */
export class MemoryKeyValue implements KeyValueStore {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    const value = this.data.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}
