import {
  BINDING_EVENT_KIND,
  createBinding,
  createKeySigner,
  createNostrKeySigner,
  deriveBchKey,
  deriveNostrKey,
} from "@cashlet-labs/bnd";
import { describe, expect, it } from "vitest";
import { handle } from "../src/background/handlers";

// A test mnemonic, published in BIP39's vectors. Never use it for funds.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

async function binding(proofType: "message" | "tx") {
  const nostr = deriveNostrKey(MNEMONIC);
  const bch = deriveBchKey(MNEMONIC);
  return createBinding({
    nostrSigner: createNostrKeySigner(nostr.privateKey),
    bchSigner: createKeySigner(bch.privateKey),
    bchKeyHash: bch.keyHash,
    network: "chipnet",
    proofType,
    createdAt: 1_795_132_800,
  });
}

describe("handle", () => {
  it("answers PING with the BND binding kind", async () => {
    expect(await handle({ type: "PING" })).toEqual({ ok: true, bindingKind: BINDING_EVENT_KIND });
  });

  it.each(["message", "tx"] as const)("verifies a binding with a %s proof", async (proofType) => {
    const created = await binding(proofType);
    const result = await handle({ type: "VERIFY_BINDING", event: created.event });
    expect(result).toEqual({
      ok: true,
      nostrPublicKey: created.nostrPublicKey,
      address: created.bch.address,
      proofType,
    });
  });

  it("refuses a tampered binding", async () => {
    const created = await binding("message");
    const event = {
      ...created.event,
      content: created.event.content.replace("chipnet", "mainnet"),
    };
    const result = await handle({ type: "VERIFY_BINDING", event });
    expect(result.ok).toBe(false);
  });
});
