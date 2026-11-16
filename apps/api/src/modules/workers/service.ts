import {
  canTransition,
  DOCUMENT_KIND_LABELS,
  WORKER_TRANSITIONS,
  type CreateWorkerInput,
  type InviteCreatedDto,
  type ListWorkersQuery,
  type OnboardingTaskCompletedDto,
  type OnboardingTaskDto,
  type OnboardingTaskKey,
  type Paginated,
  type TransitionWorkerInput,
  type UpdateWorkerInput,
  type WorkerCreatedDto,
  type WorkerDetailDto,
  type WorkerDto,
  type WorkerStatus,
} from '@meridian/shared';
import { and, asc, count, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../../db/client';
import {
  contracts,
  countries,
  documents,
  invitations,
  onboardingTasks,
  users,
  workers,
} from '../../db/schema';
import {
  assertCanAccessWorker,
  isPlatformAdmin,
  isWorker,
  requireOrgId,
  type Actor,
} from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import {
  badRequest,
  conflict,
  forbidden,
  isUniqueViolation,
  notFound,
  validationError,
} from '../../lib/errors';
import { iso, paginated } from '../../lib/http';
import { createInvitation, toInviteDto } from '../../lib/invites';
import { completeOnboardingTask, ONBOARDING_TASK_TEMPLATES } from '../../lib/onboarding';
import { deleteUserSessions } from '../../lib/sessions';

/**
 * A portal invite turns into a `users` row, and user emails are unique across
 * the WHOLE system (one person, one login). If the address already has a login,
 * the invite could be created but never accepted — so refuse up front with a
 * message the client can act on, instead of handing them a dead link.
 */
async function assertEmailHasNoLogin(dbOrTx: DbOrTx, email: string): Promise<void> {
  const [existing] = await dbOrTx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    throw conflict(
      'This email address already has a Meridian login and cannot be invited to the worker portal',
      'email_in_use',
    );
  }
}

type WorkerRow = typeof workers.$inferSelect;
type TaskRow = typeof onboardingTasks.$inferSelect;

// ---------- row -> DTO ----------

function toWorkerDto(row: WorkerRow, countryName: string): WorkerDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    countryCode: row.countryCode,
    countryName,
    jobTitle: row.jobTitle,
    department: row.department,
    startDate: row.startDate,
    endDate: row.endDate,
    salaryMinor: row.salaryMinor,
    payBasis: row.payBasis,
    currency: row.currency,
    // "Portal access" means the worker accepted an invite and has a login.
    hasPortalAccess: row.userId !== null,
    createdAt: iso(row.createdAt),
  };
}

function toTaskDto(row: TaskRow): OnboardingTaskDto {
  return {
    id: row.id,
    workerId: row.workerId,
    // The column is free text in the database; only this module and lib/onboarding
    // write it, always from ONBOARDING_TASK_TEMPLATES, so the narrowing is safe.
    key: taskKey(row.key),
    title: row.title,
    description: row.description,
    assignee: row.assignee,
    status: row.status,
    automatic: row.automatic,
    completedAt: iso(row.completedAt),
  };
}

function taskKey(key: string): OnboardingTaskKey {
  const template = ONBOARDING_TASK_TEMPLATES.find((t) => t.key === key);
  if (!template) throw new Error(`Unknown onboarding task key "${key}"`);
  return template.key;
}

// ---------- shared reads ----------

/** Worker + country name, scoped to the tenant. Undefined if not in this tenant. */
async function findWorkerWithCountry(
  dbOrTx: DbOrTx,
  orgId: string,
  workerId: string,
): Promise<{ worker: WorkerRow; countryName: string } | undefined> {
  const [row] = await dbOrTx
    .select({ worker: workers, countryName: countries.name })
    .from(workers)
    .innerJoin(countries, eq(countries.code, workers.countryCode))
    .where(and(eq(workers.id, workerId), eq(workers.organizationId, orgId)))
    .limit(1);
  return row;
}

