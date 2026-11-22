import type { ResponseFor } from "../shared/messages";
import { formatBch } from "../wallet/amount";
import { call } from "./api";

export type TxView = Extract<ResponseFor["GET_TRANSACTION"], { ok: true }>;

/** BCH with a sign, such as "+0.5" or "−0.001". */
export function signedBch(sats: number): string {
  return `${sats < 0 ? "−" : "+"}${formatBch(Math.abs(sats))}`;
}

// What a transaction means for the wallet does not change, so each is fetched once.
// Only a few run at once, so a long history does not flood the service worker.
const known = new Map<string, TxView>();
const waiting: (() => void)[] = [];
let running = 0;
const MAX_RUNNING = 3;

function nextInQueue(): void {
  running -= 1;
  waiting.shift()?.();
}

export async function fetchTransaction(txid: string): Promise<TxView> {
  const cached = known.get(txid);
  if (cached) return cached;
  if (running >= MAX_RUNNING) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    const view = await call({ type: "GET_TRANSACTION", txid });
    if (view.complete) known.set(txid, view);
    return view;
  } finally {
    nextInQueue();
  }
}

export function knownTransaction(txid: string): TxView | null {
  return known.get(txid) ?? null;
}

/** Drop what is kept for a transaction, so the next look asks again (confirmations change). */
export function forgetTransaction(txid: string): void {
  known.delete(txid);
}
