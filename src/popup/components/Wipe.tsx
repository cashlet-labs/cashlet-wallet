import { useState } from "react";
import { call } from "../api";
import { ErrorNotice } from "./common";

/**
 * Delete every wallet from this device, after the user types "wipe". Used when
 * the password is forgotten, and from Settings by anyone who wants a clean slate.
 */
export function Wipe({
  intro,
  onDone,
  onCancel,
}: {
  intro: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card stack">
      <p className="small">{intro}</p>
      <p className="notice warning">
        Wiping deletes every wallet on this device. A wallet comes back only from its recovery
        phrase. Money in a wallet whose phrase you do not have is lost.
      </p>
      <label>
        Type &quot;wipe&quot; to confirm
        <input autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <ErrorNotice error={error} />
      <div className="row">
        <button type="button" className="grow" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="danger grow"
          disabled={typed.trim().toLowerCase() !== "wipe" || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await call({ type: "RESET_ALL", confirm: "wipe" });
              onDone();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Wipe all wallets
        </button>
      </div>
    </div>
  );
}