async function loadWorkerDetail(
  dbOrTx: DbOrTx,
  orgId: string,
  workerId: string,
): Promise<WorkerDetailDto> {
  const found = await findWorkerWithCountry(dbOrTx, orgId, workerId);
  if (!found) throw notFound('Worker');
  const tasks = await dbOrTx
    .select()
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.organizationId, orgId)))
    .orderBy(asc(onboardingTasks.sortOrder), asc(onboardingTasks.id));
  return { ...toWorkerDto(found.worker, found.countryName), tasks: tasks.map(toTaskDto) };
}

/**
 * Lock the worker row for the rest of the transaction. Every write path in this
 * module starts here, so two requests changing the same worker queue up instead
 * of both acting on a stale read.
 */
async function lockWorker(tx: Tx, orgId: string, workerId: string): Promise<WorkerRow> {
  const [row] = await tx
    .select()
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.organizationId, orgId)))
    .for('update');
  if (!row) throw notFound('Worker');
  return row;
}

/** `%` and `_` (and the escape char itself) are literal characters in a search box. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const emptyToNull = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null || value.length === 0 ? null : value;

// ---------- list / read ----------

export async function listWorkers(
  actor: Actor,
  query: ListWorkersQuery,
): Promise<Paginated<WorkerDto>> {
  const orgId = requireOrgId(actor);
  const conditions: SQL[] = [eq(workers.organizationId, orgId)];
  if (query.status) conditions.push(eq(workers.status, query.status));
  if (query.type) conditions.push(eq(workers.type, query.type));
  if (query.countryCode) conditions.push(eq(workers.countryCode, query.countryCode));
  if (query.search) {
    // Parameterised, so this is not an injection risk — escaping only stops
    // "100%" from meaning "100 followed by anything".
    const pattern = `%${escapeLike(query.search)}%`;
    const match = or(
      ilike(workers.firstName, pattern),
      ilike(workers.lastName, pattern),
      ilike(workers.email, pattern),
      ilike(workers.jobTitle, pattern),
    );
    if (match) conditions.push(match);
  }
  const where = and(...conditions);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({ worker: workers, countryName: countries.name })
      .from(workers)
      .innerJoin(countries, eq(countries.code, workers.countryCode))
      .where(where)
      .orderBy(asc(workers.lastName), asc(workers.firstName), asc(workers.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(workers).where(where),
  ]);
  return paginated(
    rows.map((r) => toWorkerDto(r.worker, r.countryName)),
    totalRow?.value ?? 0,
    query,
  );
}

/** Staff see any worker in their tenant; a worker sees only themselves (else 404). */
export async function getWorker(actor: Actor, workerId: string): Promise<WorkerDetailDto> {
  assertCanAccessWorker(actor, workerId);
  return loadWorkerDetail(db, requireOrgId(actor), workerId);
}

/** The worker portal's "my profile". The route guarantees role === 'worker'. */
export async function getMyWorker(actor: Actor): Promise<WorkerDetailDto> {
  if (!isWorker(actor) || !actor.workerId) throw forbidden();
  return loadWorkerDetail(db, requireOrgId(actor), actor.workerId);
}

// ---------- hire ----------

/**
 * Hiring is ONE transaction: worker, checklist, requested documents, invitation
 * and audit row either all exist afterwards or none of them do. A half-hired
 * worker (say, a worker with no checklist) would be stuck forever.
 */
