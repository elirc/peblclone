import type { ContributionRule, DocumentKind } from '@meridian/shared';
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { countries, fxRates } from './schema';

/**
 * Reference data: countries, their (simplified!) statutory rules, and FX rates.
 *
 * These numbers are illustrative teaching data, not tax advice. Real rates have
 * bands, thresholds and yearly changes. What matters for the codebase is that
 * rules are DATA in a table — adding a country is an INSERT, not a deploy.
 */
interface CountrySeed {
  code: string;
  name: string;
  region: string;
  currency: string;
  employer: ContributionRule[];
  employee: ContributionRule[];
  feeUsd: number;
  leave: number;
  notice: number;
  probation: number;
  docs: DocumentKind[];
}

const r = (
  key: string,
  name: string,
  rateBps: number,
  annualCapMinor?: number,
): ContributionRule =>
  annualCapMinor === undefined ? { key, name, rateBps } : { key, name, rateBps, annualCapMinor };

const BASE_DOCS: DocumentKind[] = ['passport', 'bank_proof', 'tax_form'];

export const COUNTRY_SEEDS: CountrySeed[] = [
  {
    code: 'US',
    name: 'United States',
    region: 'North America',
    currency: 'USD',
    employer: [
      r('social_security', 'Social Security', 620, 17_610_000),
      r('medicare', 'Medicare', 145),
      r('unemployment', 'Unemployment insurance', 60, 700_000),
    ],
    employee: [
      r('income_tax', 'Federal income tax (est.)', 1800),
      r('social_security', 'Social Security', 620, 17_610_000),
      r('medicare', 'Medicare', 145),
    ],
    feeUsd: 49_900,
    leave: 15,
    notice: 14,
    probation: 90,
    docs: ['national_id', 'bank_proof', 'tax_form'],
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    region: 'Europe',
    currency: 'GBP',
    employer: [
      r('national_insurance', 'Employer National Insurance', 1500),
      r('pension', 'Workplace pension', 300),
      r('apprenticeship_levy', 'Apprenticeship levy', 50),
    ],
    employee: [
      r('income_tax', 'PAYE income tax (est.)', 2000),
      r('national_insurance', 'National Insurance', 800),
      r('pension', 'Workplace pension', 500),
    ],
    feeUsd: 59_900,
    leave: 28,
    notice: 30,
    probation: 90,
    docs: BASE_DOCS,
  },
  {
    code: 'DE',
    name: 'Germany',
    region: 'Europe',
    currency: 'EUR',
    employer: [
      r('pension', 'Pension insurance', 930, 9_660_000),
      r('health', 'Health insurance', 815, 6_615_000),
      r('unemployment', 'Unemployment insurance', 130, 9_660_000),
      r('care', 'Long-term care insurance', 180, 6_615_000),
    ],
    employee: [
      r('income_tax', 'Wage tax (est.)', 2200),
      r('pension', 'Pension insurance', 930, 9_660_000),
      r('health', 'Health insurance', 815, 6_615_000),
      r('unemployment', 'Unemployment insurance', 130, 9_660_000),
    ],
    feeUsd: 59_900,
    leave: 24,
    notice: 30,
    probation: 180,
    docs: [...BASE_DOCS, 'proof_of_address'],
  },
  {
    code: 'FR',
    name: 'France',
    region: 'Europe',
    currency: 'EUR',
    employer: [
      r('social_security', 'Social security contributions', 3000),
      r('pension', 'Supplementary pension', 600),
      r('unemployment', 'Unemployment insurance', 405),
    ],
    employee: [
      r('income_tax', 'Income tax withholding (est.)', 1400),
      r('social_security', 'Social contributions', 2200),
    ],
    feeUsd: 64_900,
    leave: 25,
    notice: 30,
    probation: 120,
    docs: [...BASE_DOCS, 'proof_of_address'],
  },
  {
    code: 'ES',
    name: 'Spain',
    region: 'Europe',
    currency: 'EUR',
    employer: [
      r('social_security', 'Social security', 2360, 5_674_000),
      r('unemployment', 'Unemployment', 550, 5_674_000),
      r('training', 'Professional training', 60, 5_674_000),
    ],
    employee: [
      r('income_tax', 'IRPF withholding (est.)', 1900),
      r('social_security', 'Social security', 635, 5_674_000),
    ],
    feeUsd: 59_900,
    leave: 22,
    notice: 15,
    probation: 180,
    docs: BASE_DOCS,
  },
  {
    code: 'NL',
    name: 'Netherlands',
    region: 'Europe',
    currency: 'EUR',
    employer: [
      r('social_security', 'Employee insurance schemes', 1150, 7_187_000),
      r('health', 'Healthcare Insurance Act', 651, 7_187_000),
      r('holiday_allowance', 'Holiday allowance', 800),
    ],
    employee: [r('income_tax', 'Wage tax & national insurance (est.)', 3000)],
    feeUsd: 59_900,
    leave: 20,
    notice: 30,
    probation: 60,
    docs: BASE_DOCS,
  },
  {
    code: 'CA',
    name: 'Canada',
    region: 'North America',
    currency: 'CAD',
    employer: [
      r('cpp', 'Canada Pension Plan', 595, 7_130_000),
      r('ei', 'Employment Insurance', 230, 6_570_000),
    ],
    employee: [
      r('income_tax', 'Income tax (est.)', 2000),
      r('cpp', 'Canada Pension Plan', 595, 7_130_000),
      r('ei', 'Employment Insurance', 164, 6_570_000),
    ],
    feeUsd: 54_900,
    leave: 10,
    notice: 14,
    probation: 90,
    docs: ['national_id', 'bank_proof', 'tax_form'],
  },
  {
    code: 'MX',
    name: 'Mexico',
    region: 'Latin America',
    currency: 'MXN',
    employer: [
      r('imss', 'Social security (IMSS)', 1750),
      r('infonavit', 'Housing fund (INFONAVIT)', 500),
      r('aguinaldo', 'Christmas bonus accrual', 411),
      r('payroll_tax', 'State payroll tax', 300),
    ],
    employee: [
      r('income_tax', 'ISR withholding (est.)', 1500),
      r('imss', 'Social security (IMSS)', 275),
    ],
    feeUsd: 49_900,
    leave: 12,
    notice: 0,
    probation: 30,
    docs: [...BASE_DOCS, 'proof_of_address'],
  },
  {
    code: 'BR',
    name: 'Brazil',
    region: 'Latin America',
    currency: 'BRL',
    employer: [
      r('inss', 'Social security (INSS)', 2000),
      r('fgts', 'Severance fund (FGTS)', 800),
      r('thirteenth', '13th salary accrual', 833),
      r('vacation_bonus', 'Vacation bonus accrual', 278),
    ],
    employee: [
      r('income_tax', 'IRRF withholding (est.)', 1500),
      r('inss', 'Social security (INSS)', 1100),
    ],
    feeUsd: 54_900,
    leave: 30,
    notice: 30,
    probation: 90,
    docs: [...BASE_DOCS, 'proof_of_address'],
  },
  {
    code: 'IN',
    name: 'India',
    region: 'Asia Pacific',
    currency: 'INR',
    employer: [
      r('provident_fund', 'Provident fund', 1200),
      r('gratuity', 'Gratuity accrual', 481),
      r('insurance', 'Employee state insurance', 325, 25_200_000),
    ],
    employee: [
      r('income_tax', 'TDS income tax (est.)', 1000),
      r('provident_fund', 'Provident fund', 1200),
    ],
    feeUsd: 39_900,
    leave: 18,
    notice: 30,
    probation: 180,
    docs: ['national_id', 'bank_proof', 'tax_form'],
  },
  {
    code: 'PH',
    name: 'Philippines',
    region: 'Asia Pacific',
    currency: 'PHP',
    employer: [
      r('sss', 'Social Security System', 950, 36_000_000),
      r('philhealth', 'PhilHealth', 250, 120_000_000),
      r('pagibig', 'Pag-IBIG fund', 200, 12_000_000),
      r('thirteenth', '13th month accrual', 833),
    ],
    employee: [
      r('income_tax', 'Withholding tax (est.)', 1500),
      r('sss', 'Social Security System', 450, 36_000_000),
      r('philhealth', 'PhilHealth', 250, 120_000_000),
    ],
    feeUsd: 39_900,
    leave: 5,
    notice: 30,
    probation: 180,
    docs: ['national_id', 'bank_proof', 'tax_form'],
  },
  {
    code: 'AU',
    name: 'Australia',
    region: 'Asia Pacific',
    currency: 'AUD',
    employer: [
      r('superannuation', 'Superannuation guarantee', 1200),
      r('payroll_tax', 'Payroll tax', 485),
    ],
    employee: [
      r('income_tax', 'PAYG withholding (est.)', 2400),
      r('medicare', 'Medicare levy', 200),
    ],
    feeUsd: 59_900,
    leave: 20,
    notice: 28,
    probation: 180,
    docs: BASE_DOCS,
  },
  {
    code: 'SG',
    name: 'Singapore',
    region: 'Asia Pacific',
    currency: 'SGD',
    employer: [
      r('cpf', 'Central Provident Fund', 1700, 10_200_000),
      r('sdl', 'Skills development levy', 25),
    ],
    employee: [r('cpf', 'Central Provident Fund', 2000, 10_200_000)],
    feeUsd: 59_900,
    leave: 14,
    notice: 30,
    probation: 90,
    docs: [...BASE_DOCS, 'work_permit'],
  },
  {
    code: 'JP',
    name: 'Japan',
    region: 'Asia Pacific',
    currency: 'JPY',
    employer: [
      r('pension', "Employees' pension", 915),
      r('health', 'Health insurance', 500),
      r('employment', 'Employment insurance', 95),
      r('accident', "Workers' accident insurance", 30),
    ],
    employee: [
      r('income_tax', 'Income tax withholding (est.)', 1000),
      r('pension', "Employees' pension", 915),
      r('health', 'Health insurance', 500),
    ],
    feeUsd: 64_900,
    leave: 10,
    notice: 30,
    probation: 90,
    docs: [...BASE_DOCS, 'proof_of_address'],
  },
];

