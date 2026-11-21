/**
 * Errors from Electrum servers, classified by who is at fault.
 *
 * A "server fault" means another server may well answer: the connection broke,
 * timed out, or the server's node is unusable. The wallet then fails over. Any
 * other error is about the request itself (bad parameters, a transaction the
 * network rejects, a transaction that does not exist) and is reported as it is:
 * asking another server would give the same answer.
 *
 * The rules come from real Fulcrum responses:
 *  - code 1 is "bad request", but a node with an expired release answers a
 *    broadcast with code 1 and "RPC is disabled ... expire=0";
 *  - code 2 is "daemon error" and wraps the node's own code: -100 is an
 *    expired node, -5 is an honest "no such transaction".
 */

/** The connection failed, closed or timed out. Always a server fault. */
export class ElectrumTransportError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "ElectrumTransportError";
  }
}

/** The server answered a request with a JSON-RPC error. */
export class ElectrumRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly method: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "ElectrumRpcError";
  }

  /** The node's own error code inside a daemon error, such as -5 or -100. */
  get daemonCode(): number | null {
    const match = /'code':\s*(-?\d+)/.exec(this.message) ?? /"code":\s*(-?\d+)/.exec(this.message);
    return match ? Number(match[1]) : null;
  }
}

/** The server is up but cannot be used: wrong chain, or far behind the others. */
export class ElectrumUnusableError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "ElectrumUnusableError";
  }
}

/** Messages that mean the server's node is unusable, whatever the code. */
const NODE_UNUSABLE = [
  /rpc is disabled/i,
  /expire=0/i,
  /out of consensus/i,
  /warming up/i,
  /loading block index/i,
  /initial block download/i,
  /not connected/i,
  /connection refused/i,
  /daemon (?:is )?(?:down|unavailable)/i,
];

/** Node codes inside a daemon error that are an honest answer about the request:
 *  no such transaction (-5), invalid parameter (-8), decode failed (-22),
 *  verify errors and rejections (-25, -26), already in the chain (-27). */
const NODE_ANSWER_CODES = new Set([-5, -8, -22, -25, -26, -27]);

const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INTERNAL = -32603;

/** True when another server should be tried. */
export function isServerFault(error: unknown): boolean {
  if (error instanceof ElectrumTransportError || error instanceof ElectrumUnusableError)
    return true;
  if (!(error instanceof ElectrumRpcError)) return false;
  if (NODE_UNUSABLE.some((pattern) => pattern.test(error.message))) return true;
  if (error.code === JSON_RPC_METHOD_NOT_FOUND || error.code === JSON_RPC_INTERNAL) return true;
  if (error.code === 2) {
    // A daemon error is the node's problem unless the node gave an honest answer
    // about the request. Retrying a read on another server is harmless.
    const daemonCode = error.daemonCode;
    return daemonCode === null || !NODE_ANSWER_CODES.has(daemonCode);
  }
  return false;
}

/** A broadcast the network already has: the transaction is out, not rejected. */
export function isAlreadyKnown(error: unknown): boolean {
  return (
    error instanceof ElectrumRpcError &&
    /txn-already-known|txn-already-in-mempool|transaction already in block chain|already have transaction/i.test(
      error.message,
    )
  );
}
