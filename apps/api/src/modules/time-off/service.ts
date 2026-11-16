import {
  TIME_OFF_TRANSITIONS,
  canTransition,
  countBusinessDays,
  leaveEntitlementForYear,
  toIsoDate,
  type CreateTimeOffRequestInput,
  type DecisionInput,
  type ListTimeOffQuery,
  type Paginated,
  type TimeOffBalanceDto,
  type TimeOffRequestDto,
  type TimeOffStatus,
} from '@meridian/shared';
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx } from '../../db/client';
import { countries, timeOffRequests, workers } from '../../db/schema';
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

type TimeOffRow = typeof timeOffRequests.$inferSelect;

/** Requests that hold a slot in the calendar (and, for vacation, in the balance). */
const LIVE_STATUSES: TimeOffStatus[] = ['pending', 'approved'];

function toTimeOffDto(row: TimeOffRow, workerName: string): TimeOffRequestDto {
  return {
    id: row.id,
    workerId: row.workerId,
    workerName,
    type: row.type,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    days: row.days,
    reason: row.reason,
    decisionNote: row.decisionNote,
    decidedAt: iso(row.decidedAt),
    createdAt: iso(row.createdAt),
  };
}

const fullName = (w: { firstName: string; lastName: string }) => `${w.firstName} ${w.lastName}`;
const today = () => toIsoDate(new Date());

/** Load one request the actor may see (tenant + own-records rule), or 404. */
async function loadVisible(dbOrTx: DbOrTx, actor: Actor, requestId: string) {
  const [found] = await dbOrTx
    .select({ request: timeOffRequests, firstName: workers.firstName, lastName: workers.lastName })
    .from(timeOffRequests)
    .innerJoin(workers, eq(workers.id, timeOffRequests.workerId))
    .where(
      and(
        eq(timeOffRequests.id, requestId),
        eq(timeOffRequests.organizationId, requireOrgId(actor)),
      ),
    )
    .limit(1);
  if (!found) throw notFound('Time-off request');
  if (isWorker(actor) && found.request.workerId !== actor.workerId) {
    throw notFound('Time-off request');
  }
  return { row: found.request, workerName: fullName(found) };
}

// ---------- balance ----------

interface BalanceSubject {
  id: string;
  type: 'employee' | 'contractor';
  startDate: string;
  endDate: string | null;
  annualLeaveDays: number;
}

/** Sum of vacation days in `status` whose start date falls in `year`. */
async function vacationDays(
  dbOrTx: DbOrTx,
  workerId: string,
  status: TimeOffStatus,
  year: number,
): Promise<number> {
  const [row] = await dbOrTx
    .select({
      // Postgres returns sum() as numeric (a string in node-postgres); we want a number.
      days: sql<number>`coalesce(sum(${timeOffRequests.days}), 0)`.mapWith(Number),
    })
    .from(timeOffRequests)
    .where(
      and(
        eq(timeOffRequests.workerId, workerId),
        eq(timeOffRequests.type, 'vacation'),
        eq(timeOffRequests.status, status),
        gte(timeOffRequests.startDate, `${year}-01-01`),
        lte(timeOffRequests.startDate, `${year}-12-31`),
      ),
    );
  return row?.days ?? 0;
}

/**
 * Shared by GET /time-off/balance and by create's insufficient-balance check, so
 * the number the worker sees is exactly the number the server enforces.
 */
async function computeBalance(
  dbOrTx: DbOrTx,
  worker: BalanceSubject,
  year: number,
): Promise<TimeOffBalanceDto> {
  // Contractors are not employees: no statutory leave, so nothing to track.
  if (worker.type !== 'employee') {
    return {
      workerId: worker.id,
      year,
      entitlementDays: 0,
      usedDays: 0,
      pendingDays: 0,
      remainingDays: 0,
    };
  }
  const entitlementDays = leaveEntitlementForYear({
    annualLeaveDays: worker.annualLeaveDays,
    startDate: worker.startDate,
    endDate: worker.endDate,
    year,
  });
  const usedDays = await vacationDays(dbOrTx, worker.id, 'approved', year);
  const pendingDays = await vacationDays(dbOrTx, worker.id, 'pending', year);
  return {
    workerId: worker.id,
    year,
    entitlementDays,
    usedDays,
    pendingDays,
    // Pending requests count against the balance, so two requests filed back to
    // back cannot together spend more days than the worker has.
    remainingDays: entitlementDays - usedDays - pendingDays,
  };
}

