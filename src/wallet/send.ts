import {
  createVirtualMachineBCH,
  encodeTransaction,
  generateSigningSerializationBCH,
  getDustThreshold,
  hash256,
  hashTransaction,
  hexToBin,
  secp256k1 as libauthSecp256k1,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import type { BchNetwork } from "@cashlet-labs/bnd";
import { parseDestination, type Destination } from "./address";
import type { TokenData, Utxo } from "./types";

/**
 * Building, signing and checking a send.
 *
 * Rules that protect funds:
 * - token UTXOs are never used to pay BCH: they are spent only for the tokens
 *   asked for, and their other tokens and NFTs come back as change;
 * - NFTs are spent only when named, so a minting or mutable NFT is never lost;
 * - tokens go only to token-aware addresses, and every address must be on the
 *   wallet's network;
 * - every input signs SIGHASH_ALL | FORKID | UTXOS (0x61), committing to the
 *   value and tokens of everything spent;
 * - the signed transaction is run through the BCH script engine before it is
 *   returned, and its fee is capped.
 */

const SIGHASH_ALL_FORKID_UTXOS = 0x61;
/** A Schnorr signature with its hash type (65 bytes) and a compressed key (33). */
const P2PKH_UNLOCKING_LENGTH = 1 + 65 + 1 + 33;
export const DEFAULT_FEE_RATE = 1;
const MAX_FEE_RATE = 10;
const vm = createVirtualMachineBCH(true);

export class SendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SendError";
  }
}

export interface RecipientInput {
  address: string;
  /** Satoshis. For token outputs, 0 means the minimum (dust) value. */
  value: number;
  /** Fungible tokens to send to this recipient. */
  token?: { category: string; amount: bigint };
  /** A specific NFT to send, chosen by its output. */
  nft?: { txid: string; vout: number };
}

export interface SendRequest {
  network: BchNetwork;
  utxos: readonly Utxo[];
  recipients: readonly RecipientInput[];
  /** A token-aware change address of this wallet. */
  changeAddress: string;
  /** Satoshis per byte; the server's relay fee, at least 1. */
  feeRate?: number;
  /** Signing keys for an output, by its scripthash. */
  keyFor: (utxo: Utxo) => { privateKey: Uint8Array; publicKey: Uint8Array };
  /** The locking script of a UTXO, for signing (the wallet's own P2PKH script). */
  lockingBytecodeFor: (utxo: Utxo) => Uint8Array;
}

export interface PlannedOutput {
  address: string;
  value: number;
  token: TokenData | null;
  change: boolean;
}

export interface SendPlan {
  transactionHex: string;
  txid: string;
  fee: number;
  size: number;
  inputs: Utxo[];
  outputs: PlannedOutput[];
  /** BCH leaving the wallet: outputs to others plus the fee. */
  outgoing: number;
}

function tokenToLibauth(token: TokenData): NonNullable<Output["token"]> {
  return {
    category: hexToBin(token.category),
    amount: token.amount,
    ...(token.nft
      ? { nft: { capability: token.nft.capability, commitment: hexToBin(token.nft.commitment) } }
      : {}),
  };
}

function toOutput(lockingBytecode: Uint8Array, value: number, token: TokenData | null): Output {
  return {
    lockingBytecode,
    valueSatoshis: BigInt(value),
    ...(token ? { token: tokenToLibauth(token) } : {}),
  };
}

function dustFor(lockingBytecode: Uint8Array, token: TokenData | null): number {
  return Number(getDustThreshold(toOutput(lockingBytecode, 0, token)));
}

function push(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length > 75) throw new RangeError("unsupported push length");
  return Uint8Array.of(data.length, ...data);
}

const outpoint = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;

interface Draft {
  inputs: Utxo[];
  outputs: { destination: Destination; value: number; token: TokenData | null; change: boolean }[];
}

