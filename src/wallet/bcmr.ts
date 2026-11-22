/**
 * Token metadata from BCMR registries (Bitcoin Cash Metadata Registries).
 *
 * A token's registry is announced on chain: an OP_RETURN output with the
 * magic "BCMR", the SHA-256 of the registry file and the places to fetch it
 * from. Registries and icons come from the open internet, so everything read
 * from them is checked here, and only plain text, numbers and https: or ipfs:
 * addresses leave this file.
 */

/**
 * The one host the wallet may fetch registries and icons from (listed in the
 * manifest's connect-src). ipfs: addresses are rewritten to it. A registry on
 * any other https site cannot be fetched under the extension's strict policy,
 * so the token is shown by its short id instead.
 */
export const BCMR_GATEWAY = "https://gateway.pinata.cloud";

export const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
export const MAX_ICON_BYTES = 256 * 1024;

const MAX_NAME = 64;
const MAX_SYMBOL = 16;
const MAX_URI = 300;
const MAX_URIS = 5;
const MAX_NFT_TYPES = 500;
const MAX_DECIMALS = 18;
const HEX32 = /^[0-9a-f]{64}$/;
const BCMR_MAGIC = [0x42, 0x43, 0x4d, 0x52];

export interface RegistryRef {
  /** SHA-256 of the registry file, in hex. */
  hash: string;
  uris: string[];
}

export interface TokenMeta {
  name: string;
  symbol: string | null;
  decimals: number;
  /** An https: or ipfs: address, not yet fetched. */
  icon: string | null;
  /** Names of NFT types, by commitment in hex. */
  nftTypes: { commitment: string; name: string }[];
}

/** The data pushes of an OP_RETURN script, or null if it is anything else. */
function opReturnPushes(script: Uint8Array): Uint8Array[] | null {
  if (script[0] !== 0x6a) return null;
  const pushes: Uint8Array[] = [];
  let i = 1;
  while (i < script.length) {
    const op = script[i++]!;
    let length: number;
    if (op >= 1 && op <= 75) length = op;
    else if (op === 0x4c && i < script.length) length = script[i++]!;
    else if (op === 0x4d && i + 1 < script.length) {
      length = script[i]! | (script[i + 1]! << 8);
      i += 2;
    } else return null;
    if (i + length > script.length) return null;
    pushes.push(script.subarray(i, i + length));
    i += length;
  }
  return pushes;
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The registry announced by an output script, if it is a BCMR output. */
export function parseBcmrOutput(script: Uint8Array): RegistryRef | null {
  const pushes = opReturnPushes(script);
  if (!pushes || pushes.length < 3) return null;
  const [magic, hash, ...rest] = pushes as [Uint8Array, Uint8Array, ...Uint8Array[]];
  if (magic.length !== 4 || !BCMR_MAGIC.every((b, i) => magic[i] === b)) return null;
  if (hash.length !== 32) return null;
  const uris: string[] = [];
  for (const push of rest.slice(0, MAX_URIS)) {
    try {
      const uri = new TextDecoder("utf-8", { fatal: true }).decode(push);
      if (uri.length > 0 && uri.length <= MAX_URI) uris.push(uri);
    } catch {
      // Not text: skip it.
    }
  }
  return uris.length > 0 ? { hash: toHex(hash), uris } : null;
}

/** Where to fetch an address from, or null if the wallet may not (see BCMR_GATEWAY). */
export function fetchUrl(uri: string): string | null {
  if (uri.length > MAX_URI) return null;
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length);
    return /^[A-Za-z0-9]{10,120}(\/[A-Za-z0-9][A-Za-z0-9._~-]{0,99}){0,3}$/.test(path)
      ? `${BCMR_GATEWAY}/ipfs/${path}`
      : null;
  }
  // A registry address may leave out "https://".
  const text = /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.origin === BCMR_GATEWAY && url.username === ""
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Text from an untrusted registry: no control or invisible characters, one line, shortened. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[\p{Cf}\p{Co}\p{Cn}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(cleaned);
  const result = characters.slice(0, max).join("").trim();
  return result === "" ? null : result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An icon address a popup may be given: https: or ipfs: only. */
function iconUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_URI) return null;
  return /^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(value) ? value : null;
}

/** The newest snapshot of an identity; registries list them by date, as an array or an object. */
function latestSnapshot(history: unknown): Record<string, unknown> | null {
  const entries: [string, unknown][] = Array.isArray(history)
    ? history.map((snapshot): [string, unknown] => [
        isRecord(snapshot) && typeof snapshot.begin === "string" ? snapshot.begin : "",
        snapshot,
      ])
    : isRecord(history)
      ? Object.entries(history)
      : [];
  let best: [string, unknown] | null = null;
  for (const entry of entries) if (best === null || entry[0] >= best[0]) best = entry;
  return best && isRecord(best[1]) ? best[1] : null;
}

/** The metadata a registry gives for a token category, or null if it gives none usable. */
export function parseRegistry(json: unknown, category: string): TokenMeta | null {
  if (!HEX32.test(category) || !isRecord(json) || !isRecord(json.identities)) return null;
  if (!Object.hasOwn(json.identities, category)) return null;
  const identity = latestSnapshot(json.identities[category]);
  if (!identity) return null;
  const token = isRecord(identity.token) ? identity.token : {};
  // An identity for another category (a shared authbase) is not this token's.
  if (typeof token.category === "string" && token.category !== category) return null;
  const symbol = cleanText(token.symbol, MAX_SYMBOL);
  const name = cleanText(identity.name, MAX_NAME) ?? symbol;
  if (name === null) return null;
  const decimals =
    Number.isInteger(token.decimals) &&
    (token.decimals as number) >= 0 &&
    (token.decimals as number) <= MAX_DECIMALS
      ? (token.decimals as number)
      : 0;
  const nftTypes: TokenMeta["nftTypes"] = [];
  const nfts = isRecord(token.nfts) ? token.nfts : null;
  const parse = nfts && isRecord(nfts.parse) ? nfts.parse : null;
  const types = parse && isRecord(parse.types) ? parse.types : null;
  if (types) {
    for (const [commitment, type] of Object.entries(types)) {
      if (nftTypes.length >= MAX_NFT_TYPES) break;
      if (!/^([0-9a-f]{2}){0,40}$/.test(commitment) || !isRecord(type)) continue;
      const typeName = cleanText(type.name, MAX_NAME);
      if (typeName !== null) nftTypes.push({ commitment, name: typeName });
    }
  }
  return {
    name,
    symbol,
    decimals,
    icon: isRecord(identity.uris) ? iconUri(identity.uris.icon) : null,
    nftTypes,
  };
}
