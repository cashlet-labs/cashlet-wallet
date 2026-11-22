/**
 * Runs in the page's own world, only to read one property a web component
 * keeps in JavaScript instead of in the page: the `view` of a WizardConnect
 * dialog (`<bchc-modal>`), which holds the link while the dialog shows its QR
 * code. It copies the link to `wizard-detect.ts` with a window message and
 * does nothing else. The page can send the same message, so the receiver
 * treats it as untrusted.
 */
(() => {
  const CHANNEL = "cashlet:wiz:v1";
  const TAG = "bchc-modal";
  const MAX_WATCH_MS = 30_000;
  const sent = new WeakMap<Element, string>();

  const linkOf = (element: Element): string | null => {
    try {
      const phase = (element as { view?: { phase?: { link?: unknown } } }).view?.phase;
      return typeof phase?.link === "string" && phase.link !== "" ? phase.link : null;
    } catch {
      return null;
    }
  };

  const check = (element: Element): boolean => {
    const link = linkOf(element);
    if (link === null) return false;
    if (sent.get(element) !== link) {
      sent.set(element, link);
      window.postMessage({ channel: CHANNEL, uri: link }, "*");
    }
    return true;
  };

  // The dialog sets `view` after it is added, so look again for a while.
  const watch = (element: Element) => {
    if (check(element)) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (!element.isConnected || check(element) || Date.now() - started > MAX_WATCH_MS)
        clearInterval(timer);
    }, 200);
  };

  const scan = (root: ParentNode) => {
    if (root instanceof Element && root.localName === TAG) watch(root);
    for (const element of root.querySelectorAll(TAG)) watch(element);
  };

  scan(document);
  new MutationObserver((mutations) => {
    for (const mutation of mutations)
      for (const node of mutation.addedNodes) if (node instanceof Element) scan(node);
  }).observe(document, { childList: true, subtree: true });
})();