/** Choose inputs and outputs, sign every input, and check the result. */
export function buildSend(request: SendRequest): SendPlan {
  const feeRate = request.feeRate ?? DEFAULT_FEE_RATE;
  if (!Number.isFinite(feeRate) || feeRate < DEFAULT_FEE_RATE || feeRate > MAX_FEE_RATE) {
    throw new SendError(
      `the fee rate must be between ${DEFAULT_FEE_RATE} and ${MAX_FEE_RATE} sat/byte`,
    );
  }
  if (request.recipients.length === 0) throw new SendError("add a recipient");
  const change = parseDestination(request.changeAddress, request.network);
  if (!change.tokenAware) throw new SendError("the change address must be token-aware");

  const draft = planOutputs(request, change);
  let plan = finish(request, draft, change, feeRate, []);
  // Add BCH inputs until the fee and outputs are covered; the fee grows with each input.
  const spare = request.utxos
    .filter((u) => u.token === null && !draft.inputs.some((i) => outpoint(i) === outpoint(u)))
    .sort((a, b) => Number(b.height > 0) - Number(a.height > 0) || b.value - a.value);
  const extra: Utxo[] = [];
  while (typeof plan === "number") {
    const next = spare.shift();
    if (!next)
      throw new SendError(`not enough BCH: ${plan} more satoshis are needed, including the fee`);
    extra.push(next);
    plan = finish(request, draft, change, feeRate, extra);
  }
  return plan;
}

/** Recipient outputs, plus the token inputs and token change they need. */
function planOutputs(request: SendRequest, change: Destination): Draft {
  const inputs: Utxo[] = [];
  const outputs: Draft["outputs"] = [];
  const byOutpoint = new Map(request.utxos.map((u) => [outpoint(u), u]));
  const fungibleNeeded = new Map<string, bigint>();

  for (const recipient of request.recipients) {
    const destination = parseDestination(recipient.address, request.network);
    if (!Number.isSafeInteger(recipient.value) || recipient.value < 0)
      throw new SendError("invalid amount");
    let token: TokenData | null = null;
    if (recipient.nft) {
      const nftUtxo = byOutpoint.get(outpoint(recipient.nft));
      if (!nftUtxo?.token?.nft) throw new SendError("that NFT is not in this wallet");
      if (inputs.includes(nftUtxo)) throw new SendError("the same NFT is sent twice");
      inputs.push(nftUtxo);
      // The NFT travels alone; any fungible amount on its output comes back as change.
      token = { category: nftUtxo.token.category, amount: 0n, nft: nftUtxo.token.nft };
      if (recipient.token)
        throw new SendError("send fungible tokens and an NFT as separate recipients");
    } else if (recipient.token) {
      const { category, amount } = recipient.token;
      if (!/^[0-9a-f]{64}$/.test(category) || amount <= 0n)
        throw new SendError("invalid token amount");
      token = { category, amount, nft: null };
      fungibleNeeded.set(category, (fungibleNeeded.get(category) ?? 0n) + amount);
    }
    if (token && !destination.tokenAware) {
      throw new SendError("tokens can only go to a token-aware address (starting with z or r)");
    }
    const dust = dustFor(destination.lockingBytecode, token);
    const value = token && recipient.value === 0 ? dust : recipient.value;
    if (value < dust)
      throw new SendError(`the smallest amount this output can carry is ${dust} satoshis`);
    outputs.push({ destination, value, token, change: false });
  }

  // Fungible tokens come from pure fungible outputs first; NFT outputs are never spent implicitly.
  for (const [category, needed] of fungibleNeeded) {
    let have = inputs
      .filter((u) => u.token?.category === category)
      .reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);
    const candidates = request.utxos
      .filter((u) => u.token?.category === category && u.token.nft === null && !inputs.includes(u))
      .sort((a, b) =>
        b.token!.amount > a.token!.amount ? 1 : b.token!.amount < a.token!.amount ? -1 : 0,
      );
    for (const candidate of candidates) {
      if (have >= needed) break;
      inputs.push(candidate);
      have += candidate.token!.amount;
    }
    if (have < needed) throw new SendError("not enough tokens of that category");
  }

  // Everything the token inputs carry that is not sent comes back as change.
  const fungibleIn = new Map<string, bigint>();
  for (const input of inputs) {
    if (!input.token) continue;
    fungibleIn.set(
      input.token.category,
      (fungibleIn.get(input.token.category) ?? 0n) + input.token.amount,
    );
    const sentAway = request.recipients.some((r) => r.nft && outpoint(r.nft) === outpoint(input));
    if (input.token.nft && !sentAway) {
      const nftChange: TokenData = {
        category: input.token.category,
        amount: 0n,
        nft: input.token.nft,
      };
      outputs.push({
        destination: change,
        value: dustFor(change.lockingBytecode, nftChange),
        token: nftChange,
        change: true,
      });
    }
  }
  for (const [category, total] of fungibleIn) {
    const remainder = total - (fungibleNeeded.get(category) ?? 0n);
    if (remainder > 0n) {
      const tokenChange: TokenData = { category, amount: remainder, nft: null };
      outputs.push({
        destination: change,
        value: dustFor(change.lockingBytecode, tokenChange),
        token: tokenChange,
        change: true,
      });
    }
  }
  return { inputs, outputs };
}

