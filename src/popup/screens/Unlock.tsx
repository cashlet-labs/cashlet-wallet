import { useEffect, useState } from "react";
import { call, ServiceError, type Status } from "../api";
import { ErrorNotice, Screen } from "../components/common";

export function Unlock({
  status,
  onUnlocked,
  onRestore,
}: {
  status: Status;
  onUnlocked: () => void;
  onRestore: () => void;
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
        <button type="button" className="link" onClick={onRestore}>
          Forgot the password? Restore from the recovery phrase
        </button>
      </form>
    </Screen>
  );
}
