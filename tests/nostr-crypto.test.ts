import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { parsePageRequest } from "../src/shared/page-messages";
import {
  chacha20,
  nip04Decrypt,
  nip04Encrypt,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  nip44MessageKeys,
  nip44PaddedLength,
  runCipher,
} from "../src/wallet/nostr-crypto";
import vectors from "./nip44.vectors.json";

// Official NIP-44 test vectors (github.com/paulmillr/nip44, nip44.vectors.json).
const v2 = vectors.v2;
const hex = (value: string) => hexToBytes(value);
const publicKeyOf = (secret: string) => bytesToHex(schnorr.getPublicKey(hex(secret)));

describe("ChaCha20", () => {
  it("matches the RFC 8439 section 2.4.2 vector", () => {
    // The RFC starts at block counter 1 and NIP-44 at 0, so skip the first block with padding.
    const key = hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const nonce = hex("000000000000004a00000000");
    const text = utf8ToBytes(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const padded = new Uint8Array(64 + text.length);
    padded.set(text, 64);
    const out = chacha20(key, nonce, padded).subarray(64);
    expect(bytesToHex(out.subarray(0, 16))).toBe("6e2e359a2568f98041ba0728dd0d6981");
    expect(bytesToHex(out.subarray(out.length - 4))).toBe("5e42874d");
  });
});

describe("NIP-44 v2", () => {
  it("derives the conversation key", () => {
    for (const t of v2.valid.get_conversation_key) {
      expect(bytesToHex(nip44ConversationKey(hex(t.sec1), t.pub2))).toBe(t.conversation_key);
    }
  });

  it("derives the message keys", () => {
    const group = v2.valid.get_message_keys;
    for (const k of group.keys) {
      const keys = nip44MessageKeys(hex(group.conversation_key), hex(k.nonce));
      expect(bytesToHex(keys.chachaKey)).toBe(k.chacha_key);
      expect(bytesToHex(keys.chachaNonce)).toBe(k.chacha_nonce);
      expect(bytesToHex(keys.hmacKey)).toBe(k.hmac_key);
    }
  });

  it("pads to the published lengths", () => {
    for (const [length, padded] of v2.valid.calc_padded_len as [number, number][]) {
      expect(nip44PaddedLength(length)).toBe(padded);
    }
  });

  it("encrypts to, and decrypts from, the published payloads", () => {
    for (const t of v2.valid.encrypt_decrypt) {
      const key = nip44ConversationKey(hex(t.sec1), publicKeyOf(t.sec2));
      expect(bytesToHex(key)).toBe(t.conversation_key);
      expect(nip44Encrypt(t.plaintext, key, hex(t.nonce))).toBe(t.payload);
      expect(nip44Decrypt(t.payload, key)).toBe(t.plaintext);
    }
  });

  it("matches the published hashes for the longest messages", () => {
    for (const t of v2.valid.encrypt_decrypt_long_msg) {
      const plaintext = t.pattern.repeat(t.repeat);
      expect(bytesToHex(sha256(utf8ToBytes(plaintext)))).toBe(t.plaintext_sha256);
      const payload = nip44Encrypt(plaintext, hex(t.conversation_key), hex(t.nonce));
      expect(bytesToHex(sha256(utf8ToBytes(payload)))).toBe(t.payload_sha256);
      expect(nip44Decrypt(payload, hex(t.conversation_key))).toBe(plaintext);
    }
  });

  it("refuses the published invalid payloads", () => {
    for (const t of v2.invalid.decrypt) {
      expect(() => nip44Decrypt(t.payload, hex(t.conversation_key)), t.note).toThrow();
    }
  });

  it("refuses the published invalid keys", () => {
    for (const t of v2.invalid.get_conversation_key) {
      expect(() => nip44ConversationKey(hex(t.sec1), t.pub2), t.note).toThrow();
    }
  });

  it("refuses empty and oversized messages", () => {
    const key = hex("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    expect(() => nip44Encrypt("", key)).toThrow();
    expect(() => nip44Encrypt("x".repeat(65_536), key)).toThrow();
    expect(nip44Decrypt(nip44Encrypt("x".repeat(65_535), key), key)).toHaveLength(65_535);
  });

  it("uses a fresh nonce each time", () => {
    const key = hex("c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d");
    expect(nip44Encrypt("same", key)).not.toBe(nip44Encrypt("same", key));
  });
});

describe("NIP-04", () => {
  const a = "0000000000000000000000000000000000000000000000000000000000000001";
  const b = "0000000000000000000000000000000000000000000000000000000000000002";
  // Produced by nostr-tools 2.26.1 nip04.encrypt(a, publicKey(b), "hello nostr ✓").
  const known = "ocfurokqmMpl/5DuL8L6gg==?iv=q1GIwv51wm7SpUWjVw2ysA==";

  it("decrypts a ciphertext made by another implementation, from either side", async () => {
    expect(await nip04Decrypt(hex(b), publicKeyOf(a), known)).toBe("hello nostr ✓");
    expect(await nip04Decrypt(hex(a), publicKeyOf(b), known)).toBe("hello nostr ✓");
  });

  it("produces the same ciphertext for the same IV", async () => {
    const iv = Uint8Array.from(atob("q1GIwv51wm7SpUWjVw2ysA=="), (c) => c.charCodeAt(0));
    expect(await nip04Encrypt(hex(a), publicKeyOf(b), "hello nostr ✓", iv)).toBe(known);
  });

  it("round-trips, and refuses damaged input", async () => {
    const sealed = await nip04Encrypt(hex(a), publicKeyOf(b), "round trip");
    expect(sealed).toMatch(/^[A-Za-z0-9+/]+=*\?iv=[A-Za-z0-9+/]+=*$/);
    expect(await nip04Decrypt(hex(b), publicKeyOf(a), sealed)).toBe("round trip");
    await expect(nip04Decrypt(hex(b), publicKeyOf(a), "not a ciphertext")).rejects.toThrow();
    await expect(nip04Decrypt(hex(b), publicKeyOf(a), "AAAA?iv=AAAA")).rejects.toThrow();
    await expect(nip04Encrypt(hex(a), publicKeyOf(b), "")).rejects.toThrow();
    await expect(nip04Encrypt(hex(a), "zz".repeat(32), "x")).rejects.toThrow("invalid public key");
  });
});

describe("runCipher and page requests", () => {
  const a = hex("0000000000000000000000000000000000000000000000000000000000000001");
  const peer = publicKeyOf("0000000000000000000000000000000000000000000000000000000000000002");
  const origin = "https://app.example";

  it("round-trips through both schemes", async () => {
    for (const scheme of ["nip04", "nip44"] as const) {
      const sealed = await runCipher(
        { method: `nostr.${scheme}.encrypt`, pubkey: peer, plaintext: "hi" },
        a,
      );
      const back = await runCipher(
        { method: `nostr.${scheme}.decrypt`, pubkey: peer, ciphertext: sealed },
        a,
      );
      expect(back).toBe("hi");
    }
  });

  it("accepts well-formed requests and refuses malformed ones", () => {
    const ok = parsePageRequest(
      { method: "nostr.nip44.encrypt", params: { pubkey: peer, plaintext: "hi" } },
      origin,
    );
    expect(ok).toEqual({ method: "nostr.nip44.encrypt", pubkey: peer, plaintext: "hi" });
    const bad = (params: unknown, method = "nostr.nip44.encrypt") =>
      "error" in (parsePageRequest({ method, params }, origin) as object);
    expect(bad({ pubkey: peer.toUpperCase(), plaintext: "hi" })).toBe(true);
    expect(bad({ pubkey: "ab", plaintext: "hi" })).toBe(true);
    expect(bad({ pubkey: peer, plaintext: "" })).toBe(true);
    expect(bad({ pubkey: peer, plaintext: 5 })).toBe(true);
    expect(bad({ pubkey: peer, plaintext: "x".repeat(65_537) })).toBe(true);
    expect(bad({ pubkey: peer, plaintext: "hi", extra: 1 })).toBe(true);
    expect(bad({ pubkey: peer, plaintext: "\ud800" })).toBe(true);
    expect(bad({ pubkey: peer, plaintext: "hi" }, "nostr.nip44.decrypt")).toBe(true);
    expect(bad({ pubkey: peer, ciphertext: "x".repeat(90_001) }, "nostr.nip04.decrypt")).toBe(true);
    expect(bad({ pubkey: peer, ciphertext: "abc" }, "nostr.nip04.decrypt")).toBe(false);
  });
});
