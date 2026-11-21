/** Satoshis per BCH. */
export const SATS_PER_BCH = 100_000_000;
const MAX_SATS = 21_000_000 * SATS_PER_BCH;

/**
 * Parse a BCH amount typed by a user or found in a payment URI, such as "0.01",
 * into satoshis. Exact decimal parsing, no floating point: at most 8 decimals,
 * no signs, exponents or separators.
 */
export function parseBch(text: string): number {
  const match = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(text.trim());
  if (!match) throw new RangeError("enter an amount like 0.01, with at most 8 decimals");
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(8, "0"));
  const sats = whole * SATS_PER_BCH + fraction;
  if (sats > MAX_SATS) throw new RangeError("that is more BCH than will ever exist");
  return sats;
}

/** Format satoshis as BCH with up to 8 decimals and no trailing zeros. */
export function formatBch(sats: number): string {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new RangeError("invalid amount");
  const whole = Math.floor(sats / SATS_PER_BCH);
  const fraction = String(sats % SATS_PER_BCH)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
