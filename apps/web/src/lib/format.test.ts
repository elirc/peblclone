import { describe, expect, it } from 'vitest';
import { formatBps, formatBytes, formatDate, humanize, initials } from './format';

describe('formatBps', () => {
  // Found by a builder, not by the author: 2000 bps used to print as "2%".
  it.each([
    [2000, '20%'],
    [1000, '10%'],
    [100, '1%'],
    [0, '0%'],
    [2150, '21.5%'],
    [925, '9.25%'],
    [25, '0.25%'],
    [10_000, '100%'],
  ])('%i bps -> %s', (bps, expected) => {
    expect(formatBps(bps)).toBe(expected);
  });
});

describe('other formatters', () => {
  it('formats a calendar date without shifting it across timezones', () => {
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatDate(null)).toBe('—');
  });
  it('humanizes enum values and action names', () => {
    expect(humanize('pending_approval')).toBe('Pending approval');
    expect(humanize('payroll_run.approved')).toBe('Payroll run approved');
  });
  it('builds initials and byte sizes', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});
