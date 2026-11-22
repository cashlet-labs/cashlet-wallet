import type { WebSocketLike } from "../electrum/client";
import { ElectrumPool } from "../electrum/pool";
import { NETWORKS } from "../electrum/servers";
import { orderServers } from "../wallet/net-settings";
import { isExtensionSender, parseRequest, type ErrorResponse } from "../shared/messages";
import { pageOrigin, parsePageRequest } from "../shared/page-messages";
import { WalletSession, type KeyValueStore } from "../wallet/session";
import { IndexedDbStore } from "../wallet/store";
import { WalletService } from "./wallet-service";

const AUTO_LOCK_ALARM = "auto-lock";
const FRESHNESS_ALARM = "electrum-freshness";

const local: KeyValueStore = {
  get: async <T>(key: string) => (await chrome.storage.local.get(key))[key] as T | undefined,
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: (key) => chrome.storage.local.remove(key),
};

const pools = new Set<ElectrumPool>();
const stores = new Map<string, Promise<IndexedDbStore>>();

const service = new WalletService({
  session: new WalletSession(local),
  settings: local,
  connect: (network, preferredServer) => {
    const config = NETWORKS[network];
    const pool = new ElectrumPool({
      servers: orderServers(config.servers, preferredServer ?? null),
      checkpoint: config.checkpoint,
      // The browser's WebSocket has the members WebSocketLike uses; only its handler types differ.
      createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    });
    pools.add(pool);
    const close = pool.close.bind(pool);
    pool.close = () => {
      pools.delete(pool);
      close();
    };
    return pool;
  },
  openStore: (walletId) => {
    const existing = stores.get(walletId);
    if (existing) return existing;
    const opened = IndexedDbStore.open(walletId);
    stores.set(walletId, opened);
    return opened;
  },
  onActivity: (minutes) => {
    void chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
  },
  onApprovals: (waiting) => void showApprovals(waiting),
});

const extensionOrigin = chrome.runtime.getURL("");

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!isExtensionSender(sender, chrome.runtime.id, extensionOrigin)) {
    sendResponse({ ok: false, error: "not allowed" } satisfies ErrorResponse);
    return false;
  }
  const request = parseRequest(message);
  if ("error" in request) {
    sendResponse({ ok: false, error: request.error } satisfies ErrorResponse);
    return false;
  }
  service
    .handle(request)
    .then(sendResponse, () => sendResponse({ ok: false, error: "internal error" }));
  // Keep the channel open for the asynchronous response.
  return true;
});

// Web pages reach the wallet only through the content script's port. The
// origin comes from the browser (port.sender), never from the page.
chrome.runtime.onConnect.addListener((port) => {
  const sender = port.sender;
  const origin = pageOrigin(sender?.url);
  if (
    port.name !== "cashlet-page" ||
    sender?.id !== chrome.runtime.id ||
    sender.tab === undefined ||
    sender.frameId !== 0 ||
    origin === null ||
    (sender.origin !== undefined && sender.origin !== origin)
  ) {
    port.disconnect();
    return;
  }
  // Requests die with the page: closing or navigating it rejects what is waiting.
  const closed = new AbortController();
  port.onDisconnect.addListener(() => closed.abort());
  port.onMessage.addListener((message: { id?: unknown; method?: unknown; params?: unknown }) => {
    if (typeof message?.id !== "number") return;
    const id = message.id;
    const answer = (value: { ok: true; result: unknown } | { ok: false; error: string }) => {
      if (!closed.signal.aborted) port.postMessage({ id, ...value });
    };
    const request = parsePageRequest({ method: message.method, params: message.params }, origin);
    if ("error" in request) {
      answer({ ok: false, error: request.error });
      return;
    }
    service.page(origin, request, closed.signal).then(
      (result) => answer({ ok: true, result }),
      (error: unknown) =>
        answer({ ok: false, error: error instanceof Error ? error.message : "request failed" }),
    );
  });
});

let approvalWindow: number | null = null;
let shown = 0;

chrome.windows.onRemoved.addListener((id) => {
  if (id === approvalWindow) approvalWindow = null;
});

/** Show waiting site requests: a badge count, and a small window to answer them. */
async function showApprovals(waiting: number): Promise<void> {
  const added = waiting > shown;
  shown = waiting;
  await chrome.action.setBadgeText({ text: waiting > 0 ? String(waiting) : "" });
  // Only a new request brings the window forward; answering one does not.
  if (!added) return;
  if (approvalWindow !== null) {
    try {
      await chrome.windows.update(approvalWindow, { focused: true });
      return;
    } catch {
      approvalWindow = null;
    }
  }
  const opened = await chrome.windows.create({
    url: chrome.runtime.getURL("src/popup/index.html#approve"),
    type: "popup",
    width: 380,
    height: 640,
    focused: true,
  });
  approvalWindow = opened?.id ?? null;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) service.lock();
  if (alarm.name === FRESHNESS_ALARM) for (const pool of pools) void pool.checkFreshness();
});

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar button opens the popup; the side panel opens from the browser's side panel menu.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  void chrome.alarms.create(FRESHNESS_ALARM, { periodInMinutes: 5 });
});
