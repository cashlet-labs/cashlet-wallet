import { useCallback, useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call, type Status } from "../api";
import { CopyButton, ErrorNotice, NewPassword, Screen } from "../components/common";
import { FIAT_CURRENCIES, type FiatChoice } from "../../wallet/rates";
import { deleteContact, loadContacts, saveContact, type Contact } from "../contacts";
import { FeeRate, PreferredServer } from "./NetworkSettings";
import { SignMessage, VerifyMessage } from "./SignMessage";

type Health = Extract<ResponseFor["SERVER_HEALTH"], { ok: true }>;

export function Settings({
  status,
  onBack,
  onAddWallet,
  onChanged,
  start = "main",
}: {
  status: Status;
  onBack: () => void;
  onAddWallet: () => void;
  onChanged: () => void;
  /** The section to open first. */
  start?: "main" | "wallets";
}) {
  const [section, setSection] = useState<
    | "main"
    | "phrase"
    | "password"
    | "servers"
    | "contacts"
    | "wallets"
    | "sites"
    | "sign"
    | "verify"
  >(start);
  const back = () => setSection("main");
  if (section === "phrase") return <RevealPhrase onBack={back} />;
  if (section === "password") return <ChangePassword onBack={back} />;
  if (section === "servers") return <Servers onBack={back} />;
  if (section === "sites") return <Sites onBack={back} />;
  if (section === "sign") return <SignMessage onBack={back} />;
  if (section === "verify") return <VerifyMessage onBack={back} />;
  if (section === "contacts")
    return <Contacts network={status.network ?? "chipnet"} onBack={back} />;
  if (section === "wallets")
    return (
      <Wallets status={status} onBack={back} onAddWallet={onAddWallet} onChanged={onChanged} />
    );

  return (
    <Screen title="Settings" back={onBack}>
      <div className="stack">
        <button type="button" className="wide" onClick={() => setSection("wallets")}>
          Wallets
        </button>
        <button type="button" className="wide" onClick={() => setSection("contacts")}>
          Address book
        </button>
        <button type="button" className="wide" onClick={() => setSection("sites")}>
          Connected sites
        </button>
        <button type="button" className="wide" onClick={() => setSection("sign")}>
          Sign a message
        </button>
        <button type="button" className="wide" onClick={() => setSection("verify")}>
          Verify a message
        </button>
        <button type="button" className="wide" onClick={() => setSection("phrase")}>
          Show recovery phrase
        </button>
        <button type="button" className="wide" onClick={() => setSection("password")}>
          Change password
        </button>
        <button type="button" className="wide" onClick={() => setSection("servers")}>
          Network servers
        </button>
        <AutoLock minutes={status.autoLockMinutes} onSaved={onChanged} />
        <FeeRate />
        <FiatChoiceSetting />
      </div>
    </Screen>
  );
}

type Site = Extract<ResponseFor["SITES_LIST"], { ok: true }>["sites"][number];

