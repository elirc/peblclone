import {
  CONTRACT_TRANSITIONS,
  canTransition,
  type ContractDetailDto,
  type ContractDto,
  type ContractStatus,
  type ContractTerms,
  type CreateContractInput,
  type ListContractsQuery,
  type Paginated,
  type SignContractInput,
  type UpdateContractInput,
  type WorkerStatus,
} from '@meridian/shared';
import { and, count, desc, eq, notInArray, type SQL } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../../db/client';
import { contracts, countries, workers } from '../../db/schema';
import {
  assertCanAccessWorker,
  isWorker,
  requireOrgId,
  resolveWorkerId,
  type Actor,
} from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { conflict, badRequest, isUniqueViolation, notFound } from '../../lib/errors';
import { iso, paginated } from '../../lib/http';
import { completeOnboardingTask, reopenOnboardingTask } from '../../lib/onboarding';
import { renderContract } from './template';

type ContractRow = typeof contracts.$inferSelect;

/** Statuses a worker never sees: drafts are unfinished, voids are withdrawn. */
const HIDDEN_FROM_WORKERS: ContractStatus[] = ['draft', 'void'];

/** Row -> DTO. Explicit field list: `signatureIp`, `createdBy` etc. stay private. */
function toContractDto(row: ContractRow, workerName: string): ContractDto {
  return {
    id: row.id,
    workerId: row.workerId,
    workerName,
    status: row.status,
    title: row.title,
    terms: row.terms,
    sentAt: iso(row.sentAt),
    signedAt: iso(row.signedAt),
    signedByName: row.signedByName,
    activatedAt: iso(row.activatedAt),
    terminatedAt: iso(row.terminatedAt),
    createdAt: iso(row.createdAt),
  };
}

function toContractDetailDto(row: ContractRow, workerName: string): ContractDetailDto {
  return { ...toContractDto(row, workerName), body: row.body };
}

const fullName = (w: { firstName: string; lastName: string }) => `${w.firstName} ${w.lastName}`;

/** "  ada   LOVELACE " and "Ada Lovelace" are the same signature. */
const normaliseName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Load one contract the actor may see, or throw 404. Tenant filter is in the
 * WHERE clause; worker visibility (own, not draft/void) is checked after, and
 * also answers 404 so a worker cannot probe which contract ids exist.
 */
async function loadVisible(
  dbOrTx: DbOrTx,
  actor: Actor,
  contractId: string,
): Promise<{ row: ContractRow; workerName: string; workerStatus: WorkerStatus }> {
  const [found] = await dbOrTx
    .select({
      contract: contracts,
      firstName: workers.firstName,
      lastName: workers.lastName,
      workerStatus: workers.status,
    })
    .from(contracts)
    .innerJoin(workers, eq(workers.id, contracts.workerId))
    .where(and(eq(contracts.id, contractId), eq(contracts.organizationId, requireOrgId(actor))))
    .limit(1);
  if (!found) throw notFound('Contract');
  if (isWorker(actor)) {
    if (found.contract.workerId !== actor.workerId) throw notFound('Contract');
    if (HIDDEN_FROM_WORKERS.includes(found.contract.status)) throw notFound('Contract');
  }
  return { row: found.contract, workerName: fullName(found), workerStatus: found.workerStatus };
}

// ---------- reads ----------

export async function listContracts(
  actor: Actor,
  query: ListContractsQuery,
): Promise<Paginated<ContractDto>> {
  const conditions: SQL[] = [eq(contracts.organizationId, requireOrgId(actor))];
  if (isWorker(actor)) {
    // A worker asking for someone else's contracts gets 404, like every other worker route.
    if (query.workerId) assertCanAccessWorker(actor, query.workerId);
    conditions.push(eq(contracts.workerId, resolveWorkerId(actor, undefined)));
    conditions.push(notInArray(contracts.status, HIDDEN_FROM_WORKERS));
  } else if (query.workerId) {
    conditions.push(eq(contracts.workerId, query.workerId));
  }
  if (query.status) conditions.push(eq(contracts.status, query.status));
  const where = and(...conditions);

  const [rows, [total]] = await Promise.all([
    db
      .select({ contract: contracts, firstName: workers.firstName, lastName: workers.lastName })
      .from(contracts)
      .innerJoin(workers, eq(workers.id, contracts.workerId))
      .where(where)
      // id as a tie-breaker keeps paging stable when two rows share a timestamp.
      .orderBy(desc(contracts.createdAt), desc(contracts.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ value: count() }).from(contracts).where(where),
  ]);
  return paginated(
    rows.map((r) => toContractDto(r.contract, fullName(r))),
    total?.value ?? 0,
    query,
  );
}

