import { isExtensionSender, parseRequest, type ErrorResponse } from "../shared/messages";
import { handle } from "./handlers";

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
  handle(request).then(sendResponse, (error: unknown) => {
    const text = error instanceof Error ? error.message : "internal error";
    sendResponse({ ok: false, error: text } satisfies ErrorResponse);
  });
  // Keep the channel open for the asynchronous response.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  // The toolbar button opens the popup; the side panel opens from the browser's side panel menu.
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});
