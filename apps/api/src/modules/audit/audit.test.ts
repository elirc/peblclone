import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, users } from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createUser,
  createWorker,
  loginAsWorker,
} from '../../test/helpers';

/** Insert an audit row with an explicit timestamp, so ordering is deterministic. */
async function insertLog(values: Partial<typeof auditLogs.$inferInsert> & { createdAt: Date }) {
  const [row] = await db
    .insert(auditLogs)
    .values({ action: 'thing.happened', entityType: 'thing', ...values })
    .returning();
  return row!;
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('GET /audit-logs', () => {
  it('lists the tenant’s audit trail newest first with the actor’s name', async () => {
    const t = await createTenant();
    const older = await insertLog({
      organizationId: t.org.id,
      actorUserId: t.adminUser.id,
      action: 'worker.created',
      entityType: 'worker',
      entityId: randomUUID(),
      metadata: { email: 'w@example.test' },
      createdAt: minutesAgo(10),
    });
    const newer = await insertLog({
      organizationId: t.org.id,
      actorUserId: t.adminUser.id,
      action: 'worker.updated',
      entityType: 'worker',
      createdAt: minutesAgo(1),
    });

    const res = await t.admin.get('/audit-logs');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, limit: 25, offset: 0 });
    expect(res.body.items.map((l: { id: string }) => l.id)).toEqual([newer.id, older.id]);
    expect(res.body.items[1]).toEqual({
      id: older.id,
      action: 'worker.created',
      entityType: 'worker',
      entityId: older.entityId,
      actorName: t.adminUser.fullName,
      metadata: { email: 'w@example.test' },
      createdAt: older.createdAt.toISOString(),
    });
  });

  it('includes real events written by other endpoints', async () => {
    const t = await createTenant();
    await t.admin.patch('/organization').send({ name: 'Renamed' });
    const res = await t.admin.get('/audit-logs');
    expect(res.body.items.map((l: { action: string }) => l.action)).toEqual([
      'organization.updated',
    ]);
  });

  it('shows a null actor name for system events and for users that no longer exist', async () => {
    const t = await createTenant();
    const ghost = await createUser('client_manager', t.org.id);
    await insertLog({ organizationId: t.org.id, actorUserId: null, createdAt: minutesAgo(2) });
    await insertLog({ organizationId: t.org.id, actorUserId: ghost.id, createdAt: minutesAgo(1) });
    // The foreign key normally prevents this. `session_replication_role = replica`
    // skips FK triggers for this one transaction only, to simulate a hard-deleted user.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.delete(users).where(eq(users.id, ghost.id));
    });

    const res = await t.admin.get('/audit-logs');
    expect(res.body.items.map((l: { actorName: string | null }) => l.actorName)).toEqual([
      null,
      null,
    ]);
  });

  it('is scoped to the tenant: no other tenant’s events, no platform-level events', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await insertLog({ organizationId: a.org.id, action: 'mine.created', createdAt: minutesAgo(3) });
    await insertLog({
      organizationId: b.org.id,
      action: 'theirs.created',
      createdAt: minutesAgo(2),
    });
    await insertLog({ organizationId: null, action: 'country.updated', createdAt: minutesAgo(1) });

    const res = await a.admin.get('/audit-logs');
    expect(res.body.items.map((l: { action: string }) => l.action)).toEqual(['mine.created']);

    const platform = await createPlatformAdmin(b.org.id);
    const asPlatform = await platform.client.get('/audit-logs');
    expect(asPlatform.body.items.map((l: { action: string }) => l.action)).toEqual([
      'theirs.created',
    ]);
  });

  it('filters by entityType and entityId', async () => {
    const t = await createTenant();
    const target = randomUUID();
    await insertLog({
      organizationId: t.org.id,
      entityType: 'worker',
      entityId: target,
      createdAt: minutesAgo(3),
    });
    await insertLog({
      organizationId: t.org.id,
      entityType: 'worker',
      entityId: randomUUID(),
      createdAt: minutesAgo(2),
    });
    await insertLog({
      organizationId: t.org.id,
      entityType: 'invoice',
      entityId: target,
      createdAt: minutesAgo(1),
    });

    expect((await t.admin.get('/audit-logs?entityType=worker')).body.total).toBe(2);
    expect((await t.admin.get(`/audit-logs?entityId=${target}`)).body.total).toBe(2);
    const both = await t.admin.get(`/audit-logs?entityType=worker&entityId=${target}`);
    expect(both.body.total).toBe(1);
    expect(both.body.items[0].entityType).toBe('worker');
  });

  it('paginates', async () => {
    const t = await createTenant();
    for (let i = 5; i >= 1; i -= 1) {
      await insertLog({ organizationId: t.org.id, action: `step.${i}`, createdAt: minutesAgo(i) });
    }
    const res = await t.admin.get('/audit-logs?limit=2&offset=1');
    expect(res.body).toMatchObject({ total: 5, limit: 2, offset: 1 });
    expect(res.body.items.map((l: { action: string }) => l.action)).toEqual(['step.2', 'step.3']);
  });

  it('validates the query', async () => {
    const t = await createTenant();
    expect((await t.admin.get('/audit-logs?limit=101')).status).toBe(400);
    expect((await t.admin.get('/audit-logs?entityId=nope')).status).toBe(400);
    expect((await t.admin.get('/audit-logs?offset=-1')).status).toBe(400);
  });

  it('is for admins only', async () => {
    const t = await createTenant();
    const manager = await createManager(t.org.id);
    const worker = await loginAsWorker(await createWorker(t.org.id));
    const platformNoOrg = await createPlatformAdmin();

    expect((await manager.client.get('/audit-logs')).status).toBe(403);
    expect((await worker.client.get('/audit-logs')).status).toBe(403);
    expect((await anonymous().get('/audit-logs')).status).toBe(401);
    const noOrg = await platformNoOrg.client.get('/audit-logs');
    expect(noOrg.status).toBe(400);
    expect(noOrg.body.error.code).toBe('organization_required');
  });
});
