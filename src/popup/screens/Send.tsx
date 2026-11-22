import { useEffect, useState } from "react";
import { isPayeeTarget, type RecipientMessage, type ResponseFor } from "../../shared/messages";
import { parsePaymentRequest } from "../../wallet/address";
import { formatBch, parseBch } from "../../wallet/amount";
import { call } from "../api";
import { Bch, CopyButton, ErrorNotice, Screen } from "../components/common";
import { loadContacts, type Contact } from "../contacts";

type Plan = Extract<ResponseFor["PREPARE_SEND"], { ok: true }>;
type Balance = Extract<ResponseFor["GET_BALANCE"], { ok: true }>;
type Network = "mainnet" | "chipnet";
type Payee = Extract<ResponseFor["RESOLVE_PAYEE"], { ok: true }>;

/** Send: the form, then a review of exactly what will be signed, then the result. */
export function Send({ network, onBack }: { network: Network; onBack: () => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [asset, setAsset] = useState<string>("bch");
  const [tokenAmount, setTokenAmount] = useState("");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [payee, setPayee] = useState<Payee | null>(null);
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  // True while the amount is the one worked out by Max; editing it turns it off.
  const [maxed, setMaxed] = useState(false);

  // A prepared send can be confirmed for two minutes; after that it must be reviewed again.
  useEffect(() => {
    if (!plan) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, plan.expiresAt - Date.now()));
    return () => {
      clearTimeout(timer);
      setExpired(false);
    };
  }, [plan]);

  useEffect(() => {
    void call({ type: "GET_BALANCE" }).then(setBalance, setError);
    void loadContacts().then((all) => setContacts(all.filter((c) => c.network === network)));
  }, [network]);

  // A pasted payment request fills in the amount.
  const onAddress = (value: string) => {
    setTo(value);
    if (value.includes("?")) {
      try {
        const request = parsePaymentRequest(value, network);
        setTo(request.destination.address);
        if (request.amount !== null) setAmount(formatBch(request.amount));
      } catch {
        // Shown when the user continues.
      }
    }
  };

  /** Fill in the largest amount that can go to the entered recipient. */
  const useMax = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = to.trim();
      const address = isPayeeTarget(target)
        ? (await call({ type: "RESOLVE_PAYEE", target })).address
        : parsePaymentRequest(to, network).destination.address;
      const max = await call({ type: "GET_MAX_SEND", address });
      setAmount(formatBch(max.value));
      setMaxed(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const token = balance?.tokens.find((t) => t.category === asset) ?? null;

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      // An npub or did:bnd is resolved on the relays to its current, verified address.
      const target = to.trim();
      const resolved = isPayeeTarget(target) ? await call({ type: "RESOLVE_PAYEE", target }) : null;
      setPayee(resolved);
      const address = resolved
        ? asset === "bch"
          ? resolved.address
          : resolved.tokenAddress
        : parsePaymentRequest(to, network).destination.address;
      const recipient: RecipientMessage =
        asset === "bch"
          ? { address, value: parseBch(amount) }
          : {
              address,
              value: 0,
              token: {
                category: asset,
                amount: /^[1-9][0-9]*$/.test(tokenAmount.trim()) ? tokenAmount.trim() : "invalid",
              },
            };
      if (recipient.token?.amount === "invalid")
        throw new RangeError("enter a whole number of tokens");
      setPlan(
        await call({
          type: "PREPARE_SEND",
          recipients: [recipient],
          ...(maxed && asset === "bch" ? { max: true as const } : {}),
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (txid) {
    return (
      <Screen title="Sent">
        <p className="notice ok">The transaction was sent to the network.</p>
        <div className="card stack">
          <span className="small muted">Transaction ID</span>
          <code data-testid="txid">{txid}</code>
          <CopyButton text={txid} />
        </div>
        <button type="button" className="primary wide" onClick={onBack}>
          Done
        </button>
      </Screen>
    );
  }

  if (plan) {
    return (
      <Screen title="Review" back={() => setPlan(null)}>
        {payee && (
          <div className="card stack" data-testid="payee">
            <span className="notice ok">Verified identity</span>
            <span className="small muted">Nostr key</span>
            <code>{payee.npub}</code>
            <span className="small muted">DID</span>
            <code>{payee.did}</code>
            <span className="small muted">
              The address below is this identity&apos;s current one, checked on the relays.
            </span>
          </div>
        )}
        <dl className="review card">
          {plan.outputs
            .filter((o) => !o.change)
            .map((o, i) => (
              <div key={i}>
                <dt>To</dt>
                <dd>
                  <code>{o.address}</code>
                </dd>
                <dt>Amount</dt>
                <dd>
                  {o.token ? (
                    <>
                      {o.token.nft ? "1 NFT" : `${o.token.amount} tokens`}{" "}
                      <span className="muted">(+ {o.value} sats)</span>
                    </>
                  ) : (
                    <Bch sats={o.value} />
                  )}
                </dd>
              </div>
            ))}
          <dt>Network fee</dt>
          <dd>
            {plan.fee} sats <span className="muted">({plan.size} bytes)</span>
          </dd>
          <dt>Total leaving the wallet</dt>
          <dd data-testid="outgoing">
            <Bch sats={plan.outgoing} />
          </dd>
          {plan.outputs.some((o) => o.change) && (
            <>
              <dt>Back to this wallet as change</dt>
              <dd className="small">
                {plan.outputs
                  .filter((o) => o.change)
                  .map((o, i) => (
                    <div key={i}>
                      {o.token ? (
                        `${o.token.nft ? "1 NFT" : `${o.token.amount} tokens`}`
                      ) : (
                        <Bch sats={o.value} />
                      )}
                    </div>
                  ))}
              </dd>
            </>
          )}
        </dl>
        {network === "chipnet" && <p className="small muted">Chipnet coins have no value.</p>}
        <ErrorNotice error={error} />
        <button
          type="button"
          className="primary wide"
          disabled={busy || expired}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setTxid((await call({ type: "CONFIRM_SEND", planId: plan.planId })).txid);
            } catch (e) {
              setError(e);
              setPlan(null);
            } finally {
              setBusy(false);
            }
          }}
        >
          {expired ? "Expired: go back and review again" : "Send now"}
        </button>
      </Screen>
    );
  }

  return (
    <Screen title="Send" back={onBack}>
      <label>
        To
        <input
          placeholder={
            network === "mainnet"
              ? "bitcoincash:…, npub1… or did:bnd:…"
              : "bchtest:…, npub1… or did:bnd:…"
          }
          autoComplete="off"
          spellCheck={false}
          value={to}
          onChange={(e) => onAddress(e.target.value)}
          list="contact-list"
        />
        <datalist id="contact-list">
          {contacts.map((c) => (
            <option key={c.id} value={c.address}>
              {c.name}
            </option>
          ))}
        </datalist>
      </label>
      {balance && balance.tokens.length > 0 && (
        <label>
          What to send
          <select value={asset} onChange={(e) => setAsset(e.target.value)}>
            <option value="bch">BCH</option>
            {balance.tokens
              .filter((t) => t.amount !== "0")
              .map((t) => (
                <option key={t.category} value={t.category}>
                  Token {t.category.slice(0, 8)}… ({t.amount})
                </option>
              ))}
          </select>
        </label>
      )}
      {asset === "bch" ? (
        <label>
          Amount (BCH)
          <span className="amount-row">
            <input
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setMaxed(false);
              }}
            />
            <button type="button" disabled={busy || !to} onClick={useMax}>
              Max
            </button>
          </span>
          {balance && (
            <span className="small muted">
              Available: <Bch sats={balance.confirmed + balance.unconfirmed} />
              {maxed && ". Max sends all BCH coins and leaves the tokens."}
            </span>
          )}
        </label>
      ) : (
        <label>
          Number of tokens
          <input
            inputMode="numeric"
            value={tokenAmount}
            onChange={(e) => setTokenAmount(e.target.value)}
          />
          {token && <span className="small muted">Available: {token.amount}</span>}
        </label>
      )}
      <ErrorNotice error={error} />
      <button
        type="button"
        className="primary wide"
        disabled={busy || !to || (asset === "bch" ? !amount : !tokenAmount)}
        onClick={review}
      >
        Review
      </button>
    </Screen>
  );
}
