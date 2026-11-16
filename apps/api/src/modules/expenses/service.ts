import {
  EXPENSE_MAX_AGE_DAYS,
  EXPENSE_TRANSITIONS,
  addDays,
  canTransition,
  toIsoDate,
  type CreateExpenseInput,
  type DecisionInput,
  type ExpenseDto,
  type ListExpensesQuery,
  type Paginated,
} from '@meridian/shared';
import { and, count, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client';
import { expenses, workers } from '../../db/schema';
import {
  assertCanAccessWorker,
  isWorker,
  requireOrgId,
  resolveWorkerId,
  type Actor,
} from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { iso, paginated } from '../../lib/http';

type ExpenseRow = typeof expenses.$inferSelect;

function toExpenseDto(row: ExpenseRow, workerName: string): ExpenseDto {
  return {
    id: row.id,
    workerId: row.workerId,
    workerName,
    category: row.category,
    description: row.description,
    amountMinor: row.amountMinor,
    currency: row.currency,
    incurredOn: row.incurredOn,
    status: row.status,
    decisionNote: row.decisionNote,
    decidedAt: iso(row.decidedAt),
    payrollRunId: row.payrollRunId,
    createdAt: iso(row.createdAt),
  };
}

const fullName = (w: { firstName: string; lastName: string }) => `${w.firstName} ${w.lastName}`;

/** Load one expense the actor may see (tenant + own-records rule), or 404. */
async function loadVisible(dbOrTx: DbOrTx, actor: Actor, expenseId: string) {
  const [found] = await dbOrTx
    .select({ expense: expenses, firstName: workers.firstName, lastName: workers.lastName })
    .from(expenses)
    .innerJoin(workers, eq(workers.id, expenses.workerId))
    .where(and(eq(expenses.id, expenseId), eq(expenses.organizationId, requireOrgId(actor))))
    .limit(1);
  if (!found) throw notFound('Expense');
  if (isWorker(actor) && found.expense.workerId !== actor.workerId) throw notFound('Expense');
  return { row: found.expense, workerName: fullName(found) };
}

export async function listExpenses(
  actor: Actor,
  query: ListExpensesQuery,
): Promise<Paginated<ExpenseDto>> {
  const conditions: SQL[] = [eq(expenses.organizationId, requireOrgId(actor))];
  if (isWorker(actor)) {
    if (query.workerId) assertCanAccessWorker(actor, query.workerId);
    conditions.push(eq(expenses.workerId, resolveWorkerId(actor, undefined)));
  } else if (query.workerId) {
    conditions.push(eq(expenses.workerId, query.workerId));
  }
  if (query.status) conditions.push(eq(expenses.status, query.status));
  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    db
      .select({ expense: expenses, firstName: workers.firstName, lastName: workers.lastName })
      .from(expenses)
      .innerJoin(workers, eq(workers.id, expenses.workerId))
      .where(where)
      .orderBy(desc(expenses.createdAt), desc(expenses.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(expenses).where(where),
  ]);
  return paginated(
    rows.map((r) => toExpenseDto(r.expense, fullName(r))),
    total?.value ?? 0,
    query,
  );
}

export async function createExpense(actor: Actor, input: CreateExpenseInput): Promise<ExpenseDto> {
  const orgId = requireOrgId(actor);
  const workerId = resolveWorkerId(actor, input.workerId);

  return db.transaction(async (tx) => {
    const [worker] = await tx
      .select()
      .from(workers)
      .where(and(eq(workers.id, workerId), eq(workers.organizationId, orgId)))
      .limit(1);
    if (!worker) throw notFound('Worker');
    // Offboarding workers can still claim what they spent before their last day.
    if (worker.status !== 'active' && worker.status !== 'offboarding') {
      throw conflict(
        'Expenses can only be submitted for active or offboarding workers',
        'worker_not_active',
      );
    }

    // ISO date strings compare correctly as strings (YYYY-MM-DD sorts chronologically).
    const today = toIsoDate(new Date());
    if (input.incurredOn > today) {
      throw badRequest('An expense cannot be dated in the future', 'future_date');
    }
    if (input.incurredOn < addDays(today, -EXPENSE_MAX_AGE_DAYS)) {
      throw badRequest(
        `Expenses older than ${EXPENSE_MAX_AGE_DAYS} days cannot be submitted`,
        'too_old',
      );
    }

    const [row] = await tx
      .insert(expenses)
      .values({
        organizationId: orgId,
        workerId: worker.id,
        category: input.category,
        description: input.description,
        amountMinor: input.amountMinor,
        // Reimbursed in the worker's pay currency, whatever the client sent.
        currency: worker.currency,
        incurredOn: input.incurredOn,
        status: 'submitted',
      })
      .returning();
    if (!row) throw new Error('Failed to create expense');

    await recordAudit(tx, actor, {
      action: 'expense.submitted',
      entityType: 'expense',
      entityId: row.id,
      metadata: { workerId: worker.id, amountMinor: row.amountMinor, currency: row.currency },
    });
    return toExpenseDto(row, fullName(worker));
  });
}

export async function decideExpense(
  actor: Actor,
  expenseId: string,
  input: DecisionInput,
): Promise<ExpenseDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const { row: before, workerName } = await loadVisible(tx, actor, expenseId);
    // The worker deserves to know why they are not being paid back.
    if (input.decision === 'rejected' && !input.note) {
      throw badRequest('A note is required when rejecting an expense', 'note_required');
    }
    if (!canTransition(EXPENSE_TRANSITIONS, before.status, input.decision)) {
      throw conflict(`Cannot decide an expense that is ${before.status}`, 'invalid_transition');
    }
    const [row] = await tx
      .update(expenses)
      .set({
        status: input.decision,
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionNote: input.note || null,
      })
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.organizationId, orgId),
          eq(expenses.status, before.status),
        ),
      )
      .returning();
    if (!row) throw conflict('The expense was changed by someone else', 'invalid_transition');

    await recordAudit(tx, actor, {
      action: `expense.${input.decision}`,
      entityType: 'expense',
      entityId: row.id,
      metadata: { workerId: row.workerId, from: before.status, note: row.decisionNote },
    });
    return toExpenseDto(row, workerName);
  });
}

export async function deleteExpense(actor: Actor, expenseId: string): Promise<void> {
  const orgId = requireOrgId(actor);
  await db.transaction(async (tx) => {
    const { row: before } = await loadVisible(tx, actor, expenseId);
    if (before.status !== 'submitted') {
      throw conflict(`Cannot delete an expense that is ${before.status}`, 'invalid_transition');
    }
    // `payrollRunId IS NULL` as well: an expense a payroll run has claimed must
    // not vanish from under it. Only payroll sets that column; we never touch it.
    const deleted = await tx
      .delete(expenses)
      .where(
        and(
          eq(expenses.id, expenseId),
          eq(expenses.organizationId, orgId),
          eq(expenses.status, 'submitted'),
          isNull(expenses.payrollRunId),
        ),
      )
      .returning({ id: expenses.id });
    if (deleted.length === 0) {
      throw conflict('This expense can no longer be deleted', 'invalid_transition');
    }
    await recordAudit(tx, actor, {
      action: 'expense.deleted',
      entityType: 'expense',
      entityId: before.id,
      metadata: {
        workerId: before.workerId,
        amountMinor: before.amountMinor,
        currency: before.currency,
      },
    });
  });
}