/**
 * Sign the draft with `extra` BCH inputs. Returns the plan, or the number of
 * satoshis still missing.
 */
function finish(
  request: SendRequest,
  draft: Draft,
  change: Destination,
  feeRate: number,
  extra: Utxo[],
): SendPlan | number {
  const inputs = [...draft.inputs, ...extra];
  const outputs = [...draft.outputs];
  const totalIn = inputs.reduce((s, u) => s + u.value, 0);
  const totalOut = outputs.reduce((s, o) => s + o.value, 0);
  const sizeWith = (withChange: boolean) =>
    unsignedSize(
      inputs,
      withChange
        ? [...outputs, { destination: change, value: 0, token: null, change: true }]
        : outputs,
    );

  const feeWithout = Math.ceil(sizeWith(false) * feeRate);
  if (totalIn < totalOut + feeWithout) return totalOut + feeWithout - totalIn;

  const feeWith = Math.ceil(sizeWith(true) * feeRate);
  const changeValue = totalIn - totalOut - feeWith;
  if (changeValue >= dustFor(change.lockingBytecode, null)) {
    outputs.push({ destination: change, value: changeValue, token: null, change: true });
  }
  return sign(request, inputs, outputs);
}

function buildTransaction(
  inputs: Utxo[],
  outputs: Draft["outputs"],
  unlocking: (index: number) => Uint8Array,
): Transaction {
  return {
    version: 2,
    locktime: 0,
    inputs: inputs.map((u, index) => ({
      outpointTransactionHash: hexToBin(u.txid),
      outpointIndex: u.vout,
      sequenceNumber: 0xffffffff,
      unlockingBytecode: unlocking(index),
    })),
    outputs: outputs.map((o) => toOutput(o.destination.lockingBytecode, o.value, o.token)),
  };
}

function unsignedSize(inputs: Utxo[], outputs: Draft["outputs"]): number {
  return encodeTransaction(
    buildTransaction(inputs, outputs, () => new Uint8Array(P2PKH_UNLOCKING_LENGTH)),
  ).length;
}

function sign(request: SendRequest, inputs: Utxo[], outputs: Draft["outputs"]): SendPlan {
  const sourceOutputs = inputs.map((u) =>
    toOutput(request.lockingBytecodeFor(u), u.value, u.token),
  );
  const unsigned = buildTransaction(inputs, outputs, () => new Uint8Array());
  const unlocking = inputs.map((utxo, inputIndex) => {
    const { privateKey, publicKey } = request.keyFor(utxo);
    const preimage = generateSigningSerializationBCH(
      { inputIndex, sourceOutputs, transaction: unsigned },
      {
        coveredBytecode: sourceOutputs[inputIndex]!.lockingBytecode,
        signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID_UTXOS),
      },
    );
    const signature = libauthSecp256k1.signMessageHashSchnorr(privateKey, hash256(preimage));
    if (typeof signature === "string") throw new SendError(`could not sign: ${signature}`);
    return Uint8Array.of(
      ...push(Uint8Array.of(...signature, SIGHASH_ALL_FORKID_UTXOS)),
      ...push(publicKey),
    );
  });
  const transaction = buildTransaction(inputs, outputs, (i) => unlocking[i]!);
  const verdict = vm.verify({ sourceOutputs, transaction });
  if (verdict !== true)
    throw new SendError(`the transaction did not pass the script check: ${verdict}`);

  const encoded = encodeTransaction(transaction);
  const totalIn = inputs.reduce((s, u) => s + u.value, 0);
  const totalOut = outputs.reduce((s, o) => s + o.value, 0);
  const fee = totalIn - totalOut;
  const toOthers = outputs.filter((o) => !o.change).reduce((s, o) => s + o.value, 0);
  // A safety net against a bug or a bad fee rate: never more than 10,000 sats or 5% of the send.
  if (fee > Math.max(10_000, Math.ceil(toOthers * 0.05)))
    throw new SendError(`the fee (${fee} sats) is too high`);
  return {
    transactionHex: Array.from(encoded, (b) => b.toString(16).padStart(2, "0")).join(""),
    txid: hashTransaction(encoded),
    fee,
    size: encoded.length,
    inputs,
    outputs: outputs.map((o) => ({
      address: o.destination.address,
      value: o.value,
      token: o.token,
      change: o.change,
    })),
    outgoing: toOthers + fee,
  };
}
