import { useCallback, useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call } from "../api";
import { ErrorNotice, Screen } from "../components/common";
import { poll } from "../errors";

type List = Extract<ResponseFor["APPROVALS_LIST"], { ok: true }>;
type Approval = List["approvals"][number];

/** Names of common Nostr event kinds (NIP-01 and others), to help the user read a request. */
const KIND_NAMES: Record<number, string> = {
  0: "Profile (replaces your name, picture and bio)",
  1: "Note",
  3: "Follow list (replaces who you follow)",
  4: "Direct message (old format)",
  5: "Deletion request",
  6: "Repost",
  7: "Reaction",
  1984: "Report",
  9734: "Zap request",
  10002: "Relay list (replaces your relays)",
  22242: "Relay login",
  27235: "Website login (HTTP auth)",
  30023: "Article",
};

function kindName(kind: number): string {
  return KIND_NAMES[kind] ?? `Event kind ${kind}`;
}

const time = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const bch = (sats: string) => {
  const value = BigInt(sats);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} BCH`;
};

function Transaction({ tx }: { tx: NonNullable<Approval["transaction"]> }) {
  return (
    <div className="card stack" data-testid="dapp-transaction">
      <span>This app asks you to sign a transaction.</span>
      {tx.userPrompt && (
        <span className="small">
          The app says: <q>{tx.userPrompt}</q>
        </span>
      )}
      <span className="small muted">From this wallet</span>
      <span data-testid="dapp-spending">
        {bch(tx.signing.value)} in {tx.signing.count} of {tx.inputs} input
        {tx.inputs === 1 ? "" : "s"}
      </span>
      <span className="small muted">Outputs</span>
      <ul className="event-tags">
        {tx.outputs.map((o, i) => (
          <li key={i} className="small">
            <code>
              {o.address ??
                (o.script?.startsWith("6a") ? "Data (OP_RETURN)" : `Script ${o.script}`)}
            </code>
            {o.own && <span className="muted"> (this wallet)</span>}
            <div>
              {bch(o.value)}
              {o.token &&
                ` + ${o.token.nft ? `1 ${o.token.nft}` : ""}${o.token.nft && o.token.amount !== "0" ? " and " : ""}${o.token.amount !== "0" ? `${o.token.amount} tokens` : ""} of ${o.token.category.slice(0, 8)}…`}
            </div>
          </li>
        ))}
      </ul>
      <span className="small muted">Network fee</span>
      <span>{bch(tx.fee)}</span>
      {tx.feeLevel === "high" && (
        <p className="notice warning">
          This fee is higher than usual. Check the amounts before signing.
        </p>
      )}
      {tx.burns.length > 0 && (
        <p className="notice warning">
          Tokens of {tx.burns.map((c) => `${c.slice(0, 8)}…`).join(", ")} are spent and not paid
          anywhere: they will be destroyed.
        </p>
      )}
      <p className="small muted">
        {tx.broadcast
          ? tx.signing.count === tx.inputs
            ? "Cashlet sends the signed transaction to the network and gives it to the app."
            : "Other inputs still need signatures, so Cashlet gives the signed transaction to the app and does not send it."
          : "Cashlet only signs and does not send it to the network. The app receives the signed transaction and could still send it."}
      </p>
    </div>
  );
}

function Details({ approval, npub }: { approval: Approval; npub: string | null }) {
  if (approval.type === "transaction" && approval.transaction) {
    return <Transaction tx={approval.transaction} />;
  }
  if (approval.type === "connect") {
    return (
      <div className="card stack">
        <span>This site asks for your Nostr public key. It can then recognise you.</span>
        {npub && <code>{npub}</code>}
        <span className="small muted">It cannot sign anything without asking you.</span>
      </div>
    );
  }
  if (approval.type === "login" && approval.login) {
    return (
      <div className="card stack">
        <span>This site asks you to log in with your BND identity.</span>
        <span className="small muted">Login address</span>
        <code>{approval.login.audience}</code>
        <span className="small">
          {approval.login.level === "dual"
            ? "Both your Nostr key and your BCH address sign. Sites ask for this before actions that move money."
            : "Your Nostr key signs."}
        </span>
        <span className="small muted">
          The site learns your DID, Nostr key and identity address. No coins move.
        </span>
      </div>
    );
  }
  const event = approval.event;
  if (!event) return null;
  // Compared with when the site asked, which is close to now.
  const skew = Math.abs(event.created_at - approval.createdAt / 1000);
  return (
    <div className="card stack">
      <span>This site asks you to sign a Nostr event.</span>
      <span className="small muted">Kind</span>
      <span data-testid="event-kind">{kindName(event.kind)}</span>
      <span className="small muted">Content</span>
      <pre className="event-content" data-testid="event-content">
        {event.content === "" ? "(empty)" : event.content}
      </pre>
      {event.tags.length > 0 && (
        <>
          <span className="small muted">Tags ({event.tags.length})</span>
          <ul className="event-tags">
            {event.tags.map((tag, i) => (
              <li key={i}>
                <code>{tag.join(" · ")}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <span className="small muted">Dated</span>
      <span className="small">
        {time(event.created_at)}
        {skew > 3600 && " (not now: check this is expected)"}
      </span>
      {npub && (
        <span className="small muted">
          Signed by <code>{npub}</code>
        </span>
      )}
    </div>
  );
}

/** Requests from websites, one at a time, oldest first. */
export function Approvals({ onDone }: { onDone: () => void }) {
  const [list, setList] = useState<List | null>(null);
  const [remember, setRemember] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const next = await call({ type: "APPROVALS_LIST" });
      setList(next);
      if (next.approvals.length === 0) onDone();
    } catch (e) {
      setError(e);
    }
  }, [onDone]);

  useEffect(() => poll(load, 2_000), [load]);

  const approval = list?.approvals[0];
  if (!list || !approval) {
    return (
      <Screen title="Requests">
        <ErrorNotice error={error} />
        <p className="muted">No requests are waiting.</p>
      </Screen>
    );
  }
  // Remembering a site is the usual choice for a connection; for signing, the user opts in.
  const remembering = approval.rememberable && (remember ?? approval.type === "connect");

  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await call({ type: "APPROVAL_DECIDE", id: approval.id, approve, remember: remembering });
      setRemember(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <Screen
      title={
        list.approvals.length > 1 ? `Request 1 of ${list.approvals.length}` : "Request from a site"
      }
    >
      <p className="site-origin" data-testid="approval-origin">
        {approval.origin}
      </p>
      <Details approval={approval} npub={list.npub} />
      {approval.rememberable && (
        <label className="check">
          <input
            type="checkbox"
            checked={remembering}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>
            {approval.type === "connect"
              ? "Remember this site"
              : "Don't ask again for this kind of event on this site"}
          </span>
        </label>
      )}
      <ErrorNotice error={error} />
      <div className="row">
        <button type="button" className="grow" disabled={busy} onClick={() => void decide(false)}>
          Reject
        </button>
        <button
          type="button"
          className="primary grow"
          disabled={busy}
          onClick={() => void decide(true)}
        >
          {approval.type === "connect"
            ? "Connect"
            : approval.type === "login"
              ? "Log in"
              : approval.type === "transaction"
                ? approval.transaction?.broadcast &&
                  approval.transaction.signing.count === approval.transaction.inputs
                  ? "Sign and send"
                  : "Sign"
                : "Sign"}
        </button>
      </div>
    </Screen>
  );
}
