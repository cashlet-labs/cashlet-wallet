import type { ResponseFor } from "../../shared/messages";

type Approval = Extract<ResponseFor["APPROVALS_LIST"], { ok: true }>["approvals"][number];

/** A site asks to encrypt a message to someone, or to read one from them, with the Nostr key. */
export function CipherDetails({ approval }: { approval: Approval }) {
  const cipher = approval.cipher;
  if (!cipher) return null;
  const scheme = cipher.scheme === "nip04" ? "NIP-04" : "NIP-44";
  return (
    <div className="card stack" data-testid="cipher-request">
      {approval.type === "encrypt" ? (
        <span>This site asks you to encrypt a message to this Nostr key ({scheme}).</span>
      ) : (
        <span>
          This site asks to read a message from this Nostr key ({scheme}). It will see the text.
        </span>
      )}
      <span className="small muted">{approval.type === "encrypt" ? "To" : "From"}</span>
      <code data-testid="cipher-peer">{cipher.peer}</code>
      {cipher.plaintext !== null && (
        <>
          <span className="small muted">Message</span>
          <pre className="event-content" data-testid="cipher-plaintext">
            {cipher.plaintext}
          </pre>
        </>
      )}
    </div>
  );
}
