import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Chain } from "./hd";
import type { AddressRecord, HistoryEntry, Utxo } from "./types";

/**
 * Where scanned wallet data lives. Nothing secret is stored here: addresses,
 * outputs and history are public on chain, but together they identify the
 * wallet, so the store is per wallet and is deleted when the wallet is removed.
 */
export interface WalletStore {
  addresses(): Promise<AddressRecord[]>;
  putAddress(address: AddressRecord): Promise<void>;
  /** Replace everything known about one address in a single step. */
  replaceAddressData(scripthash: string, utxos: Utxo[], history: HistoryEntry[]): Promise<void>;
  utxos(): Promise<Utxo[]>;
  history(): Promise<HistoryEntry[]>;
  blockTime(height: number): Promise<number | null>;
  putBlockTime(height: number, timestamp: number): Promise<void>;
  clear(): Promise<void>;
}

const addressKey = (chain: Chain, index: number) => `${chain}/${index}`;

/** An in-memory store, for tests and for wallets that are only being looked at. */
export class MemoryStore implements WalletStore {
  private readonly addressMap = new Map<string, AddressRecord>();
  private readonly utxoMap = new Map<string, Utxo[]>();
  private readonly historyMap = new Map<string, HistoryEntry[]>();
  private readonly times = new Map<number, number>();

  async addresses(): Promise<AddressRecord[]> {
    return [...this.addressMap.values()];
  }
  async putAddress(address: AddressRecord): Promise<void> {
    this.addressMap.set(addressKey(address.chain, address.index), { ...address });
  }
  async replaceAddressData(
    scripthash: string,
    utxos: Utxo[],
    history: HistoryEntry[],
  ): Promise<void> {
    this.utxoMap.set(
      scripthash,
      utxos.map((u) => ({ ...u })),
    );
    this.historyMap.set(
      scripthash,
      history.map((h) => ({ ...h })),
    );
  }
  async utxos(): Promise<Utxo[]> {
    return [...this.utxoMap.values()].flat();
  }
  async history(): Promise<HistoryEntry[]> {
    return [...this.historyMap.values()].flat();
  }
  async blockTime(height: number): Promise<number | null> {
    return this.times.get(height) ?? null;
  }
  async putBlockTime(height: number, timestamp: number): Promise<void> {
    this.times.set(height, timestamp);
  }
  async clear(): Promise<void> {
    this.addressMap.clear();
    this.utxoMap.clear();
    this.historyMap.clear();
    this.times.clear();
  }
}

/** Token amounts are bigints, which IndexedDB stores, but kept as strings for clarity across versions. */
type StoredUtxo = Omit<Utxo, "token"> & {
  key: string;
  token: (Omit<NonNullable<Utxo["token"]>, "amount"> & { amount: string }) | null;
};
type StoredHistory = HistoryEntry & { key: string };

interface Schema extends DBSchema {
  addresses: { key: string; value: AddressRecord & { key: string } };
  utxos: { key: string; value: StoredUtxo; indexes: { by_scripthash: string } };
  history: { key: string; value: StoredHistory; indexes: { by_scripthash: string } };
  blocktimes: { key: number; value: { height: number; timestamp: number } };
}

/** The IndexedDB store used by the extension: one database per wallet. */
export class IndexedDbStore implements WalletStore {
  private constructor(private readonly db: IDBPDatabase<Schema>) {}

  static async open(walletId: string): Promise<IndexedDbStore> {
    if (!/^[0-9a-z-]{1,64}$/.test(walletId)) throw new TypeError("invalid wallet id");
    const db = await openDB<Schema>(`cashlet-wallet-${walletId}`, 1, {
      upgrade(database) {
        database.createObjectStore("addresses", { keyPath: "key" });
        database
          .createObjectStore("utxos", { keyPath: "key" })
          .createIndex("by_scripthash", "scripthash");
        database
          .createObjectStore("history", { keyPath: "key" })
          .createIndex("by_scripthash", "scripthash");
        database.createObjectStore("blocktimes", { keyPath: "height" });
      },
    });
    return new IndexedDbStore(db);
  }

  async addresses(): Promise<AddressRecord[]> {
    return (await this.db.getAll("addresses")).map(({ key: _key, ...address }) => address);
  }

  async putAddress(address: AddressRecord): Promise<void> {
    await this.db.put("addresses", { ...address, key: addressKey(address.chain, address.index) });
  }

  async replaceAddressData(
    scripthash: string,
    utxos: Utxo[],
    history: HistoryEntry[],
  ): Promise<void> {
    const tx = this.db.transaction(["utxos", "history"], "readwrite");
    const utxoStore = tx.objectStore("utxos");
    const historyStore = tx.objectStore("history");
    for (const key of await utxoStore.index("by_scripthash").getAllKeys(scripthash))
      await utxoStore.delete(key);
    for (const key of await historyStore.index("by_scripthash").getAllKeys(scripthash))
      await historyStore.delete(key);
    for (const utxo of utxos) {
      await utxoStore.put({
        ...utxo,
        key: `${utxo.txid}:${utxo.vout}`,
        token: utxo.token ? { ...utxo.token, amount: utxo.token.amount.toString() } : null,
      });
    }
    for (const entry of history)
      await historyStore.put({ ...entry, key: `${scripthash}:${entry.txid}` });
    await tx.done;
  }

  async utxos(): Promise<Utxo[]> {
    return (await this.db.getAll("utxos")).map(({ key: _key, token, ...utxo }) => ({
      ...utxo,
      token: token ? { ...token, amount: BigInt(token.amount) } : null,
    }));
  }

  async history(): Promise<HistoryEntry[]> {
    return (await this.db.getAll("history")).map(({ key: _key, ...entry }) => entry);
  }

  async blockTime(height: number): Promise<number | null> {
    return (await this.db.get("blocktimes", height))?.timestamp ?? null;
  }

  async putBlockTime(height: number, timestamp: number): Promise<void> {
    await this.db.put("blocktimes", { height, timestamp });
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(["addresses", "utxos", "history", "blocktimes"], "readwrite");
    await Promise.all([
      tx.objectStore("addresses").clear(),
      tx.objectStore("utxos").clear(),
      tx.objectStore("history").clear(),
      tx.objectStore("blocktimes").clear(),
      tx.done,
    ]);
  }

  close(): void {
    this.db.close();
  }
}
