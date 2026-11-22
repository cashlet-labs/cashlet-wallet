import { useEffect, useRef, useState } from "react";
import type { BchNetwork } from "@cashlet-labs/bnd";
import { formatBch } from "../../wallet/amount";
import { CopyButton, ErrorNotice, Screen } from "../components/common";
import { explorerTxUrl } from "../explorer";
import {
  fetchTransaction,
  forgetTransaction,
  knownTransaction,
  signedBch,
  type TxView,
} from "../tx-view";

const DIRECTION = { received: "Received", sent: "Sent", self: "Moved to yourself" } as const;

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;

function tokenText(t: TxView["tokens"][number]): string {
  const parts: string[] = [];
  if (t.amount !== "0") parts.push(`${t.amount.startsWith("-") ? "" : "+"}${t.amount}`);
  if (t.nfts !== 0)
    parts.push(`${t.nfts > 0 ? "+" : ""}${t.nfts} NFT${Math.abs(t.nfts) === 1 ? "" : "s"}`);
  return parts.join(", ");
}

/** One line of the activity list. It looks up what the transaction did once it is on screen. */
export function TxRow({
  txid,
  when,
  onOpen,
}: {
  txid: string;
  when: string;
  onOpen: (txid: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<TxView | null>(knownTransaction(txid));
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const node = ref.current;
    if (visible || !node) return;
    const observer = new IntersectionObserver((seen) => {
      if (seen.some((s) => s.isIntersecting)) setVisible(true);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || view) return;
    let current = true;
    fetchTransaction(txid).then(
      (v) => current && setView(v),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [visible, view, txid]);

  return (
    <button type="button" className="tx-row" ref={ref} onClick={() => onOpen(txid)}>
      <span className="tx-what">
        {view ? DIRECTION[view.direction] : <code title={txid}>{short(txid)}</code>}
        <span className="small muted">{when}</span>
      </span>
      {view && (
        <span className={`tx-amount ${view.direction}`}>
          {view.net === 0 && view.tokens.length > 0 ? "CashTokens" : signedBch(view.net)}
        </span>
      )}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tx-field">
      <dt className="small muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function Transaction({
  txid,
  network,
  onBack,
}: {
  txid: string;
  network: BchNetwork;
  onBack: () => void;
}) {
  const [tx, setTx] = useState<TxView | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let current = true;
    const load = () =>
      fetchTransaction(txid).then(
        (v) => current && (setTx(v), setError(null)),
        (e: unknown) => current && setError(e),
      );
    void load();
    // Confirmations change while the screen is open.
    const timer = setInterval(() => {
      forgetTransaction(txid);
      void load();
    }, 30_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [txid]);

  let status = "";
  if (tx) {
    if (tx.height <= 0) status = "Pending";
    else if (tx.confirmations === null) status = `In block ${tx.height}`;
    else
      status = `${tx.confirmations.toLocaleString()} confirmation${tx.confirmations === 1 ? "" : "s"}`;
  }

  return (
    <Screen title="Transaction" back={onBack}>
      <ErrorNotice error={error} />
      {!tx && !error && (
        <p role="status" className="muted">
          Loading…
        </p>
      )}
      {tx && (
        <>
          <div className="balance" aria-live="polite">
            <div className="small muted">{DIRECTION[tx.direction]}</div>
            <div className="amount" data-testid="tx-net">
              {signedBch(tx.net)}
              <span className="unit">BCH</span>
            </div>
            {tx.direction === "sent" && tx.fee !== null && (
              <div className="small muted">Includes a fee of {formatBch(tx.fee)} BCH</div>
            )}
          </div>
          {!tx.complete && (
            <p className="notice warning">
              Some details could not be loaded, so the amounts may be incomplete.
            </p>
          )}
          <dl className="card tx-details">
            <Row label="Status">{status}</Row>
            {tx.time !== null && (
              <Row label="Time">
                {new Date(tx.time * 1000).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </Row>
            )}
            {tx.fee !== null && <Row label="Fee">{formatBch(tx.fee)} BCH</Row>}
            <Row label="Size">{tx.size.toLocaleString()} bytes</Row>
            {tx.direction === "sent" && tx.counterparties.length > 0 && (
              <Row label="Sent to">
                <ul className="tx-addresses">
                  {tx.counterparties.map((c, i) => (
                    <li key={i}>
                      <code>{c.address ?? "Not an address"}</code>
                      <span className="small muted">{formatBch(c.value)} BCH</span>
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            {tx.direction !== "sent" && tx.receivedOn.length > 0 && (
              <Row label={tx.direction === "received" ? "Received on" : "Moved to"}>
                <ul className="tx-addresses">
                  {tx.receivedOn.map((address) => (
                    <li key={address}>
                      <code>{address}</code>
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            {tx.tokens.length > 0 && (
              <Row label="Tokens">
                <ul className="tx-addresses">
                  {tx.tokens.map((t) => (
                    <li key={t.category}>
                      <code title={t.category}>{short(t.category)}</code>
                      <span>{tokenText(t)}</span>
                    </li>
                  ))}
                </ul>
              </Row>
            )}
            <Row label="Transaction ID">
              <code className="tx-id" data-testid="tx-id">
                {tx.txid}
              </code>
            </Row>
          </dl>
          <div className="row">
            <CopyButton text={tx.txid} label="Copy transaction ID" />
            <a
              className="button"
              href={explorerTxUrl(network, tx.txid)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in explorer
            </a>
          </div>
        </>
      )}
    </Screen>
  );
}
