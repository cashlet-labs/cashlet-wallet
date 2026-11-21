/**
 * Messages between extension pages and the service worker.
 *
 * Every message is a plain JSON object with a `type`. The service worker checks
 * each one with `parseRequest` before acting on it, and only accepts requests
 * from the extension's own pages (see `isExtensionSender`). Chrome passes
 * messages as JSON, so token amounts travel as decimal strings.
 */
import type { BchNetwork } from "@cashlet-labs/bnd";
import type { ApprovalView } from "../background/sites";

export interface RecipientMessage {
  address: string;
  value: number;
  token?: { category: string; amount: string };
  nft?: { txid: string; vout: number };
}

export type Request =
  | { type: "PING" }
  | { type: "VERIFY_BINDING"; event: unknown }
  | { type: "STATUS" }
  | { type: "CREATE_WALLET"; password: string; network: BchNetwork; name?: string }
  | {
      type: "IMPORT_WALLET";
      mnemonic: string;
      password: string;
      network: BchNetwork;
      name?: string;
    }
  | { type: "UNLOCK"; password: string; walletId?: string }
  | { type: "LOCK" }
  | { type: "GET_RECEIVE_ADDRESS"; tokenAware: boolean }
  | { type: "GET_BALANCE" }
  | { type: "GET_HISTORY" }
  | { type: "PREPARE_SEND"; recipients: RecipientMessage[] }
  | { type: "CONFIRM_SEND"; planId: string }
  | { type: "REVEAL_MNEMONIC"; password: string }
  | { type: "CHANGE_PASSWORD"; oldPassword: string; newPassword: string }
  | { type: "REMOVE_WALLET"; walletId: string; password: string }
  | { type: "RENAME_WALLET"; walletId: string; name: string }
  | { type: "SET_AUTO_LOCK"; minutes: number }
  | { type: "SERVER_HEALTH" }
  | { type: "CONFIRM_BACKUP"; walletId: string }
  | { type: "IDENTITY_STATUS" }
  | { type: "IDENTITY_BIND" }
  | { type: "IDENTITY_ROTATE"; key: "bch" | "nostr" }
  | { type: "IDENTITY_REVOKE"; password: string }
  | { type: "IDENTITY_PUBLIC_RELAYS"; enabled: boolean }
  | { type: "RESOLVE_PAYEE"; target: string }
  | { type: "APPROVALS_LIST" }
  | { type: "APPROVAL_DECIDE"; id: string; approve: boolean; remember: boolean }
  | { type: "SITES_LIST" }
  | { type: "SITE_REMOVE"; origin: string };

export type RequestType = Request["type"];

export interface TokenBalance {
  category: string;
  amount: string;
  nfts: { capability: string; commitment: string }[];
}

export interface PlannedOutputMessage {
  address: string;
  value: number;
  token: {
    category: string;
    amount: string;
    nft: { capability: string; commitment: string } | null;
  } | null;
  change: boolean;
}

export interface ResponseFor {
  PING: { ok: true; bindingKind: number };
  VERIFY_BINDING:
    | { ok: true; nostrPublicKey: string; address: string; proofType: string | null }
    | { ok: false; reason: string };
  STATUS: {
    ok: true;
    wallets: { id: string; name: string; network: BchNetwork; backedUp: boolean }[];
    activeId: string | null;
    unlocked: boolean;
    retryAfter: number;
    network: BchNetwork | null;
    scan: "idle" | "scanning" | "ready" | "error";
    scanError: string | null;
    autoLockMinutes: number;
    /** Site requests waiting for the user. */
    approvals: number;
  };
  CREATE_WALLET: { ok: true; id: string; mnemonic: string };
  IMPORT_WALLET: { ok: true; id: string };
  UNLOCK: { ok: true };
  LOCK: { ok: true };
  GET_RECEIVE_ADDRESS: { ok: true; address: string; index: number };
  GET_BALANCE: { ok: true; confirmed: number; unconfirmed: number; tokens: TokenBalance[] };
  GET_HISTORY: { ok: true; entries: { txid: string; height: number; time: number | null }[] };
  PREPARE_SEND: {
    ok: true;
    planId: string;
    fee: number;
    size: number;
    outgoing: number;
    outputs: PlannedOutputMessage[];
    expiresAt: number;
  };
  CONFIRM_SEND: { ok: true; txid: string };
  REVEAL_MNEMONIC: { ok: true; mnemonic: string };
  CHANGE_PASSWORD: { ok: true };
  REMOVE_WALLET: { ok: true };
  RENAME_WALLET: { ok: true };
  SET_AUTO_LOCK: { ok: true };
  CONFIRM_BACKUP: { ok: true };
  IDENTITY_STATUS: {
    ok: true;
    npub: string;
    nostrPublicKey: string;
    address: string;
    state: "none" | "current" | "revoked" | "disputed" | "unknown";
    did: string | null;
    relays: { complete: number; asked: number };
    publicRelays: boolean;
  };
  IDENTITY_BIND: { ok: true; did: string; accepted: string[] };
  IDENTITY_ROTATE: { ok: true; did: string; accepted: string[] };
  IDENTITY_REVOKE: { ok: true; accepted: string[] };
  IDENTITY_PUBLIC_RELAYS: { ok: true };
  RESOLVE_PAYEE: { ok: true; address: string; tokenAddress: string; did: string; npub: string };
  APPROVALS_LIST: { ok: true; approvals: ApprovalView[]; npub: string | null };
  APPROVAL_DECIDE: { ok: true };
  SITES_LIST: { ok: true; sites: { origin: string; kinds: number[]; connectedAt: number }[] };
  SITE_REMOVE: { ok: true };
  SERVER_HEALTH: {
    ok: true;
    current: string | null;
    servers: { url: string; state: string; tip: number | null; lastError: string | null }[];
  };
}

