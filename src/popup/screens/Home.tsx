import { useCallback, useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call, type Status } from "../api";
import { Bch, ErrorNotice } from "../components/common";
import { poll } from "../errors";
import { Fiat, useRate } from "../fiat";

type Balance = Extract<ResponseFor["GET_BALANCE"], { ok: true }>;
type History = Extract<ResponseFor["GET_HISTORY"], { ok: true }>["entries"];

function when(time: number | null, height: number): string {
  if (height <= 0) return "Pending";
  if (time === null) return `Block ${height}`;
  return new Date(time * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;

export function Home({
  status,
  onSend,
  onReceive,
  onIdentity,
  onApps,
  onBackup,
}: {
  status: Status;
  onSend: () => void;
  onReceive: () => void;
  onIdentity: () => void;
  onApps: () => void;
  onBackup: () => void;
}) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [tab, setTab] = useState<"activity" | "tokens">("activity");
  const [error, setError] = useState<unknown>(null);
  const quote = useRate();
  const active = status.wallets.find((w) => w.id === status.activeId);

  const load = useCallback(async () => {
    try {
      const [b, h] = await Promise.all([
        call({ type: "GET_BALANCE" }),
        call({ type: "GET_HISTORY" }),
      ]);
      setBalance(b);
      setHistory(h.entries);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  // While scanning, refresh often; afterwards the scanner keeps the store current.
  useEffect(() => poll(load, status.scan === "scanning" ? 2_000 : 8_000), [load, status.scan]);

  return (
    <section className="screen">
      {active && !active.backedUp && (
        <div className="notice warning row spread">
          <span>Your recovery phrase is not backed up yet.</span>
          <button type="button" className="icon" onClick={onBackup}>
            Back up
          </button>
        </div>
      )}
      <div className="balance" aria-live="polite">
        <div className="amount" data-testid="balance">
          {balance ? (
            <>
              {(balance.confirmed + balance.unconfirmed) / 1e8 === 0
                ? "0"
                : ((balance.confirmed + balance.unconfirmed) / 1e8).toLocaleString(undefined, {
                    maximumFractionDigits: 8,
                  })}
              <span className="unit">BCH</span>
            </>
          ) : (
            "…"
          )}
        </div>
        {balance && quote && quote.currency !== "OFF" && (
          <div className="fiat-line small" data-testid="fiat-balance">
            {quote.testCoins ? (
              <span className="muted">Test coins have no value</span>
            ) : quote.rate === null ? (
              <span className="muted">—</span>
            ) : (
              <Fiat quote={quote} sats={balance.confirmed + balance.unconfirmed} />
            )}
          </div>
        )}
        {balance && balance.unconfirmed !== 0 && (
          <div className="small muted">
            Including <Bch sats={balance.unconfirmed} /> not yet confirmed
          </div>
        )}
        <div className="small muted">
          {status.scan === "scanning" && "Checking the network…"}
          {status.scan === "error" &&
            `Could not reach the network: ${status.scanError ?? "unknown error"}`}
        </div>
      </div>
      <div className="row">
        <button type="button" className="primary grow" onClick={onSend}>
          Send
        </button>
        <button type="button" className="grow" onClick={onReceive}>
          Receive
        </button>
        <button type="button" className="grow" onClick={onIdentity}>
          Identity
        </button>
        <button type="button" className="grow" onClick={onApps}>
          Apps
        </button>
      </div>
      <ErrorNotice error={error} />
      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "activity"}
          onClick={() => setTab("activity")}
        >
          Activity
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "tokens"}
          onClick={() => setTab("tokens")}
        >
          Tokens {balance && balance.tokens.length > 0 ? `(${balance.tokens.length})` : ""}
        </button>
      </div>
      {tab === "activity" &&
        (history.length === 0 ? (
          <p className="muted small">No transactions yet.</p>
        ) : (
          <ul className="list" aria-label="Transactions">
            {history.map((entry) => (
              <li key={entry.txid}>
                <code title={entry.txid}>{short(entry.txid)}</code>
                <span className="small muted">{when(entry.time, entry.height)}</span>
              </li>
            ))}
          </ul>
        ))}
      {tab === "tokens" &&
        (!balance || balance.tokens.length === 0 ? (
          <p className="muted small">
            No CashTokens yet. Receive them on your token address (starting with z).
          </p>
        ) : (
          <ul className="list" aria-label="Tokens">
            {balance.tokens.map((token) => (
              <li key={token.category}>
                <code title={token.category}>{short(token.category)}</code>
                <span>
                  {token.amount !== "0" && <span>{token.amount}</span>}
                  {token.nfts.length > 0 && (
                    <span className="small muted">
                      {" "}
                      {token.nfts.length} NFT{token.nfts.length === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
