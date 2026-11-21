import { BINDING_EVENT_KIND, verifyBinding } from "@cashlet-labs/bnd";
import type { Request, ResponseFor } from "../shared/messages";

/** Handle a validated request. Pure: no Chrome APIs, so it can be tested in Node. */
export async function handle<R extends Request>(request: R): Promise<ResponseFor[R["type"]]> {
  switch (request.type) {
    case "PING":
      return { ok: true, bindingKind: BINDING_EVENT_KIND } as ResponseFor[R["type"]];
    case "VERIFY_BINDING": {
      const result = verifyBinding(request.event);
      const response = result.ok
        ? {
            ok: true as const,
            nostrPublicKey: result.nostrPublicKey,
            address: result.bch.address,
            proofType: result.proofType,
          }
        : { ok: false as const, reason: result.reason };
      return response as ResponseFor[R["type"]];
    }
  }
}
