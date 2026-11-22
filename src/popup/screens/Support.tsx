import { CopyButton, Qr, Screen } from "../components/common";

/** Where donations to the project go. Fixed in the code, never taken from a server. */
export const SUPPORT_ADDRESS = "bitcoincash:zpwd6edurja89cdq7hppvzq6xxzj5ct58uqf9czcx9";

/** The project's donation page: Cashlet is open source and free, and support keeps it running. */
export function Support({ onBack }: { onBack: () => void }) {
  return (
    <Screen title="Support Cashlet" back={onBack}>
      <p>
        Cashlet is open source and free to use. Your support helps us run the servers and relays it
        uses and keep improving it.
      </p>
      <Qr value={SUPPORT_ADDRESS} label="QR code of the Cashlet support address" />
      <div className="card stack">
        <span className="small muted">Send BCH or CashTokens to</span>
        <code data-testid="support-address">{SUPPORT_ADDRESS}</code>
        <CopyButton text={SUPPORT_ADDRESS} label="Copy address" />
      </div>
      <p className="small muted">
        Any amount helps. Source code: github.com/cashlet-labs/cashlet-wallet
      </p>
    </Screen>
  );
}