export type ErrorResponse = { ok: false; error: string; code?: string };

const MAX_EVENT_BYTES = 64 * 1024;
const HEX32 = /^[0-9a-f]{64}$/;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exactly these keys: `required` must be present, `optional` may be. */
function hasKeys(value: Fields, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function network(value: unknown): value is BchNetwork {
  return value === "mainnet" || value === "chipnet";
}

function recipient(value: unknown): RecipientMessage | null {
  if (!isRecord(value) || !hasKeys(value, ["address", "value"], ["token", "nft"])) return null;
  if (
    !text(value.address, 120) ||
    !Number.isSafeInteger(value.value) ||
    (value.value as number) < 0
  )
    return null;
  const result: RecipientMessage = { address: value.address, value: value.value as number };
  if (value.token !== undefined) {
    const t = value.token;
    if (
      !isRecord(t) ||
      !hasKeys(t, ["category", "amount"]) ||
      typeof t.category !== "string" ||
      !HEX32.test(t.category) ||
      typeof t.amount !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(t.amount)
    ) {
      return null;
    }
    result.token = { category: t.category, amount: t.amount };
  }
  if (value.nft !== undefined) {
    const n = value.nft;
    if (
      !isRecord(n) ||
      !hasKeys(n, ["txid", "vout"]) ||
      typeof n.txid !== "string" ||
      !HEX32.test(n.txid) ||
      !Number.isInteger(n.vout) ||
      (n.vout as number) < 0
    ) {
      return null;
    }
    result.nft = { txid: n.txid, vout: n.vout as number };
  }
  return result;
}

/** An npub, a 64-hex Nostr public key, or a did:bnd. Checked fully when it is resolved. */
export function isPayeeTarget(value: string): boolean {
  return (
    /^npub1[02-9ac-hj-np-z]{58}$/.test(value) ||
    HEX32.test(value) ||
    /^did:bnd:[0-9a-z:]{1,190}$/.test(value)
  );
}

/** Validate an untrusted message. Returns the request, or a reason it was refused. */
export function parseRequest(value: unknown): Request | { error: string } {
  if (!isRecord(value) || typeof value.type !== "string") return { error: "malformed message" };
  const v = value;
  const bad = { error: `malformed ${v.type}` };
  switch (v.type) {
    case "PING":
    case "STATUS":
    case "LOCK":
    case "GET_BALANCE":
    case "GET_HISTORY":
    case "SERVER_HEALTH":
    case "IDENTITY_STATUS":
    case "IDENTITY_BIND":
    case "APPROVALS_LIST":
    case "SITES_LIST":
      return hasKeys(v, ["type"]) ? ({ type: v.type } as Request) : bad;
    case "VERIFY_BINDING":
      if (!hasKeys(v, ["type", "event"])) return bad;
      // A binding event is at most 64 KB on relays (BND-1 section 9.3).
      if (JSON.stringify(v.event ?? null).length > MAX_EVENT_BYTES)
        return { error: "event too large" };
      return { type: "VERIFY_BINDING", event: v.event };
    case "CREATE_WALLET":
      if (!hasKeys(v, ["type", "password", "network"], ["name"])) return bad;
      if (
        !text(v.password, 1024) ||
        !network(v.network) ||
        (v.name !== undefined && !text(v.name, 40))
      )
        return bad;
      return {
        type: "CREATE_WALLET",
        password: v.password,
        network: v.network,
        ...(v.name !== undefined ? { name: v.name as string } : {}),
      };
    case "IMPORT_WALLET":
      if (!hasKeys(v, ["type", "mnemonic", "password", "network"], ["name"])) return bad;
      if (!text(v.mnemonic, 1024) || !text(v.password, 1024) || !network(v.network)) return bad;
      if (v.name !== undefined && !text(v.name, 40)) return bad;
      return {
        type: "IMPORT_WALLET",
        mnemonic: v.mnemonic,
        password: v.password,
        network: v.network,
        ...(v.name !== undefined ? { name: v.name as string } : {}),
      };
    case "UNLOCK":
      if (!hasKeys(v, ["type", "password"], ["walletId"]) || !text(v.password, 1024)) return bad;
      if (v.walletId !== undefined && !text(v.walletId, 64)) return bad;
      return {
        type: "UNLOCK",
        password: v.password,
        ...(v.walletId ? { walletId: v.walletId as string } : {}),
      };
    case "GET_RECEIVE_ADDRESS":
      return hasKeys(v, ["type", "tokenAware"]) && typeof v.tokenAware === "boolean"
        ? { type: "GET_RECEIVE_ADDRESS", tokenAware: v.tokenAware }
        : bad;
    case "PREPARE_SEND": {
      if (!hasKeys(v, ["type", "recipients"]) || !Array.isArray(v.recipients)) return bad;
      if (v.recipients.length === 0 || v.recipients.length > 50) return bad;
      const recipients = v.recipients.map(recipient);
      if (recipients.some((r) => r === null)) return bad;
      return { type: "PREPARE_SEND", recipients: recipients as RecipientMessage[] };
    }
    case "CONFIRM_SEND":
      return hasKeys(v, ["type", "planId"]) && text(v.planId, 64)
        ? { type: "CONFIRM_SEND", planId: v.planId }
        : bad;
    case "REVEAL_MNEMONIC":
      return hasKeys(v, ["type", "password"]) && text(v.password, 1024)
        ? { type: "REVEAL_MNEMONIC", password: v.password }
        : bad;
    case "CHANGE_PASSWORD":
      return hasKeys(v, ["type", "oldPassword", "newPassword"]) &&
        text(v.oldPassword, 1024) &&
        text(v.newPassword, 1024)
        ? { type: "CHANGE_PASSWORD", oldPassword: v.oldPassword, newPassword: v.newPassword }
        : bad;
    case "REMOVE_WALLET":
      return hasKeys(v, ["type", "walletId", "password"]) &&
        text(v.walletId, 64) &&
        text(v.password, 1024)
        ? { type: "REMOVE_WALLET", walletId: v.walletId, password: v.password }
        : bad;
    case "RENAME_WALLET":
      return hasKeys(v, ["type", "walletId", "name"]) && text(v.walletId, 64) && text(v.name, 40)
        ? { type: "RENAME_WALLET", walletId: v.walletId, name: v.name }
        : bad;
    case "CONFIRM_BACKUP":
      return hasKeys(v, ["type", "walletId"]) && text(v.walletId, 64)
        ? { type: "CONFIRM_BACKUP", walletId: v.walletId }
        : bad;
    case "SET_AUTO_LOCK":
      return hasKeys(v, ["type", "minutes"]) &&
        Number.isInteger(v.minutes) &&
        (v.minutes as number) >= 1 &&
        (v.minutes as number) <= 1440
        ? { type: "SET_AUTO_LOCK", minutes: v.minutes as number }
        : bad;
    case "IDENTITY_ROTATE":
      return hasKeys(v, ["type", "key"]) && (v.key === "bch" || v.key === "nostr")
        ? { type: "IDENTITY_ROTATE", key: v.key }
        : bad;
    case "IDENTITY_REVOKE":
      return hasKeys(v, ["type", "password"]) && text(v.password, 1024)
        ? { type: "IDENTITY_REVOKE", password: v.password }
        : bad;
    case "IDENTITY_PUBLIC_RELAYS":
      return hasKeys(v, ["type", "enabled"]) && typeof v.enabled === "boolean"
        ? { type: "IDENTITY_PUBLIC_RELAYS", enabled: v.enabled }
        : bad;
    case "RESOLVE_PAYEE":
      return hasKeys(v, ["type", "target"]) && text(v.target, 200) && isPayeeTarget(v.target)
        ? { type: "RESOLVE_PAYEE", target: v.target }
        : bad;
    case "APPROVAL_DECIDE":
      return hasKeys(v, ["type", "id", "approve", "remember"]) &&
        typeof v.id === "string" &&
        /^[0-9a-f]{32}$/.test(v.id) &&
        typeof v.approve === "boolean" &&
        typeof v.remember === "boolean"
        ? { type: "APPROVAL_DECIDE", id: v.id, approve: v.approve, remember: v.remember }
        : bad;
    case "SITE_REMOVE":
      return hasKeys(v, ["type", "origin"]) && text(v.origin, 300)
        ? { type: "SITE_REMOVE", origin: v.origin }
        : bad;
    default:
      return { error: `unknown message type: ${v.type}` };
  }
}

/**
 * True only for the extension's own pages (popup, side panel). Content scripts
 * and other extensions are refused: they run on behalf of web pages.
 */
export function isExtensionSender(
  sender: Pick<chrome.runtime.MessageSender, "id" | "url">,
  extensionId: string,
  extensionOrigin: string,
): boolean {
  return (
    sender.id === extensionId &&
    typeof sender.url === "string" &&
    sender.url.startsWith(extensionOrigin)
  );
}
