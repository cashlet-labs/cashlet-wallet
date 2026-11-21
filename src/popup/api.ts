import type { ErrorResponse, Request, ResponseFor } from "../shared/messages";

/** An error from the service worker, with its code when it has one (LOCKED, WRONG_PASSWORD, THROTTLED). */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

type Ok<T extends Request["type"]> = Extract<ResponseFor[T], { ok: true }>;

/** Send a request and return the successful response, or throw a ServiceError. */
export async function call<T extends Request["type"]>(
  request: Extract<Request, { type: T }>,
): Promise<Ok<T>> {
  const response = (await chrome.runtime.sendMessage(request)) as
    ResponseFor[T] | ErrorResponse | undefined;
  if (!response) throw new ServiceError("the wallet service did not answer", undefined);
  if (!response.ok) {
    const failure = response as ErrorResponse | { ok: false; reason: string };
    if ("reason" in failure) throw new ServiceError(failure.reason, undefined);
    throw new ServiceError(failure.error, failure.code);
  }
  return response as Ok<T>;
}

export type Status = Ok<"STATUS">;
