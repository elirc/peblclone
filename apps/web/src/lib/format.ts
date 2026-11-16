import { formatMoney } from '@meridian/shared';

export { formatMoney };

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});
const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A calendar date (`YYYY-MM-DD`) -> "Jan 5, 2026". Formatted in UTC so it never shifts a day. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  return dateFormatter.format(new Date(`${date.slice(0, 10)}T00:00:00Z`));
}

/** An instant (ISO timestamp) -> "Jan 5, 2026, 3:04 PM" in the viewer's timezone. */
export function formatDateTime(timestamp: string | null | undefined): string {
  if (!timestamp) return '—';
  return dateTimeFormatter.format(new Date(timestamp));
}

/** 2150 -> "21.5%" */
export function formatBps(bps: number): string {
  // Whole percentages print with no decimals; otherwise up to two, without a trailing zero.
  // (An earlier version stripped a trailing zero from whole numbers too: 20% became '2%'.)
  const percent = bps / 100;
  const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/0$/, '');
  return `${text}%`;
}

/** 'pending_approval' -> 'Pending approval' */
export function humanize(value: string): string {
  const spaced = value.replace(/[_.]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function fullName(person: { firstName: string; lastName: string }): string {
  return `${person.firstName} ${person.lastName}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Today's date as YYYY-MM-DD in the viewer's local timezone (for date inputs). */
export function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}
