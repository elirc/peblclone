/**
 * Calendar-date helpers. A "date" here is a plain `YYYY-MM-DD` string — a day
 * on a calendar, with no time and no timezone. We do arithmetic in UTC so the
 * server's local timezone can never shift a start date by a day.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function toUtc(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = toUtc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Monday–Friday days in the inclusive range. Public holidays are out of scope (see journal). */
export function countBusinessDays(startDate: string, endDate: string): number {
  const end = toUtc(endDate).getTime();
  let count = 0;
  for (let d = toUtc(startDate); d.getTime() <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

/** Do two inclusive date ranges share at least one day? */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export function firstDayOfMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function lastDayOfMonth(year: number, month: number): string {
  return toIsoDate(new Date(Date.UTC(year, month, 0)));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Inclusive number of calendar days between two dates. */
export function daysBetweenInclusive(startDate: string, endDate: string): number {
  return Math.round((toUtc(endDate).getTime() - toUtc(startDate).getTime()) / 86_400_000) + 1;
}

export function formatPeriod(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
