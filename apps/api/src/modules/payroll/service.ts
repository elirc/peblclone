import {
  calculatePayslip,
  canTransition,
  grossForPeriod,
  PAYROLL_RUN_TRANSITIONS,
  type CreatePayrollRunInput,
  type ListPayrollRunsQuery,
  type Paginated,
  type PayrollItemDto,
  type PayrollRunDetailDto,
  type PayrollRunDto,
  type PayrollRunStatus,
  type PayslipDto,
  type RejectPayrollRunInput,
  type listPayslipsQuerySchema,
} from '@meridian/shared';
import { and, asc, count, desc, eq, inArray, isNull, ne, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db, type DbOrTx, type Tx } from '../../db/client';
import { countries, expenses, invoices, payrollItems, payrollRuns, workers } from '../../db/schema';
import { isWorker, requireOrgId, type Actor } from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { badRequest, conflict, forbidden, isUniqueViolation, notFound } from '../../lib/errors';
import { iso, paginated } from '../../lib/http';
import { issueInvoiceForRun } from '../../lib/invoicing';

type PayrollRunRow = typeof payrollRuns.$inferSelect;
type PayrollItemRow = typeof payrollItems.$inferSelect;
type CountryRow = typeof countries.$inferSelect;
type ListPayslipsQuery = z.infer<typeof listPayslipsQuerySchema>;

/** Workers in these statuses can still be owed pay for a period (e.g. a final month). */
const PAYABLE_WORKER_STATUSES = ['active', 'offboarding', 'terminated'] as const;

// ---------- row -> DTO ----------

function toRunDto(
  run: PayrollRunRow,
  countryName: string,
  invoiceId: string | null,
): PayrollRunDto {
  return {
    id: run.id,
    countryCode: run.countryCode,
    countryName,
    currency: run.currency,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    status: run.status,
    workerCount: run.workerCount,
    grossMinor: run.grossMinor,
    deductionsMinor: run.deductionsMinor,
    netMinor: run.netMinor,
    employerCostMinor: run.employerCostMinor,
    reimbursementsMinor: run.reimbursementsMinor,
    totalCostMinor: run.grossMinor + run.employerCostMinor + run.reimbursementsMinor,
    rejectionReason: run.rejectionReason,
    invoiceId,
    submittedAt: iso(run.submittedAt),
    approvedAt: iso(run.approvedAt),
    paidAt: iso(run.paidAt),
    createdAt: iso(run.createdAt),
  };
}

function toItemDto(
  item: PayrollItemRow,
  worker: { firstName: string; lastName: string },
): PayrollItemDto {
  return {
    id: item.id,
    payrollRunId: item.payrollRunId,
    workerId: item.workerId,
    workerName: `${worker.firstName} ${worker.lastName}`,
    workerType: item.workerType,
    daysWorked: item.daysWorked,
    daysInPeriod: item.daysInPeriod,
    grossMinor: item.grossMinor,
    deductionsMinor: item.deductionsMinor,
    netMinor: item.netMinor,
    employerCostMinor: item.employerCostMinor,
    reimbursementsMinor: item.reimbursementsMinor,
    deductions: item.deductions,
    employerCosts: item.employerCosts,
  };
}

// ---------- reads ----------

/**
 * The run's live invoice, joined in. `invoices_one_per_run` is a partial unique
 * index on non-void invoices, so this join can match at most one row per run.
 */
const liveInvoiceJoin = and(eq(invoices.payrollRunId, payrollRuns.id), ne(invoices.status, 'void'));

async function loadRunDetail(
  dbOrTx: DbOrTx,
  orgId: string,
  runId: string,
): Promise<PayrollRunDetailDto> {
  const [row] = await dbOrTx
    .select({ run: payrollRuns, countryName: countries.name, invoiceId: invoices.id })
    .from(payrollRuns)
    .innerJoin(countries, eq(countries.code, payrollRuns.countryCode))
    .leftJoin(invoices, liveInvoiceJoin)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
    .limit(1);
  if (!row) throw notFound('Payroll run');

  const items = await dbOrTx
    .select({ item: payrollItems, firstName: workers.firstName, lastName: workers.lastName })
    .from(payrollItems)
    .innerJoin(workers, eq(workers.id, payrollItems.workerId))
    .where(and(eq(payrollItems.payrollRunId, runId), eq(payrollItems.organizationId, orgId)))
    .orderBy(asc(workers.lastName), asc(workers.firstName), asc(payrollItems.id));

  return {
    ...toRunDto(row.run, row.countryName, row.invoiceId),
    items: items.map((r) => toItemDto(r.item, r)),
  };
}

