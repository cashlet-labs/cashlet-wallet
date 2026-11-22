import { useEffect, useState } from "react";
import { formatFiat, isFiatCurrency } from "../wallet/rates";
import { call } from "./api";

export interface Quote {
  currency: string;
  /** The price of 1 BCH, or null when it is not known. */
  rate: number | null;
  testCoins: boolean;
}

/** The fiat price, fetched by the service worker. Null until it answers; never blocks the page. */
export function useRate(): Quote | null {
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    let current = true;
    call({ type: "GET_RATE" }).then(
      (r) => current && setQuote({ currency: r.currency, rate: r.rate, testCoins: r.testCoins }),
      () => current && setQuote(null),
    );
    return () => {
      current = false;
    };
  }, []);
  return quote;
}

/** Satoshis as money in the chosen currency, or null when there is no price. */
export function fiatText(quote: Quote | null, sats: number): string | null {
  if (!quote || quote.rate === null || !isFiatCurrency(quote.currency)) return null;
  try {
    return formatFiat(sats, quote.rate, quote.currency);
  } catch {
    return null;
  }
}

/** "≈ $1.23", or nothing when there is no price. */
export function Fiat({ quote, sats }: { quote: Quote | null; sats: number | null }) {
  const text = sats === null ? null : fiatText(quote, sats);
  return text ? <span className="fiat muted">≈ {text}</span> : null;
}
