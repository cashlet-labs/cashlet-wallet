import type { BchNetwork } from "@cashlet-labs/bnd";

/** A block every server for a network must agree on, to refuse servers on another chain. */
export interface Checkpoint {
  height: number;
  /** Block hash, in the usual display (big-endian) order. */
  hash: string;
}

export interface NetworkConfig {
  servers: readonly string[];
  checkpoint: Checkpoint;
}

/**
 * Public Fulcrum servers. Order is the preference order; the pool moves past any
 * server that is down, on the wrong chain, behind the others, or whose node is
 * unusable. Checked live on 2026-11-21: all chipnet servers agreed on the
 * checkpoint; cbch.loping.net was 8,327 blocks behind with "RPC is disabled".
 */
export const NETWORKS: Record<BchNetwork, NetworkConfig> = {
  mainnet: {
    servers: [
      "wss://bch.imaginary.cash:50004",
      "wss://electrum.imaginary.cash:50004",
      "wss://electroncash.dk:50004",
      "wss://bch.loping.net:62104",
      "wss://electron.jochen-hoenicke.de:51004",
    ],
    // Block 478559, the first block after the split from BTC: BCH's genesis is BTC's.
    checkpoint: {
      height: 478559,
      hash: "000000000000000000651ef99cb9fcbe0dadde1d424bd9f15ff20136191a5eec",
    },
  },
  chipnet: {
    servers: [
      "wss://chipnet.imaginary.cash:50004",
      "wss://chipnet.bch.ninja:50004",
      "wss://cbch.loping.net:62104",
    ],
    checkpoint: {
      height: 100000,
      hash: "000000000010e4c904dcf276d0b91b5c7458e9159340ea04a85059561237959c",
    },
  },
};

export interface ElectrumTiming {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxTipLag: number;
  peerTipMaxAgeMs: number;
  cooldownBaseMs: number;
  cooldownMaxMs: number;
}

export const ELECTRUM_TIMING: Readonly<ElectrumTiming> = {
  connectTimeoutMs: 12_000,
  requestTimeoutMs: 20_000,
  /** A server more than this many blocks behind the best tip seen is not used. */
  maxTipLag: 2,
  /** How long a peer's tip counts as fresh when judging another server. */
  peerTipMaxAgeMs: 5 * 60_000,
  /** First wait after a fault; doubles per fault up to the maximum. */
  cooldownBaseMs: 60_000,
  cooldownMaxMs: 30 * 60_000,
};

/** Every host the extension may open a WebSocket to. Kept in sync with manifest.json. */
export function allServerUrls(): string[] {
  return Object.values(NETWORKS).flatMap((network) => [...network.servers]);
}
