import { describe, expect, it } from "vitest";
import { HdWallet } from "../src/wallet/hd";
import {
  keyHashOfAddress,
  signMessage,
  signedMessageHash,
  verifyMessage,
} from "../src/wallet/signed-message";
import { bytesToHex } from "@noble/hashes/utils.js";

// Vectors from the bitcoinjs-message test suite (MIT), which follows Bitcoin Core's format.
const MESSAGE = "vires is numeris";

describe("Bitcoin Signed Message", () => {
  it("hashes like the reference (magic hash of 'Vires is Numeris')", () => {
    expect(bytesToHex(signedMessageHash("Vires is Numeris"))).toBe(
      "f8a5affbef4a3241b19067aa694562f64f513310817297089a8929a930f4f933",
    );
    expect(bytesToHex(signedMessageHash(""))).toBe(
      "80e795d4a4caadd7047af389d9f7f220562feb6196032e2131e10563352c4bcc",
    );
  });

  it("signs with the same bytes as the reference for private key 1", () => {
    const key = new Uint8Array(32);
    key[31] = 1;
    expect(signMessage(key, MESSAGE)).toBe(
      "IF8nHqFr3K2UKYahhX3soVeoW8W1ECNbr0wfck7lzyXjCS5Q16Ek45zyBuy1Fiy9sTPKVgsqqOuPvbycuVSSVl8=",
    );
  });

  it("verifies a known signature for a legacy address, and its cashaddr form", () => {
    const legacy = "1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs";
    const signature =
      "H8JawPtQOrybrSP1WHQnQPr67B9S3qrxBrl1mlzoTJOSHEpmnF7D3+t+LX0Xei9J20B5AIdPbeL3AaTBZ4N3bY0=";
    expect(verifyMessage(legacy, MESSAGE, signature)).toBe(true);
    expect(bytesToHex(keyHashOfAddress(legacy))).toHaveLength(40);
    expect(verifyMessage(legacy, `${MESSAGE}!`, signature)).toBe(false);
    expect(verifyMessage("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", MESSAGE, signature)).toBe(false);
  });

  it("round-trips for a wallet address in cashaddr form, with and without prefix", () => {
    const wallet = HdWallet.fromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const message = "I own this address ✓";
    const signature = signMessage(wallet.privateKey(0, 0), message);
    for (const network of ["mainnet", "chipnet"] as const) {
      const address = wallet.address(0, 0, network);
      expect(verifyMessage(address, message, signature)).toBe(true);
      expect(verifyMessage(address.split(":")[1] as string, message, signature)).toBe(true);
      expect(verifyMessage(address.toUpperCase(), message, signature)).toBe(true);
      expect(verifyMessage(wallet.address(0, 0, network, true), message, signature)).toBe(true);
      expect(verifyMessage(wallet.address(0, 1, network), message, signature)).toBe(false);
    }
    expect(verifyMessage(wallet.address(0, 0, "mainnet"), "another", signature)).toBe(false);
  });

  it("answers false for damaged signatures and throws for addresses that cannot sign", () => {
    const wallet = HdWallet.fromMnemonic(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    );
    const address = wallet.address(0, 0, "mainnet");
    const signature = signMessage(wallet.privateKey(0, 0), "hi");
    expect(verifyMessage(address, "hi", "not base64!")).toBe(false);
    expect(verifyMessage(address, "hi", signature.slice(0, 40))).toBe(false);
    expect(verifyMessage(address, "hi", "AAAA")).toBe(false);
    expect(() => verifyMessage("nonsense", "hi", signature)).toThrow(TypeError);
    // The support address in the README is a script (p2sh) address.
    expect(() =>
      verifyMessage("bitcoincash:pr6m7j9njldwwzlg9v7v53unlr4jkmx6eyvwc0uz5t", "hi", signature),
    ).toThrow(TypeError);
    expect(() => signMessage(wallet.privateKey(0, 0), "")).toThrow();
  });
});