export async function getBalance(
  actor: Actor,
  query: { workerId?: string; year?: number },
): Promise<TimeOffBalanceDto> {
  const workerId = resolveWorkerId(actor, query.workerId);
  const year = query.year ?? Number(today().slice(0, 4));
  const [worker] = await db
    .select({
      id: workers.id,
      type: workers.type,
      startDate: workers.startDate,
      endDate: workers.endDate,
      annualLeaveDays: countries.annualLeaveDays,
    })
    .from(workers)
    .innerJoin(countries, eq(countries.code, workers.countryCode))
    .where(and(eq(workers.id, workerId), eq(workers.organizationId, requireOrgId(actor))))
    .limit(1);
  if (!worker) throw notFound('Worker');
  return computeBalance(db, worker, year);
}

// ---------- list ----------

export async function listRequests(
  actor: Actor,
  query: ListTimeOffQuery,
): Promise<Paginated<TimeOffRequestDto>> {
  const conditions: SQL[] = [eq(timeOffRequests.organizationId, requireOrgId(actor))];
  if (isWorker(actor)) {
    if (query.workerId) assertCanAccessWorker(actor, query.workerId);
    conditions.push(eq(timeOffRequests.workerId, resolveWorkerId(actor, undefined)));
  } else if (query.workerId) {
    conditions.push(eq(timeOffRequests.workerId, query.workerId));
  }
  if (query.status) conditions.push(eq(timeOffRequests.status, query.status));
  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        request: timeOffRequests,
        firstName: workers.firstName,
        lastName: workers.lastName,
      })
      .from(timeOffRequests)
      .innerJoin(workers, eq(workers.id, timeOffRequests.workerId))
      .where(where)
      .orderBy(desc(timeOffRequests.createdAt), desc(timeOffRequests.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(timeOffRequests).where(where),
  ]);
  return paginated(
    rows.map((r) => toTimeOffDto(r.request, fullName(r))),
    total?.value ?? 0,
    query,
  );
}

// ---------- create ----------

export async function createRequest(
  actor: Actor,
  input: CreateTimeOffRequestInput,
): Promise<TimeOffRequestDto> {
  const orgId = requireOrgId(actor);
  const workerId = resolveWorkerId(actor, input.workerId);

  return db.transaction(async (tx) => {
    // FOR UPDATE serialises every request-creation for this worker. Without it,
    // two simultaneous requests could both run the overlap and balance checks
    // below against the same "before" state, and both be inserted.
    const [worker] = await tx
      .select()
      .from(workers)
      .where(and(eq(workers.id, workerId), eq(workers.organizationId, orgId)))
      .for('update');
    if (!worker) throw notFound('Worker');
    if (worker.status !== 'active') {
      throw conflict('Time off can only be requested for active workers', 'worker_not_active');
    }
    if (worker.type !== 'employee') {
      throw conflict('Contractors do not request time off', 'not_applicable_to_contractors');
    }
    if (input.startDate < worker.startDate) {
      throw badRequest('Time off cannot start before the worker’s start date', 'before_start_date');
    }
    if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) {
      // Balances are per calendar year; split a Dec→Jan absence into two requests.
      throw badRequest('Start and end must be in the same calendar year', 'spans_years');
    }
    const days = countBusinessDays(input.startDate, input.endDate);
    if (days === 0) throw badRequest('The range contains no working days', 'no_working_days');

    const [overlap] = await tx
      .select({ id: timeOffRequests.id })
      .from(timeOffRequests)
      .where(
        and(
          eq(timeOffRequests.workerId, worker.id),
          inArray(timeOffRequests.status, LIVE_STATUSES),
          // Inclusive ranges overlap when each starts on or before the other ends.
          lte(timeOffRequests.startDate, input.endDate),
          gte(timeOffRequests.endDate, input.startDate),
        ),
      )
      .limit(1);
    if (overlap) {
      throw conflict('This overlaps an existing time-off request', 'overlapping_request');
    }

    if (input.type === 'vacation') {
      const [country] = await tx
        .select({ annualLeaveDays: countries.annualLeaveDays })
        .from(countries)
        .where(eq(countries.code, worker.countryCode))
        .limit(1);
      const balance = await computeBalance(
        tx,
        { ...worker, annualLeaveDays: country?.annualLeaveDays ?? 0 },
        Number(input.startDate.slice(0, 4)),
      );
      if (days > balance.remainingDays) {
        throw conflict(
          `Requested ${days} days but only ${balance.remainingDays} remain`,
          'insufficient_balance',
        );
      }
    }

    const [row] = await tx
      .insert(timeOffRequests)
      .values({
        organizationId: orgId,
        workerId: worker.id,
        type: input.type,
        status: 'pending',
        startDate: input.startDate,
        endDate: input.endDate,
        days,
        reason: input.reason || null,
      })
      .returning();
    if (!row) throw new Error('Failed to create time-off request');

    await recordAudit(tx, actor, {
      action: 'time_off.requested',
      entityType: 'time_off_request',
      entityId: row.id,
      metadata: { workerId: worker.id, type: row.type, days },
    });
    return toTimeOffDto(row, fullName(worker));
  });
}

