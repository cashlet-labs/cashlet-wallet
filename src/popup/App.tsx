import { useEffect, useState } from "react";
import { send } from "../shared/client";

type Status =
  { state: "checking" } | { state: "ready"; kind: number } | { state: "error"; message: string };

export function App() {
  const [status, setStatus] = useState<Status>({ state: "checking" });

  useEffect(() => {
    send({ type: "PING" }).then(
      (response) =>
        setStatus(
          response.ok
            ? { state: "ready", kind: response.bindingKind }
            : { state: "error", message: response.error },
        ),
      (error: unknown) =>
        setStatus({
          state: "error",
          message: error instanceof Error ? error.message : "unknown error",
        }),
    );
  }, []);

  return (
    <main className="shell">
      <h1>Cashlet</h1>
      <p className="muted">In development. Not ready for real funds.</p>
      <p role="status">
        {status.state === "checking" && "Starting…"}
        {status.state === "ready" && `Wallet service running · BND binding kind ${status.kind}`}
        {status.state === "error" && `Wallet service unavailable: ${status.message}`}
      </p>
    </main>
  );
}
