/**
 * Money rules for the whole codebase:
 *
 * 1. Amounts are integers in MINOR units (cents, pence, centavos). Never floats.
 *    0.1 + 0.2 !== 0.3 in IEEE-754, and payroll is the last place to find that out.
 * 2. An amount is meaningless without its currency; they always travel together.
 * 3. Percentages are basis points (bps): 1 bp = 0.01%, so 21.5% = 2150 bps.
 * 4. Rounding happens in exactly one place (`roundHalfUp`) so it is consistent.
 */

export const BPS_DENOMINATOR = 10_000;

/** Round to the nearest integer, halves away from zero (the convention payroll uses). */
export function roundHalfUp(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** `rateBps` basis points of `amountMinor`, rounded to a whole minor unit. */
export function applyBps(amountMinor: number, rateBps: number): number {
  return roundHalfUp((amountMinor * rateBps) / BPS_DENOMINATOR);
}

/**
 * Split an annual amount into its amount for one month.
 * Rounds per month; the sub-cent drift over a year is accepted and documented (ADR 0003).
 */
export function monthlyFromAnnual(annualMinor: number): number {
  return roundHalfUp(annualMinor / 12);
}

/**
 * Convert between currencies given "units of currency per 1 USD" rates.
 * Rates arrive as decimal strings from Postgres `numeric`; we multiply as numbers,
 * which is fine at invoice magnitudes (well inside 2^53) and round once at the end.
 */
export function convertMinor(amountMinor: number, fromPerUsd: string, toPerUsd: string): number {
  const from = Number(fromPerUsd);
  const to = Number(toPerUsd);
  if (!(from > 0) || !(to > 0)) throw new Error('FX rate must be a positive number');
  return roundHalfUp((amountMinor / from) * to);
}

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP']);

export function minorUnitDigits(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
}

/** Human-readable money, e.g. formatMoney(123456, 'EUR') -> "€1,234.56". */
export function formatMoney(amountMinor: number, currency: string, locale = 'en-US'): string {
  const digits = minorUnitDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

/** Parse what a human typed ("1,234.50") into minor units. Returns null if not a number. */
export function parseMoneyToMinor(input: string, currency: string): number | null {
  const cleaned = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return roundHalfUp(Number(cleaned) * 10 ** minorUnitDigits(currency));
}
