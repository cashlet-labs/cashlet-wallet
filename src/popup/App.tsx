import { useCallback, useEffect, useState } from "react";
import { call, type Status } from "./api";
import { ErrorNotice, Screen } from "./components/common";
import { poll } from "./errors";
import { Approvals } from "./screens/Approvals";
import { Apps } from "./screens/Apps";
import { Home } from "./screens/Home";
import { Identity } from "./screens/Identity";
import { BackupCheck, CreateWallet, ImportWallet, Welcome } from "./screens/Onboarding";
import { Receive } from "./screens/Receive";
import { Send } from "./screens/Send";
import { Transaction } from "./screens/Transaction";
import { Settings } from "./screens/Settings";
import { Support } from "./screens/Support";
import { currentSurface, openSidePanel, openTab } from "./views";
import { Unlock } from "./screens/Unlock";

type View =
  | "home"
  | "send"
  | "receive"
  | "identity"
  | "apps"
  | "support"
  | "settings"
  | "transaction"
  | "welcome"
  | "create"
  | "import"
  | "backup";

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<View>("home");
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call({ type: "STATUS" }));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  // The service worker opens this page in its own window when a site asks for something.
  const approvalWindow = location.hash === "#approve";
  const approvalsDone = useCallback(() => {
    if (approvalWindow) window.close();
    else void refresh();
  }, [approvalWindow, refresh]);

  // Follows auto-lock and scanning without a reload.
  useEffect(() => poll(refresh, 3_000), [refresh]);

  const go = (next: View) => () => {
    setView(next);
    void refresh();
  };

  let body;
  if (!status) {
    body = (
      <Screen>
        {error ? (
          <ErrorNotice error={error} />
        ) : (
          <p role="status" className="muted">
            Starting…
          </p>
        )}
      </Screen>
    );
  } else if (view === "create") {
    body = (
      <CreateWallet
        unlocked={status.unlocked}
        onDone={go("home")}
        onBack={go(status.wallets.length ? "settings" : "welcome")}
      />
    );
  } else if (view === "import") {
    body = (
      <ImportWallet
        unlocked={status.unlocked}
        onDone={go("home")}
        onBack={go(status.wallets.length && status.unlocked ? "settings" : "welcome")}
      />
    );
  } else if (status.wallets.length === 0 || view === "welcome") {
    body = (
      <Welcome
        onCreate={() => setView("create")}
        onImport={() => setView("import")}
        {...(status.wallets.length > 0 ? { onCancel: go("home") } : {})}
      />
    );
  } else if (!status.unlocked) {
    body = <Unlock status={status} onUnlocked={go("home")} onRestore={() => setView("import")} />;
  } else if (view === "home" && (status.approvals > 0 || approvalWindow)) {
    body = <Approvals onDone={approvalsDone} />;
  } else if (view === "send") {
    body = <Send network={status.network ?? "chipnet"} onBack={go("home")} />;
  } else if (view === "receive") {
    body = <Receive onBack={go("home")} />;
  } else if (view === "identity") {
    body = <Identity onBack={go("home")} />;
  } else if (view === "support") {
    body = <Support onBack={go("home")} />;
  } else if (view === "apps") {
    body = <Apps onBack={go("home")} />;
  } else if (view === "transaction" && txid) {
    body = <Transaction txid={txid} network={status.network ?? "chipnet"} onBack={go("home")} />;
  } else if (view === "settings") {
    body = (
      <Settings
        status={status}
        onBack={go("home")}
        onAddWallet={() => setView("welcome")}
        onChanged={() => void refresh()}
      />
    );
  } else if (view === "backup") {
    body = <BackupFromSettings status={status} onDone={go("home")} />;
  } else {
    body = (
      <Home
        status={status}
        onSend={() => setView("send")}
        onReceive={() => setView("receive")}
        onIdentity={() => setView("identity")}
        onApps={() => setView("apps")}
        onBackup={() => setView("backup")}
        onTransaction={(id) => {
          setTxid(id);
          setView("transaction");
        }}
      />
    );
  }

  const active = status?.wallets.find((w) => w.id === status.activeId);
  const surface = currentSurface();
  return (
    <div className={`app surface-${surface}`}>
      <header className="topbar">
        <span className="brand">
          <span className="mark" aria-hidden="true">
            C
          </span>
          Cashlet
          {status?.unlocked && status.network && (
            <span className={`tag${status.network === "chipnet" ? " test" : ""}`}>
              {status.network === "chipnet" ? "Chipnet" : "Mainnet"}
            </span>
          )}
        </span>
        <span className="row views" aria-label="Wallet view">
          {surface !== "sidepanel" && (
            <button
              type="button"
              className="icon"
              title="Open in the side panel"
              aria-label="Open in the side panel"
              onClick={openSidePanel}
            >
              ◧
            </button>
          )}
          {surface !== "tab" && (
            <button
              type="button"
              className="icon"
              title="Open in a full tab"
              aria-label="Open in a full tab"
              onClick={openTab}
            >
              ⤢
            </button>
          )}
        </span>
        {status?.unlocked && (
          <span className="row">
            {active && <span className="small muted account-name">{active.name}</span>}
            <button
              type="button"
              className="icon"
              onClick={() => setView(view === "settings" ? "home" : "settings")}
            >
              Settings
            </button>
            <button
              type="button"
              className="icon"
              onClick={async () => {
                await call({ type: "LOCK" });
                setView("home");
                void refresh();
              }}
            >
              Lock
            </button>
          </span>
        )}
      </header>
      <main>{body}</main>
      <footer className="support-link">
        <button type="button" className="link" onClick={() => setView("support")}>
          Open source · Support Cashlet
        </button>
      </footer>
    </div>
  );
}

/** Back up an existing wallet: show the phrase after the password, then check it. */
function BackupFromSettings({ status, onDone }: { status: Status; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [words, setWords] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (words && checking && status.activeId) {
    return (
      <BackupCheck
        walletId={status.activeId}
        words={words}
        onDone={onDone}
        onBack={() => setChecking(false)}
      />
    );
  }
  if (words) {
    return (
      <Screen title="Write down your recovery phrase" back={onDone}>
        <ol className="phrase-grid show" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {words.map((word, i) => (
            <li key={i} className="word">
              <span className="n">{i + 1}</span>
              <span className="static">{word}</span>
            </li>
          ))}
        </ol>
        <button type="button" className="primary wide" onClick={() => setChecking(true)}>
          I wrote them down
        </button>
      </Screen>
    );
  }
  return (
    <Screen title="Back up your wallet" back={onDone}>
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
          Show the recovery phrase
        </button>
      </form>
    </Screen>
  );
}