export async function listRuns(
  actor: Actor,
  query: ListPayrollRunsQuery,
): Promise<Paginated<PayrollRunDto>> {
  const orgId = requireOrgId(actor);
  const filters: SQL[] = [eq(payrollRuns.organizationId, orgId)];
  if (query.status) filters.push(eq(payrollRuns.status, query.status));
  if (query.countryCode) filters.push(eq(payrollRuns.countryCode, query.countryCode));
  const where = and(...filters);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ run: payrollRuns, countryName: countries.name, invoiceId: invoices.id })
      .from(payrollRuns)
      .innerJoin(countries, eq(countries.code, payrollRuns.countryCode))
      .leftJoin(invoices, liveInvoiceJoin)
      .where(where)
      .orderBy(
        desc(payrollRuns.periodYear),
        desc(payrollRuns.periodMonth),
        asc(countries.name),
        desc(payrollRuns.createdAt),
      )
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(payrollRuns).where(where),
  ]);

  return paginated(
    rows.map((r) => toRunDto(r.run, r.countryName, r.invoiceId)),
    totalRow?.total ?? 0,
    query,
  );
}

export async function getRun(actor: Actor, runId: string): Promise<PayrollRunDetailDto> {
  return loadRunDetail(db, requireOrgId(actor), runId);
}

// ---------- create / recalculate / delete ----------

/** Months since year 0, so "is this period after next month" is one integer comparison. */
const monthIndex = (year: number, month: number) => year * 12 + (month - 1);

function assertPeriodNotTooFar(year: number, month: number): void {
  const now = new Date();
  const nextMonth = monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1) + 1;
  if (monthIndex(year, month) > nextMonth) {
    // Next month is allowed so a client can prepare a run before month-end.
    throw badRequest('Payroll can be prepared at most one month ahead', 'period_too_far');
  }
}

async function findCountry(countryCode: string): Promise<CountryRow> {
  const [country] = await db
    .select()
    .from(countries)
    .where(eq(countries.code, countryCode))
    .limit(1);
  if (!country) throw badRequest('Unknown country code', 'unknown_country');
  return country;
}

interface RunTotals {
  workerCount: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  reimbursementsMinor: number;
}

/**
 * Compute one payroll item per payable worker, claim their approved expenses,
 * and return the run totals. The totals are SUMS OF THE STORED ITEMS — the run
 * header can never disagree with its own lines.
 *
 * Must run inside the caller's transaction: if anything fails (say, nobody is
 * payable), the expense claims and item rows roll back with it.
 */
async function buildItems(tx: Tx, run: PayrollRunRow, country: CountryRow): Promise<RunTotals> {
  const candidates = await tx
    .select()
    .from(workers)
    .where(
      and(
        eq(workers.organizationId, run.organizationId),
        eq(workers.countryCode, run.countryCode),
        inArray(workers.status, [...PAYABLE_WORKER_STATUSES]),
      ),
    )
    .orderBy(asc(workers.lastName), asc(workers.firstName));

  const totals: RunTotals = {
    workerCount: 0,
    grossMinor: 0,
    deductionsMinor: 0,
    netMinor: 0,
    employerCostMinor: 0,
    reimbursementsMinor: 0,
  };

  for (const worker of candidates) {
    const gross = grossForPeriod({
      salaryMinor: worker.salaryMinor,
      payBasis: worker.payBasis,
      startDate: worker.startDate,
      endDate: worker.endDate,
      year: run.periodYear,
      month: run.periodMonth,
    });
    if (gross.daysWorked <= 0) continue;

    // Claim and read in ONE conditional UPDATE: a concurrent run for another
    // period re-checks `payroll_run_id IS NULL` after waiting for our row lock,
    // so the same expense can never be reimbursed twice.
    const claimed = await tx
      .update(expenses)
      .set({ payrollRunId: run.id })
      .where(
        and(
          eq(expenses.organizationId, run.organizationId),
          eq(expenses.workerId, worker.id),
          eq(expenses.status, 'approved'),
          isNull(expenses.payrollRunId),
          // Defensive: expenses are recorded in the worker's currency, which is the
          // country's; never add amounts in a different currency to this run.
          eq(expenses.currency, run.currency),
        ),
      )
      .returning({ amountMinor: expenses.amountMinor });
    const reimbursementsMinor = claimed.reduce((total, e) => total + e.amountMinor, 0);

    const slip = calculatePayslip({
      workerType: worker.type,
      grossMinor: gross.grossMinor,
      employerContributions: country.employerContributions,
      employeeDeductions: country.employeeDeductions,
      reimbursementsMinor,
    });

    const [item] = await tx
      .insert(payrollItems)
      .values({
        organizationId: run.organizationId,
        payrollRunId: run.id,
        workerId: worker.id,
        workerType: worker.type,
        daysWorked: gross.daysWorked,
        daysInPeriod: gross.daysInPeriod,
        grossMinor: slip.grossMinor,
        deductionsMinor: slip.deductionsMinor,
        netMinor: slip.netMinor,
        employerCostMinor: slip.employerCostMinor,
        reimbursementsMinor: slip.reimbursementsMinor,
        deductions: slip.deductions,
        employerCosts: slip.employerCosts,
      })
      .returning();
    if (!item) throw new Error('Payroll item insert returned no row');

    totals.workerCount += 1;
    totals.grossMinor += item.grossMinor;
    totals.deductionsMinor += item.deductionsMinor;
    totals.netMinor += item.netMinor;
    totals.employerCostMinor += item.employerCostMinor;
    totals.reimbursementsMinor += item.reimbursementsMinor;
  }

  if (totals.workerCount === 0) {
    throw conflict('Nobody in this country is payable for this period', 'no_payable_workers');
  }
  return totals;
}

