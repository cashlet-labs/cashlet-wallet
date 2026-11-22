import { useState } from "react";
import { call } from "../api";
import { CopyButton, ErrorNotice, Screen } from "../components/common";

/** Sign a message with one of the wallet's own addresses, to prove the address is yours. */
export function SignMessage({ onBack }: { onBack: () => void }) {
  const [source, setSource] = useState<"identity" | "receive">("identity");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ address: string; signature: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Screen title="Sign a message" back={onBack}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const { address, signature } = await call({ type: "SIGN_MESSAGE", source, message });
            setResult({ address, signature });
          } catch (err) {
            setResult(null);
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted small">
          A signature shows that you hold the key of an address. No coins move.
        </p>
        <label>
          Address
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value as "identity" | "receive");
              setResult(null);
            }}
          >
            <option value="identity">Identity address</option>
            <option value="receive">Current receive address</option>
          </select>
        </label>
        <label>
          Message
          <textarea
            rows={4}
            maxLength={65_536}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setResult(null);
            }}
          />
        </label>
        <ErrorNotice error={error} />
        <button type="submit" className="primary wide" disabled={busy || message === ""}>
          Sign
        </button>
      </form>
      {result && (
        <div className="card stack" data-testid="signed-message">
          <span className="small muted">Signed with</span>
          <code data-testid="signed-address">{result.address}</code>
          <span className="small muted">Signature</span>
          <code data-testid="signature">{result.signature}</code>
          <CopyButton text={result.signature} label="Copy signature" />
        </div>
      )}
    </Screen>
  );
}

/** Check a signed message against an address. Needs no keys. */
export function VerifyMessage({ onBack }: { onBack: () => void }) {
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [valid, setValid] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setValid(null);
  };
  return (
    <Screen title="Verify a message" back={onBack}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setValid(null);
          try {
            setValid((await call({ type: "VERIFY_MESSAGE", address, message, signature })).valid);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <label>
          Address
          <input value={address} onChange={(e) => edit(setAddress)(e.target.value)} />
        </label>
        <label>
          Message
          <textarea
            rows={4}
            maxLength={65_536}
            value={message}
            onChange={(e) => edit(setMessage)(e.target.value)}
          />
        </label>
        <label>
          Signature
          <input value={signature} onChange={(e) => edit(setSignature)(e.target.value)} />
        </label>
        <ErrorNotice error={error} />
        <button
          type="submit"
          className="primary wide"
          disabled={address === "" || message === "" || signature === ""}
        >
          Verify
        </button>
      </form>
      {valid !== null && (
        <p
          className={valid ? "notice" : "notice warning"}
          role="status"
          data-testid="verify-result"
        >
          {valid
            ? "Valid. This address signed this message."
            : "Not valid. This address did not sign this message."}
        </p>
      )}
    </Screen>
  );
}
