import QRCode from "qrcode";
import { useEffect, useState, type ReactNode } from "react";
import { formatBch } from "../../wallet/amount";
import { errorText, MIN_PASSWORD } from "../errors";

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="notice error" role="alert">
      {errorText(error)}
    </p>
  );
}

export function Bch({ sats }: { sats: number }) {
  return (
    <>
      {formatBch(sats)} <span className="muted">BCH</span>
    </>
  );
}

/** New password with confirmation. Reports the password once both match and it is long enough. */
export function NewPassword({
  onChange,
  label = "Password",
}: {
  onChange: (password: string | null) => void;
  label?: string;
}) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const tooShort = first.length > 0 && first.length < MIN_PASSWORD;
  const mismatch = second.length > 0 && first !== second;
  useEffect(() => {
    onChange(first.length >= MIN_PASSWORD && first === second ? first : null);
  }, [first, second, onChange]);
  return (
    <div className="stack">
      <label>
        {label}
        <input
          type="password"
          autoComplete="new-password"
          value={first}
          aria-invalid={tooShort}
          onChange={(e) => setFirst(e.target.value)}
        />
        {tooShort && <span className="small muted">At least {MIN_PASSWORD} characters.</span>}
      </label>
      <label>
        Repeat the password
        <input
          type="password"
          autoComplete="new-password"
          value={second}
          aria-invalid={mismatch}
          onChange={(e) => setSecond(e.target.value)}
        />
        {mismatch && <span className="small muted">The passwords do not match.</span>}
      </label>
    </div>
  );
}

export function NetworkChoice({
  value,
  onChange,
}: {
  value: "mainnet" | "chipnet";
  onChange: (n: "mainnet" | "chipnet") => void;
}) {
  // Wallets hold real BCH. The test network is for developers, one extra step away.
  return (
    <details className="developer" open={value === "chipnet"}>
      <summary className="small muted">Developer options</summary>
      <label className="row">
        <input
          type="checkbox"
          checked={value === "chipnet"}
          onChange={(e) => onChange(e.target.checked ? "chipnet" : "mainnet")}
        />
        Use chipnet, the test network
      </label>
      {value === "chipnet" && (
        <span className="notice warning">
          Chipnet coins have no value. This wallet cannot receive real BCH.
        </span>
      )}
    </details>
  );
}

/** A QR code drawn as an SVG data image; the library's markup never enters the page. */
export function Qr({ value, label }: { value: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(
      (svg) => current && setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
      () => current && setSrc(null),
    );
    return () => {
      current = false;
    };
  }, [value]);
  return <div className="qr">{src && <img src={src} alt={label} />}</div>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? "Copied" : label}
    </button>
  );
}

export function Screen({
  title,
  back,
  children,
  className,
}: {
  title?: string;
  back?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `screen ${className}` : "screen"}>
      {(title || back) && (
        <div className="row">
          {back && (
            <button type="button" className="link" onClick={back} aria-label="Back">
              ← Back
            </button>
          )}
          {title && <h2 className="grow">{title}</h2>}
        </div>
      )}
      {children}
    </section>
  );
}