/** Undo a draft's expense claims so the expenses can be picked up again. */
async function releaseClaimedExpenses(tx: Tx, run: PayrollRunRow): Promise<void> {
  await tx
    .update(expenses)
    .set({ payrollRunId: null })
    .where(
      and(
        eq(expenses.organizationId, run.organizationId),
        eq(expenses.payrollRunId, run.id),
        // Only drafts are released, and a draft has reimbursed nothing yet; the guard
        // just makes sure a paid-out expense can never lose the link to its run.
        ne(expenses.status, 'reimbursed'),
      ),
    );
}

/** Read a run inside a transaction and hold its row lock until commit. */
async function lockRun(tx: Tx, orgId: string, runId: string): Promise<PayrollRunRow> {
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
    .for('update')
    .limit(1);
  if (!run) throw notFound('Payroll run');
  return run;
}

function invalidTransition(from: PayrollRunStatus, action: string) {
  return conflict(
    `A ${from.replace('_', ' ')} payroll run cannot be ${action}`,
    'invalid_transition',
  );
}

export async function createRun(
  actor: Actor,
  input: CreatePayrollRunInput,
): Promise<PayrollRunDetailDto> {
  const orgId = requireOrgId(actor);
  const country = await findCountry(input.countryCode);
  assertPeriodNotTooFar(input.periodYear, input.periodMonth);

  try {
    return await db.transaction(async (tx) => {
      // Insert the header FIRST. A second concurrent create for the same period
      // blocks here on the unique index and then fails — before it has claimed
      // any expenses.
      const [run] = await tx
        .insert(payrollRuns)
        .values({
          organizationId: orgId,
          countryCode: country.code,
          currency: country.currency,
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
          status: 'draft',
          createdBy: actor.userId,
        })
        .returning();
      if (!run) throw new Error('Payroll run insert returned no row');

      const totals = await buildItems(tx, run, country);
      await tx.update(payrollRuns).set(totals).where(eq(payrollRuns.id, run.id));

      await recordAudit(tx, actor, {
        action: 'payroll_run.created',
        entityType: 'payroll_run',
        entityId: run.id,
        metadata: {
          countryCode: country.code,
          periodYear: input.periodYear,
          periodMonth: input.periodMonth,
          workerCount: totals.workerCount,
        },
      });
      return loadRunDetail(tx, orgId, run.id);
    });
  } catch (err) {
    if (isUniqueViolation(err, 'payroll_runs_period_unique')) {
      throw conflict('A payroll run already exists for this country and period', 'run_exists');
    }
    throw err;
  }
}

export async function recalculateRun(actor: Actor, runId: string): Promise<PayrollRunDetailDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, orgId, runId);
    if (run.status !== 'draft') throw invalidTransition(run.status, 'recalculated');

    const [country] = await tx
      .select()
      .from(countries)
      .where(eq(countries.code, run.countryCode))
      .limit(1);
    if (!country) throw notFound('Country');

    // Start from a clean slate: release every claim, drop every item, build again
    // with today's salaries, rules and approved expenses.
    await releaseClaimedExpenses(tx, run);
    await tx
      .delete(payrollItems)
      .where(and(eq(payrollItems.payrollRunId, run.id), eq(payrollItems.organizationId, orgId)));
    const totals = await buildItems(tx, run, country);
    await tx.update(payrollRuns).set(totals).where(eq(payrollRuns.id, run.id));

    await recordAudit(tx, actor, {
      action: 'payroll_run.recalculated',
      entityType: 'payroll_run',
      entityId: run.id,
      metadata: { workerCount: totals.workerCount, grossMinor: totals.grossMinor },
    });
    return loadRunDetail(tx, orgId, run.id);
  });
}

