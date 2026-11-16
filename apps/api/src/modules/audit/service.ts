import type { AuditLogDto, ListAuditLogsQuery, Paginated } from '@meridian/shared';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../../db/client';
import { auditLogs, users } from '../../db/schema';
import { requireOrgId, type Actor } from '../../lib/actor';
import { iso, paginated } from '../../lib/http';

export async function listAuditLogs(
  actor: Actor,
  query: ListAuditLogsQuery,
): Promise<Paginated<AuditLogDto>> {
  // Platform-level events (organizationId null, e.g. a country edit) never match a tenant.
  const filters: SQL[] = [eq(auditLogs.organizationId, requireOrgId(actor))];
  if (query.entityType) filters.push(eq(auditLogs.entityType, query.entityType));
  if (query.entityId) filters.push(eq(auditLogs.entityId, query.entityId));
  const where = and(...filters);

  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        // LEFT JOIN: system events have no actor, and a deleted user leaves a null name
        // rather than making the event disappear from the trail.
        actorName: users.fullName,
        metadata: auditLogs.metadata,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(where)
      // Rows written in one transaction share a timestamp (now() is per transaction);
      // their relative order is not meaningful.
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(query.limit)
      .offset(query.offset),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);

  return paginated(
    rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
    totalRow?.total ?? 0,
    query,
  );
}