/** Sites that may read the Nostr key, and the event kinds they may have signed without asking. */
function Sites({ onBack }: { onBack: () => void }) {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setSites((await call({ type: "SITES_LIST" })).sites);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    let current = true;
    call({ type: "SITES_LIST" }).then(
      (r) => current && setSites(r.sites),
      (e: unknown) => current && setError(e),
    );
    return () => {
      current = false;
    };
  }, []);
  return (
    <Screen title="Connected sites" back={onBack}>
      <ErrorNotice error={error} />
      {sites && sites.length === 0 && (
        <p className="muted small">No site can use your Nostr key without asking.</p>
      )}
      {sites && sites.length > 0 && (
        <ul className="list" aria-label="Connected sites">
          {sites.map((site) => (
            <li key={site.origin}>
              <span className="stack">
                <code>{site.origin}</code>
                <span className="small muted">
                  {site.kinds.length === 0
                    ? "Reads your public key; asks before signing"
                    : `Signs event kind${site.kinds.length === 1 ? "" : "s"} ${site.kinds.join(", ")} without asking`}
                  {site.ciphers?.length
                    ? `. Allowed to ${site.ciphers.map((c) => c.replace("nostr.", "").replace(".", " ")).join(", ")} without asking`
                    : ""}
                </span>
              </span>
              <button
                type="button"
                className="icon"
                onClick={async () => {
                  try {
                    await call({ type: "SITE_REMOVE", origin: site.origin });
                    await load();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}

function AutoLock({ minutes, onSaved }: { minutes: number; onSaved: () => void }) {
  return (
    <label>
      Lock automatically after
      <select
        value={minutes}
        onChange={async (e) => {
          await call({ type: "SET_AUTO_LOCK", minutes: Number(e.target.value) });
          onSaved();
        }}
      >
        {[1, 5, 15, 30, 60, 240].map((m) => (
          <option key={m} value={m}>
            {m < 60 ? `${m} minute${m === 1 ? "" : "s"}` : `${m / 60} hour${m === 60 ? "" : "s"}`}{" "}
            of inactivity
          </option>
        ))}
      </select>
    </label>
  );
}

function FiatChoiceSetting() {
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let current = true;
    call({ type: "GET_RATE" }).then(
      (r) => current && setChoice(r.currency),
      (e: unknown) => current && setError(e),
    );
    return () => {
      current = false;
    };
  }, []);
  return (
    <label>
      Show prices in
      <select
        value={choice ?? "USD"}
        disabled={choice === null}
        onChange={async (e) => {
          const next = e.target.value as FiatChoice;
          try {
            await call({ type: "SET_FIAT", currency: next });
            setChoice(next);
            setError(null);
          } catch (err) {
            setError(err);
          }
        }}
      >
        {FIAT_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value="OFF">Off</option>
      </select>
      <ErrorNotice error={error} />
    </label>
  );
}

function RevealPhrase({ onBack }: { onBack: () => void }) {
  const [password, setPassword] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (words) {
    return (
      <Screen title="Recovery phrase" back={onBack}>
        <p className="notice warning">Anyone who sees these words can take your money.</p>
        <ol className="phrase-grid show" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {words.map((word, i) => (
            <li key={i} className="word">
              <span className="n">{i + 1}</span>
              <span className="static">{word}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="wide" onClick={() => setWords(null)}>
          Hide
        </button>
      </Screen>
    );
  }
  return (
    <Screen title="Show recovery phrase" back={onBack}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setWords((await call({ type: "REVEAL_MNEMONIC", password })).mnemonic.split(" "));
            setPassword("");
          } catch (err) {
            setError(err);
          }
        }}
      >
        <p className="muted">
          Enter your password to see the 12 words. Make sure nobody is watching your screen.
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
        <ErrorNotice error={error} />
        <button type="submit" className="primary wide" disabled={!password}>
          Show
        </button>
      </form>
    </Screen>
  );
}

function ChangePassword({ onBack }: { onBack: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const onNext = useCallback((value: string | null) => setNext(value), []);
  return (
    <Screen title="Change password" back={onBack}>
      {done ? (
        <p className="notice ok">The password was changed.</p>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!next) return;
            try {
              await call({ type: "CHANGE_PASSWORD", oldPassword: current, newPassword: next });
              setDone(true);
            } catch (err) {
              setError(err);
            }
          }}
        >
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <NewPassword label="New password" onChange={onNext} />
          <ErrorNotice error={error} />
          <button type="submit" className="primary wide" disabled={!current || !next}>
            Change password
          </button>
        </form>
      )}
    </Screen>
  );
}

function Servers({ onBack }: { onBack: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const load = () => call({ type: "SERVER_HEALTH" }).then(setHealth, setError);
    void load();
    const timer = setInterval(() => void load(), 3_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Screen title="Network servers" back={onBack}>
      <p className="small muted">
        Cashlet uses public servers and moves to another one when a server is down, on the wrong
        chain, behind the others, or reports a node problem.
      </p>
      <PreferredServer />
      <ErrorNotice error={error} />
      <ul className="list">
        {health?.servers.map((s) => (
          <li key={s.url}>
            <span className="stack" style={{ gap: 2 }}>
              <code>{s.url.replace("wss://", "")}</code>
              {s.lastError && <span className="small muted">{s.lastError}</span>}
            </span>
            <span className="small">
              {s.url === health.current ? (
                <span className="tag">In use</span>
              ) : s.state === "cooling" ? (
                "Set aside"
              ) : s.state === "ok" ? (
                "OK"
              ) : (
                "Not tried"
              )}
              {s.tip !== null && <div className="muted">Block {s.tip}</div>}
            </span>
          </li>
        ))}
      </ul>
    </Screen>
  );
}

function Contacts({ network, onBack }: { network: "mainnet" | "chipnet"; onBack: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(
    () => void loadContacts().then((all) => setContacts(all.filter((c) => c.network === network))),
    [network],
  );
  useEffect(reload, [reload]);
  return (
    <Screen title="Address book" back={onBack}>
      <ul className="list">
        {contacts.length === 0 && <li className="muted small">No contacts yet.</li>}
        {contacts.map((c) => (
          <li key={c.id}>
            <span className="stack" style={{ gap: 2 }}>
              <strong>{c.name}</strong>
              <code className="small">{c.address}</code>
            </span>
            <span className="row">
              <CopyButton text={c.address} />
              <button
                type="button"
                className="icon danger"
                onClick={() => void deleteContact(c.id).then(reload)}
              >
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await saveContact(name, address, network);
            setName("");
            setAddress("");
            setError(null);
            reload();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <h3>Add a contact</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Address
          <input spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <ErrorNotice error={error} />
        <button type="submit" className="primary" disabled={!name || !address}>
          Save
        </button>
      </form>
    </Screen>
  );
}

function Wallets({
  status,
  onBack,
  onAddWallet,
  onChanged,
}: {
  status: Status;
  onBack: () => void;
  onAddWallet: () => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<{ kind: "remove" | "adopt"; id: string } | null>(null);
  const [password, setPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const show = (kind: "remove" | "adopt", id: string) => {
    setForm({ kind, id });
    setPassword("");
    setOldPassword("");
    setError(null);
  };
  const target = status.wallets.find((w) => w.id === form?.id);
  return (
    <Screen title="Wallets" back={onBack}>
      <ul className="list">
        {status.wallets.map((w) => (
          <li key={w.id}>
            <span className="stack" style={{ gap: 2 }}>
              <strong>
                {w.name} {w.id === status.activeId && <span className="tag">Open</span>}
              </strong>
              <span className="small muted">
                {w.network === "mainnet" ? "Mainnet" : "Chipnet"}
                {w.needsPassword && " · uses an older password"}
              </span>
            </span>
            <span className="row">
              {w.id !== status.activeId && (
                <button
                  type="button"
                  className="icon"
                  disabled={busy}
                  onClick={async () => {
                    if (w.needsPassword) return show("adopt", w.id);
                    setBusy(true);
                    try {
                      await call({ type: "SWITCH_WALLET", walletId: w.id });
                      onChanged();
                      onBack();
                    } catch (err) {
                      setError(err);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Switch
                </button>
              )}
              <button type="button" className="icon danger" onClick={() => show("remove", w.id)}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      {!form && <ErrorNotice error={error} />}
      {form && target && (
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              if (form.kind === "remove") {
                await call({ type: "REMOVE_WALLET", walletId: form.id, password });
              } else {
                await call({ type: "ADOPT_WALLET", walletId: form.id, oldPassword, password });
              }
              setForm(null);
              onChanged();
              if (form.kind === "adopt") onBack();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          {form.kind === "remove" ? (
            <p className="notice warning">
              Removing {target.name} deletes it from this device. Without its recovery phrase the
              money in it is lost.
            </p>
          ) : (
            <>
              <p className="small muted">
                {target.name} was added with another password. Enter it once and the wallet moves
                over to the Cashlet password.
              </p>
              <label>
                {target.name}&apos;s old password
                <input
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </label>
            </>
          )}
          <label>
            {form.kind === "remove" && target.needsPassword
              ? `${target.name}'s password`
              : "Cashlet password"}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <ErrorNotice error={error} />
          <div className="row">
            <button type="button" className="grow" onClick={() => setForm(null)}>
              Cancel
            </button>
            <button
              type="submit"
              className={form.kind === "remove" ? "danger grow" : "primary grow"}
              disabled={!password || (form.kind === "adopt" && !oldPassword) || busy}
            >
              {form.kind === "remove" ? "Remove" : "Switch"}
            </button>
          </div>
        </form>
      )}
      <button type="button" className="wide" onClick={onAddWallet}>
        Add another wallet
      </button>
    </Screen>
  );
}