export async function getContract(actor: Actor, contractId: string): Promise<ContractDetailDto> {
  const { row, workerName } = await loadVisible(db, actor, contractId);
  return toContractDetailDto(row, workerName);
}

// ---------- generate & edit ----------

export async function createContract(
  actor: Actor,
  input: CreateContractInput,
): Promise<ContractDetailDto> {
  const orgId = requireOrgId(actor);
  try {
    return await db.transaction(async (tx) => {
      // Lock the worker so a concurrent cancellation (which voids live contracts)
      // cannot slip in between our status check and our insert.
      const [worker] = await tx
        .select()
        .from(workers)
        .where(and(eq(workers.id, input.workerId), eq(workers.organizationId, orgId)))
        .for('update');
      if (!worker) throw notFound('Worker');
      if (worker.status !== 'onboarding' && worker.status !== 'active') {
        throw conflict(
          `A contract cannot be generated for a worker who is ${worker.status}`,
          'worker_not_eligible',
        );
      }
      const [country] = await tx
        .select()
        .from(countries)
        .where(eq(countries.code, worker.countryCode))
        .limit(1);
      if (!country) throw notFound('Country');

      // A snapshot: later salary or country-rule changes do not rewrite a contract.
      const terms: ContractTerms = {
        workerName: fullName(worker),
        workerType: worker.type,
        jobTitle: worker.jobTitle,
        countryCode: country.code,
        countryName: country.name,
        startDate: worker.startDate,
        salaryMinor: worker.salaryMinor,
        payBasis: worker.payBasis,
        currency: worker.currency,
        annualLeaveDays: country.annualLeaveDays,
        noticePeriodDays: country.noticePeriodDays,
        probationDays: country.probationDays,
      };
      const { title, body } = renderContract(terms);

      const [row] = await tx
        .insert(contracts)
        .values({
          organizationId: orgId,
          workerId: worker.id,
          status: 'draft',
          title,
          body,
          terms,
          createdBy: actor.userId,
        })
        .returning();
      if (!row) throw new Error('Failed to create contract');

      await recordAudit(tx, actor, {
        action: 'contract.created',
        entityType: 'contract',
        entityId: row.id,
        metadata: { workerId: worker.id },
      });
      return toContractDetailDto(row, terms.workerName);
    });
  } catch (err) {
    // The partial unique index is the real guard: a SELECT-then-INSERT check
    // would let two simultaneous "generate" clicks both pass.
    if (isUniqueViolation(err, 'contracts_one_live_per_worker')) {
      throw conflict('This worker already has a live contract', 'contract_exists');
    }
    throw err;
  }
}

export async function updateContract(
  actor: Actor,
  contractId: string,
  input: UpdateContractInput,
): Promise<ContractDetailDto> {
  const orgId = requireOrgId(actor);
  if (Object.keys(input).length === 0) return getContract(actor, contractId);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(contracts)
      .set(input)
      .where(
        and(
          eq(contracts.id, contractId),
          eq(contracts.organizationId, orgId),
          eq(contracts.status, 'draft'),
        ),
      )
      .returning();
    if (!row) {
      // Zero rows: either it does not exist (for us) or it is past draft.
      await loadVisible(tx, actor, contractId);
      throw conflict('Only draft contracts can be edited', 'contract_not_editable');
    }
    await recordAudit(tx, actor, {
      action: 'contract.updated',
      entityType: 'contract',
      entityId: row.id,
      metadata: { fields: Object.keys(input) },
    });
    const { workerName } = await loadVisible(tx, actor, contractId);
    return toContractDetailDto(row, workerName);
  });
}

// ---------- transitions ----------

type ContractAction = 'send' | 'recall' | 'sign' | 'activate' | 'void' | 'terminate';

const ACTION_TARGET: Record<ContractAction, ContractStatus> = {
  send: 'sent',
  recall: 'draft',
  sign: 'signed',
  activate: 'active',
  void: 'void',
  terminate: 'terminated',
};

const AUDIT_VERB: Record<ContractAction, string> = {
  send: 'sent',
  recall: 'recalled',
  sign: 'signed',
  activate: 'activated',
  void: 'voided',
  terminate: 'terminated',
};

