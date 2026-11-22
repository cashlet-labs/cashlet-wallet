import { useEffect, useRef, useState } from "react";
import { formatBch } from "../../wallet/amount";
import { call } from "../api";
import { poll } from "../errors";

/**
 * A short notice when money arrives, on whatever screen is open. It watches the
 * wallet's BCH balance: a rise is a payment in, since a send only lowers it.
 * The first reading after unlocking, or after switching wallets, is only remembered.
 */
export function Received({ walletId, scanning }: { walletId: string; scanning: boolean }) {
  const last = useRef<{ walletId: string; total: number } | null>(null);
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
        last.current = { walletId, total };
        // While the first scan runs, the balance climbs as old payments are found.
        if (!before || before.walletId !== walletId || scanning) return;
        if (total > before.total) setNotice({ sats: total - before.total, at: Date.now() });
      }, 3_000),
    [walletId, scanning],
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