/** Units of currency per 1 USD. Static demo rates. */
export const FX_SEEDS: Record<string, string> = {
  USD: '1',
  EUR: '0.92',
  GBP: '0.79',
  CAD: '1.36',
  MXN: '18.20',
  BRL: '5.45',
  INR: '84.10',
  PHP: '57.80',
  AUD: '1.52',
  SGD: '1.34',
  JPY: '151.00',
};

/** Idempotent: safe to run on every boot of a dev/test database. */
export async function seedReferenceData(db: DbOrTx): Promise<void> {
  for (const c of COUNTRY_SEEDS) {
    const values = {
      code: c.code,
      name: c.name,
      region: c.region,
      currency: c.currency,
      employerContributions: c.employer,
      employeeDeductions: c.employee,
      monthlyFeeUsdMinor: c.feeUsd,
      annualLeaveDays: c.leave,
      noticePeriodDays: c.notice,
      probationDays: c.probation,
      requiredDocuments: c.docs,
    };
    await db.insert(countries).values(values).onConflictDoNothing({ target: countries.code });
  }
  for (const [currency, perUsd] of Object.entries(FX_SEEDS)) {
    await db
      .insert(fxRates)
      .values({ currency, perUsd })
      .onConflictDoUpdate({ target: fxRates.currency, set: { perUsd, updatedAt: sql`now()` } });
  }
}
