import { useCallback, useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call } from "../api";
import { CopyButton, ErrorNotice, Screen } from "../components/common";

type Status = Extract<ResponseFor["IDENTITY_STATUS"], { ok: true }>;

const STATE_TEXT: Record<Status["state"], string> = {
  none: "Not published yet. Publish it so people can pay you by your npub or DID.",
  current: "Published and verified on the relays.",
  revoked: "Revoked. Payments and logins by this identity are refused.",
  disputed:
    "Two different bindings claim this identity. Do not use it until this is settled; it may mean your recovery phrase leaked.",
  unknown: "Too few relays answered to check this identity. Try again shortly.",
};

/**
 * The wallet's BND identity: its Nostr key bound to one of its BCH addresses.
 * Every change here is signed by both keys and sent to the relays.
 */
export function Identity({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [password, setPassword] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await call({ type: "IDENTITY_STATUS" }));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    let current = true;
    call({ type: "IDENTITY_STATUS" }).then(
      (found) => current && setStatus(found),
      (e: unknown) => current && setError(e),
    );
    return () => {
      current = false;
    };
  }, []);

  /** Run one change, then read the identity back from the relays. */
  const act = async (label: string, run: () => Promise<{ accepted: string[] }>) => {
    setBusy(label);
    setError(null);
    setDone(null);
    try {
      const { accepted } = await run();
      setDone(`Sent to ${accepted.length} relay${accepted.length === 1 ? "" : "s"}.`);
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return (
      <Screen title="Identity" back={onBack}>
        {error ? (
          <>
            <ErrorNotice error={error} />
            <button type="button" className="wide" onClick={() => void load()}>
              Try again
            </button>
          </>
        ) : (
          <p role="status" className="muted">
            Checking the relays…
          </p>
        )}
      </Screen>
    );
  }

  const live = status.state === "current";

  return (
    <Screen title="Identity" back={onBack}>
      <p
        data-testid="identity-state"
        className={`notice ${live ? "ok" : status.state === "none" ? "" : "warning"}`}
      >
        {STATE_TEXT[status.state]}
      </p>
      <div className="card stack">
        <span className="small muted">Nostr public key</span>
        <code data-testid="npub">{status.npub}</code>
        <CopyButton text={status.npub} />
      </div>
      {status.did && (
        <div className="card stack">
          <span className="small muted">DID</span>
          <code data-testid="did">{status.did}</code>
          <CopyButton text={status.did} />
        </div>
      )}
      <div className="card stack">
        <span className="small muted">
          {status.state === "none" ? "Address it will name" : "Address it names"}
        </span>
        <code data-testid="identity-address">{status.address}</code>
      </div>
      <p className="small muted">
        {status.relays.complete} of {status.relays.asked} relays answered.
      </p>

      <label className="check">
        <input
          type="checkbox"
          checked={status.publicRelays}
          disabled={busy !== null}
          onChange={async (e) => {
            const enabled = e.target.checked;
            try {
              await call({ type: "IDENTITY_PUBLIC_RELAYS", enabled });
              setStatus({ ...status, publicRelays: enabled });
            } catch (err) {
              setError(err);
            }
          }}
        />
        <span>
          Also publish to public Nostr relays. The Septem Labs and Bonga relays are always used.
        </span>
      </label>

      <ErrorNotice error={error} />
      {done && <p className="notice ok">{done}</p>}

      {status.state === "none" && (
        <button
          type="button"
          className="primary wide"
          disabled={busy !== null}
          onClick={() => void act("bind", () => call({ type: "IDENTITY_BIND" }))}
        >
          {busy === "bind" ? "Publishing…" : "Publish identity"}
        </button>
      )}

      {live && !revoking && (
        <div className="stack">
          <p className="small muted">
            Moving to a new address or Nostr key keeps your DID. Both current keys sign the change.
          </p>
          <div className="row">
            <button
              type="button"
              className="grow"
              disabled={busy !== null}
              onClick={() => void act("bch", () => call({ type: "IDENTITY_ROTATE", key: "bch" }))}
            >
              {busy === "bch" ? "Moving…" : "Use a new address"}
            </button>
            <button
              type="button"
              className="grow"
              disabled={busy !== null}
              onClick={() =>
                void act("nostr", () => call({ type: "IDENTITY_ROTATE", key: "nostr" }))
              }
            >
              {busy === "nostr" ? "Moving…" : "Use a new Nostr key"}
            </button>
          </div>
          <button
            type="button"
            className="link"
            disabled={busy !== null}
            onClick={() => setRevoking(true)}
          >
            Revoke this identity…
          </button>
        </div>
      )}

      {live && revoking && (
        <form
          className="card stack"
          onSubmit={(e) => {
            e.preventDefault();
            void act("revoke", async () => {
              const result = await call({ type: "IDENTITY_REVOKE", password });
              setPassword("");
              setRevoking(false);
              return result;
            });
          }}
        >
          <p className="notice warning">
            Revoking is permanent. People will no longer be able to pay you or log in as you with
            this identity. Your coins are not affected.
          </p>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="row">
            <button
              type="button"
              className="grow"
              onClick={() => {
                setRevoking(false);
                setPassword("");
              }}
            >
              Cancel
            </button>
            <button type="submit" className="primary grow" disabled={!password || busy !== null}>
              {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
          </div>
        </form>
      )}

      {status.state !== "none" && (
        <button type="button" className="link" disabled={busy !== null} onClick={() => void load()}>
          Check again
        </button>
      )}
    </Screen>
  );
}
