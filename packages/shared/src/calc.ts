import { daysBetweenInclusive, daysInMonth, firstDayOfMonth, lastDayOfMonth } from './dates';
import type { PayBasis, WorkerType } from './enums';
import { applyBps, monthlyFromAnnual, roundHalfUp } from './money';

/**
 * Pure payroll maths. No database, no clock, no I/O — every function here is
 * "numbers in, numbers out", which is why this file has the densest unit tests
 * in the repo and why the API and the web app can both import it.
 *
 * The statutory model is deliberately simplified (flat rates with optional
 * caps). Real payroll engines have progressive bands, thresholds and yearly
 * true-ups; the *shape* of the code (rules as data, pure calculation, one
 * rounding function) is what carries over.
 */

/** One statutory line, e.g. "Pension insurance 9.3% up to a salary cap". */
export interface ContributionRule {
  key: string;
  name: string;
  rateBps: number;
  /** Annual salary above this amount is not charged. Null/undefined = uncapped. */
  annualCapMinor?: number | null;
}

export interface CostLine {
  key: string;
  name: string;
  rateBps: number;
  monthlyMinor: number;
  annualMinor: number;
}

export interface CostBreakdown {
  countryCode: string;
  currency: string;
  annualSalaryMinor: number;
  monthlySalaryMinor: number;
  employerContributions: CostLine[];
  monthlyEmployerCostMinor: number;
  annualEmployerCostMinor: number;
  /** Salary + employer contributions, in local currency. */
  monthlyTotalMinor: number;
  annualTotalMinor: number;
  /** Meridian's management fee. Always USD. */
  monthlyFeeUsdMinor: number;
  /** Indicative employee side, so a hiring manager can talk about take-home pay. */
  employeeDeductions: CostLine[];
  monthlyDeductionsMinor: number;
  monthlyNetMinor: number;
}

function contributionOn(baseMinor: number, capMinor: number | null | undefined, rateBps: number) {
  const capped = capMinor != null ? Math.min(baseMinor, capMinor) : baseMinor;
  return applyBps(capped, rateBps);
}

function costLines(annualSalaryMinor: number, rules: readonly ContributionRule[]): CostLine[] {
  return rules.map((rule) => {
    const annualMinor = contributionOn(annualSalaryMinor, rule.annualCapMinor, rule.rateBps);
    return {
      key: rule.key,
      name: rule.name,
      rateBps: rule.rateBps,
      annualMinor,
      monthlyMinor: monthlyFromAnnual(annualMinor),
    };
  });
}

const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

export function calculateEmploymentCost(input: {
  countryCode: string;
  currency: string;
  annualSalaryMinor: number;
  employerContributions: readonly ContributionRule[];
  employeeDeductions: readonly ContributionRule[];
  monthlyFeeUsdMinor: number;
}): CostBreakdown {
  const monthlySalaryMinor = monthlyFromAnnual(input.annualSalaryMinor);
  const employer = costLines(input.annualSalaryMinor, input.employerContributions);
  const employee = costLines(input.annualSalaryMinor, input.employeeDeductions);
  const monthlyEmployerCostMinor = sum(employer.map((l) => l.monthlyMinor));
  const annualEmployerCostMinor = sum(employer.map((l) => l.annualMinor));
  const monthlyDeductionsMinor = sum(employee.map((l) => l.monthlyMinor));
  return {
    countryCode: input.countryCode,
    currency: input.currency,
    annualSalaryMinor: input.annualSalaryMinor,
    monthlySalaryMinor,
    employerContributions: employer,
    monthlyEmployerCostMinor,
    annualEmployerCostMinor,
    monthlyTotalMinor: monthlySalaryMinor + monthlyEmployerCostMinor,
    annualTotalMinor: input.annualSalaryMinor + annualEmployerCostMinor,
    monthlyFeeUsdMinor: input.monthlyFeeUsdMinor,
    employeeDeductions: employee,
    monthlyDeductionsMinor,
    monthlyNetMinor: monthlySalaryMinor - monthlyDeductionsMinor,
  };
}

/** Annualise whatever the worker's pay basis is. */
export function annualSalaryOf(salaryMinor: number, payBasis: PayBasis): number {
  return payBasis === 'annual' ? salaryMinor : salaryMinor * 12;
}

export interface ProratedGross {
  grossMinor: number;
  daysWorked: number;
  daysInPeriod: number;
}

