import { decodeTransaction, hexToBin } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { HdWallet, type Chain } from "../src/wallet/hd";
import { p2pkhLockingBytecode, scripthashOf } from "../src/wallet/indexer";
import { buildSendMax, SendError, type MaxSendRequest } from "../src/wallet/send";
import type { TokenData, Utxo } from "../src/wallet/types";

// Published BIP39 test vector. Never use it for funds.
const wallet = HdWallet.fromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const other = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const CAT = "c1".repeat(32);
const RECIPIENT = other.address(0, 0, "chipnet");

const keys = new Map<string, [Chain, number]>();
for (const chain of [0, 1] as const) {
  for (let index = 0; index < 5; index++) {
    keys.set(scripthashOf(p2pkhLockingBytecode(wallet.addressKey(chain, index).keyHash)), [
      chain,
      index,
    ]);
  }
}
const sh = (chain: Chain, index: number) =>
  scripthashOf(p2pkhLockingBytecode(wallet.addressKey(chain, index).keyHash));
let n = 0;
function utxo(
  value: number,
  token: TokenData | null = null,
  height = 100,
  at: [Chain, number] = [0, 0],
): Utxo {
  n += 1;
  return {
    txid: n.toString(16).padStart(64, "0"),
    vout: 0,
    value,
    height,
    scripthash: sh(...at),
    token,
  };
}

function request(utxos: Utxo[], extra: Partial<MaxSendRequest> = {}): MaxSendRequest {
  return {
    network: "chipnet",
    utxos,
    address: RECIPIENT,
    keyFor: (u) => {
      const [chain, index] = keys.get(u.scripthash)!;
      return {
        privateKey: wallet.privateKey(chain, index),
        publicKey: wallet.addressKey(chain, index).publicKey,
      };
    },
    lockingBytecodeFor: (u) => {
      const [chain, index] = keys.get(u.scripthash)!;
      return p2pkhLockingBytecode(wallet.addressKey(chain, index).keyHash);
    },
    ...extra,
  };
}

function decoded(hex: string) {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === "string") throw new Error(tx);
  return tx;
}

describe("buildSendMax", () => {
  it("sends everything minus the exact fee, with one output and no change", () => {
    const plan = buildSendMax(request([utxo(60_000), utxo(40_000, null, 0, [0, 1])]));
    expect(plan.fee).toBe(plan.size);
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]).toMatchObject({ address: RECIPIENT, value: 100_000 - plan.fee });
    expect(plan.outputs[0]!.change).toBe(false);
    expect(plan.inputs).toHaveLength(2);
    expect(plan.outgoing).toBe(100_000);
    const tx = decoded(plan.transactionHex);
    expect(tx.outputs).toHaveLength(1);
    expect(Number(tx.outputs[0]!.valueSatoshis)).toBe(100_000 - plan.fee);
  });

  it("uses the chosen fee rate", () => {
    const plan = buildSendMax(request([utxo(100_000)], { feeRate: 3 }));
    expect(plan.fee).toBe(plan.size * 3);
    expect(plan.outputs[0]!.value).toBe(100_000 - plan.size * 3);
  });

  it("never spends or burns token coins", () => {
    const fungible: TokenData = { category: CAT, amount: 50n, nft: null };
    const nft: TokenData = {
      category: CAT,
      amount: 0n,
      nft: { capability: "minting", commitment: "01" },
    };
    const coins = [utxo(20_000), utxo(10_000, fungible), utxo(10_000, nft)];
    const plan = buildSendMax(request(coins));
    expect(plan.inputs).toEqual([coins[0]]);
    const tx = decoded(plan.transactionHex);
    expect(tx.outputs.every((o) => o.token === undefined)).toBe(true);
    expect(tx.inputs).toHaveLength(1);
  });

  it("leaves out a coin worth less than the fee it adds", () => {
    const tiny = utxo(100);
    const plan = buildSendMax(request([utxo(50_000), tiny]));
    expect(plan.inputs).not.toContain(tiny);
  });

  it("refuses when the balance is too small for the fee and dust", () => {
    expect(() => buildSendMax(request([utxo(300)]))).toThrow(SendError);
    expect(() => buildSendMax(request([utxo(400)]))).toThrow(/too small/);
  });

  it("succeeds at the smallest amount that is not dust", () => {
    const probe = buildSendMax(request([utxo(10_000)]));
    const exact = probe.fee + 546;
    const plan = buildSendMax(request([utxo(exact)]));
    expect(plan.outputs[0]!.value).toBe(546);
    expect(() => buildSendMax(request([utxo(exact - 1)]))).toThrow(/too small/);
  });

  it("refuses when only token coins exist", () => {
    const fungible: TokenData = { category: CAT, amount: 5n, nft: null };
    expect(() => buildSendMax(request([utxo(50_000, fungible)]))).toThrow(/no BCH/);
  });

  it("refuses a bad fee rate and a wrong-network address", () => {
    expect(() => buildSendMax(request([utxo(50_000)], { feeRate: 0 }))).toThrow(SendError);
    expect(() => buildSendMax(request([utxo(50_000)], { feeRate: 11 }))).toThrow(SendError);
    expect(() =>
      buildSendMax(request([utxo(50_000)], { address: other.address(0, 0, "mainnet") })),
    ).toThrow();
  });
});