export async function createWorker(
  actor: Actor,
  input: CreateWorkerInput,
): Promise<WorkerCreatedDto> {
  const orgId = requireOrgId(actor);

  const [country] = await db
    .select()
    .from(countries)
    .where(eq(countries.code, input.countryCode))
    .limit(1);
  if (!country) throw badRequest('Unknown country code', 'unknown_country');
  // Contractors are not employed by Meridian, so they can be engaged anywhere;
  // employees need Meridian to have a legal entity (EOR) in the country.
  if (input.type === 'employee' && !country.eorSupported) {
    throw badRequest(`Meridian cannot employ people in ${country.name} yet`, 'eor_not_supported');
  }

  return db.transaction(async (tx) => {
    let worker: WorkerRow | undefined;
    try {
      [worker] = await tx
        .insert(workers)
        .values({
          organizationId: orgId,
          type: input.type,
          status: 'onboarding',
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          countryCode: country.code,
          jobTitle: input.jobTitle,
          department: emptyToNull(input.department) ?? null,
          startDate: input.startDate,
          salaryMinor: input.salaryMinor,
          payBasis: input.payBasis,
          // Pay currency is fixed at hire time from the country, never from the client.
          currency: country.currency,
        })
        .returning();
    } catch (err) {
      // The unique index is the real guard; a pre-check would race.
      if (isUniqueViolation(err, 'workers_org_email_unique')) {
        throw conflict('A worker with this email already exists', 'worker_email_taken');
      }
      throw err;
    }
    if (!worker) throw new Error('Failed to create worker');

    await tx.insert(onboardingTasks).values(
      ONBOARDING_TASK_TEMPLATES.map((t, i) => ({
        organizationId: orgId,
        workerId: worker.id,
        key: t.key,
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        automatic: t.automatic,
        sortOrder: i,
      })),
    );

    if (country.requiredDocuments.length > 0) {
      await tx.insert(documents).values(
        country.requiredDocuments.map((kind) => ({
          organizationId: orgId,
          workerId: worker.id,
          kind,
          title: DOCUMENT_KIND_LABELS[kind],
          status: 'requested' as const,
        })),
      );
    } else {
      // Nothing to collect means nothing to verify: tick the box now, otherwise
      // the checklist could never complete.
      await completeOnboardingTask(tx, worker.id, 'documents_verified', actor.userId);
    }

    let acceptUrl: string | null = null;
    if (input.sendInvite) {
      await assertEmailHasNoLogin(tx, worker.email);
      const created = await createInvitation(tx, {
        organizationId: orgId,
        email: worker.email,
        role: 'worker',
        workerId: worker.id,
        invitedBy: actor.userId,
      });
      acceptUrl = created.acceptUrl;
    }

    await recordAudit(tx, actor, {
      action: 'worker.created',
      entityType: 'worker',
      entityId: worker.id,
      metadata: {
        type: worker.type,
        countryCode: worker.countryCode,
        documentsRequested: country.requiredDocuments.length,
        inviteSent: input.sendInvite,
      },
    });

    return { worker: await loadWorkerDetail(tx, orgId, worker.id), acceptUrl };
  });
}

// ---------- update ----------

const EDITABLE_STATUSES: readonly WorkerStatus[] = ['onboarding', 'active'];

export async function updateWorker(
  actor: Actor,
  workerId: string,
  input: UpdateWorkerInput,
): Promise<WorkerDetailDto> {
  const orgId = requireOrgId(actor);

  return db.transaction(async (tx) => {
    const current = await lockWorker(tx, orgId, workerId);
    if (!EDITABLE_STATUSES.includes(current.status)) {
      throw conflict(`A ${current.status} worker cannot be edited`, 'worker_not_editable');
    }

    // Only fields whose value actually changes count: re-sending the current
    // start date of an active worker is not "changing" it.
    const changes: Partial<typeof workers.$inferInsert> = {};
    if (input.firstName !== undefined && input.firstName !== current.firstName) {
      changes.firstName = input.firstName;
    }
    if (input.lastName !== undefined && input.lastName !== current.lastName) {
      changes.lastName = input.lastName;
    }
    if (input.jobTitle !== undefined && input.jobTitle !== current.jobTitle) {
      changes.jobTitle = input.jobTitle;
    }
    const department = emptyToNull(input.department);
    if (department !== undefined && department !== current.department) {
      changes.department = department;
    }
    if (input.startDate !== undefined && input.startDate !== current.startDate) {
      // Once someone has started, their start date is history (payroll and
      // leave accrual depend on it).
      if (current.status !== 'onboarding') {
        throw conflict('The start date can only change during onboarding', 'start_date_locked');
      }
      changes.startDate = input.startDate;
    }
    if (input.salaryMinor !== undefined && input.salaryMinor !== current.salaryMinor) {
      changes.salaryMinor = input.salaryMinor;
    }
    if (input.payBasis !== undefined && input.payBasis !== current.payBasis) {
      changes.payBasis = input.payBasis;
    }

    const fields = Object.keys(changes);
    if (fields.length === 0) return loadWorkerDetail(tx, orgId, workerId);

    const updated = await tx
      .update(workers)
      .set(changes)
      .where(
        and(
          eq(workers.id, workerId),
          eq(workers.organizationId, orgId),
          eq(workers.status, current.status),
        ),
      )
      .returning({ id: workers.id });
    if (updated.length === 0) {
      throw conflict('The worker changed while you were editing; reload', 'worker_not_editable');
    }

    const metadata: Record<string, unknown> = { fields };
    if (changes.salaryMinor !== undefined) {
      metadata.salary = { from: current.salaryMinor, to: changes.salaryMinor };
    }
    await recordAudit(tx, actor, {
      action: 'worker.updated',
      entityType: 'worker',
      entityId: workerId,
      metadata,
    });
    return loadWorkerDetail(tx, orgId, workerId);
  });
}

