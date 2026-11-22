import { SATS_PER_BCH } from "./amount";
import type { KeyValueStore } from "./session";

/** Currencies offered in Settings. Both rate sources quote all of them. */
export const FIAT_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "KES",
  "NGN",
  "INR",
  "BRL",
  "JPY",
  "CNY",
  "CAD",
  "AUD",
  "ZAR",
] as const;
export type FiatCurrency = (typeof FIAT_CURRENCIES)[number];

/** The choice stored in settings: a currency, or "OFF" for no prices. */
export type FiatChoice = FiatCurrency | "OFF";
export const DEFAULT_FIAT: FiatChoice = "USD";

export function isFiatCurrency(value: unknown): value is FiatCurrency {
  return typeof value === "string" && (FIAT_CURRENCIES as readonly string[]).includes(value);
}

export function isFiatChoice(value: unknown): value is FiatChoice {
  return value === "OFF" || isFiatCurrency(value);
}

/** Rate sources, tried in order. Both hosts are listed in the manifest's connect-src. */
export const RATE_URLS = [
  "https://bitpay.com/api/rates/BCH",
  "https://api.coinbase.com/v2/exchange-rates?currency=BCH",
] as const;
export const RATE_ORIGINS = RATE_URLS.map((url) => new URL(url).origin);

export const RATE_TTL_MS = 5 * 60_000;
/** A failed refresh may fall back to a rate this old. */
export const RATE_STALE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
const MIN_RATE = 0.01;
const MAX_RATE = 1e9;

export type Rates = Partial<Record<FiatCurrency, number>>;

function sane(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE ? n : null;
}

function pick(entries: Iterable<[unknown, unknown]>): Rates {
  const rates: Rates = {};
  for (const [code, rate] of entries) {
    const n = sane(rate);
    if (isFiatCurrency(code) && n !== null) rates[code] = n;
  }
  return rates;
}

/** Read BCH prices from a source's JSON. Ignores bad entries; throws if USD is missing. */
export function parseRates(url: string, body: unknown): Rates {
  let rates: Rates = {};
  if (url.startsWith(RATE_URLS[0]) && Array.isArray(body)) {
    rates = pick(
      body.map((r): [unknown, unknown] => {
        const row = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
        return [row.code, row.rate];
      }),
    );
  } else if (typeof body === "object" && body !== null) {
    const data = (body as { data?: { currency?: unknown; rates?: unknown } }).data;
    if (data?.currency === "BCH" && typeof data.rates === "object" && data.rates !== null) {
      rates = pick(Object.entries(data.rates));
    }
  }
  if (rates.USD === undefined) throw new Error("no usable rates");
  return rates;
}

interface Cached {
  rates: Rates;
  fetchedAt: number;
}

const CACHE_KEY = "fiatRates";
const CHOICE_KEY = "fiatCurrency";

export interface RateDeps {
  settings: KeyValueStore;
  fetch?: typeof fetch;
  now?: () => number;
}

/** BCH prices from public rate sources, cached for a few minutes. Runs in the service worker. */
export class RateService {
  private pending: Promise<Cached | null> | null = null;

  constructor(private readonly deps: RateDeps) {}

  async choice(): Promise<FiatChoice> {
    const stored = await this.deps.settings.get<unknown>(CHOICE_KEY);
    return isFiatChoice(stored) ? stored : DEFAULT_FIAT;
  }

  async setChoice(choice: FiatChoice): Promise<void> {
    await this.deps.settings.set(CHOICE_KEY, choice);
  }

  /** The price of 1 BCH in the chosen currency, or null when none is known. Never throws. */
  async rate(currency: FiatCurrency): Promise<{ rate: number | null; fetchedAt: number | null }> {
    const cached = await this.refresh();
    const rate = cached?.rates[currency];
    return rate === undefined || !cached
      ? { rate: null, fetchedAt: null }
      : { rate, fetchedAt: cached.fetchedAt };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private refresh(): Promise<Cached | null> {
    this.pending ??= this.load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(): Promise<Cached | null> {
    const stored = await this.deps.settings.get<Cached>(CACHE_KEY);
    const saved =
      stored && typeof stored.fetchedAt === "number" && typeof stored.rates === "object"
        ? stored
        : null;
    const age = saved ? this.now() - saved.fetchedAt : Infinity;
    if (saved && age >= 0 && age < RATE_TTL_MS) return saved;
    const fresh = await this.fetchAny();
    if (fresh) {
      const cached = { rates: fresh, fetchedAt: this.now() };
      await this.deps.settings.set(CACHE_KEY, cached);
      return cached;
    }
    return saved && age >= 0 && age < RATE_STALE_MS ? saved : null;
  }

  private async fetchAny(): Promise<Rates | null> {
    const doFetch = this.deps.fetch ?? fetch;
    for (const url of RATE_URLS) {
      try {
        const response = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!response.ok) continue;
        return parseRates(url, await response.json());
      } catch {
        // Try the next source.
      }
    }
    return null;
  }
}

/** Format satoshis as money, such as "$1.23". Tiny amounts show as "< $0.01". */
export function formatFiat(sats: number, rate: number, currency: FiatCurrency): string {
  const value = (sats / SATS_PER_BCH) * rate;
  const money = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const cent = 10 ** -(money.resolvedOptions().maximumFractionDigits ?? 2);
  if (value > 0 && value < cent) return `< ${money.format(cent)}`;
  return money.format(value);
}
