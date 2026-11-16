import type { DbOrTx } from '../db/client';
import { auditLogs } from '../db/schema';
import type { Actor } from './actor';

export interface AuditEntry {
  /** `<entity>.<past-tense verb>`, e.g. 'worker.created', 'payroll_run.approved'. */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Small, non-sensitive context. Never passwords, tokens or document contents. */
  metadata?: Record<string, unknown>;
  /** Defaults to the actor's organization. */
  organizationId?: string | null;
}

/**
 * Append one row to the audit trail.
 *
 * Pass the transaction (`tx`) you are already in whenever the action changes
 * data: the change and its audit record then commit or roll back TOGETHER.
 * An audit log that can miss events — or record events that never happened —
 * is worse than none.
 */
export async function recordAudit(
  dbOrTx: DbOrTx,
  actor: { userId: Actor['userId'] | null; organizationId: Actor['organizationId'] } | null,
  entry: AuditEntry,
): Promise<void> {
  await dbOrTx.insert(auditLogs).values({
    organizationId:
      entry.organizationId !== undefined ? entry.organizationId : (actor?.organizationId ?? null),
    actorUserId: actor?.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ?? {},
  });
}
