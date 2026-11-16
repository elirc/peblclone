import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { sessions } from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createUser,
  createWorker,
  loginAs,
  loginAsWorker,
} from '../../test/helpers';

describe('organization profile', () => {
  it('returns the caller’s own organization', async () => {
    const { org, admin } = await createTenant();
    const res = await admin.get('/organization');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: org.id, name: org.name });
  });

  it('lets an admin update it, but not a manager', async () => {
    const { org, admin } = await createTenant();
    const manager = await createManager(org.id);

    const denied = await manager.client.patch('/organization').send({ name: 'Hacked' });
    expect(denied.status).toBe(403);

    const ok = await admin.patch('/organization').send({ name: 'Renamed Co' });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe('Renamed Co');
  });

  it('requires authentication', async () => {
    expect((await anonymous().get('/organization')).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('never shows another organization’s team', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createUser('client_manager', b.org.id, { fullName: 'Belongs To B' });

    const res = await a.admin.get('/team');
    expect(res.status).toBe(200);
    const names = res.body.items.map((m: { fullName: string }) => m.fullName);
    expect(names).not.toContain('Belongs To B');
    expect(res.body.items).toHaveLength(1);
  });

  it('answers 404 when modifying a user from another organization', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const victim = await createUser('client_manager', b.org.id);

    const res = await a.admin.patch(`/team/${victim.id}`).send({ isActive: false });
    expect(res.status).toBe(404);
  });

  it('ignores X-Org-Id from anyone who is not a platform admin', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const spoofing = await loginAs(a.adminUser, { 'X-Org-Id': b.org.id });

    const res = await spoofing.get('/organization');
    expect(res.body.id).toBe(a.org.id);
  });

  it('lets a platform admin work inside a chosen tenant', async () => {
    const { org } = await createTenant();
    const noOrg = await createPlatformAdmin();
    const withOrg = await createPlatformAdmin(org.id);

    const missing = await noOrg.client.get('/organization');
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('organization_required');

    expect((await withOrg.client.get('/organization')).body.id).toBe(org.id);
  });
});

describe('platform admin: organizations list', () => {
  it('lists every organization with headcount, for platform admins only', async () => {
    const a = await createTenant();
    await createTenant();
    await createWorker(a.org.id);
    const platform = await createPlatformAdmin();

    const res = await platform.client.get('/admin/organizations');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const row = res.body.items.find((o: { id: string }) => o.id === a.org.id);
    expect(row.workerCount).toBe(1);

    expect((await a.admin.get('/admin/organizations')).status).toBe(403);
  });
});

describe('team management', () => {
  it('invites a teammate and returns a one-time accept link', async () => {
    const { admin } = await createTenant();
    const res = await admin
      .post('/team/invites')
      .send({ email: 'Teammate@Example.test', role: 'client_manager' });

    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({
      email: 'teammate@example.test',
      role: 'client_manager',
    });
    expect(res.body.acceptUrl).toMatch(/\/accept-invite\?token=.{40,}/);

    const pending = await admin.get('/team/invites');
    expect(pending.body.items).toHaveLength(1);
    // The token itself is never listed again.
    expect(JSON.stringify(pending.body)).not.toMatch(/token/i);
  });

  it('the accept link really works end to end', async () => {
    const { org, admin } = await createTenant();
    const invited = await admin
      .post('/team/invites')
      .send({ email: 'flow@example.test', role: 'client_admin' });
    const token = new URL(invited.body.acceptUrl).searchParams.get('token');

    const accepted = await anonymous()
      .post('/auth/accept-invite')
      .send({ token, fullName: 'Flow Tester', password: 'a-long-enough-password' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user.organizationId).toBe(org.id);

    expect((await admin.get('/team')).body.items).toHaveLength(2);
    expect((await admin.get('/team/invites')).body.items).toHaveLength(0);
  });

  it('refuses to invite an email that already has an account', async () => {
    const { admin, adminUser } = await createTenant();
    const res = await admin
      .post('/team/invites')
      .send({ email: adminUser.email, role: 'client_manager' });
    expect(res.status).toBe(409);
  });

  it('cannot hand out the platform_admin or worker role', async () => {
    const { admin } = await createTenant();
    for (const role of ['platform_admin', 'worker']) {
      const res = await admin.post('/team/invites').send({ email: 'x@example.test', role });
      expect(res.status).toBe(400);
    }
  });

  it('re-inviting replaces the earlier pending invite', async () => {
    const { admin } = await createTenant();
    const body = { email: 'again@example.test', role: 'client_manager' };
    const first = await admin.post('/team/invites').send(body);
    await admin.post('/team/invites').send(body);

    expect((await admin.get('/team/invites')).body.items).toHaveLength(1);
    const oldToken = new URL(first.body.acceptUrl).searchParams.get('token');
    expect((await anonymous().get(`/auth/invite?token=${oldToken}`)).status).toBe(404);
  });

  it('revokes a pending invite', async () => {
    const { admin } = await createTenant();
    const invited = await admin
      .post('/team/invites')
      .send({ email: 'gone@example.test', role: 'client_manager' });

    expect((await admin.delete(`/team/invites/${invited.body.invite.id}`)).status).toBe(204);
    expect((await admin.get('/team/invites')).body.items).toHaveLength(0);
  });

  it('deactivating a teammate kills their sessions immediately', async () => {
    const { org, admin } = await createTenant();
    const manager = await createManager(org.id);
    expect((await manager.client.get('/auth/me')).status).toBe(200);

    const res = await admin.patch(`/team/${manager.user.id}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);

    expect((await manager.client.get('/auth/me')).status).toBe(401);
    const remaining = await db.select().from(sessions);
    expect(remaining.every((s) => s.userId !== manager.user.id)).toBe(true);
  });

  it('does not let an admin demote or deactivate themselves', async () => {
    const { admin, adminUser } = await createTenant();
    const res = await admin.patch(`/team/${adminUser.id}`).send({ role: 'client_manager' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('cannot_modify_self');
  });

  it('is off limits to managers (invites) and to workers (everything)', async () => {
    const { org } = await createTenant();
    const manager = await createManager(org.id);
    const worker = await loginAsWorker(await createWorker(org.id));

    expect(
      (
        await manager.client
          .post('/team/invites')
          .send({ email: 'a@b.test', role: 'client_manager' })
      ).status,
    ).toBe(403);
    expect((await manager.client.get('/team')).status).toBe(200);
    expect((await worker.client.get('/team')).status).toBe(403);
  });

  it('rejects a malformed id with 400 instead of a database error', async () => {
    const { admin } = await createTenant();
    const res = await admin.patch('/team/not-a-uuid').send({ isActive: false });
    expect(res.status).toBe(400);
  });
});
