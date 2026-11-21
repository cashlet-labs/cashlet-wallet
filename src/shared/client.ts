import type { ErrorResponse, Request, ResponseFor } from "./messages";

/** Send a request from an extension page to the service worker. */
export async function send<R extends Request>(
  request: R,
): Promise<ResponseFor[R["type"]] | ErrorResponse> {
  return (await chrome.runtime.sendMessage(request)) as ResponseFor[R["type"]] | ErrorResponse;
}
