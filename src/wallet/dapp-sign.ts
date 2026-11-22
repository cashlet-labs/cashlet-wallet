import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash256,
  hashTransaction,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1 as libauthSecp256k1,
  type Input,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import type { BchNetwork } from "@cashlet-labs/bnd";
import type { DappChain, HdWallet } from "./hd";
import { p2pkhLockingBytecode } from "./indexer";

/**
 * Signing a transaction a dApp built (WizardConnect `sign_transaction_request`).
 *
 * The dApp is untrusted. Before anything is shown or signed:
 * - every input must have its source output, in order, with the same outpoint,
 *   so the fee and the amounts the user sees are the ones the signature covers;
 * - every input the wallet signs must be a P2PKH output of the key the dApp
 *   names, so the wallet never signs for a script it did not check;
 * - contract inputs are refused for now: checking them needs the contract.
 *
 * Inputs are signed SIGHASH_ALL | FORKID | UTXOS (0x61), which commits to every
 * input's value and tokens as well as every output.
 */

const SIGHASH_ALL_FORKID_UTXOS = 0x61;
const MAX_INPUTS = 500;
const MAX_OUTPUTS = 500;
const vm = createVirtualMachineBCH(true);

export class DappSignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DappSignError";
  }
}

/** HD paths a dApp may name, as WizardConnect's hdwalletv1 numbers them. */
const PATHS: Record<string, number> = { receive: 0, change: 1, defi: 7 };

export interface DappSignRequest {
  transaction: Transaction;
  sourceOutputs: Output[];
  /** Input index → key the wallet signs it with. */
  keys: Map<number, { chain: number; index: number }>;
  broadcast: boolean;
  userPrompt: string | null;
}

/** What the approval screen shows. Amounts are decimal strings: dApps may send values above 2^53. */
export interface DappTxSummary {
  inputs: number;
  /** Inputs this wallet signs, and what they hold. */
  signing: { count: number; value: string };
  outputs: {
    address: string | null;
    /** Hex of a script that is not an address, for example OP_RETURN data. */
    script: string | null;
    value: string;
    token: { category: string; amount: string; nft: string | null } | null;
    /** True when the output pays one of the keys this request signs with. */
    own: boolean;
  }[];
  fee: string;
  /** "ok", or "high" when the fee is unusual for its size (shown as a warning). */
  feeLevel: "ok" | "high";
  /** Token categories spent by the inputs but not paid to any output: they are destroyed. */
  burns: string[];
  broadcast: boolean;
  userPrompt: string | null;
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bytes from a hex string, an extended-JSON `<Uint8Array: 0x…>` string, or a byte array. */
function bytes(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") {
    const hex =
      value.startsWith("<Uint8Array: 0x") && value.endsWith(">") ? value.slice(15, -1) : value;
    if (/^([0-9a-f]{2})*$/i.test(hex)) return hexToBin(hex.toLowerCase());
  }
  if (isRecord(value) && Object.keys(value).every((k) => /^\d+$/.test(k))) {
    const values = Object.values(value);
    if (values.every((b) => Number.isInteger(b) && (b as number) >= 0 && (b as number) <= 255))
      return Uint8Array.from(values as number[]);
  }
  throw new DappSignError(`${what} is not valid bytes`);
}

/** A non-negative integer from a number, a numeric string or an extended-JSON `<bigint: 5n>`. */
function integer(value: unknown, what: string, max: bigint = 2n ** 63n - 1n): bigint {
  let text: string | null = null;
  if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
  else if (typeof value === "string")
    text = value.startsWith("<bigint: ") && value.endsWith("n>") ? value.slice(9, -2) : value;
  if (text === null || !/^\d{1,20}$/.test(text))
    throw new DappSignError(`${what} is not a whole number`);
  const result = BigInt(text);
  if (result > max) throw new DappSignError(`${what} is too large`);
  return result;
}

function smallInteger(value: unknown, what: string, max = 0xffffffff): number {
  return Number(integer(value, what, BigInt(max)));
}

function token(value: unknown, what: string): Output["token"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new DappSignError(`${what} token is malformed`);
  const category = bytes(value.category, `${what} token category`);
  if (category.length !== 32) throw new DappSignError(`${what} token category must be 32 bytes`);
  const result: NonNullable<Output["token"]> = {
    category,
    amount: integer(value.amount ?? 0, `${what} token amount`),
  };
  if (value.nft !== undefined && value.nft !== null) {
    const nft = value.nft;
    if (!isRecord(nft) || !["none", "mutable", "minting"].includes(nft.capability as string))
      throw new DappSignError(`${what} NFT is malformed`);
    const commitment = bytes(nft.commitment ?? "", `${what} NFT commitment`);
    if (commitment.length > 128) throw new DappSignError(`${what} NFT commitment is too long`);
    result.nft = { capability: nft.capability as "none" | "mutable" | "minting", commitment };
  }
  return result;
}