export async function deleteRun(actor: Actor, runId: string): Promise<void> {
  const orgId = requireOrgId(actor);
  await db.transaction(async (tx) => {
    const run = await lockRun(tx, orgId, runId);
    if (run.status !== 'draft') throw invalidTransition(run.status, 'deleted');

    // Explicit release, rather than relying on the FK's ON DELETE SET NULL, so the
    // rule "deleting a draft gives its expenses back" is visible in the code.
    await releaseClaimedExpenses(tx, run);
    await tx
      .delete(payrollRuns)
      .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.organizationId, orgId)));

    await recordAudit(tx, actor, {
      action: 'payroll_run.deleted',
      entityType: 'payroll_run',
      entityId: run.id,
      metadata: {
        countryCode: run.countryCode,
        periodYear: run.periodYear,
        periodMonth: run.periodMonth,
      },
    });
  });
}

// ---------- transitions ----------

interface TransitionSpec {
  to: PayrollRunStatus;
  /** Past participle for the error message: "cannot be submitted". */
  verb: string;
  auditAction: string;
  set: Partial<typeof payrollRuns.$inferInsert>;
  metadata?: Record<string, unknown>;
  /** Extra checks before the status changes (e.g. "the invoice must be paid"). */
  before?: (tx: Tx, run: PayrollRunRow) => Promise<void>;
  /** Extra writes after the status changed, in the same transaction. */
  after?: (tx: Tx, run: PayrollRunRow) => Promise<Record<string, unknown> | void>;
}

/**
 * Every status change goes through here:
 *   1. load the run in the caller's tenant (404 otherwise)
 *   2. ask the transition table (409 invalid_transition otherwise)
 *   3. UPDATE … WHERE status = <what we just read>, so if two requests race,
 *      exactly one matches the row and the other gets a 409
 *   4. side effects + audit, all in the same transaction
 */
async function transition(
  actor: Actor,
  runId: string,
  spec: TransitionSpec,
): Promise<PayrollRunDetailDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(payrollRuns)
      .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, orgId)))
      .limit(1);
    if (!current) throw notFound('Payroll run');
    if (!canTransition(PAYROLL_RUN_TRANSITIONS, current.status, spec.to)) {
      throw invalidTransition(current.status, spec.verb);
    }
    if (spec.before) await spec.before(tx, current);

    const [updated] = await tx
      .update(payrollRuns)
      .set({ ...spec.set, status: spec.to })
      .where(
        and(
          eq(payrollRuns.id, runId),
          eq(payrollRuns.organizationId, orgId),
          eq(payrollRuns.status, current.status),
        ),
      )
      .returning();
    if (!updated) throw invalidTransition(current.status, spec.verb);

    const extra = spec.after ? await spec.after(tx, updated) : undefined;
    await recordAudit(tx, actor, {
      action: spec.auditAction,
      entityType: 'payroll_run',
      entityId: runId,
      metadata: { from: current.status, to: spec.to, ...spec.metadata, ...(extra ?? {}) },
    });
    return loadRunDetail(tx, orgId, runId);
  });
}

export function submitRun(actor: Actor, runId: string) {
  return transition(actor, runId, {
    to: 'pending_approval',
    verb: 'submitted',
    auditAction: 'payroll_run.submitted',
    set: { submittedAt: new Date() },
  });
}

export function rejectRun(actor: Actor, runId: string, input: RejectPayrollRunInput) {
  return transition(actor, runId, {
    to: 'draft',
    verb: 'rejected',
    auditAction: 'payroll_run.rejected',
    set: { rejectionReason: input.reason },
    metadata: { reason: input.reason },
  });
}

export function approveRun(actor: Actor, runId: string) {
  return transition(actor, runId, {
    to: 'approved',
    verb: 'approved',
    auditAction: 'payroll_run.approved',
    set: { rejectionReason: null, approvedBy: actor.userId, approvedAt: new Date() },
    // Same transaction as the approval: if the invoice cannot be issued (e.g. a
    // missing FX rate), the approval rolls back and the run stays pending.
    after: async (tx, run) => {
      const invoice = await issueInvoiceForRun(tx, run, actor);
      return { invoiceId: invoice.id, invoiceNumber: invoice.number };
    },
  });
}

