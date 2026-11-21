/**
 * Messages between extension pages and the service worker.
 *
 * Every message is a plain object with a `type`. The service worker checks each
 * one with `parseRequest` before acting on it, and only accepts requests from
 * the extension's own pages (see `isExtensionSender`).
 */

/** Ask whether the service worker is running, and which protocol it speaks. */
export interface PingRequest {
  type: "PING";
}

/** Verify one BND binding event offline (BND-1 section 7). */
export interface VerifyBindingRequest {
  type: "VERIFY_BINDING";
  event: unknown;
}

export type Request = PingRequest | VerifyBindingRequest;

export interface PingResponse {
  ok: true;
  bindingKind: number;
}

export type VerifyBindingResponse =
  | { ok: true; nostrPublicKey: string; address: string; proofType: string | null }
  | { ok: false; reason: string };

export interface ResponseFor {
  PING: PingResponse;
  VERIFY_BINDING: VerifyBindingResponse;
}

export type ErrorResponse = { ok: false; error: string };

const MAX_EVENT_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate an untrusted message. Returns the request, or a reason it was refused. */
export function parseRequest(value: unknown): Request | { error: string } {
  if (!isRecord(value) || typeof value.type !== "string") return { error: "malformed message" };
  switch (value.type) {
    case "PING":
      return Object.keys(value).length === 1 ? { type: "PING" } : { error: "malformed PING" };
    case "VERIFY_BINDING": {
      if (Object.keys(value).sort().join(",") !== "event,type") {
        return { error: "malformed VERIFY_BINDING" };
      }
      // A binding event is at most 64 KB on relays (BND-1 section 9.3).
      if (JSON.stringify(value.event ?? null).length > MAX_EVENT_BYTES) {
        return { error: "event too large" };
      }
      return { type: "VERIFY_BINDING", event: value.event };
    }
    default:
      return { error: `unknown message type: ${value.type}` };
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