function output(value: unknown, what: string): Output {
  if (!isRecord(value)) throw new DappSignError(`${what} is malformed`);
  const result: Output = {
    lockingBytecode: bytes(value.lockingBytecode, `${what} locking script`),
    valueSatoshis: integer(value.valueSatoshis, `${what} value`, 2_100_000_000_000_000n),
  };
  const t = token(value.token, what);
  if (t) result.token = t;
  return result;
}

function input(value: unknown, what: string): Input {
  if (!isRecord(value)) throw new DappSignError(`${what} is malformed`);
  const hash = bytes(value.outpointTransactionHash, `${what} outpoint`);
  if (hash.length !== 32) throw new DappSignError(`${what} outpoint must be 32 bytes`);
  return {
    outpointTransactionHash: hash,
    outpointIndex: smallInteger(value.outpointIndex, `${what} outpoint index`),
    sequenceNumber: smallInteger(value.sequenceNumber ?? 0xffffffff, `${what} sequence`),
    unlockingBytecode: bytes(value.unlockingBytecode ?? "", `${what} unlocking script`),
  };
}

function transactionOf(value: unknown): Transaction {
  if (typeof value === "string") {
    const decoded = decodeTransaction(bytes(value, "the transaction"));
    if (typeof decoded === "string")
      throw new DappSignError(`the transaction is invalid: ${decoded}`);
    return decoded;
  }
  if (!isRecord(value) || !Array.isArray(value.inputs) || !Array.isArray(value.outputs))
    throw new DappSignError("the transaction is malformed");
  if (value.inputs.length === 0 || value.inputs.length > MAX_INPUTS)
    throw new DappSignError("the transaction has too many or no inputs");
  if (value.outputs.length === 0 || value.outputs.length > MAX_OUTPUTS)
    throw new DappSignError("the transaction has too many or no outputs");
  return {
    version: smallInteger(value.version ?? 2, "the transaction version"),
    locktime: smallInteger(value.locktime ?? 0, "the transaction locktime"),
    inputs: value.inputs.map((i, n) => input(i, `input ${n}`)),
    outputs: value.outputs.map((o, n) => output(o, `output ${n}`)),
  };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Check an untrusted request: `transaction` is WizardConnect's WcSignTransactionRequest,
 * `inputPaths` its `[inputIndex, pathName, addressIndex]` list.
 */
export function parseDappRequest(
  wallet: HdWallet,
  request: unknown,
  inputPaths: unknown,
): DappSignRequest {
  if (!isRecord(request)) throw new DappSignError("the request is malformed");
  const transaction = transactionOf(request.transaction);
  if (!Array.isArray(request.sourceOutputs))
    throw new DappSignError("the request has no source outputs");
  if (request.sourceOutputs.length !== transaction.inputs.length)
    throw new DappSignError("every input needs its source output, so the amounts can be checked");

  const sourceOutputs = request.sourceOutputs.map((value, n): Output => {
    if (!isRecord(value)) throw new DappSignError(`source output ${n} is malformed`);
    if (value.contract !== undefined && value.contract !== null)
      throw new DappSignError("contract inputs are not supported yet");
    const spent = transaction.inputs[n]!;
    // The source output must describe the outpoint the input actually spends.
    if (value.outpointTransactionHash !== undefined || value.outpointIndex !== undefined) {
      const claimed = input(value, `source output ${n}`);
      if (
        !equal(claimed.outpointTransactionHash, spent.outpointTransactionHash) ||
        claimed.outpointIndex !== spent.outpointIndex
      )
        throw new DappSignError(`source output ${n} does not match the outpoint input ${n} spends`);
    } else {
      throw new DappSignError(`source output ${n} does not name its outpoint`);
    }
    return output(value, `source output ${n}`);
  });

  if (!Array.isArray(inputPaths) || inputPaths.length === 0)
    throw new DappSignError("the request names no inputs for this wallet to sign");
  const keys = new Map<number, { chain: number; index: number }>();
  for (const entry of inputPaths) {
    if (!Array.isArray(entry) || entry.length !== 3)
      throw new DappSignError("an input path is malformed");
    const [inputIndex, pathName, addressIndex] = entry as unknown[];
    const chain = typeof pathName === "string" ? PATHS[pathName] : undefined;
    if (chain === undefined) throw new DappSignError(`unknown key path: ${String(pathName)}`);
    if (
      !Number.isInteger(inputIndex) ||
      (inputIndex as number) < 0 ||
      (inputIndex as number) >= transaction.inputs.length
    )
      throw new DappSignError("an input path names an input that does not exist");
    const index = smallInteger(addressIndex, "an address index", 0x7fffffff);
    if (keys.has(inputIndex as number)) throw new DappSignError("an input is named twice");
    // The wallet signs only its own P2PKH output for that key.
    const expected = p2pkhLockingBytecode(wallet.addressKey(chain as DappChain, index).keyHash);
    if (!equal(sourceOutputs[inputIndex as number]!.lockingBytecode, expected))
      throw new DappSignError(
        `input ${String(inputIndex)} is not this wallet's address for that key`,
      );
    keys.set(inputIndex as number, { chain, index });
  }

  const prompt = typeof request.userPrompt === "string" ? request.userPrompt.slice(0, 200) : null;
  return {
    transaction,
    sourceOutputs,
    keys,
    broadcast: request.broadcast !== false,
    userPrompt: prompt && prompt.trim() !== "" ? prompt : null,
  };
}

const NFT_NAMES = { none: "NFT", mutable: "mutable NFT", minting: "minting NFT" } as const;

export function summarize(
  request: DappSignRequest,
  wallet: HdWallet,
  network: BchNetwork,
): DappTxSummary {
  const ownScripts = [...request.keys.values()].map(({ chain, index }) =>
    p2pkhLockingBytecode(wallet.addressKey(chain as DappChain, index).keyHash),
  );
  const totalIn = request.sourceOutputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  const totalOut = request.transaction.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
  if (totalOut > totalIn) throw new DappSignError("the outputs are worth more than the inputs");
  // A dApp could send most of the inputs to miners. Refuse fees that are plainly
  // wrong; warn about ones that are merely high.
  const fee = totalIn - totalOut;
  const size = BigInt(
    encodeTransaction(request.transaction).length + 107 * request.transaction.inputs.length,
  );
  if (fee > 1_000_000n && fee * 2n > totalIn)
    throw new DappSignError("the network fee would be more than half of what is spent");
  const feeLevel: "ok" | "high" = fee > size * 10n || fee * 100n > totalIn ? "high" : "ok";
  const signingValue = [...request.keys.keys()].reduce(
    (s, i) => s + request.sourceOutputs[i]!.valueSatoshis,
    0n,
  );
  const prefix = network === "mainnet" ? "bitcoincash" : "bchtest";
  const outCategories = new Set(
    request.transaction.outputs.flatMap((o) => (o.token ? [binToHex(o.token.category)] : [])),
  );
  const burns = [
    ...new Set(request.sourceOutputs.flatMap((o) => (o.token ? [binToHex(o.token.category)] : []))),
  ].filter((c) => !outCategories.has(c));
  return {
    inputs: request.transaction.inputs.length,
    signing: { count: request.keys.size, value: signingValue.toString() },
    outputs: request.transaction.outputs.map((o) => {
      const address = lockingBytecodeToCashAddress({
        bytecode: o.lockingBytecode,
        prefix,
        tokenSupport: o.token !== undefined,
      });
      return {
        address: typeof address === "string" ? null : address.address,
        script: typeof address === "string" ? binToHex(o.lockingBytecode) : null,
        value: o.valueSatoshis.toString(),
        token: o.token
          ? {
              category: binToHex(o.token.category),
              amount: o.token.amount.toString(),
              nft: o.token.nft ? NFT_NAMES[o.token.nft.capability] : null,
            }
          : null,
        own: ownScripts.some((s) => equal(s, o.lockingBytecode)),
      };
    }),
    fee: fee.toString(),
    feeLevel,
    burns,
    broadcast: request.broadcast,
    userPrompt: request.userPrompt,
  };
}

function push(data: Uint8Array): Uint8Array {
  return Uint8Array.of(data.length, ...data);
}

/** Sign this wallet's inputs. Returns the transaction hex and its ID. */
export function signDappRequest(
  request: DappSignRequest,
  wallet: HdWallet,
): { hex: string; txid: string; complete: boolean } {
  const { transaction, sourceOutputs } = request;
  const unlocking = transaction.inputs.map((spent, inputIndex) => {
    const key = request.keys.get(inputIndex);
    if (!key) return spent.unlockingBytecode;
    const chain = key.chain as DappChain;
    const preimage = generateSigningSerializationBCH(
      { inputIndex, sourceOutputs, transaction },
      {
        coveredBytecode: sourceOutputs[inputIndex]!.lockingBytecode,
        signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID_UTXOS),
      },
    );
    const signature = libauthSecp256k1.signMessageHashSchnorr(
      wallet.privateKey(chain, key.index),
      hash256(preimage),
    );
    if (typeof signature === "string") throw new DappSignError(`could not sign: ${signature}`);
    return Uint8Array.of(
      ...push(Uint8Array.of(...signature, SIGHASH_ALL_FORKID_UTXOS)),
      ...push(wallet.addressKey(chain, key.index).publicKey),
    );
  });
  const signed: Transaction = {
    ...transaction,
    inputs: transaction.inputs.map((i, n) => ({ ...i, unlockingBytecode: unlocking[n]! })),
  };
  // When every input is unlocked, the whole transaction must pass the script engine.
  const complete = signed.inputs.every((i) => i.unlockingBytecode.length > 0);
  if (complete) {
    const verdict = vm.verify({ sourceOutputs, transaction: signed });
    if (verdict !== true)
      throw new DappSignError(`the signed transaction did not pass the script check: ${verdict}`);
  }
  const encoded = encodeTransaction(signed);
  return { hex: binToHex(encoded), txid: hashTransaction(encoded), complete };
}
