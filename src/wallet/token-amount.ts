/** The most tokens one output can hold. */
const MAX_TOKEN_AMOUNT = 2n ** 63n - 1n;

/**
 * Show a raw token amount (a whole number of the smallest unit) with the
 * token's decimals, such as "1,234.5". Exact: no floating point.
 */
export function formatTokenAmount(raw: string | bigint, decimals: number): string {
  const units = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = (units / scale).toLocaleString("en-US");
  const fraction = decimals === 0 ? "" : (units % scale).toString().padStart(decimals, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/**
 * Parse an amount typed by the user, such as "1.5", into raw units. At most
 * `decimals` decimals, no signs, exponents or separators, more than zero and
 * no more than a token output can hold.
 */
export function parseTokenAmount(text: string, decimals: number): bigint {
  const match = /^(\d{1,19})(?:\.(\d+))?$/.exec(text.trim());
  if (!match) throw new RangeError("enter an amount like 1.5");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError(
      decimals === 0
        ? "this token has no decimals: enter a whole number"
        : `this token has at most ${decimals} decimal${decimals === 1 ? "" : "s"}`,
    );
  }
  const units = BigInt(match[1]! + fraction.padEnd(decimals, "0"));
  if (units === 0n) throw new RangeError("enter an amount above zero");
  if (units > MAX_TOKEN_AMOUNT) throw new RangeError("that is more than one output can hold");
  return units;
}