// ---------- status transitions ----------

export async function transitionWorker(
  actor: Actor,
  workerId: string,
  input: TransitionWorkerInput,
): Promise<WorkerDetailDto> {
  const orgId = requireOrgId(actor);

  return db.transaction(async (tx) => {
    const current = await lockWorker(tx, orgId, workerId);
    const from = current.status;
    const to = input.to;

    if (!canTransition(WORKER_TRANSITIONS, from, to)) {
      throw conflict(`Cannot move a worker from ${from} to ${to}`, 'invalid_transition');
    }
    if (from === 'onboarding' && to === 'active') {
      // Activation is earned by finishing the checklist, never granted by a button.
      throw conflict(
        'The worker becomes active automatically when onboarding is complete',
        'onboarding_incomplete',
      );
    }

    const changes: Partial<typeof workers.$inferInsert> = { status: to };
    const effects: Record<string, number> = {};

    if (to === 'offboarding') {
      if (!input.endDate) {
        throw validationError({ endDate: ['An end date is required to start offboarding'] });
      }
      // ISO dates compare correctly as strings.
      if (input.endDate < current.startDate) {
        throw validationError({ endDate: ['End date must be on or after the start date'] });
      }
      changes.endDate = input.endDate;
    }

    if (from === 'offboarding' && to === 'active') {
      // Rescinding a resignation/termination: they are staying, so no end date.
      changes.endDate = null;
    }

    if (from === 'offboarding' && to === 'terminated') {
      const ended = await tx
        .update(contracts)
        .set({ status: 'terminated', terminatedAt: new Date() })
        .where(
          and(
            eq(contracts.workerId, workerId),
            eq(contracts.organizationId, orgId),
            eq(contracts.status, 'active'),
          ),
        )
        .returning({ id: contracts.id });
      effects.contractsTerminated = ended.length;
    }

    if (from === 'onboarding' && to === 'cancelled') {
      // A hire that never happened: no contract may stay live, and no invite
      // link may keep working.
      const voided = await tx
        .update(contracts)
        .set({ status: 'void' })
        .where(
          and(
            eq(contracts.workerId, workerId),
            eq(contracts.organizationId, orgId),
            inArray(contracts.status, ['draft', 'sent', 'signed']),
          ),
        )
        .returning({ id: contracts.id });
      const revoked = await tx
        .delete(invitations)
        .where(
          and(
            eq(invitations.workerId, workerId),
            eq(invitations.organizationId, orgId),
            isNull(invitations.acceptedAt),
          ),
        )
        .returning({ id: invitations.id });
      effects.contractsVoided = voided.length;
      effects.invitationsRevoked = revoked.length;

      // If they had already accepted their invite, the portal login must die with
      // the hire: deactivate it and end its sessions now, in this transaction.
      // (A TERMINATED worker deliberately keeps read access — they still need
      // their final payslip. Every write path already requires an active worker.)
      if (current.userId) {
        await tx.update(users).set({ isActive: false }).where(eq(users.id, current.userId));
        await deleteUserSessions(tx, current.userId);
        effects.portalLoginsDeactivated = 1;
      }
    }

    // Conditional update: the row lock above already serialises us, but the
    // WHERE status = <from> makes the rule hold even without it.
    const updated = await tx
      .update(workers)
      .set(changes)
      .where(
        and(eq(workers.id, workerId), eq(workers.organizationId, orgId), eq(workers.status, from)),
      )
      .returning({ id: workers.id });
    if (updated.length === 0) {
      throw conflict('The worker status changed in the meantime', 'invalid_transition');
    }

    await recordAudit(tx, actor, {
      action: 'worker.status_changed',
      entityType: 'worker',
      entityId: workerId,
      metadata: { from, to, reason: input.reason ?? null, ...effects },
    });
    return loadWorkerDetail(tx, orgId, workerId);
  });
}

