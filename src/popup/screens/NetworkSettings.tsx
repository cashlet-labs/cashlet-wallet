import { useEffect, useState } from "react";
import type { ResponseFor } from "../../shared/messages";
import { call } from "../api";
import { ErrorNotice } from "../components/common";

type NetworkSettings = Extract<ResponseFor["GET_NETWORK_SETTINGS"], { ok: true }>;

function useNetworkSettings() {
  const [settings, setSettings] = useState<NetworkSettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => call({ type: "GET_NETWORK_SETTINGS" }).then(setSettings, setError);
  useEffect(() => {
    void load();
  }, []);
  return { settings, error, setError, load };
}

/** The fee rate paid on sends: automatic, or a fixed number of satoshis per byte. */
export function FeeRate() {
  const { settings, error, setError, load } = useNetworkSettings();
  if (!settings) return <ErrorNotice error={error} />;
  const rates = Array.from(
    { length: settings.maxFeeRate - settings.minFeeRate + 1 },
    (_, i) => settings.minFeeRate + i,
  );
  return (
    <label>
      Fee rate
      <select
        value={settings.feeRate ?? "auto"}
        onChange={async (e) => {
          try {
            await call({
              type: "SET_FEE_RATE",
              rate: e.target.value === "auto" ? null : Number(e.target.value),
            });
            await load();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <option value="auto">Automatic</option>
        {rates.map((r) => (
          <option key={r} value={r}>
            {r} sat/byte
          </option>
        ))}
      </select>
      <span className="small muted">
        Automatic pays what the server asks for, at least {settings.minFeeRate} sat/byte. A higher
        rate costs more. The most you can set is {settings.maxFeeRate} sat/byte.
      </span>
      <ErrorNotice error={error} />
    </label>
  );
}

/** Which built-in server is tried first on this wallet's network. */
export function PreferredServer() {
  const { settings, error, setError, load } = useNetworkSettings();
  const [saved, setSaved] = useState(false);
  if (!settings) return <ErrorNotice error={error} />;
  return (
    <label>
      Preferred server
      <select
        value={settings.preferredServer ?? "auto"}
        onChange={async (e) => {
          try {
            await call({
              type: "SET_PREFERRED_SERVER",
              network: settings.network,
              url: e.target.value === "auto" ? null : e.target.value,
            });
            setSaved(true);
            await load();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <option value="auto">Automatic</option>
        {settings.servers.map((url) => (
          <option key={url} value={url}>
            {url.replace("wss://", "")}
          </option>
        ))}
      </select>
      <span className="small muted">
        Custom servers are not possible: the extension may only connect to the servers in this list.
        If the preferred server is down, Cashlet moves to another one.
      </span>
      {saved && <span className="small muted">Used the next time you unlock.</span>}
      <ErrorNotice error={error} />
    </label>
  );
}
