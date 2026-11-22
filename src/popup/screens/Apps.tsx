import { useCallback, useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call } from "../api";
import { ErrorNotice, Screen } from "../components/common";
import { poll } from "../errors";

type Connection = Extract<ResponseFor["WIZARD_LIST"], { ok: true }>["connections"][number];

const STATUS: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

/** WizardConnect: connect a dApp by pasting its wiz:// link, or approve it when a site shows one. */
export function Apps({ onBack }: { onBack: () => void }) {
  const [uri, setUri] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setConnections((await call({ type: "WIZARD_LIST" })).connections);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => poll(load, 2_000), [load]);

  return (
    <Screen title="Apps" back={onBack}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await call({ type: "WIZARD_CONNECT", uri: uri.trim() });
            setUri("");
            await load();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          WizardConnect link
          <input
            placeholder="wiz://…"
            autoComplete="off"
            spellCheck={false}
            value={uri}
            onChange={(e) => setUri(e.target.value)}
          />
        </label>
        <p className="small muted">
          The app will see all your addresses, balances and history. It cannot spend anything: every
          transaction is shown here for you to approve.
        </p>
        <ErrorNotice error={error} />
        <button type="submit" className="primary wide" disabled={busy || !uri.trim()}>
          Connect
        </button>
      </form>
      {connections.length === 0 ? (
        <p className="muted small">No apps are connected.</p>
      ) : (
        <ul className="list" aria-label="Connected apps">
          {connections.map((c) => (
            <li key={c.id}>
              <span className="stack">
                <span>{c.name ?? "Waiting for the app…"}</span>
                <span className="small muted" data-testid="app-status">
                  {STATUS[c.status] ?? c.status}
                </span>
                {c.origin && (
                  <span className="small muted" data-testid="app-origin">
                    From {c.origin}
                  </span>
                )}
              </span>
              <button
                type="button"
                className="icon"
                onClick={async () => {
                  await call({ type: "WIZARD_DISCONNECT", id: c.id }).catch(setError);
                  await load();
                }}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="small muted">
        Connections close when the wallet locks, and may drop when the browser pauses the wallet.
        Paste the link again to reconnect.
      </p>
    </Screen>
  );
}
