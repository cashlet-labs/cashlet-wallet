import { useEffect, useState } from "react";
import { parseBch } from "../../wallet/amount";
import { call } from "../api";
import { CopyButton, ErrorNotice, Qr, Screen } from "../components/common";

export function Receive({ onBack }: { onBack: () => void }) {
  const [tokens, setTokens] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    call({ type: "GET_RECEIVE_ADDRESS", tokenAware: tokens }).then(
      (r) => setAddress(r.address),
      (e: unknown) => setError(e),
    );
  }, [tokens]);

  let amountError: string | null = null;
  let uri = address ?? "";
  if (address && amount.trim() !== "") {
    try {
      parseBch(amount);
      uri = `${address}?amount=${amount.trim()}`;
    } catch (e) {
      amountError = e instanceof Error ? e.message : "invalid amount";
    }
  }

  return (
    <Screen title="Receive" back={onBack}>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!tokens} onClick={() => setTokens(false)}>
          BCH
        </button>
        <button type="button" role="tab" aria-selected={tokens} onClick={() => setTokens(true)}>
          BCH and tokens
        </button>
      </div>
      <ErrorNotice error={error} />
      {address && (
        <>
          <Qr value={uri} label={`QR code for ${address}`} />
          <div className="card stack">
            <code data-testid="receive-address">{address}</code>
            <div className="row">
              <CopyButton text={address} label="Copy address" />
              {uri !== address && <CopyButton text={uri} label="Copy request" />}
            </div>
          </div>
          <label>
            Amount to request (optional)
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              aria-invalid={amountError !== null}
              onChange={(e) => setAmount(e.target.value)}
            />
            {amountError && <span className="small muted">{amountError}</span>}
          </label>
          <p className="small muted">
            {tokens
              ? "This address accepts BCH and CashTokens. Some older wallets cannot send to it."
              : "A new address is shown after each payment, so payments are harder to link."}
          </p>
        </>
      )}
    </Screen>
  );
}
