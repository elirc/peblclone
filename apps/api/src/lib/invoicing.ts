import {
  addDays,
  CONTRACTOR_MONTHLY_FEE_USD_MINOR,
  convertMinor,
  formatMoney,
  formatPeriod,
  INVOICE_DUE_DAYS,
  toIsoDate,
  type InvoiceLineKind,
} from '@meridian/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { countries, fxRates, invoiceLines, invoices, payrollItems, payrollRuns } from '../db/schema';
import type { Actor } from './actor';
import { recordAudit } from './audit';
import { conflict, notFound } from './errors';

/**
 * Turning an approved payroll run into a client invoice.
 *
 * This lives in `lib/` rather than in the invoices module because the PAYROLL
 * module calls it (inside its approve transaction) and modules never import each
 * other. Keeping it here also means "how an invoice is built" is one readable
 * function instead of being split across two services.
 *
 * Invoices are always in USD. The run's local totals are converted with the rate
 * in `fx_rates` *at this moment*, and that rate is frozen onto the invoice: if the
 * rate table changes tomorrow, yesterday's invoice must still add up.
 */

type PayrollRunRow = typeof payrollRuns.$inferSelect;
export type InvoiceRow = typeof invoices.$inferSelect;

interface DraftLine {
  kind: InvoiceLineKind;
  description: string;
  amountMinor: number;
}

/** `INV-2026-001001`. The number part comes from a sequence, never from counting rows. */
function formatInvoiceNumber(year: number, sequenceValue: number): string {
  return `INV-${year}-${String(sequenceValue).padStart(6, '0')}`;
}

export async function issueInvoiceForRun(
  tx: Tx,
  run: PayrollRunRow,
  actor: Actor,
): Promise<InvoiceRow> {
  const [rate] = await tx
    .select({ perUsd: fxRates.perUsd })
    .from(fxRates)
    .where(eq(fxRates.currency, run.currency))
    .limit(1);
  if (!rate) {
    // Refusing is the only safe answer: guessing a rate would bill the client a made-up amount.
    throw conflict(`No exchange rate for ${run.currency}; cannot issue the invoice`, 'fx_rate_missing');
  }

  const [country] = await tx
    .select({ name: countries.name, monthlyFeeUsdMinor: countries.monthlyFeeUsdMinor })
    .from(countries)
    .where(eq(countries.code, run.countryCode))
    .limit(1);
  if (!country) throw notFound('Country');

  // The platform fee is per head and differs by worker type, so count the run's items.
  const headcount = await tx
    .select({ workerType: payrollItems.workerType, n: sql<number>`count(*)::int` })
    .from(payrollItems)
    .where(
      and(
        eq(payrollItems.payrollRunId, run.id),
        eq(payrollItems.organizationId, run.organizationId),
      ),
    )
    .groupBy(payrollItems.workerType);
  const employees = headcount.find((h) => h.workerType === 'employee')?.n ?? 0;
  const contractors = headcount.find((h) => h.workerType === 'contractor')?.n ?? 0;

  const toUsd = (localMinor: number) => convertMinor(
      localMinor,
      { currency: run.currency, perUsd: rate.perUsd },
      { currency: 'USD', perUsd: '1' },
    );
  const period = formatPeriod(run.periodYear, run.periodMonth);
  const local = (amountMinor: number) => formatMoney(amountMinor, run.currency);

  const candidates: DraftLine[] = [
    {
      kind: 'gross_pay',
      description: `Gross pay, ${country.name}, ${period} (${local(run.grossMinor)})`,
      amountMinor: toUsd(run.grossMinor),
    },
    {
      kind: 'employer_cost',
      description: `Employer contributions, ${period} (${local(run.employerCostMinor)})`,
      amountMinor: toUsd(run.employerCostMinor),
    },
    {
      kind: 'reimbursement',
      description: `Expense reimbursements, ${period} (${local(run.reimbursementsMinor)})`,
      amountMinor: toUsd(run.reimbursementsMinor),
    },
  ];
  // Employer cost and reimbursement lines are omitted when they are zero (e.g. a
  // contractor-only run); gross pay is always shown so the invoice is never empty.
  const lines = candidates.filter((line) => line.kind === 'gross_pay' || line.amountMinor !== 0);

  const feeMinor =
    country.monthlyFeeUsdMinor * employees + CONTRACTOR_MONTHLY_FEE_USD_MINOR * contractors;
  const subtotalMinor = lines.reduce((total, line) => total + line.amountMinor, 0);
  lines.push({
    kind: 'platform_fee',
    description: `Meridian platform fee (${employees} employee(s), ${contractors} contractor(s))`,
    amountMinor: feeMinor,
  });

  // nextval() is outside transactional rollback: a failed approve "burns" a number.
  // That gap is acceptable and expected — what must never happen is a number reused.
  const seq = await tx.execute<{ n: string }>(sql`select nextval('invoice_number_seq') as n`);
  const sequenceValue = Number(seq.rows[0]?.n);
  if (!Number.isSafeInteger(sequenceValue)) throw new Error('invoice_number_seq returned no value');

  const issuedAt = new Date();
  const [invoice] = await tx
    .insert(invoices)
    .values({
      organizationId: run.organizationId,
      number: formatInvoiceNumber(issuedAt.getUTCFullYear(), sequenceValue),
      status: 'issued',
      currency: 'USD',
      subtotalMinor,
      feeMinor,
      totalMinor: subtotalMinor + feeMinor,
      payrollRunId: run.id,
      fxRate: rate.perUsd,
      localCurrency: run.currency,
      issuedAt,
      dueDate: addDays(toIsoDate(issuedAt), INVOICE_DUE_DAYS),
    })
    .returning();
  if (!invoice) throw new Error('Invoice insert returned no row');

  await tx.insert(invoiceLines).values(
    lines.map((line, index) => ({
      invoiceId: invoice.id,
      kind: line.kind,
      description: line.description,
      amountMinor: line.amountMinor,
      sortOrder: index,
    })),
  );

  await recordAudit(tx, actor, {
    action: 'invoice.issued',
    entityType: 'invoice',
    entityId: invoice.id,
    organizationId: run.organizationId,
    metadata: {
      number: invoice.number,
      payrollRunId: run.id,
      totalMinor: invoice.totalMinor,
      currency: 'USD',
      fxRate: rate.perUsd,
      localCurrency: run.currency,
    },
  });

  return invoice;
}
