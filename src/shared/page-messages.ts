/**
 * Requests web pages make through `window.nostr` (NIP-07) and `window.bnd`.
 *
 * Pages are untrusted. Each request is checked here before anything else sees
 * it; the origin is never part of the request, the service worker takes it
 * from the browser.
 */
import {
  APPROVAL_D_TAG,
  AUTH_EVENT_KIND,
  BINDING_D_TAG,
  BINDING_EVENT_KIND,
  parseChallenge,
  type AuthChallenge,
  type UnsignedEvent,
} from "@cashlet-labs/bnd";

import { isCipherMethod, parseCipherRequest, type CipherRequest } from "./page-cipher";

export type PageRequest =
  | CipherRequest
  | { method: "nostr.getPublicKey" }
  | { method: "nostr.getRelays" }
  | { method: "nostr.signEvent"; event: UnsignedEvent }
  | { method: "bnd.login"; challenge: AuthChallenge };

export const MAX_CONTENT_CHARS = 64 * 1024;
const MAX_TAGS = 2_000;
const MAX_TAG_ITEMS = 100;
const MAX_TAG_CHARS = 4_096;

/**
 * Event kinds whose signature changes who the user is or follows: a site may
 * ask for them, but the answer is never remembered.
 */
const ALWAYS_ASK = new Set([0, 3, 5, 10002, AUTH_EVENT_KIND, BINDING_EVENT_KIND]);

export function rememberable(kind: number): boolean {
  return !ALWAYS_ASK.has(kind);
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * NIP-01 event IDs hash a serialization that writes these characters as-is,
 * while JSON.stringify escapes them, so the two would disagree on the ID.
 */
function serializable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // NIP-01 escapes only \b \t \n \f \r among control characters.
    if (code < 0x20 && ![0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code)) return false;
    // A lone surrogate is not valid UTF-8.
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function eventTemplate(value: unknown, origin: string): UnsignedEvent | string {
  if (!isRecord(value)) return "the event must be an object";
  // NIP-07 pages often pass a full or partial event; the wallet fills in pubkey, id and sig.
  const allowed = ["kind", "content", "tags", "created_at", "pubkey", "id", "sig"];
  if (Object.keys(value).some((k) => !allowed.includes(k))) return "the event has unknown fields";
  const { kind, content, tags, created_at: createdAt } = value;
  if (!Number.isInteger(kind) || (kind as number) < 0 || (kind as number) > 65_535)
    return "the event kind must be a whole number from 0 to 65535";
  if (typeof content !== "string" || content.length > MAX_CONTENT_CHARS)
    return "the event content must be text of at most 64 KB";
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_TAGS ||
    !tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length > 0 &&
        tag.length <= MAX_TAG_ITEMS &&
        tag.every((item) => typeof item === "string" && item.length <= MAX_TAG_CHARS),
    )
  )
    return "the event tags must be lists of text";
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0)
    return "the event time must be a whole number of seconds";
  const strings = [content, ...(tags as string[][]).flat()];
  if (!strings.every(serializable)) return "the event contains characters Nostr cannot sign";

  const template: UnsignedEvent = {
    kind: kind as number,
    content,
    tags: (tags as string[][]).map((tag) => [...tag]),
    created_at: createdAt as number,
  };
  // Bindings and their approvals are made by the wallet's Identity screen, never by a site.
  const d = template.tags.find((tag) => tag[0] === "d")?.[1];
  if (template.kind === BINDING_EVENT_KIND && (d === BINDING_D_TAG || d === APPROVAL_D_TAG))
    return "sites cannot sign BND bindings; use the wallet's Identity screen";
  // A NIP-98 login event for another site would let this one log in there as the user.
  if (template.kind === AUTH_EVENT_KIND) {
    const url = template.tags.find((tag) => tag[0] === "u")?.[1];
    let target: string | null;
    try {
      target = url === undefined ? null : new URL(url).origin;
    } catch {
      target = null;
    }
    if (target !== origin) return "a login event can only be signed for the site asking for it";
  }
  return template;
}

/** Validate a page's request. `origin` is the page's origin, as the browser reports it. */
export function parsePageRequest(value: unknown, origin: string): PageRequest | { error: string } {
  if (!isRecord(value) || typeof value.method !== "string") return { error: "malformed request" };
  const params = value.params === undefined ? {} : value.params;
  if (!isRecord(params)) return { error: "malformed request" };
  const keys = Object.keys(params);
  switch (value.method) {
    case "nostr.getPublicKey":
    case "nostr.getRelays":
      return keys.length === 0 ? { method: value.method } : { error: "malformed request" };
    case "nostr.signEvent": {
      if (keys.join() !== "event") return { error: "malformed request" };
      const event = eventTemplate(params.event, origin);
      return typeof event === "string" ? { error: event } : { method: "nostr.signEvent", event };
    }
    case "bnd.login": {
      if (keys.join() !== "challenge") return { error: "malformed request" };
      try {
        const challenge = parseChallenge(params.challenge);
        if (new URL(challenge.audience).origin !== origin)
          return { error: "this login challenge is for a different site" };
        return { method: "bnd.login", challenge };
      } catch (error) {
        return { error: error instanceof Error ? error.message : "malformed challenge" };
      }
    }
    default:
      if (isCipherMethod(value.method)) return parseCipherRequest(value.method, params);
      return { error: `unsupported method: ${value.method}` };
  }
}

/**
 * The origin of a page that may use the wallet: https, or http on this
 * computer for development. Anything else (file:, data:, other extensions,
 * plain http sites) is refused.
 */
export function pageOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return parsed.origin;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    )
      return parsed.origin;
    return null;
  } catch {
    return null;
  }
}
