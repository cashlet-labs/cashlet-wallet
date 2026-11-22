/**
 * Where the wallet is shown: the toolbar popup, the browser's side panel, or a
 * full tab. The page is the same in all three; only its frame differs.
 */
export type Surface = "popup" | "sidepanel" | "tab";

export function currentSurface(): Surface {
  if (new URLSearchParams(location.search).get("view") === "tab") return "tab";
  const popups = chrome.extension?.getViews?.({ type: "popup" }) ?? [];
  return popups.includes(window) ? "popup" : "sidepanel";
}

// The window is looked up ahead of time: Chrome only opens the side panel from a
// click if nothing is awaited first.
let windowId: number | undefined;
void chrome.windows?.getCurrent?.().then((w) => (windowId = w.id));

/** Open the wallet in the side panel of this window, then close the popup. */
export function openSidePanel(): void {
  if (windowId === undefined) return;
  void chrome.sidePanel.open({ windowId }).then(() => {
    if (currentSurface() === "popup") window.close();
  });
}

/** Open the wallet in its own tab, then close the popup. */
export function openTab(): void {
  void chrome.tabs
    .create({ url: chrome.runtime.getURL("src/popup/index.html?view=tab") })
    .then(() => {
      if (currentSurface() !== "tab") window.close();
    });
}
