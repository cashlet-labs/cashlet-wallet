import { deriveBchKey, deriveNostrKey, encodeBchAddress } from "@cashlet-labs/bnd";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  HdWallet,
  isValidMnemonic,
  newMnemonic,
  normalizeMnemonic,
  publicKeyOf,
} from "../src/wallet/hd";

// Published test vectors. Never use them for funds.
const BIP39_VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NIP06_VECTOR =
  "leader monkey parrot ring guide accident before fence cannon height naive bean";

describe("mnemonics", () => {
  it("creates valid 12-word phrases", () => {
    const phrase = newMnemonic();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(isValidMnemonic(phrase)).toBe(true);
  });

  it("accepts spacing and case variations, refuses bad checksums", () => {
    expect(normalizeMnemonic(`  ${BIP39_VECTOR.toUpperCase().replaceAll(" ", "   ")} \n`)).toBe(
      BIP39_VECTOR,
    );
    expect(isValidMnemonic(BIP39_VECTOR.replace("about", "abandon"))).toBe(false);
    expect(() => HdWallet.fromMnemonic("not a phrase")).toThrow("invalid recovery phrase");
  });
});

describe("HdWallet", () => {
  const wallet = HdWallet.fromMnemonic(BIP39_VECTOR);

  it("derives the same receive keys as BND (m/44'/145'/0'/0/i)", () => {
    for (const index of [0, 1, 7]) {
      const bnd = deriveBchKey(BIP39_VECTOR, 0, index);
      const own = wallet.addressKey(0, index);
      expect(own.path).toBe(bnd.path);
      expect(bytesToHex(own.publicKey)).toBe(bytesToHex(bnd.publicKey));
      expect(bytesToHex(own.keyHash)).toBe(bytesToHex(bnd.keyHash));
      expect(bytesToHex(wallet.privateKey(0, index))).toBe(bytesToHex(bnd.privateKey));
    }
  });

  it("encodes addresses for both networks, plain and token-aware", () => {
    const keyHash = wallet.addressKey(0, 0).keyHash;
    expect(wallet.address(0, 0, "mainnet")).toBe(encodeBchAddress(keyHash, "mainnet"));
    expect(wallet.address(0, 0, "chipnet")).toMatch(/^bchtest:q/);
    expect(wallet.address(0, 0, "mainnet", true)).toMatch(/^bitcoincash:z/);
  });

  it("keeps change keys separate from receive keys", () => {
    expect(wallet.addressKey(1, 0).path).toBe("m/44'/145'/0'/1/0");
    expect(wallet.address(1, 0, "mainnet")).not.toBe(wallet.address(0, 0, "mainnet"));
  });

  it("matches each private key to its public key", () => {
    const key = wallet.addressKey(1, 3);
    expect(bytesToHex(publicKeyOf(wallet.privateKey(1, 3)))).toBe(bytesToHex(key.publicKey));
    expect(wallet.ownsPublicKey(1, 3, key.publicKey)).toBe(true);
    expect(wallet.ownsPublicKey(1, 4, key.publicKey)).toBe(false);
  });

  it("derives the NIP-06 test vector's Nostr key, as BND does", () => {
    const nostr = HdWallet.fromMnemonic(NIP06_VECTOR).nostrKey();
    expect(bytesToHex(nostr.privateKey)).toBe(
      "7f7ff03d123792d6ac594bfa67bf6d0c0ab55b6b1fdb6249303fe861f1ccba9a",
    );
    expect(nostr.publicKey).toBe(
      "17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917",
    );
    expect(nostr.publicKey).toBe(deriveNostrKey(NIP06_VECTOR).publicKey);
  });

  it("refuses out-of-range indexes", () => {
    expect(() => wallet.addressKey(0, -1)).toThrow("out of range");
    expect(() => wallet.addressKey(0, 2 ** 31)).toThrow("out of range");
    expect(() => wallet.privateKey(0, 1.5)).toThrow("out of range");
  });
});