/**
 * Gross pay for one calendar month, prorated by calendar days when the worker
 * starts or ends part-way through. Returns 0 days if they were not employed
 * at all during the period.
 */
export function grossForPeriod(input: {
  salaryMinor: number;
  payBasis: PayBasis;
  startDate: string;
  endDate: string | null;
  year: number;
  month: number;
}): ProratedGross {
  const periodStart = firstDayOfMonth(input.year, input.month);
  const periodEnd = lastDayOfMonth(input.year, input.month);
  const daysInPeriod = daysInMonth(input.year, input.month);
  const from = input.startDate > periodStart ? input.startDate : periodStart;
  const to = input.endDate && input.endDate < periodEnd ? input.endDate : periodEnd;
  if (from > to) return { grossMinor: 0, daysWorked: 0, daysInPeriod };

  const monthlyMinor =
    input.payBasis === 'annual' ? monthlyFromAnnual(input.salaryMinor) : input.salaryMinor;
  const daysWorked = daysBetweenInclusive(from, to);
  const grossMinor =
    daysWorked === daysInPeriod
      ? monthlyMinor
      : roundHalfUp((monthlyMinor * daysWorked) / daysInPeriod);
  return { grossMinor, daysWorked, daysInPeriod };
}

export interface PayslipLine {
  key: string;
  name: string;
  rateBps: number;
  amountMinor: number;
}

export interface PayslipCalculation {
  grossMinor: number;
  deductions: PayslipLine[];
  deductionsMinor: number;
  employerCosts: PayslipLine[];
  employerCostMinor: number;
  reimbursementsMinor: number;
  /** What lands in the worker's bank account: gross − deductions + reimbursements. */
  netMinor: number;
  /** What the client is charged in local currency: gross + employer costs + reimbursements. */
  totalCostMinor: number;
}

function payslipLines(grossMinor: number, rules: readonly ContributionRule[]): PayslipLine[] {
  return rules.map((rule) => {
    const monthlyCap = rule.annualCapMinor != null ? monthlyFromAnnual(rule.annualCapMinor) : null;
    return {
      key: rule.key,
      name: rule.name,
      rateBps: rule.rateBps,
      amountMinor: contributionOn(grossMinor, monthlyCap, rule.rateBps),
    };
  });
}

/**
 * One worker's payslip for one period. Contractors are paid gross: no statutory
 * deductions and no employer contributions — that is the legal difference
 * between the two worker types, expressed in four lines.
 */
export function calculatePayslip(input: {
  workerType: WorkerType;
  grossMinor: number;
  employerContributions: readonly ContributionRule[];
  employeeDeductions: readonly ContributionRule[];
  reimbursementsMinor: number;
}): PayslipCalculation {
  const isEmployee = input.workerType === 'employee';
  const deductions = isEmployee ? payslipLines(input.grossMinor, input.employeeDeductions) : [];
  const employerCosts = isEmployee
    ? payslipLines(input.grossMinor, input.employerContributions)
    : [];
  const deductionsMinor = sum(deductions.map((l) => l.amountMinor));
  const employerCostMinor = sum(employerCosts.map((l) => l.amountMinor));
  return {
    grossMinor: input.grossMinor,
    deductions,
    deductionsMinor,
    employerCosts,
    employerCostMinor,
    reimbursementsMinor: input.reimbursementsMinor,
    netMinor: input.grossMinor - deductionsMinor + input.reimbursementsMinor,
    totalCostMinor: input.grossMinor + employerCostMinor + input.reimbursementsMinor,
  };
}

/**
 * Vacation entitlement for a calendar year, prorated by the months the worker
 * is employed in that year (a month counts if they are employed on any day of it).
 * Rounded to the nearest half day — the smallest unit HR systems usually track.
 */
export function leaveEntitlementForYear(input: {
  annualLeaveDays: number;
  startDate: string;
  endDate: string | null;
  year: number;
}): number {
  const yearStart = `${input.year}-01-01`;
  const yearEnd = `${input.year}-12-31`;
  const from = input.startDate > yearStart ? input.startDate : yearStart;
  const to = input.endDate && input.endDate < yearEnd ? input.endDate : yearEnd;
  if (from > to) return 0;
  const months = Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  return Math.round(((input.annualLeaveDays * months) / 12) * 2) / 2;
}
