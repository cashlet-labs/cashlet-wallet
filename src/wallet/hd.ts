import { encodeBchAddress, keyHashFromPublicKey, type BchNetwork } from "@cashlet-labs/bnd";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Receive addresses are chain 0 and change addresses chain 1 (BIP44). */
export type Chain = 0 | 1;

/** BIP44 account for Bitcoin Cash, coin type 145. */
const BCH_ACCOUNT = "m/44'/145'/0'";
/** NIP-06 path of the Nostr key, the same one BND derives (BND-1 section 3.2). */
const NOSTR_PATH = "m/44'/1237'/0'/0/0";
/** BIP32 indexes below 2^31; hardened indexes are not used for addresses. */
const MAX_INDEX = 0x7fffffff;

export interface AddressKey {
  chain: Chain;
  index: number;
  /** BIP32 path, for display and for wallets that sign by path. */
  path: string;
  publicKey: Uint8Array;
  keyHash: Uint8Array;
}

export function newMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

/** Lowercase, single spaces: the form that is validated and stored. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(normalizeMnemonic(mnemonic), wordlist);
}

function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new RangeError("address index out of range");
  }
}

/**
 * Keys of one wallet, derived from its mnemonic. The seed is computed once; private
 * keys are derived only when something is signed and are never kept.
 */
export class HdWallet {
  private readonly account: HDKey;
  private readonly root: HDKey;
  private readonly chains: Record<Chain, HDKey>;

  private constructor(root: HDKey) {
    this.root = root;
    this.account = root.derive(BCH_ACCOUNT);
    this.chains = { 0: this.account.deriveChild(0), 1: this.account.deriveChild(1) };
  }

  static fromMnemonic(mnemonic: string): HdWallet {
    const normalized = normalizeMnemonic(mnemonic);
    if (!validateMnemonic(normalized, wordlist)) throw new TypeError("invalid recovery phrase");
    return new HdWallet(HDKey.fromMasterSeed(mnemonicToSeedSync(normalized)));
  }

  /** Public data of an address key. No private key is returned. */
  addressKey(chain: Chain, index: number): AddressKey {
    checkIndex(index);
    const node = this.chains[chain].deriveChild(index);
    if (!node.publicKey) throw new Error("public key derivation failed");
    return {
      chain,
      index,
      path: `${BCH_ACCOUNT}/${chain}/${index}`,
      publicKey: node.publicKey,
      keyHash: keyHashFromPublicKey(node.publicKey),
    };
  }

  address(chain: Chain, index: number, network: BchNetwork, tokenAware = false): string {
    return encodeBchAddress(this.addressKey(chain, index).keyHash, network, { tokenAware });
  }

  /** The private key of one address, for signing. The caller drops it after use. */
  privateKey(chain: Chain, index: number): Uint8Array {
    checkIndex(index);
    const key = this.chains[chain].deriveChild(index).privateKey;
    if (!key) throw new Error("private key derivation failed");
    return key;
  }

  /** The Nostr key (NIP-06), as BND derives it. */
  nostrKey(): { privateKey: Uint8Array; publicKey: string } {
    const privateKey = this.root.derive(NOSTR_PATH).privateKey;
    if (!privateKey) throw new Error("Nostr key derivation failed");
    return { privateKey, publicKey: bytesToHex(schnorr.getPublicKey(privateKey)) };
  }

  /** True when `publicKey` belongs to this address (used before signing an input). */
  ownsPublicKey(chain: Chain, index: number, publicKey: Uint8Array): boolean {
    const own = this.addressKey(chain, index).publicKey;
    return own.length === publicKey.length && own.every((byte, i) => byte === publicKey[i]);
  }
}

/** The compressed public key of a private key. */
export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}
