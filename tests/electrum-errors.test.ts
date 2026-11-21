import { describe, expect, it } from "vitest";
import {
  ElectrumRpcError,
  ElectrumTransportError,
  ElectrumUnusableError,
  isAlreadyKnown,
  isServerFault,
} from "../src/electrum/errors";

// Exact responses captured from public chipnet Fulcrum servers on 2026-11-21.
const RPC_DISABLED_READ =
  "daemon error: DaemonError({'code': -100, 'message': 'RPC is disabled. This version of Bitcoin Cash Node is old and may be out of consensus with the network. It is recommended that you upgrade. To proceed without upgrading, and re-enable the RPC interface, restart the node with the configuration option expire=0.'})";
const RPC_DISABLED_BROADCAST =
  "the transaction was rejected by network rules.\n\nRPC is disabled. This version of Bitcoin Cash Node is old and may be out of consensus with the network. It is recommended that you upgrade. To proceed without upgrading, and re-enable the RPC interface, restart the node with the configuration option expire=0.\n";
const NO_SUCH_TX =
  "daemon error: DaemonError({'code': -5, 'message': 'No such mempool or blockchain transaction. Use gettransaction for wallet transactions.'})";
const DECODE_FAILED = "the transaction was rejected by network rules.\n\nTX decode failed\n";

const rpc = (message: string, code: number | null, method = "blockchain.transaction.get") =>
  new ElectrumRpcError(message, code, method, "wss://example.test");

describe("isServerFault", () => {
  it("fails over on transport problems and unusable servers", () => {
    expect(isServerFault(new ElectrumTransportError("closed", "wss://a"))).toBe(true);
    expect(isServerFault(new ElectrumUnusableError("behind", "wss://a"))).toBe(true);
  });

  it("fails over when the node's RPC is disabled, under either code", () => {
    expect(isServerFault(rpc(RPC_DISABLED_READ, 2))).toBe(true);
    // The broadcast form uses code 1, the code of a real rejection.
    expect(isServerFault(rpc(RPC_DISABLED_BROADCAST, 1, "blockchain.transaction.broadcast"))).toBe(
      true,
    );
  });

  it("reads the node's own code inside a daemon error", () => {
    expect(rpc(RPC_DISABLED_READ, 2).daemonCode).toBe(-100);
    expect(rpc(NO_SUCH_TX, 2).daemonCode).toBe(-5);
  });

  it("does not fail over on an honest answer about the request", () => {
    expect(isServerFault(rpc(NO_SUCH_TX, 2))).toBe(false);
    expect(isServerFault(rpc(DECODE_FAILED, 1, "blockchain.transaction.broadcast"))).toBe(false);
    expect(
      isServerFault(rpc("Height 99999999 is out of range", 1, "blockchain.block.header")),
    ).toBe(false);
  });

  it("fails over on unknown methods, internal errors and unknown daemon errors", () => {
    expect(isServerFault(rpc("Unsupported request: x", -32601))).toBe(true);
    expect(isServerFault(rpc("internal", -32603))).toBe(true);
    expect(isServerFault(rpc("daemon error: something else", 2))).toBe(true);
  });

  it("does not treat other errors as server faults", () => {
    expect(isServerFault(new Error("bug"))).toBe(false);
    expect(isServerFault("text")).toBe(false);
  });
});

describe("isAlreadyKnown", () => {
  it("recognises a transaction the network already has", () => {
    expect(
      isAlreadyKnown(rpc("the transaction was rejected by network rules.\n\ntxn-already-known", 1)),
    ).toBe(true);
    expect(isAlreadyKnown(rpc("transaction already in block chain", 1))).toBe(true);
    expect(isAlreadyKnown(rpc(DECODE_FAILED, 1))).toBe(false);
  });
});
