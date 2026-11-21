/**
 * Runs in the extension's isolated world on each page's top frame. It carries
 * requests from `inpage.ts` to the service worker over one port per page and
 * carries the answers back. It never looks inside a request: the service
 * worker checks everything, and learns the page's origin from the browser.
 */
(() => {
  const CHANNEL = "cashlet:v1";
  const MAX_IN_FLIGHT = 20;
  const MAX_CHARS = 256 * 1024;
  let port: chrome.runtime.Port | null = null;
  const inFlight = new Set<number>();

  const reply = (id: number, answer: { ok: boolean; result?: unknown; error?: string }) => {
    inFlight.delete(id);
    window.postMessage({ channel: CHANNEL, direction: "response", id, ...answer }, "*");
  };

  const connect = (): chrome.runtime.Port => {
    if (port) return port;
    const opened = chrome.runtime.connect({ name: "cashlet-page" });
    opened.onMessage.addListener((message: { id?: unknown }) => {
      if (typeof message?.id !== "number" || !inFlight.has(message.id)) return;
      reply(message.id, message as { ok: boolean; result?: unknown; error?: string });
    });
    opened.onDisconnect.addListener(() => {
      port = null;
      for (const id of [...inFlight])
        reply(id, { ok: false, error: "the wallet restarted; try again" });
    });
    port = opened;
    return opened;
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      channel?: unknown;
      direction?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    } | null;
    if (event.source !== window || typeof data !== "object" || data === null) return;
    if (data.channel !== CHANNEL || data.direction !== "request") return;
    if (typeof data.id !== "number" || !Number.isSafeInteger(data.id) || inFlight.has(data.id))
      return;
    const id = data.id;
    inFlight.add(id);
    if (inFlight.size > MAX_IN_FLIGHT) {
      reply(id, { ok: false, error: "too many requests are waiting" });
      return;
    }
    let size: number;
    try {
      size = JSON.stringify({ method: data.method, params: data.params }).length;
    } catch {
      size = Infinity;
    }
    if (size > MAX_CHARS) {
      reply(id, { ok: false, error: "request too large" });
      return;
    }
    try {
      connect().postMessage({ id, method: data.method, params: data.params });
    } catch {
      reply(id, { ok: false, error: "the wallet is not available" });
    }
  });
})();
