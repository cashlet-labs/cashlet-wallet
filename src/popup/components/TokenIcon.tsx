import type { TokenMetaEntry } from "../../shared/messages";

export function TokenIcon({ meta }: { meta: TokenMetaEntry | undefined }) {
  return meta?.icon ? (
    <img className="token-icon" src={meta.icon} alt="" width={28} height={28} />
  ) : (
    <span className="token-icon token-icon-empty" aria-hidden="true" />
  );
}
