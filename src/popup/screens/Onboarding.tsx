import { useCallback, useMemo, useState } from "react";
import { call } from "../api";
import { ErrorNotice, NetworkChoice, NewPassword, Screen } from "../components/common";
import { PhraseInput } from "../components/PhraseInput";
import { backupQuestions, checkPhrase, completion, type PhraseLength } from "../phrase";

type Network = "mainnet" | "chipnet";

export function Welcome({
  onCreate,
  onImport,
  onCancel,
}: {
  onCreate: () => void;
  onImport: () => void;
  onCancel?: () => void;
}) {
  return (
    <Screen {...(onCancel ? { back: onCancel } : {})}>
      <div className="stack" style={{ marginTop: 24 }}>
        <h1>Your keys, your Bitcoin Cash</h1>
        <p className="muted">
          Cashlet keeps your recovery phrase encrypted on this device. Nobody else, including us,
          can move your money.
        </p>
      </div>
      <div className="stack" style={{ marginTop: "auto" }}>
        <button type="button" className="primary wide" onClick={onCreate}>
          Create a new wallet
        </button>
        <button type="button" className="wide" onClick={onImport}>
          I already have a recovery phrase
        </button>
      </div>
    </Screen>
  );
}

/** Create: password, then the new phrase, then a check that it was written down. */
export function CreateWallet({
  onDone,
  onBack,
  unlocked = false,
}: {
  onDone: () => void;
  onBack: () => void;
  /** Adding a wallet while unlocked: it takes the Cashlet password. */
  unlocked?: boolean;
}) {
  const [step, setStep] = useState<"password" | "phrase" | "check">("password");
  const [network, setNetwork] = useState<Network>("mainnet");
  const [password, setPassword] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; words: string[] } | null>(null);
  const [savedIt, setSavedIt] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const onPassword = useCallback((value: string | null) => setPassword(value), []);

  if (step === "password") {
    return (
      <Screen title="Create a wallet" back={onBack}>
        <NetworkChoice value={network} onChange={setNetwork} />
        <PasswordFields unlocked={unlocked} onChange={onPassword} />
        <p className="small muted">
          One password unlocks Cashlet and all its wallets on this device. The recovery phrase
          restores this wallet anywhere.
        </p>
        <ErrorNotice error={error} />
        <button
          type="button"
          className="primary wide"
          disabled={!password || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const result = await call({ type: "CREATE_WALLET", password: password!, network });
              setCreated({ id: result.id, words: result.mnemonic.split(" ") });
              setStep("phrase");
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Continue
        </button>
      </Screen>
    );
  }

  if (step === "phrase" && created) {
    return (
      <Screen title="Write down your recovery phrase">
        <p className="notice warning">
          Write these 12 words on paper, in order, and keep them somewhere safe. Anyone with them
          can take your money. Never type them into a website.
        </p>
        <ol
          className="phrase-grid show"
          aria-label="Your recovery phrase"
          style={{ margin: 0, padding: 0, listStyle: "none" }}
        >
          {created.words.map((word, i) => (
            <li key={i} className="word">
              <span className="n">{i + 1}</span>
              <span className="static">{word}</span>
            </li>
          ))}
        </ol>
        <label className="check">
          <input type="checkbox" checked={savedIt} onChange={(e) => setSavedIt(e.target.checked)} />
          I wrote the words down, in order
        </label>
        <button
          type="button"
          className="primary wide"
          disabled={!savedIt}
          onClick={() => setStep("check")}
        >
          Continue
        </button>
      </Screen>
    );
  }

  return created ? (
    <BackupCheck
      walletId={created.id}
      words={created.words}
      onDone={onDone}
      onBack={() => setStep("phrase")}
    />
  ) : null;
}

