import { useEffect, useMemo, useState } from "react";
import type { TokenMetaEntry } from "../shared/messages";
import { formatTokenAmount } from "../wallet/token-amount";
import { call } from "./api";

export type TokenMetaMap = Map<string, TokenMetaEntry>;

const RETRY_MS = 2_000;
const MAX_RETRIES = 30;

/**
 * Names and icons for token categories. Starts empty and fills in as the
 * service finds them; the screen never waits for it.
 */
export function useTokenMeta(categories: string[]): TokenMetaMap {
  const [found, setFound] = useState<TokenMetaMap>(new Map());
  const key = categories.join(",");
  const wanted = useMemo(() => (key ? key.split(",") : []), [key]);
  useEffect(() => {
    if (wanted.length === 0) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const load = async () => {
      try {
        const { tokens } = await call({ type: "GET_TOKEN_META", categories: wanted });
        if (!alive) return;
        setFound(new Map(tokens.map((t) => [t.category, t])));
        if (tokens.some((t) => t.state === "pending") && ++tries < MAX_RETRIES)
          timer = setTimeout(() => void load(), RETRY_MS);
      } catch {
        // The short id is shown instead.
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wanted]);
  return found;
}

export const shortId = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-6)}`;

/** The token's name, or its short id while the name is not known. */
export function tokenName(category: string, meta: TokenMetaEntry | undefined): string {
  return meta?.name ?? shortId(category);
}

/** A raw amount with the token's decimals, and its symbol when it has one. */
export function tokenAmountText(raw: string, meta: TokenMetaEntry | undefined): string {
  const amount = formatTokenAmount(raw, meta?.decimals ?? 0);
  return meta?.symbol ? `${amount} ${meta.symbol}` : amount;
}

/** Counts of the NFTs held, by the type names the registry gives. */
export function nftSummary(
  nfts: { commitment: string }[],
  meta: TokenMetaEntry | undefined,
): string {
  const counts = new Map<string, number>();
  for (const nft of nfts) {
    const name = meta?.nftTypes.find((t) => t.commitment === nft.commitment)?.name;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
}