// ---------- portal invite ----------

const NOT_INVITABLE: readonly WorkerStatus[] = ['terminated', 'cancelled'];

export async function inviteWorker(actor: Actor, workerId: string): Promise<InviteCreatedDto> {
  const orgId = requireOrgId(actor);

  return db.transaction(async (tx) => {
    const worker = await lockWorker(tx, orgId, workerId);
    if (NOT_INVITABLE.includes(worker.status)) {
      throw conflict(`A ${worker.status} worker cannot be invited`, 'worker_not_invitable');
    }
    if (worker.userId) {
      throw conflict('This worker already has portal access', 'already_has_access');
    }
    await assertEmailHasNoLogin(tx, worker.email);

    // One live link per worker: a new invite kills the old ones.
    await tx
      .delete(invitations)
      .where(
        and(
          eq(invitations.workerId, workerId),
          eq(invitations.organizationId, orgId),
          isNull(invitations.acceptedAt),
        ),
      );
    const { invite, acceptUrl } = await createInvitation(tx, {
      organizationId: orgId,
      email: worker.email,
      role: 'worker',
      workerId,
      invitedBy: actor.userId,
    });
    await recordAudit(tx, actor, {
      action: 'worker.invited',
      entityType: 'worker',
      entityId: workerId,
      metadata: { invitationId: invite.id },
    });
    return { invite: toInviteDto(invite), acceptUrl };
  });
}

// ---------- onboarding tasks ----------

/** Who may tick a manual task, by assignee. Platform admins may tick anything. */
function canCompleteTask(actor: Actor, task: TaskRow): boolean {
  if (isPlatformAdmin(actor)) return true;
  switch (task.assignee) {
    case 'worker':
      return isWorker(actor) && actor.workerId === task.workerId;
    case 'client':
      return actor.role === 'client_admin' || actor.role === 'client_manager';
    case 'platform':
      return false;
  }
}

export async function completeTask(
  actor: Actor,
  taskId: string,
): Promise<OnboardingTaskCompletedDto> {
  const orgId = requireOrgId(actor);

  return db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.id, taskId), eq(onboardingTasks.organizationId, orgId)))
      .limit(1);
    if (!task) throw notFound('Task');
    // A worker reaching for someone else's checklist learns nothing: 404.
    if (isWorker(actor) && actor.workerId !== task.workerId) throw notFound('Task');

    if (task.automatic) {
      throw conflict('This task completes automatically', 'task_is_automatic');
    }
    if (!canCompleteTask(actor, task)) throw forbidden('This task is assigned to someone else');

    // Lock order matches lib/onboarding (worker row first), so two tasks finishing
    // together cannot both miss the "last task" moment.
    const worker = await lockWorker(tx, orgId, task.workerId);

    if (task.status === 'completed') {
      // Idempotent: double-clicks and retries are harmless.
      return { task: toTaskDto(task), workerStatus: worker.status };
    }

    const result = await completeOnboardingTask(tx, task.workerId, taskKey(task.key), actor.userId);
    if (result.completed) {
      await recordAudit(tx, actor, {
        action: 'onboarding_task.completed',
        entityType: 'onboarding_task',
        entityId: task.id,
        metadata: { workerId: task.workerId, key: task.key, workerActivated: result.activated },
      });
    }

    const [after] = await tx
      .select()
      .from(onboardingTasks)
      .where(eq(onboardingTasks.id, taskId))
      .limit(1);
    const [status] = await tx
      .select({ status: workers.status })
      .from(workers)
      .where(eq(workers.id, task.workerId))
      .limit(1);
    if (!after || !status) throw notFound('Task');
    return { task: toTaskDto(after), workerStatus: status.status };
  });
}
