/**
 * Runs in the extension's isolated world on each page's top frame. It looks for
 * WizardConnect links (wiz://…) the page shows, so the user need not paste
 * them, and passes each one to the service worker, which asks the user.
 *
 * The page is untrusted and this script only forwards what it finds: the
 * service worker checks the link, limits how often a site may ask, and learns
 * the origin from the browser. It never sends anything back to the page, so a
 * page cannot tell whether a wallet is installed or what it did with a link.
 */
(() => {
  const LINK = /wiz:\/\/[^\s"'<>\\]+/gi;
  const MAX_URI_CHARS = 2_048;
  const MAX_TEXT_CHARS = 8_192;
  const MAX_DISTINCT = 10;
  const DEBOUNCE_MS = 250;
  const CHANNEL = "cashlet:wiz:v1";

  let port: chrome.runtime.Port | null = null;
  let next = 1;
  const sent = new Set<string>();

  const send = (uri: string) => {
    if (uri.length > MAX_URI_CHARS || sent.has(uri) || sent.size >= MAX_DISTINCT) return;
    sent.add(uri);
    try {
      if (!port) {
        port = chrome.runtime.connect({ name: "cashlet-page" });
        port.onDisconnect.addListener(() => {
          port = null;
        });
      }
      port.postMessage({ id: next++, method: "wizard.detect", params: { uri } });
    } catch {
      // The extension was reloaded or is not available; the page is not told.
      port = null;
    }
  };

  const isLink = (value: string) => /^wiz:\/\//i.test(value.trim());

  const fromText = (text: string | null | undefined) => {
    if (!text) return;
    for (const match of text.slice(0, MAX_TEXT_CHARS).matchAll(LINK)) send(match[0]);
  };

  /** Links in one element's own attributes and value; `deep` also reads its text. */
  const fromElement = (element: Element, deep: boolean) => {
    for (const attribute of element.attributes) fromText(attribute.value);
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      fromText(element.value);
    else if (deep) fromText(element.textContent);
  };

  const scan = (root: ParentNode) => {
    for (const element of root.querySelectorAll('a[href^="wiz:" i], area[href^="wiz:" i]'))
      fromElement(element, false);
    for (const element of root.querySelectorAll("input, textarea, code, pre"))
      fromElement(element, true);
    // Web components: attributes, text, and open shadow roots, nested ones too.
    for (const element of root.querySelectorAll("*")) {
      if (element.localName.includes("-")) fromElement(element, true);
      if (element.shadowRoot) scan(element.shadowRoot);
    }
  };

  // One scan per quiet moment; a page that never stops changing is still scanned.
  let scheduled = false;
  const scanSoon = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scan(document);
    }, DEBOUNCE_MS);
  };

  // Stop the browser from leaving for a wiz:// address, and hand the link to the wallet.
  document.addEventListener(
    "click",
    (event) => {
      for (const target of event.composedPath()) {
        if (!(target instanceof Element)) continue;
        const href = target.closest("a[href], area[href]")?.getAttribute("href");
        if (href && isLink(href)) {
          event.preventDefault();
          send(href.trim());
          return;
        }
      }
    },
    true,
  );

  // Links a web component keeps in a JavaScript property come from wizard-main.ts.
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as { channel?: unknown; uri?: unknown } | null;
    if (event.source !== window || typeof data !== "object" || data === null) return;
    if (data.channel === CHANNEL && typeof data.uri === "string" && isLink(data.uri))
      send(data.uri.trim());
  });

  new MutationObserver(scanSoon).observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });
  scanSoon();
})();
