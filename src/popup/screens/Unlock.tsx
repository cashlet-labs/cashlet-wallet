import { useEffect, useState } from "react";
import { call, ServiceError, type Status } from "../api";
import { ErrorNotice, Screen } from "../components/common";

export function Unlock({
  status,
  onUnlocked,
  onRestore,
  onReset,
}: {
  status: Status;
  onUnlocked: () => void;
  onRestore: () => void;
  onReset: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(status.retryAfter);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(timer);
  }, [wait]);

  return (
    <Screen>
      <form
        className="stack"
        style={{ marginTop: 32 }}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await call({ type: "UNLOCK", password });
            setPassword("");
            onUnlocked();
          } catch (e) {
            setError(e);
            if (e instanceof ServiceError && e.code === "THROTTLED") {
              setWait(Number(/(\d+) seconds/.exec(e.message)?.[1] ?? 5));
            } else if (e instanceof ServiceError && e.code === "WRONG_PASSWORD") {
              setWait((await call({ type: "STATUS" })).retryAfter);
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Welcome back</h1>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <ErrorNotice error={error} />
        {wait > 0 && (
          <p className="small muted">Too many wrong passwords. Try again in {wait} seconds.</p>
        )}
        <button type="submit" className="primary wide" disabled={!password || busy || wait > 0}>
          Unlock
        </button>
        <ResetAll onDone={onReset} />
        <button type="button" className="link" onClick={onRestore}>
          Forgot the password? Restore from the recovery phrase
        </button>
      </form>
    </Screen>
  );
}

/** Start over: delete every wallet on this device, after the user types a confirmation. */
function ResetAll({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<unknown>(null);
  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Lost the password? Remove all wallets and start over
      </button>
    );
  }
  return (
    <div className="card stack">
      <p className="notice warning">
        This deletes every wallet from this device. You can restore each one later only with its
        recovery phrase. Money in a wallet whose phrase you do not have is lost.
      </p>
      <label>
        Type &quot;remove all&quot; to confirm
        <input autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="button" className="grow" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="danger grow"
          disabled={typed.trim().toLowerCase() !== "remove all"}
          onClick={async () => {
            try {
              await call({ type: "RESET_ALL", confirm: "remove all" });
              onDone();
            } catch (e) {
              setError(e);
            }
          }}
        >
          Remove all wallets
        </button>
      </div>
    </div>
  );
}
