import { describe, expect, it } from 'vitest';
import {
  annualSalaryOf,
  calculateEmploymentCost,
  calculatePayslip,
  grossForPeriod,
  leaveEntitlementForYear,
  type ContributionRule,
} from './calc';

const employer: ContributionRule[] = [
  { key: 'pension', name: 'Pension', rateBps: 930, annualCapMinor: 9_000_000 },
  { key: 'health', name: 'Health', rateBps: 730 },
];
const employee: ContributionRule[] = [{ key: 'income_tax', name: 'Income tax', rateBps: 2000 }];

describe('calculateEmploymentCost', () => {
  it('adds uncapped and capped employer contributions on top of salary', () => {
    const result = calculateEmploymentCost({
      countryCode: 'DE',
      currency: 'EUR',
      annualSalaryMinor: 6_000_000, // €60,000.00, under the pension cap
      employerContributions: employer,
      employeeDeductions: employee,
      monthlyFeeUsdMinor: 59_900,
    });
    expect(result.monthlySalaryMinor).toBe(500_000);
    // pension 9.3% of 60k = 5,580.00 ; health 7.3% of 60k = 4,380.00
    expect(result.employerContributions.map((l) => l.annualMinor)).toEqual([558_000, 438_000]);
    expect(result.annualEmployerCostMinor).toBe(996_000);
    expect(result.annualTotalMinor).toBe(6_996_000);
    expect(result.monthlyTotalMinor).toBe(500_000 + 46_500 + 36_500);
    expect(result.monthlyNetMinor).toBe(500_000 - 100_000);
    expect(result.monthlyFeeUsdMinor).toBe(59_900);
  });

  it('stops charging a capped contribution above the cap', () => {
    const result = calculateEmploymentCost({
      countryCode: 'DE',
      currency: 'EUR',
      annualSalaryMinor: 12_000_000, // €120,000.00, above the €90,000 cap
      employerContributions: employer,
      employeeDeductions: [],
      monthlyFeeUsdMinor: 0,
    });
    expect(result.employerContributions[0]?.annualMinor).toBe(837_000); // 9.3% of 90k
    expect(result.employerContributions[1]?.annualMinor).toBe(876_000); // 7.3% of 120k
  });
});

describe('grossForPeriod', () => {
  const base = { salaryMinor: 6_000_000, payBasis: 'annual' as const, endDate: null };

  it('pays a full month when employed for the whole period', () => {
    expect(grossForPeriod({ ...base, startDate: '2025-01-01', year: 2026, month: 3 })).toEqual({
      grossMinor: 500_000,
      daysWorked: 31,
      daysInPeriod: 31,
    });
  });

  it('prorates by calendar days for a mid-month start', () => {
    // starts 16 June: 15 of 30 days
    expect(grossForPeriod({ ...base, startDate: '2026-06-16', year: 2026, month: 6 })).toEqual({
      grossMinor: 250_000,
      daysWorked: 15,
      daysInPeriod: 30,
    });
  });

  it('prorates for a mid-month end date', () => {
    const r = grossForPeriod({
      ...base,
      startDate: '2025-01-01',
      endDate: '2026-02-14',
      year: 2026,
      month: 2,
    });
    expect(r.daysWorked).toBe(14);
    expect(r.grossMinor).toBe(250_000); // 14/28
  });

  it('pays nothing before the start date or after the end date', () => {
    expect(grossForPeriod({ ...base, startDate: '2026-07-01', year: 2026, month: 6 }).grossMinor).toBe(0);
    expect(
      grossForPeriod({ ...base, startDate: '2025-01-01', endDate: '2026-01-31', year: 2026, month: 2 })
        .daysWorked,
    ).toBe(0);
  });

  it('uses a monthly salary as-is', () => {
    expect(
      grossForPeriod({
        salaryMinor: 300_000,
        payBasis: 'monthly',
        startDate: '2025-01-01',
        endDate: null,
        year: 2026,
        month: 1,
      }).grossMinor,
    ).toBe(300_000);
    expect(annualSalaryOf(300_000, 'monthly')).toBe(3_600_000);
  });
});

describe('calculatePayslip', () => {
  it('computes net pay and total client cost for an employee', () => {
    const slip = calculatePayslip({
      workerType: 'employee',
      grossMinor: 500_000,
      employerContributions: employer,
      employeeDeductions: employee,
      reimbursementsMinor: 12_345,
    });
    expect(slip.deductionsMinor).toBe(100_000);
    expect(slip.employerCostMinor).toBe(46_500 + 36_500);
    expect(slip.netMinor).toBe(500_000 - 100_000 + 12_345);
    expect(slip.totalCostMinor).toBe(500_000 + 83_000 + 12_345);
  });

  it('applies the monthly share of an annual cap', () => {
    const slip = calculatePayslip({
      workerType: 'employee',
      grossMinor: 1_000_000, // €10,000 gross; monthly cap is 90k/12 = €7,500
      employerContributions: employer,
      employeeDeductions: [],
      reimbursementsMinor: 0,
    });
    expect(slip.employerCosts[0]?.amountMinor).toBe(69_750); // 9.3% of 7,500.00
  });

  it('pays contractors gross with no statutory lines', () => {
    const slip = calculatePayslip({
      workerType: 'contractor',
      grossMinor: 400_000,
      employerContributions: employer,
      employeeDeductions: employee,
      reimbursementsMinor: 0,
    });
    expect(slip.deductions).toEqual([]);
    expect(slip.employerCosts).toEqual([]);
    expect(slip.netMinor).toBe(400_000);
    expect(slip.totalCostMinor).toBe(400_000);
  });
});

describe('leaveEntitlementForYear', () => {
  it('gives the full entitlement for a full year', () => {
    expect(
      leaveEntitlementForYear({ annualLeaveDays: 20, startDate: '2024-03-01', endDate: null, year: 2026 }),
    ).toBe(20);
  });
  it('prorates by months employed, to the nearest half day', () => {
    // July–December = 6 months of 25 days = 12.5
    expect(
      leaveEntitlementForYear({ annualLeaveDays: 25, startDate: '2026-07-10', endDate: null, year: 2026 }),
    ).toBe(12.5);
  });
  it('is zero for a year entirely outside employment', () => {
    expect(
      leaveEntitlementForYear({ annualLeaveDays: 25, startDate: '2027-01-01', endDate: null, year: 2026 }),
    ).toBe(0);
  });
});
