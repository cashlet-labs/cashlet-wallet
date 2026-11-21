import { decodeTransaction, hexToBin, lockingBytecodeToCashAddress } from "@bitauth/libauth";
import { describe, expect, it } from "vitest";
import { HdWallet, type Chain } from "../src/wallet/hd";
import { p2pkhLockingBytecode, scripthashOf } from "../src/wallet/indexer";
import { buildSend, SendError, type SendRequest } from "../src/wallet/send";
import type { TokenData, Utxo } from "../src/wallet/types";

// Published BIP39 test vector. Never use it for funds.
const wallet = HdWallet.fromMnemonic(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);
const other = HdWallet.fromMnemonic(
  "legal winner thank year wave sausage worth useful legal winner thank yellow",
);
const CAT = "c1".repeat(32);
const CAT2 = "c2".repeat(32);
const RECIPIENT = other.address(0, 0, "chipnet");
const RECIPIENT_TOKENS = other.address(0, 0, "chipnet", true);
const CHANGE = wallet.address(1, 0, "chipnet", true);

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

function request(
  utxos: Utxo[],
  recipients: SendRequest["recipients"],
  extra: Partial<SendRequest> = {},
): SendRequest {
  return {
    network: "chipnet",
    utxos,
    recipients,
    changeAddress: CHANGE,
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
  return tx.outputs.map((o) => {
    const address = lockingBytecodeToCashAddress({
      bytecode: o.lockingBytecode,
      prefix: "bchtest",
      tokenSupport: o.token !== undefined,
    });
    return {
      address: typeof address === "string" ? address : address.address,
      value: Number(o.valueSatoshis),
      tokenAmount: o.token?.amount,
      nft: o.token?.nft?.capability,
    };
  });
}

describe("buildSend: BCH", () => {
  it("pays the recipient, returns change and pays an exact 1 sat/byte fee", () => {
    const plan = buildSend(request([utxo(100_000)], [{ address: RECIPIENT, value: 30_000 }]));
    expect(plan.fee).toBe(plan.size);
    expect(plan.outgoing).toBe(30_000 + plan.fee);
    expect(decoded(plan.transactionHex)).toEqual([
      { address: RECIPIENT, value: 30_000, tokenAmount: undefined, nft: undefined },
      {
        // Change without tokens is a plain output to the same key as the token-aware change address.
        address: wallet.address(1, 0, "chipnet"),
        value: 100_000 - 30_000 - plan.fee,
        tokenAmount: undefined,
        nft: undefined,
      },
    ]);
    expect(plan.txid).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers confirmed, larger outputs and adds inputs until the send is covered", () => {
    const small = utxo(20_000);
    const pending = utxo(90_000, null, 0);
    const big = utxo(60_000, null, 50, [0, 1]);
    const plan = buildSend(request([small, pending, big], [{ address: RECIPIENT, value: 70_000 }]));
    expect(plan.inputs.map((i) => i.value)).toEqual([60_000, 20_000]);
  });

  it("adds a change output only above dust; otherwise the remainder goes to the fee", () => {
    const plan = buildSend(request([utxo(10_500)], [{ address: RECIPIENT, value: 10_000 }]));
    expect(plan.outputs.filter((o) => o.change)).toEqual([]);
    expect(plan.fee).toBe(500);
  });

  it("says how much is missing", () => {
    expect(() => buildSend(request([utxo(1_000)], [{ address: RECIPIENT, value: 5_000 }]))).toThrow(
      /not enough BCH: \d+ more satoshis/,
    );
  });

  it("never pays BCH with token outputs", () => {
    const tokenRich = utxo(500_000, { category: CAT, amount: 10n, nft: null });
    expect(() =>
      buildSend(request([tokenRich, utxo(1_000)], [{ address: RECIPIENT, value: 5_000 }])),
    ).toThrow("not enough BCH");
  });

  it("refuses addresses for another network, amounts below dust and odd fee rates", () => {
    const funds = [utxo(100_000)];
    const mainnet = other.address(0, 0, "mainnet");
    expect(() => buildSend(request(funds, [{ address: mainnet, value: 1_000 }]))).toThrow(
      "this wallet is on chipnet",
    );
    expect(() => buildSend(request(funds, [{ address: RECIPIENT, value: 100 }]))).toThrow(
      "smallest amount",
    );
    expect(() =>
      buildSend(request(funds, [{ address: RECIPIENT, value: 1_000 }], { feeRate: 0.5 })),
    ).toThrow("fee rate");
    expect(() =>
      buildSend(request(funds, [{ address: RECIPIENT, value: 1_000 }], { feeRate: 50 })),
    ).toThrow("fee rate");
    expect(() => buildSend(request(funds, []))).toThrow("add a recipient");
  });

  it("refuses a plan whose fee is out of proportion", () => {
    // 60 inputs at 10 sat/byte cost far more than the 10,000-sat ceiling for a small send.
    const dust = Array.from({ length: 60 }, () => utxo(3_000));
    expect(() =>
      buildSend(request(dust, [{ address: RECIPIENT, value: 20_000 }], { feeRate: 10 })),
    ).toThrow("too high");
  });
});

describe("buildSend: CashTokens", () => {
  it("sends fungible tokens and returns the rest as token change", () => {
    const plan = buildSend(
      request(
        [utxo(1_000, { category: CAT, amount: 100n, nft: null }), utxo(50_000)],
        [{ address: RECIPIENT_TOKENS, value: 0, token: { category: CAT, amount: 30n } }],
      ),
    );
    const outputs = decoded(plan.transactionHex);
    expect(outputs[0]).toMatchObject({ address: RECIPIENT_TOKENS, tokenAmount: 30n });
    expect(outputs.find((o) => o.address === CHANGE && o.tokenAmount === 70n)).toBeDefined();
    expect(
      outputs
        .filter((o) => o.tokenAmount !== undefined)
        .reduce((s, o) => s + (o.tokenAmount ?? 0n), 0n),
    ).toBe(100n);
  });

  it("refuses to send tokens to an address that cannot hold them", () => {
    expect(() =>
      buildSend(
        request(
          [utxo(1_000, { category: CAT, amount: 100n, nft: null }), utxo(50_000)],
          [{ address: RECIPIENT, value: 0, token: { category: CAT, amount: 1n } }],
        ),
      ),
    ).toThrow("token-aware");
  });

  it("never spends an NFT to find fungible tokens", () => {
    const minting = utxo(1_000, {
      category: CAT,
      amount: 500n,
      nft: { capability: "minting", commitment: "" },
    });
    expect(() =>
      buildSend(
        request(
          [minting, utxo(50_000)],
          [{ address: RECIPIENT_TOKENS, value: 0, token: { category: CAT, amount: 1n } }],
        ),
      ),
    ).toThrow("not enough tokens");
  });

  it("sends a chosen NFT and returns the fungible amount on its output", () => {
    const nft = utxo(1_000, {
      category: CAT2,
      amount: 25n,
      nft: { capability: "mutable", commitment: "abcd" },
    });
    const plan = buildSend(
      request(
        [nft, utxo(50_000)],
        [{ address: RECIPIENT_TOKENS, value: 0, nft: { txid: nft.txid, vout: nft.vout } }],
      ),
    );
    const outputs = decoded(plan.transactionHex);
    expect(outputs[0]).toMatchObject({
      address: RECIPIENT_TOKENS,
      nft: "mutable",
      tokenAmount: 0n,
    });
    expect(outputs.find((o) => o.address === CHANGE && o.tokenAmount === 25n)).toBeDefined();
  });

  it("keeps NFTs riding on the same output as fungible tokens it spends", () => {
    // Only pure fungible outputs are picked, so this checks the NFT stays untouched.
    const fungible = utxo(1_000, { category: CAT, amount: 10n, nft: null });
    const keep = utxo(1_000, {
      category: CAT,
      amount: 0n,
      nft: { capability: "none", commitment: "01" },
    });
    const plan = buildSend(
      request(
        [fungible, keep, utxo(50_000)],
        [{ address: RECIPIENT_TOKENS, value: 0, token: { category: CAT, amount: 10n } }],
      ),
    );
    expect(plan.inputs).not.toContain(keep);
  });

  it("refuses an NFT the wallet does not hold", () => {
    expect(() =>
      buildSend(
        request(
          [utxo(50_000)],
          [{ address: RECIPIENT_TOKENS, value: 0, nft: { txid: "ff".repeat(32), vout: 0 } }],
        ),
      ),
    ).toThrow("not in this wallet");
  });
});

it("refuses a change address that cannot hold tokens", () => {
  expect(() =>
    buildSend(
      request([utxo(100_000)], [{ address: RECIPIENT, value: 1_000 }], {
        changeAddress: wallet.address(1, 0, "chipnet"),
      }),
    ),
  ).toThrow(SendError);
});