// ---------- decision & cancel ----------

export async function decideRequest(
  actor: Actor,
  requestId: string,
  input: DecisionInput,
): Promise<TimeOffRequestDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const { row: before, workerName } = await loadVisible(tx, actor, requestId);
    if (!canTransition(TIME_OFF_TRANSITIONS, before.status, input.decision)) {
      throw conflict(`Cannot decide a request that is ${before.status}`, 'invalid_transition');
    }
    const [row] = await tx
      .update(timeOffRequests)
      .set({
        status: input.decision,
        decidedBy: actor.userId,
        decidedAt: new Date(),
        decisionNote: input.note || null,
      })
      .where(
        and(
          eq(timeOffRequests.id, requestId),
          eq(timeOffRequests.organizationId, orgId),
          eq(timeOffRequests.status, before.status),
        ),
      )
      .returning();
    // Someone else decided or cancelled it between our read and our write.
    if (!row) throw conflict('The request was changed by someone else', 'invalid_transition');

    await recordAudit(tx, actor, {
      action: `time_off.${input.decision}`,
      entityType: 'time_off_request',
      entityId: row.id,
      metadata: { workerId: row.workerId, from: before.status, note: row.decisionNote },
    });
    return toTimeOffDto(row, workerName);
  });
}

export async function cancelRequest(actor: Actor, requestId: string): Promise<TimeOffRequestDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const { row: before, workerName } = await loadVisible(tx, actor, requestId);
    if (!canTransition(TIME_OFF_TRANSITIONS, before.status, 'cancelled')) {
      throw conflict(`Cannot cancel a request that is ${before.status}`, 'invalid_transition');
    }
    // A worker cannot retroactively un-take leave that has begun; their manager can
    // (e.g. they came back early), which is why this applies to workers only.
    if (isWorker(actor) && before.status === 'approved' && before.startDate <= today()) {
      throw conflict('This time off has already started', 'already_started');
    }
    const [row] = await tx
      .update(timeOffRequests)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(timeOffRequests.id, requestId),
          eq(timeOffRequests.organizationId, orgId),
          eq(timeOffRequests.status, before.status),
        ),
      )
      .returning();
    if (!row) throw conflict('The request was changed by someone else', 'invalid_transition');

    await recordAudit(tx, actor, {
      action: 'time_off.cancelled',
      entityType: 'time_off_request',
      entityId: row.id,
      metadata: { workerId: row.workerId, from: before.status },
    });
    return toTimeOffDto(row, workerName);
  });
}