interface TransitionOptions {
  /** Extra checks that need the current row (e.g. the signature name). Throw to refuse. */
  check?: (row: ContractRow, workerName: string) => void;
  /** Extra columns to write alongside the status. */
  set?: Partial<typeof contracts.$inferInsert>;
  /** Side effects in the same transaction, after the status change. */
  after?: (tx: Tx, before: ContractRow, workerStatus: WorkerStatus) => Promise<void>;
}

/**
 * Every contract status change goes through here:
 *  1. read the current row (404 if the actor may not see it);
 *  2. ask CONTRACT_TRANSITIONS whether `current -> target` is legal (409 if not);
 *  3. conditional UPDATE … WHERE status = <current>. If a concurrent request
 *     changed the status in between, zero rows match and we answer 409 rather
 *     than overwrite their change.
 */
async function transition(
  actor: Actor,
  contractId: string,
  action: ContractAction,
  options: TransitionOptions = {},
): Promise<ContractDetailDto> {
  const orgId = requireOrgId(actor);
  const to = ACTION_TARGET[action];

  return db.transaction(async (tx) => {
    const { row: before, workerName } = await loadVisible(tx, actor, contractId);

    // Lock order: WORKER first, then contract — the same order the workers
    // module uses when it cancels a hire. Two transactions that take the same
    // locks in opposite orders can deadlock (Postgres kills one, which the
    // client sees as a 500); taking them in one agreed order makes them queue
    // instead. Reading the status under the lock also means the `after` hooks
    // act on current facts, not on a stale read.
    const [lockedWorker] = await tx
      .select({ status: workers.status })
      .from(workers)
      .where(and(eq(workers.id, before.workerId), eq(workers.organizationId, orgId)))
      .for('update');
    if (!lockedWorker) throw notFound('Contract');
    const workerStatus = lockedWorker.status;

    if (!canTransition(CONTRACT_TRANSITIONS, before.status, to)) {
      throw conflict(
        `Cannot ${action} a contract that is ${before.status}`,
        'invalid_transition',
      );
    }
    options.check?.(before, workerName);

    const [row] = await tx
      .update(contracts)
      .set({ ...options.set, status: to })
      .where(
        and(
          eq(contracts.id, contractId),
          eq(contracts.organizationId, orgId),
          eq(contracts.status, before.status),
        ),
      )
      .returning();
    if (!row) {
      throw conflict('The contract was changed by someone else; reload and retry', 'invalid_transition');
    }

    await options.after?.(tx, before, workerStatus);
    await recordAudit(tx, actor, {
      action: `contract.${AUDIT_VERB[action]}`,
      entityType: 'contract',
      entityId: row.id,
      metadata: { workerId: row.workerId, from: before.status, to },
    });
    return toContractDetailDto(row, workerName);
  });
}

export function sendContract(actor: Actor, contractId: string) {
  return transition(actor, contractId, 'send', { set: { sentAt: new Date() } });
}

/** Back to draft for corrections. `sentAt` is cleared: it describes the current send. */
export function recallContract(actor: Actor, contractId: string) {
  return transition(actor, contractId, 'recall', { set: { sentAt: null } });
}

export function signContract(
  actor: Actor,
  contractId: string,
  input: SignContractInput,
  signatureIp: string,
) {
  return transition(actor, contractId, 'sign', {
    check: (_row, workerName) => {
      if (normaliseName(input.signedByName) !== normaliseName(workerName)) {
        throw badRequest(
          `The signature must match the worker's full name (${workerName})`,
          'signature_mismatch',
        );
      }
    },
    set: {
      signedAt: new Date(),
      signedByName: input.signedByName.trim().replace(/\s+/g, ' '),
      signedByUserId: actor.userId,
      signatureIp,
    },
    // Signing ticks the onboarding checklist; if it was the last task, the
    // worker becomes active in this same transaction.
    after: async (tx, before) => {
      await completeOnboardingTask(tx, before.workerId, 'contract_signed', actor.userId);
    },
  });
}

export function activateContract(actor: Actor, contractId: string) {
  return transition(actor, contractId, 'activate', { set: { activatedAt: new Date() } });
}

export function voidContract(actor: Actor, contractId: string) {
  return transition(actor, contractId, 'void', {
    // A voided signature no longer counts: an onboarding worker must sign a new contract.
    after: async (tx, before, workerStatus) => {
      if (before.status === 'signed' && workerStatus === 'onboarding') {
        await reopenOnboardingTask(tx, before.workerId, 'contract_signed');
      }
    },
  });
}

export function terminateContract(actor: Actor, contractId: string) {
  return transition(actor, contractId, 'terminate', { set: { terminatedAt: new Date() } });
}
