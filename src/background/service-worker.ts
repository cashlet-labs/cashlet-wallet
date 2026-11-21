import type { WebSocketLike } from "../electrum/client";
import { ElectrumPool } from "../electrum/pool";
import { NETWORKS } from "../electrum/servers";
import { isExtensionSender, parseRequest, type ErrorResponse } from "../shared/messages";
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
  connect: (network) => {
    const config = NETWORKS[network];
    const pool = new ElectrumPool({
      servers: config.servers,
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) service.lock();
  if (alarm.name === FRESHNESS_ALARM) for (const pool of pools) void pool.checkFreshness();
});

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar button opens the popup; the side panel opens from the browser's side panel menu.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  void chrome.alarms.create(FRESHNESS_ALARM, { periodInMinutes: 5 });
});
