import { useCallback, useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call, type Status } from "../api";
import { Bch, ErrorNotice } from "../components/common";
import { TokenIcon } from "../components/TokenIcon";
import { poll } from "../errors";
import { TxRow } from "./Transaction";
import { nftSummary, shortId, tokenAmountText, tokenName, useTokenMeta } from "../token-meta";
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

const short = shortId;
const PAGE = 25;

export function Home({
  status,
  onSend,
  onReceive,
  onIdentity,
  onApps,
  onBackup,
  onOlderPasswords,
  onTransaction,
}: {
  status: Status;
  onSend: () => void;
  onReceive: () => void;
  onIdentity: () => void;
  onApps: () => void;
  onBackup: () => void;
  onOlderPasswords: () => void;
  onTransaction: (txid: string) => void;
}) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<History>([]);
  const [tab, setTab] = useState<"activity" | "tokens">("activity");
  // Long histories are shown a page at a time, inside the scrolling list.
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<unknown>(null);
  const quote = useRate();
  const active = status.wallets.find((w) => w.id === status.activeId);
  const tokenMeta = useTokenMeta(balance?.tokens.map((t) => t.category) ?? []);

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
    <section className="screen home">
      {active && !active.backedUp && (
        <div className="notice warning row spread">
          <span>Your recovery phrase is not backed up yet.</span>
          <button type="button" className="icon" onClick={onBackup}>
            Back up
          </button>
        </div>
      )}
      {status.wallets.some((w) => w.needsPassword) && (
        <div className="notice warning row spread">
          <span>
            {status.wallets.filter((w) => w.needsPassword).length === 1
              ? "One wallet still uses an older password."
              : "Some wallets still use an older password."}
          </span>
          <button type="button" className="icon" onClick={onOlderPasswords}>
            Fix
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
      <div className="actions">
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
      <div className="tab-panel" role="tabpanel">
        {tab === "activity" &&
          (history.length === 0 ? (
            <p className="muted small">No transactions yet.</p>
          ) : (
            <>
              <ul className="list" aria-label="Transactions">
                {history.slice(0, shown).map((entry) => (
                  <li key={entry.txid}>
                    <TxRow
                      txid={entry.txid}
                      when={when(entry.time, entry.height)}
                      onOpen={onTransaction}
                    />
                  </li>
                ))}
              </ul>
              {history.length > shown && (
                <button
                  type="button"
                  className="icon more"
                  onClick={() => setShown((n) => n + PAGE)}
                >
                  Show {Math.min(PAGE, history.length - shown)} more
                </button>
              )}
            </>
          ))}
        {tab === "tokens" &&
          (!balance || balance.tokens.length === 0 ? (
            <p className="muted small">
              No CashTokens yet. Receive them on your token address (starting with z).
            </p>
          ) : (
            <ul className="list" aria-label="Tokens">
              {balance.tokens.map((token) => {
                const meta = tokenMeta.get(token.category);
                const types = nftSummary(token.nfts, meta);
                return (
                  <li key={token.category}>
                    <span className="token-row">
                      <TokenIcon meta={meta} />
                      <span className="token-names">
                        <span className="token-name">{tokenName(token.category, meta)}</span>
                        {meta?.name ? (
                          <code className="small muted" title={token.category}>
                            {short(token.category)}
                          </code>
                        ) : (
                          <span className="small muted">
                            {meta?.state === "unknown" ? "No registry found" : "Looking up…"}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="token-amount">
                      {token.amount !== "0" && <span>{tokenAmountText(token.amount, meta)}</span>}
                      {token.nfts.length > 0 && (
                        <span className="small muted">
                          {" "}
                          {token.nfts.length} NFT{token.nfts.length === 1 ? "" : "s"}
                          {types && ` (${types})`}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>
    </section>
  );
}
