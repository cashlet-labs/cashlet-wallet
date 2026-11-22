import type { BchNetwork } from "@cashlet-labs/bnd";
import { NETWORKS } from "../electrum/servers";
import type { KeyValueStore } from "./session";

/** Network settings the user can change: the fee rate and the preferred Electrum server. */

export const MIN_FEE_RATE = 1;
export const MAX_FEE_RATE = 10;

const FEE_RATE_KEY = "feeRate";
const serverKey = (network: BchNetwork) => `preferredServer:${network}`;

/** A fee rate in whole sat/byte the wallet accepts. */
export function isFeeRate(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= MIN_FEE_RATE &&
    (value as number) <= MAX_FEE_RATE
  );
}

/** A server from the built-in list for this network. Custom servers are not allowed by the CSP. */
export function isBuiltInServer(network: BchNetwork, url: unknown): url is string {
  return typeof url === "string" && NETWORKS[network].servers.includes(url);
}

/** The chosen fee rate, or null for automatic (the server's relay fee). */
export async function loadFeeRate(settings: KeyValueStore): Promise<number | null> {
  const stored = await settings.get<unknown>(FEE_RATE_KEY);
  return isFeeRate(stored) ? stored : null;
}

export async function saveFeeRate(settings: KeyValueStore, rate: number | null): Promise<void> {
  if (rate === null) await settings.remove(FEE_RATE_KEY);
  else await settings.set(FEE_RATE_KEY, rate);
}

/** The preferred server for a network, or null for automatic. A stale or unknown value counts as automatic. */
export async function loadPreferredServer(
  settings: KeyValueStore,
  network: BchNetwork,
): Promise<string | null> {
  const stored = await settings.get<unknown>(serverKey(network));
  return isBuiltInServer(network, stored) ? stored : null;
}

export async function savePreferredServer(
  settings: KeyValueStore,
  network: BchNetwork,
  url: string | null,
): Promise<void> {
  if (url === null) await settings.remove(serverKey(network));
  else await settings.set(serverKey(network), url);
}

/** The built-in servers with the preferred one first; the rest keep their order for failover. */
export function orderServers(servers: readonly string[], preferred: string | null): string[] {
  return preferred && servers.includes(preferred)
    ? [preferred, ...servers.filter((s) => s !== preferred)]
    : [...servers];
}
