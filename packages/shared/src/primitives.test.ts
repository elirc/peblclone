import { describe, expect, it } from 'vitest';
import { addDays, countBusinessDays, isIsoDate, lastDayOfMonth, rangesOverlap } from './dates';
import { applyBps, convertMinor, formatMoney, parseMoneyToMinor, roundHalfUp } from './money';
import { createTimeOffRequestSchema, emailSchema, registerSchema } from './schemas';
import {
  canTransition,
  isTerminal,
  PAYROLL_RUN_TRANSITIONS,
  WORKER_TRANSITIONS,
} from './state-machines';

describe('money', () => {
  it('rounds halves away from zero', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.4)).toBe(1);
    expect(roundHalfUp(-0.5)).toBe(-1);
  });
  it('applies basis points', () => {
    expect(applyBps(100_000, 2150)).toBe(21_500);
    expect(applyBps(333, 5000)).toBe(167); // 166.5 rounds up
  });
  it('converts through USD', () => {
    const usd = { currency: 'USD', perUsd: '1' };
    // 920 EUR -> USD at 0.92 EUR per USD = 1000 USD
    expect(convertMinor(92_000, { currency: 'EUR', perUsd: '0.92' }, usd)).toBe(100_000);
    expect(() => convertMinor(1, { currency: 'EUR', perUsd: '0' }, usd)).toThrow();
  });
  it('accounts for currencies with no minor unit (yen)', () => {
    const usd = { currency: 'USD', perUsd: '1' };
    const jpy = { currency: 'JPY', perUsd: '151' };
    // 151,000 yen is $1,000.00 = 100,000 cents. (Not 1,000 cents: yen has no "cents".)
    expect(convertMinor(151_000, jpy, usd)).toBe(100_000);
    // ...and back: $1,000.00 is 151,000 yen.
    expect(convertMinor(100_000, usd, jpy)).toBe(151_000);
  });
  it('formats and parses', () => {
    expect(formatMoney(123_456, 'USD')).toBe('$1,234.56');
    expect(formatMoney(5000, 'JPY')).toBe('¥5,000');
    expect(parseMoneyToMinor('1,234.50', 'USD')).toBe(123_450);
    expect(parseMoneyToMinor('abc', 'USD')).toBeNull();
  });
});

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('28/02/2026')).toBe(false);
  });
  it('counts business days inclusively', () => {
    expect(countBusinessDays('2026-06-01', '2026-06-05')).toBe(5); // Mon–Fri
    expect(countBusinessDays('2026-06-05', '2026-06-08')).toBe(2); // Fri + Mon
    expect(countBusinessDays('2026-06-06', '2026-06-07')).toBe(0); // weekend
  });
  it('detects overlapping ranges, including touching ends', () => {
    expect(rangesOverlap('2026-01-01', '2026-01-05', '2026-01-05', '2026-01-09')).toBe(true);
    expect(rangesOverlap('2026-01-01', '2026-01-04', '2026-01-05', '2026-01-09')).toBe(false);
  });
  it('handles month ends and leap years', () => {
    expect(lastDayOfMonth(2024, 2)).toBe('2024-02-29');
    expect(lastDayOfMonth(2026, 2)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('state machines', () => {
  it('allows only listed transitions', () => {
    expect(canTransition(WORKER_TRANSITIONS, 'onboarding', 'active')).toBe(true);
    expect(canTransition(WORKER_TRANSITIONS, 'onboarding', 'terminated')).toBe(false);
    expect(canTransition(PAYROLL_RUN_TRANSITIONS, 'draft', 'paid')).toBe(false);
    expect(canTransition(PAYROLL_RUN_TRANSITIONS, 'pending_approval', 'draft')).toBe(true);
  });
  it('knows terminal states', () => {
    expect(isTerminal(WORKER_TRANSITIONS, 'terminated')).toBe(true);
    expect(isTerminal(WORKER_TRANSITIONS, 'active')).toBe(false);
  });
});

describe('schemas', () => {
  it('normalises email', () => {
    expect(emailSchema.parse('  Ada@Example.COM ')).toBe('ada@example.com');
  });
  it('rejects short passwords and bad country codes', () => {
    const result = registerSchema.safeParse({
      organizationName: 'Acme',
      countryCode: 'USA',
      fullName: 'Ada',
      email: 'ada@example.com',
      password: 'short',
    });
    expect(result.success).toBe(false);
  });
  it('rejects a time-off range that ends before it starts', () => {
    const result = createTimeOffRequestSchema.safeParse({
      type: 'vacation',
      startDate: '2026-06-10',
      endDate: '2026-06-01',
    });
    expect(result.success).toBe(false);
  });
});