/** Ask for three words of the phrase before marking the wallet as backed up. */
export function BackupCheck({
  walletId,
  words,
  onDone,
  onBack,
}: {
  walletId: string;
  words: string[];
  onDone: () => void;
  onBack: () => void;
}) {
  const questions = useMemo(() => backupQuestions(words.length), [words]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<unknown>(null);
  const correct = questions.every(
    (n) => (completion(answers[n] ?? "") ?? answers[n]) === words[n - 1],
  );
  const filled = questions.every((n) => (answers[n] ?? "").length > 0);

  return (
    <Screen title="Check your backup" back={onBack}>
      <p className="muted">Enter these words from your paper copy.</p>
      {questions.map((n) => (
        <label key={n}>
          Word {n}
          <input
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={answers[n] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [n]: e.target.value.trim().toLowerCase() })}
          />
        </label>
      ))}
      {filled && !correct && (
        <p className="notice error">At least one word does not match. Check your paper copy.</p>
      )}
      <ErrorNotice error={error} />
      <button
        type="button"
        className="primary wide"
        disabled={!correct}
        onClick={async () => {
          try {
            await call({ type: "CONFIRM_BACKUP", walletId });
            onDone();
          } catch (e) {
            setError(e);
          }
        }}
      >
        Finish
      </button>
    </Screen>
  );
}

/** Import: the phrase word by word, then a password. */
export function ImportWallet({
  onDone,
  onBack,
  unlocked = false,
}: {
  onDone: () => void;
  onBack: () => void;
  unlocked?: boolean;
}) {
  const [length, setLength] = useState<PhraseLength>(12);
  const [words, setWords] = useState<string[]>(() => Array.from({ length: 12 }, () => ""));
  const [network, setNetwork] = useState<Network>("mainnet");
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const check = checkPhrase(words);
  // A word still being typed is not reported as unknown.
  const unknown =
    check.state === "unknown-words" ? check.positions.filter((p) => p - 1 !== active) : [];
  const onPassword = useCallback((value: string | null) => setPassword(value), []);

  const changeLength = (next: PhraseLength) => {
    setLength(next);
    setWords((current) => Array.from({ length: next }, (_, i) => current[i] ?? ""));
  };

  return (
    <Screen title="Restore a wallet" back={onBack}>
      <div className="row spread">
        <span className="small muted">Type each word, or paste the whole phrase.</span>
        <select
          aria-label="Number of words"
          value={length}
          onChange={(e) => changeLength(Number(e.target.value) as PhraseLength)}
          style={{ width: "auto" }}
        >
          <option value={12}>12 words</option>
          <option value={24}>24 words</option>
        </select>
      </div>
      <PhraseInput words={words} onChange={setWords} onActiveChange={setActive} />
      {unknown.length > 0 && (
        <p className="notice error">
          {unknown.length === 1 ? "Word" : "Words"} {unknown.join(", ")}{" "}
          {unknown.length === 1 ? "is" : "are"} not on the recovery word list.
        </p>
      )}
      {check.state === "bad-checksum" && (
        <p className="notice error">
          These words are not a valid recovery phrase. Check their order and spelling.
        </p>
      )}
      {check.state === "valid" && <p className="notice ok">The recovery phrase is valid.</p>}
      <NetworkChoice value={network} onChange={setNetwork} />
      <PasswordFields unlocked={unlocked} onChange={onPassword} />
      <ErrorNotice error={error} />
      <button
        type="button"
        className="primary wide"
        disabled={check.state !== "valid" || !password || busy}
        onClick={async () => {
          if (check.state !== "valid" || !password) return;
          setBusy(true);
          setError(null);
          try {
            await call({ type: "IMPORT_WALLET", mnemonic: check.phrase, password, network });
            onDone();
          } catch (e) {
            setError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Restore wallet
      </button>
    </Screen>
  );
}

/** A new password for the first wallet, or the Cashlet password when adding another. */
function PasswordFields({
  unlocked,
  onChange,
}: {
  unlocked: boolean;
  onChange: (password: string | null) => void;
}) {
  const [current, setCurrent] = useState("");
  if (!unlocked) return <NewPassword onChange={onChange} />;
  return (
    <label>
      Cashlet password
      <input
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => {
          setCurrent(e.target.value);
          onChange(e.target.value || null);
        }}
      />
    </label>
  );
}