export function processRun(actor: Actor, runId: string) {
  return transition(actor, runId, {
    to: 'processing',
    verb: 'processed',
    auditAction: 'payroll_run.processing',
    set: {},
    // Meridian does not pay out money it has not received from the client.
    before: async (tx, run) => {
      const [invoice] = await tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(
          and(
            eq(invoices.payrollRunId, run.id),
            eq(invoices.organizationId, run.organizationId),
            ne(invoices.status, 'void'),
          ),
        )
        .limit(1);
      if (invoice?.status !== 'paid') {
        throw conflict('The invoice for this run has not been paid yet', 'invoice_unpaid');
      }
    },
  });
}

export function markRunPaid(actor: Actor, runId: string) {
  return transition(actor, runId, {
    to: 'paid',
    verb: 'marked paid',
    auditAction: 'payroll_run.paid',
    set: { paidAt: new Date() },
    after: async (tx, run) => {
      // approved -> reimbursed (EXPENSE_TRANSITIONS); the WHERE makes it a no-op for anything else.
      const reimbursed = await tx
        .update(expenses)
        .set({ status: 'reimbursed' })
        .where(
          and(
            eq(expenses.organizationId, run.organizationId),
            eq(expenses.payrollRunId, run.id),
            eq(expenses.status, 'approved'),
          ),
        )
        .returning({ id: expenses.id });
      return { expensesReimbursed: reimbursed.length };
    },
  });
}

// ---------- payslips ----------

/** A payslip is a payroll item of a PAID run; anything earlier is still a draft of someone's pay. */
function payslipFilters(actor: Actor, orgId: string, requestedWorkerId: string | undefined): SQL[] {
  const filters: SQL[] = [
    eq(payrollItems.organizationId, orgId),
    eq(payrollRuns.organizationId, orgId),
    eq(payrollRuns.status, 'paid'),
  ];
  if (isWorker(actor)) {
    if (!actor.workerId) throw forbidden();
    // A worker asking for someone else's payslips learns nothing: 404, not 403.
    if (requestedWorkerId && requestedWorkerId !== actor.workerId) throw notFound('Worker');
    filters.push(eq(payrollItems.workerId, actor.workerId));
  } else if (requestedWorkerId) {
    filters.push(eq(payrollItems.workerId, requestedWorkerId));
  }
  return filters;
}

const payslipSelection = {
  item: payrollItems,
  firstName: workers.firstName,
  lastName: workers.lastName,
  currency: payrollRuns.currency,
  periodYear: payrollRuns.periodYear,
  periodMonth: payrollRuns.periodMonth,
  paidAt: payrollRuns.paidAt,
};

function toPayslipDto(row: {
  item: PayrollItemRow;
  firstName: string;
  lastName: string;
  currency: string;
  periodYear: number;
  periodMonth: number;
  paidAt: Date | null;
}): PayslipDto {
  // Every paid run has paidAt (mark-paid sets both in one UPDATE).
  if (!row.paidAt) throw new Error(`Paid payroll run ${row.item.payrollRunId} has no paidAt`);
  return {
    ...toItemDto(row.item, row),
    currency: row.currency,
    periodYear: row.periodYear,
    periodMonth: row.periodMonth,
    paidAt: iso(row.paidAt),
  };
}

export async function listPayslips(
  actor: Actor,
  query: ListPayslipsQuery,
): Promise<Paginated<PayslipDto>> {
  const orgId = requireOrgId(actor);
  const where = and(...payslipFilters(actor, orgId, query.workerId));

  const [rows, [totalRow]] = await Promise.all([
    db
      .select(payslipSelection)
      .from(payrollItems)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.payrollRunId))
      .innerJoin(workers, eq(workers.id, payrollItems.workerId))
      .where(where)
      .orderBy(
        desc(payrollRuns.periodYear),
        desc(payrollRuns.periodMonth),
        desc(payrollRuns.paidAt),
        asc(workers.lastName),
        asc(workers.firstName),
      )
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ total: count() })
      .from(payrollItems)
      .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.payrollRunId))
      .where(where),
  ]);

  return paginated(rows.map(toPayslipDto), totalRow?.total ?? 0, query);
}

export async function getPayslip(actor: Actor, itemId: string): Promise<PayslipDto> {
  const orgId = requireOrgId(actor);
  const filters = payslipFilters(actor, orgId, undefined);
  const [row] = await db
    .select(payslipSelection)
    .from(payrollItems)
    .innerJoin(payrollRuns, eq(payrollRuns.id, payrollItems.payrollRunId))
    .innerJoin(workers, eq(workers.id, payrollItems.workerId))
    .where(and(eq(payrollItems.id, itemId), ...filters))
    .limit(1);
  if (!row) throw notFound('Payslip');
  return toPayslipDto(row);
}
