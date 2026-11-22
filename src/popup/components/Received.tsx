import { useEffect, useRef, useState } from "react";
import { formatBch } from "../../wallet/amount";
import { call } from "../api";
import { poll } from "../errors";

/**
 * A short notice when money arrives, on whatever screen is open. A new payment
 * first shows as unconfirmed, so the notice needs both the total and the
 * unconfirmed balance to rise. Past payments found while the wallet scans are
 * already confirmed, and a send lowers the total, so neither shows a notice.
 * The first reading after unlocking, or after switching wallets, is only remembered.
 */
export function Received({ walletId }: { walletId: string }) {
  const last = useRef<{ walletId: string; total: number; unconfirmed: number } | null>(null);
  const [notice, setNotice] = useState<{ sats: number; at: number } | null>(null);

  useEffect(() => {
    last.current = null;
  }, [walletId]);

  useEffect(
    () =>
      poll(async () => {
        const balance = await call({ type: "GET_BALANCE" });
        const total = balance.confirmed + balance.unconfirmed;
        const before = last.current;
        last.current = { walletId, total, unconfirmed: balance.unconfirmed };
        if (!before || before.walletId !== walletId) return;
        const received = Math.min(total - before.total, balance.unconfirmed - before.unconfirmed);
        if (received > 0) setNotice({ sats: received, at: Date.now() });
      }, 3_000),
    [walletId],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8_000);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!notice) return null;
  return (
    <div className="toast" role="status" key={notice.at}>
      <span className="toast-mark" aria-hidden="true">
        ↓
      </span>
      <span>
        <strong>Received {formatBch(notice.sats)} BCH</strong>
        <span className="small muted"> Shown in Activity.</span>
      </span>
      <button type="button" className="icon" aria-label="Close" onClick={() => setNotice(null)}>
        ×
      </button>
    </div>
  );
}
