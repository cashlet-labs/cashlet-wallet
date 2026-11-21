import { describe, expect, it } from "vitest";
import {
  headerTimestamp,
  MalformedAnswerError,
  p2pkhLockingBytecode,
  parseHistory,
  parseUtxos,
  scripthashOf,
} from "../src/wallet/indexer";
import { decodeBchAddress } from "@cashlet-labs/bnd";

const SH = "ab".repeat(32);
const TX = "cd".repeat(32);
const CATEGORY = "ef".repeat(32);

describe("scripthashOf", () => {
  it("gives the key a live server indexed a chipnet address under", () => {
    // On 2026-11-21 a chipnet Fulcrum server returned this address's real history
    // (one transaction at height 330043) for exactly this scripthash.
    const { keyHash } = decodeBchAddress("bchtest:qqrh26ggznk0ljer68r7yq23egs54aksd57ukrd79v");
    const lock = p2pkhLockingBytecode(keyHash);
    expect(lock.length).toBe(25);
    expect(scripthashOf(lock)).toBe(
      "78c920a59690567a1da19d914cf1c4d462be0fa5a3518dfbbbde6145524b6c68",
    );
  });
});

describe("parseUtxos", () => {
  it("reads plain and token outputs", () => {
    const utxos = parseUtxos(
      [
        { tx_hash: TX, tx_pos: 0, value: 50_000, height: 330_043 },
        {
          tx_hash: TX,
          tx_pos: 1,
          value: 1_000,
          height: 0,
          token_data: {
            category: CATEGORY,
            amount: "9223372036854775807",
            nft: { capability: "minting", commitment: "01ff" },
          },
        },
      ],
      SH,
    );
    expect(utxos[0]).toEqual({
      txid: TX,
      vout: 0,
      value: 50_000,
      height: 330_043,
      scripthash: SH,
      token: null,
    });
    expect(utxos[1]?.token).toEqual({
      category: CATEGORY,
      amount: 2n ** 63n - 1n,
      nft: { capability: "minting", commitment: "01ff" },
    });
  });

  it("reads an NFT with no fungible amount", () => {
    const [utxo] = parseUtxos(
      [
        {
          tx_hash: TX,
          tx_pos: 2,
          value: 800,
          height: 5,
          token_data: { category: CATEGORY, nft: { capability: "none", commitment: "" } },
        },
      ],
      SH,
    );
    expect(utxo?.token).toEqual({
      category: CATEGORY,
      amount: 0n,
      nft: { capability: "none", commitment: "" },
    });
  });

  it("refuses malformed answers", () => {
    const bad = [
      "x",
      [{ tx_hash: "zz", tx_pos: 0, value: 1, height: 1 }],
      [{ tx_hash: TX, tx_pos: -1, value: 1, height: 1 }],
      [{ tx_hash: TX, tx_pos: 0, value: 1.5, height: 1 }],
      [{ tx_hash: TX, tx_pos: 0, value: 21e14 + 1, height: 1 }],
      [
        {
          tx_hash: TX,
          tx_pos: 0,
          value: 1,
          height: 1,
          token_data: { category: CATEGORY, amount: "1e3" },
        },
      ],
      [
        {
          tx_hash: TX,
          tx_pos: 0,
          value: 1,
          height: 1,
          token_data: { category: CATEGORY, amount: "9223372036854775808" },
        },
      ],
      [
        {
          tx_hash: TX,
          tx_pos: 0,
          value: 1,
          height: 1,
          token_data: { category: CATEGORY, nft: { capability: "owner" } },
        },
      ],
      [{ tx_hash: TX, tx_pos: 0, value: 1, height: 1, token_data: { category: CATEGORY } }],
    ];
    for (const value of bad) expect(() => parseUtxos(value, SH)).toThrow(MalformedAnswerError);
  });
});

describe("parseHistory", () => {
  it("reads confirmed and mempool entries", () => {
    expect(
      parseHistory(
        [
          { tx_hash: TX, height: 7 },
          { tx_hash: TX, height: -1, fee: 220 },
        ],
        SH,
      ),
    ).toEqual([
      { txid: TX, height: 7, scripthash: SH },
      { txid: TX, height: -1, scripthash: SH },
    ]);
  });

  it("refuses malformed entries", () => {
    expect(() => parseHistory([{ tx_hash: TX, height: -2 }], SH)).toThrow(MalformedAnswerError);
    expect(() => parseHistory({}, SH)).toThrow(MalformedAnswerError);
  });
});

describe("headerTimestamp", () => {
  it("reads the block time from bytes 68 to 71", () => {
    const header = "00".repeat(68) + "23d40269" + "00".repeat(8);
    expect(headerTimestamp(header)).toBe(0x6902d423);
  });

  it("refuses anything but an 80-byte header", () => {
    expect(() => headerTimestamp("00".repeat(79))).toThrow(MalformedAnswerError);
  });
});
