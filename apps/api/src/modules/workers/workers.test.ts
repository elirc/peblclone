import type { ContractStatus } from '@meridian/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { COUNTRY_SEEDS } from '../../db/reference-data';
import {
  auditLogs,
  contracts,
  countries,
  documents,
  invitations,
  onboardingTasks,
  users,
  workers,
} from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createUser,
  createWorker,
  loginAsWorker,
  type WorkerRow,
} from '../../test/helpers';

// ---------- local helpers ----------

/** Countries are not truncated between tests; restore any we change. */
const touched = new Set<string>();
afterEach(async () => {
  for (const code of touched) {
    const seed = COUNTRY_SEEDS.find((c) => c.code === code);
    if (!seed) continue;
    await db
      .update(countries)
      .set({ eorSupported: true, requiredDocuments: seed.docs })
      .where(eq(countries.code, code));
  }
  touched.clear();
});
async function setCountry(code: string, values: Partial<typeof countries.$inferInsert>) {
  touched.add(code);
  await db.update(countries).set(values).where(eq(countries.code, code));
}

const hireBody = (overrides: Record<string, unknown> = {}) => ({
  type: 'employee',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.test',
  countryCode: 'DE',
  jobTitle: 'Analyst',
  startDate: '2026-12-01',
  salaryMinor: 7_000_000,
  payBasis: 'annual',
  ...overrides,
});

async function insertContract(worker: WorkerRow, status: ContractStatus) {
  const [row] = await db
    .insert(contracts)
    .values({
      organizationId: worker.organizationId,
      workerId: worker.id,
      status,
      title: 'Employment agreement',
      body: 'Terms...',
      terms: {
        workerName: `${worker.firstName} ${worker.lastName}`,
        workerType: worker.type,
        jobTitle: worker.jobTitle,
        countryCode: worker.countryCode,
        countryName: 'Germany',
        startDate: worker.startDate,
        salaryMinor: worker.salaryMinor,
        payBasis: worker.payBasis,
        currency: worker.currency,
        annualLeaveDays: 24,
        noticePeriodDays: 30,
        probationDays: 180,
      },
    })
    .returning();
  if (!row) throw new Error('contract insert failed');
  return row;
}

const tasksOf = (workerId: string) =>
  db.select().from(onboardingTasks).where(eq(onboardingTasks.workerId, workerId));

async function taskOf(workerId: string, key: string) {
  const [task] = await db
    .select()
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.key, key)));
  if (!task) throw new Error(`no task ${key}`);
  return task;
}

const auditsFor = (action: string) =>
  db.select().from(auditLogs).where(eq(auditLogs.action, action));

// ---------- hire ----------

describe('POST /workers (hire)', () => {
  it('creates an onboarding worker with checklist, requested documents and an invite', async () => {
    const { org, admin } = await createTenant();
    const res = await admin.post('/workers').send(hireBody());

    expect(res.status).toBe(201);
    const worker = res.body.worker;
    expect(worker).toMatchObject({
      type: 'employee',
      status: 'onboarding',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      countryCode: 'DE',
      countryName: 'Germany',
      currency: 'EUR',
      department: null,
      endDate: null,
      hasPortalAccess: false,
    });
    expect(worker.tasks.map((t: { key: string }) => t.key)).toEqual([
      'contract_signed',
      'documents_verified',
      'bank_details',
      'client_confirm_start',
    ]);
    expect(worker.tasks.every((t: { status: string }) => t.status === 'pending')).toBe(true);
    expect(res.body.acceptUrl).toMatch(/\/accept-invite\?token=.{40,}/);

    const docs = await db.select().from(documents).where(eq(documents.workerId, worker.id));
    expect(docs.map((d) => d.kind).sort()).toEqual(
      ['bank_proof', 'passport', 'proof_of_address', 'tax_form'],
    );
    expect(docs.find((d) => d.kind === 'bank_proof')?.title).toBe('Proof of bank account');
    expect(docs.every((d) => d.status === 'requested' && d.organizationId === org.id)).toBe(true);

    const invites = await db.select().from(invitations).where(eq(invitations.workerId, worker.id));
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ role: 'worker', email: 'ada@example.test' });

    const [audit] = await auditsFor('worker.created');
    expect(audit).toMatchObject({ entityId: worker.id, organizationId: org.id });
  });

  it('copies the currency from the country, ignoring anything the client sends', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/workers').send(hireBody({ countryCode: 'jp', currency: 'USD' }));
    expect(res.status).toBe(201);
    expect(res.body.worker).toMatchObject({ countryCode: 'JP', currency: 'JPY' });
  });

  it('skips the invite when sendInvite is false', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/workers').send(hireBody({ sendInvite: false }));
    expect(res.status).toBe(201);
    expect(res.body.acceptUrl).toBeNull();
    expect(await db.select().from(invitations)).toHaveLength(0);
  });

  it('completes documents_verified at once when the country requires no documents', async () => {
    await setCountry('NL', { requiredDocuments: [] });
    const { admin } = await createTenant();
    const res = await admin.post('/workers').send(hireBody({ countryCode: 'NL' }));

    expect(res.status).toBe(201);
    const task = res.body.worker.tasks.find((t: { key: string }) => t.key === 'documents_verified');
    expect(task.status).toBe('completed');
    expect(task.completedAt).toEqual(expect.any(String));
    expect(res.body.worker.status).toBe('onboarding');
    expect(await db.select().from(documents)).toHaveLength(0);
  });

  it('rejects an unknown country with unknown_country', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/workers').send(hireBody({ countryCode: 'ZZ' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_country');
  });

  it('refuses an employee where EOR is unsupported, but allows a contractor', async () => {
    await setCountry('BR', { eorSupported: false });
    const { admin } = await createTenant();
    const employee = await admin.post('/workers').send(hireBody({ countryCode: 'BR' }));
    expect(employee.status).toBe(400);
    expect(employee.body.error.code).toBe('eor_not_supported');

    const contractor = await admin
      .post('/workers')
      .send(hireBody({ countryCode: 'BR', type: 'contractor' }));
    expect(contractor.status).toBe(201);
  });

  it('rejects a duplicate email with 409 and leaves nothing behind', async () => {
    const { admin } = await createTenant();
    const first = await admin.post('/workers').send(hireBody());
    expect(first.status).toBe(201);

    // Same address, different case: the schema lower-cases emails.
    const dup = await admin.post('/workers').send(hireBody({ email: 'ADA@example.test' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('worker_email_taken');

    expect(await db.select().from(workers)).toHaveLength(1);
    expect(await db.select().from(onboardingTasks)).toHaveLength(4);
    expect(await db.select().from(documents)).toHaveLength(4);
    expect(await db.select().from(invitations)).toHaveLength(1);
    expect(await auditsFor('worker.created')).toHaveLength(1);
  });

  it('allows the same email in two different organizations', async () => {
    const a = await createTenant();
    const b = await createTenant();
    expect((await a.admin.post('/workers').send(hireBody())).status).toBe(201);
    expect((await b.admin.post('/workers').send(hireBody())).status).toBe(201);
  });

  it('validates the body with per-field details', async () => {
    const { admin } = await createTenant();
    const res = await admin
      .post('/workers')
      .send(hireBody({ email: 'nope', salaryMinor: 0, startDate: '2026-13-40', type: 'intern' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(Object.keys(res.body.error.details).sort()).toEqual(
      ['email', 'salaryMinor', 'startDate', 'type'],
    );
  });

  it('is open to managers and platform admins (inside a tenant), not workers', async () => {
    const { org } = await createTenant();
    const manager = await createManager(org.id);
    const platform = await createPlatformAdmin(org.id);
    const worker = await loginAsWorker(await createWorker(org.id));

    expect((await manager.client.post('/workers').send(hireBody())).status).toBe(201);
    expect(
      (await platform.client.post('/workers').send(hireBody({ email: 'p@example.test' }))).status,
    ).toBe(201);
    expect(
      (await worker.client.post('/workers').send(hireBody({ email: 'w@example.test' }))).status,
    ).toBe(403);
    expect((await anonymous().post('/workers').send(hireBody())).status).toBe(401);
  });

  it('the invite link gives the worker portal access to their own record', async () => {
    const { admin } = await createTenant();
    const hired = await admin.post('/workers').send(hireBody());
    const token = new URL(hired.body.acceptUrl).searchParams.get('token');

    const accepted = await anonymous()
      .post('/auth/accept-invite')
      .send({ token, fullName: 'Ada Lovelace', password: 'a-long-enough-password' });
    expect(accepted.status).toBe(201);
    const cookie = accepted.get('Set-Cookie') ?? [];
    expect(cookie.length).toBeGreaterThan(0);

    const me = await anonymous().get('/me/worker').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ id: hired.body.worker.id, hasPortalAccess: true });
    expect((await admin.get(`/workers/${hired.body.worker.id}`)).body.hasPortalAccess).toBe(true);
  });
});

// ---------- list ----------

describe('GET /workers', () => {
  it('lists the tenant’s workers sorted by last name, then first name', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id, { firstName: 'Zed', lastName: 'Adams' });
    await createWorker(org.id, { firstName: 'Amy', lastName: 'Brown' });
    await createWorker(org.id, { firstName: 'Bob', lastName: 'Adams' });

    const res = await admin.get('/workers');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, limit: 25, offset: 0 });
    expect(res.body.items.map((w: { firstName: string }) => w.firstName)).toEqual(['Bob', 'Zed', 'Amy']);
    expect(res.body.items[0]).toMatchObject({ countryName: 'Germany', hasPortalAccess: false });
    expect(res.body.items[0]).not.toHaveProperty('tasks');
  });

  it('filters by status, type and country', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id, { lastName: 'Active' });
    await createWorker(org.id, { lastName: 'Onboard', status: 'onboarding' });
    await createWorker(org.id, { lastName: 'Contractor', type: 'contractor', countryCode: 'GB' });

    const byStatus = await admin.get('/workers?status=onboarding');
    expect(byStatus.body.items.map((w: { lastName: string }) => w.lastName)).toEqual(['Onboard']);
    const byType = await admin.get('/workers?type=contractor');
    expect(byType.body.items.map((w: { lastName: string }) => w.lastName)).toEqual(['Contractor']);
    const byCountry = await admin.get('/workers?countryCode=gb');
    expect(byCountry.body).toMatchObject({ total: 1 });
    expect(byCountry.body.items[0].countryName).toBe('United Kingdom');
  });

  it('searches names, email and job title case-insensitively', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id, { firstName: 'Grace', lastName: 'Hopper', email: 'grace@navy.test' });
    await createWorker(org.id, { firstName: 'Alan', lastName: 'Turing', jobTitle: 'Codebreaker' });
    await createWorker(org.id, { firstName: 'Kat', lastName: 'Johnson' });

    const names = async (q: string) =>
      (await admin.get(`/workers?search=${encodeURIComponent(q)}`)).body.items.map(
        (w: { lastName: string }) => w.lastName,
      );
    expect(await names('grace')).toEqual(['Hopper']);
    expect(await names('TURING')).toEqual(['Turing']);
    expect(await names('NAVY.test')).toEqual(['Hopper']);
    expect(await names('codebreak')).toEqual(['Turing']);
    expect(await names('nobody')).toEqual([]);
  });

  it('treats % and _ in the search as literal characters', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id, { lastName: 'Plain', jobTitle: 'Engineer' });
    await createWorker(org.id, { lastName: 'Percent', jobTitle: '100% remote' });
    await createWorker(org.id, { lastName: 'Underscore', email: 'under_score@example.test' });

    const names = async (q: string) =>
      (await admin.get(`/workers?search=${encodeURIComponent(q)}`)).body.items.map(
        (w: { lastName: string }) => w.lastName,
      );
    expect(await names('%')).toEqual(['Percent']);
    expect(await names('_')).toEqual(['Underscore']);
    // As a wildcard, `_` would match the "i" in "Engineer" and `%` would match "100".
    expect(await names('Eng_neer')).toEqual([]);
    expect(await names('1%remote')).toEqual([]);
    expect(await names('\\')).toEqual([]);
  });

  it('paginates with a correct total', async () => {
    const { org, admin } = await createTenant();
    for (const name of ['A', 'B', 'C']) await createWorker(org.id, { lastName: name });
    const res = await admin.get('/workers?limit=2&offset=2');
    expect(res.body).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(res.body.items.map((w: { lastName: string }) => w.lastName)).toEqual(['C']);
    expect((await admin.get('/workers?limit=101')).status).toBe(400);
    expect((await admin.get('/workers?status=retired')).status).toBe(400);
  });

  it('never shows another organization’s workers', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createWorker(b.org.id);
    expect((await a.admin.get('/workers')).body).toMatchObject({ items: [], total: 0 });
  });

  it('is staff-only', async () => {
    const { org } = await createTenant();
    const manager = await createManager(org.id);
    const worker = await loginAsWorker(await createWorker(org.id));
    expect((await manager.client.get('/workers')).status).toBe(200);
    expect((await worker.client.get('/workers')).status).toBe(403);
  });
});

// ---------- read ----------

describe('GET /workers/:id and /me/worker', () => {
  it('returns the detail with tasks ordered by sortOrder', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const res = await admin.get(`/workers/${worker.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: worker.id, countryName: 'Germany' });
    expect(res.body.tasks).toHaveLength(4);
    expect(res.body.tasks[0]).toMatchObject({
      key: 'contract_signed',
      workerId: worker.id,
      assignee: 'worker',
      automatic: true,
      status: 'pending',
      completedAt: null,
    });
  });

  it('lets a worker read their own record but answers 404 for anyone else’s', async () => {
    const { org } = await createTenant();
    const mine = await createWorker(org.id);
    const theirs = await createWorker(org.id);
    const me = await loginAsWorker(mine);

    expect((await me.client.get(`/workers/${mine.id}`)).status).toBe(200);
    const other = await me.client.get(`/workers/${theirs.id}`);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('not_found');
  });

  it('answers 404 for a worker in another organization', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const foreign = await createWorker(b.org.id);
    expect((await a.admin.get(`/workers/${foreign.id}`)).status).toBe(404);
  });

  it('rejects a malformed id with 400', async () => {
    const { admin } = await createTenant();
    expect((await admin.get('/workers/123')).status).toBe(400);
  });

  it('GET /me/worker returns the signed-in worker, and is for workers only', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, {}, { withTasks: true });
    const me = await loginAsWorker(worker);

    const res = await me.client.get('/me/worker');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: worker.id, hasPortalAccess: true });
    expect(res.body.tasks).toHaveLength(4);
    expect((await admin.get('/me/worker')).status).toBe(403);
  });
});

// ---------- update ----------

describe('PATCH /workers/:id', () => {
  it('updates the given fields and audits names of changed fields plus old/new salary', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { department: 'R&D' });
    const res = await admin
      .patch(`/workers/${worker.id}`)
      .send({ jobTitle: 'Staff Engineer', salaryMinor: 8_000_000, firstName: worker.firstName });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ jobTitle: 'Staff Engineer', salaryMinor: 8_000_000, department: 'R&D' });
    expect(res.body.tasks).toEqual([]);

    const [audit] = await auditsFor('worker.updated');
    expect(audit?.metadata).toEqual({
      fields: ['jobTitle', 'salaryMinor'],
      salary: { from: 6_000_000, to: 8_000_000 },
    });
  });

  it('clears the department with null', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { department: 'Sales' });
    const res = await admin.patch(`/workers/${worker.id}`).send({ department: null });
    expect(res.body.department).toBeNull();
  });

  it('allows a start date change while onboarding', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' });
    const res = await admin.patch(`/workers/${worker.id}`).send({ startDate: '2027-02-01' });
    expect(res.status).toBe(200);
    expect(res.body.startDate).toBe('2027-02-01');
  });

  it('locks the start date once active (409 start_date_locked)', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id);
    const res = await admin.patch(`/workers/${worker.id}`).send({ startDate: '2025-02-01' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('start_date_locked');

    // Re-sending the unchanged date is not a change.
    const same = await admin.patch(`/workers/${worker.id}`).send({ startDate: worker.startDate });
    expect(same.status).toBe(200);
  });

  it('refuses edits unless onboarding or active (409 worker_not_editable)', async () => {
    const { org, admin } = await createTenant();
    for (const status of ['offboarding', 'terminated', 'cancelled'] as const) {
      const worker = await createWorker(org.id, { status, endDate: '2025-06-30' });
      const res = await admin.patch(`/workers/${worker.id}`).send({ jobTitle: 'Nope' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('worker_not_editable');
    }
  });

  it('validates the body', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id);
    const res = await admin.patch(`/workers/${worker.id}`).send({ salaryMinor: -5, payBasis: 'weekly' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details).sort()).toEqual(['payBasis', 'salaryMinor']);
  });

  it('is staff-only and tenant-scoped', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const mine = await createWorker(a.org.id);
    const foreign = await createWorker(b.org.id);
    const manager = await createManager(a.org.id);
    const worker = await loginAsWorker(mine);

    expect((await manager.client.patch(`/workers/${mine.id}`).send({ jobTitle: 'X' })).status).toBe(200);
    expect((await worker.client.patch(`/workers/${mine.id}`).send({ jobTitle: 'Y' })).status).toBe(403);
    expect((await a.admin.patch(`/workers/${foreign.id}`).send({ jobTitle: 'Z' })).status).toBe(404);
  });
});

// ---------- transitions ----------

describe('POST /workers/:id/transition', () => {
  it('refuses onboarding -> active with onboarding_incomplete', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const res = await admin.post(`/workers/${worker.id}/transition`).send({ to: 'active' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('onboarding_incomplete');
  });

  it('starts offboarding with an end date, and audits from/to/reason', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id);
    const res = await admin
      .post(`/workers/${worker.id}/transition`)
      .send({ to: 'offboarding', endDate: '2026-12-31', reason: 'Resigned' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'offboarding', endDate: '2026-12-31' });
    const [audit] = await auditsFor('worker.status_changed');
    expect(audit?.metadata).toMatchObject({ from: 'active', to: 'offboarding', reason: 'Resigned' });
  });

  it('requires an end date for offboarding, on or after the start date', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { startDate: '2025-01-01' });

    const missing = await admin.post(`/workers/${worker.id}/transition`).send({ to: 'offboarding' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toHaveProperty('endDate');

    const early = await admin
      .post(`/workers/${worker.id}/transition`)
      .send({ to: 'offboarding', endDate: '2024-12-31' });
    expect(early.status).toBe(400);

    const sameDay = await admin
      .post(`/workers/${worker.id}/transition`)
      .send({ to: 'offboarding', endDate: '2025-01-01' });
    expect(sameDay.status).toBe(200);
  });

  it('rescinding offboarding (-> active) clears the end date', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'offboarding', endDate: '2026-06-30' });
    const res = await admin.post(`/workers/${worker.id}/transition`).send({ to: 'active' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active', endDate: null });
  });

  it('terminating also terminates the active contract', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'offboarding', endDate: '2026-06-30' });
    const contract = await insertContract(worker, 'active');

    const res = await admin.post(`/workers/${worker.id}/transition`).send({ to: 'terminated' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'terminated', endDate: '2026-06-30' });

    const [after] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
    expect(after?.status).toBe('terminated');
    expect(after?.terminatedAt).toBeInstanceOf(Date);
  });

  it('cancelling a hire voids the live contract and revokes unaccepted invitations', async () => {
    const { admin } = await createTenant();
    const hired = await admin.post('/workers').send(hireBody());
    const workerId = hired.body.worker.id;
    const [row] = await db.select().from(workers).where(eq(workers.id, workerId));
    if (!row) throw new Error('worker missing');
    const contract = await insertContract(row, 'sent');

    const res = await admin
      .post(`/workers/${workerId}/transition`)
      .send({ to: 'cancelled', reason: 'Offer declined' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');

    const [after] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
    expect(after?.status).toBe('void');
    expect(await db.select().from(invitations).where(eq(invitations.workerId, workerId))).toHaveLength(0);

    // The old link is dead.
    const token = new URL(hired.body.acceptUrl).searchParams.get('token');
    expect((await anonymous().get(`/auth/invite?token=${token}`)).status).toBe(404);
  });

  it('answers 409 invalid_transition for every move the table forbids', async () => {
    const { org, admin } = await createTenant();
    const illegal: [string, string][] = [
      ['onboarding', 'offboarding'],
      ['onboarding', 'terminated'],
      ['onboarding', 'onboarding'],
      ['active', 'terminated'],
      ['active', 'cancelled'],
      ['active', 'onboarding'],
      ['active', 'active'],
      ['offboarding', 'cancelled'],
      ['offboarding', 'onboarding'],
      ['terminated', 'active'],
      ['terminated', 'offboarding'],
      ['cancelled', 'onboarding'],
      ['cancelled', 'active'],
    ];
    for (const [from, to] of illegal) {
      const worker = await createWorker(org.id, {
        status: from as WorkerRow['status'],
        endDate: from === 'offboarding' || from === 'terminated' ? '2026-06-30' : null,
      });
      const res = await admin
        .post(`/workers/${worker.id}/transition`)
        .send({ to, endDate: '2026-12-31' });
      expect(res.status, `${from} -> ${to}`).toBe(409);
      expect(res.body.error.code).toBe('invalid_transition');
      const [after] = await db.select().from(workers).where(eq(workers.id, worker.id));
      expect(after?.status).toBe(from);
    }
    expect(await auditsFor('worker.status_changed')).toHaveLength(0);
  });

  it('is admin-only: managers and workers get 403', async () => {
    const { org } = await createTenant();
    const target = await createWorker(org.id);
    const manager = await createManager(org.id);
    const worker = await loginAsWorker(target);
    const platform = await createPlatformAdmin(org.id);
    const body = { to: 'offboarding', endDate: '2026-12-31' };

    expect((await manager.client.post(`/workers/${target.id}/transition`).send(body)).status).toBe(403);
    expect((await worker.client.post(`/workers/${target.id}/transition`).send(body)).status).toBe(403);
    expect((await platform.client.post(`/workers/${target.id}/transition`).send(body)).status).toBe(200);
  });

  it('answers 404 for another organization’s worker and 400 for a bad body', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const foreign = await createWorker(b.org.id);
    const res = await a.admin
      .post(`/workers/${foreign.id}/transition`)
      .send({ to: 'offboarding', endDate: '2026-12-31' });
    expect(res.status).toBe(404);

    const mine = await createWorker(a.org.id);
    expect((await a.admin.post(`/workers/${mine.id}/transition`).send({ to: 'fired' })).status).toBe(400);
  });
});

// ---------- invite ----------

describe('POST /workers/:id/invite', () => {
  it('creates a worker invite and replaces earlier unaccepted ones', async () => {
    const { org, admin } = await createTenant();
    const hired = await admin.post('/workers').send(hireBody());
    const workerId = hired.body.worker.id;

    const res = await admin.post(`/workers/${workerId}/invite`);
    expect(res.status).toBe(201);
    expect(res.body.invite).toMatchObject({ role: 'worker', workerId, email: 'ada@example.test' });
    expect(res.body.acceptUrl).toMatch(/\/accept-invite\?token=/);

    const live = await db.select().from(invitations).where(eq(invitations.workerId, workerId));
    expect(live.map((i) => i.id)).toEqual([res.body.invite.id]);

    const oldToken = new URL(hired.body.acceptUrl).searchParams.get('token');
    expect((await anonymous().get(`/auth/invite?token=${oldToken}`)).status).toBe(404);
    const newToken = new URL(res.body.acceptUrl).searchParams.get('token');
    expect((await anonymous().get(`/auth/invite?token=${newToken}`)).status).toBe(200);

    const [audit] = await auditsFor('worker.invited');
    expect(audit).toMatchObject({ entityId: workerId, organizationId: org.id });
  });

  it('refuses a worker who already has portal access (409 already_has_access)', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id);
    await loginAsWorker(worker);
    const res = await admin.post(`/workers/${worker.id}/invite`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_has_access');
  });

  it('refuses terminated and cancelled workers with 409', async () => {
    const { org, admin } = await createTenant();
    for (const status of ['terminated', 'cancelled'] as const) {
      const worker = await createWorker(org.id, { status, endDate: '2025-06-30' });
      const res = await admin.post(`/workers/${worker.id}/invite`);
      expect(res.status).toBe(409);
    }
    expect(await db.select().from(invitations)).toHaveLength(0);
  });

  it('is staff-only and tenant-scoped', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const target = await createWorker(a.org.id);
    const foreign = await createWorker(b.org.id);
    const manager = await createManager(a.org.id);
    const other = await loginAsWorker(await createWorker(a.org.id));

    expect((await other.client.post(`/workers/${target.id}/invite`)).status).toBe(403);
    expect((await a.admin.post(`/workers/${foreign.id}/invite`)).status).toBe(404);
    expect((await manager.client.post(`/workers/${target.id}/invite`)).status).toBe(201);
  });
});

// ---------- onboarding tasks ----------

describe('POST /onboarding-tasks/:id/complete', () => {
  it('lets the worker complete their own worker-assigned task', async () => {
    const { org } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const me = await loginAsWorker(worker);
    const task = await taskOf(worker.id, 'bank_details');

    const res = await me.client.post(`/onboarding-tasks/${task.id}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({ id: task.id, key: 'bank_details', status: 'completed' });
    expect(res.body.task.completedAt).toEqual(expect.any(String));
    expect(res.body.workerStatus).toBe('onboarding');

    const [audit] = await auditsFor('onboarding_task.completed');
    expect(audit).toMatchObject({ entityId: task.id, actorUserId: me.user.id });
  });

  it('lets client staff complete client-assigned tasks, but not worker-assigned ones', async () => {
    const { org, admin } = await createTenant();
    const manager = await createManager(org.id);
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const clientTask = await taskOf(worker.id, 'client_confirm_start');
    const workerTask = await taskOf(worker.id, 'bank_details');

    expect((await manager.client.post(`/onboarding-tasks/${clientTask.id}/complete`)).status).toBe(200);
    expect((await admin.post(`/onboarding-tasks/${workerTask.id}/complete`)).status).toBe(403);
  });

  it('does not let a worker complete a client-assigned task (403)', async () => {
    const { org } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const me = await loginAsWorker(worker);
    const clientTask = await taskOf(worker.id, 'client_confirm_start');
    expect((await me.client.post(`/onboarding-tasks/${clientTask.id}/complete`)).status).toBe(403);
  });

  it('reserves platform-assigned tasks for platform admins', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' });
    const [task] = await db
      .insert(onboardingTasks)
      .values({
        organizationId: org.id,
        workerId: worker.id,
        key: 'bank_details',
        title: 'Platform check',
        assignee: 'platform',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    const platform = await createPlatformAdmin(org.id);

    expect((await admin.post(`/onboarding-tasks/${task.id}/complete`)).status).toBe(403);
    expect((await platform.client.post(`/onboarding-tasks/${task.id}/complete`)).status).toBe(200);
  });

  it('lets a platform admin complete worker- and client-assigned tasks', async () => {
    const { org } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const platform = await createPlatformAdmin(org.id);
    for (const key of ['bank_details', 'client_confirm_start']) {
      const task = await taskOf(worker.id, key);
      expect((await platform.client.post(`/onboarding-tasks/${task.id}/complete`)).status).toBe(200);
    }
  });

  it('refuses automatic tasks with 409 task_is_automatic', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const platform = await createPlatformAdmin(org.id);
    for (const key of ['contract_signed', 'documents_verified']) {
      const task = await taskOf(worker.id, key);
      for (const c of [admin, platform.client]) {
        const res = await c.post(`/onboarding-tasks/${task.id}/complete`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('task_is_automatic');
      }
    }
  });

  it('is idempotent: completing twice returns the task unchanged', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const task = await taskOf(worker.id, 'client_confirm_start');

    const first = await admin.post(`/onboarding-tasks/${task.id}/complete`);
    const second = await admin.post(`/onboarding-tasks/${task.id}/complete`);
    expect(second.status).toBe(200);
    expect(second.body.task).toEqual(first.body.task);
    expect(await auditsFor('onboarding_task.completed')).toHaveLength(1);
  });

  it('completing the last pending task flips the worker to active', async () => {
    const { org } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const me = await loginAsWorker(worker);
    // Everything else is already done.
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(onboardingTasks.workerId, worker.id));
    const last = await taskOf(worker.id, 'bank_details');
    await db.update(onboardingTasks).set({ status: 'pending', completedAt: null }).where(eq(onboardingTasks.id, last.id));

    const res = await me.client.post(`/onboarding-tasks/${last.id}/complete`);
    expect(res.status).toBe(200);
    expect(res.body.workerStatus).toBe('active');
    expect((await me.client.get('/me/worker')).body.status).toBe('active');
    expect(await auditsFor('worker.activated')).toHaveLength(1);
    expect((await tasksOf(worker.id)).every((t) => t.status === 'completed')).toBe(true);
  });

  it('answers 404 for another worker’s task and for another organization’s task', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const mine = await createWorker(a.org.id, { status: 'onboarding' }, { withTasks: true });
    const colleague = await createWorker(a.org.id, { status: 'onboarding' }, { withTasks: true });
    const foreign = await createWorker(b.org.id, { status: 'onboarding' }, { withTasks: true });
    const me = await loginAsWorker(mine);

    const colleagueTask = await taskOf(colleague.id, 'bank_details');
    expect((await me.client.post(`/onboarding-tasks/${colleagueTask.id}/complete`)).status).toBe(404);

    const foreignTask = await taskOf(foreign.id, 'client_confirm_start');
    expect((await a.admin.post(`/onboarding-tasks/${foreignTask.id}/complete`)).status).toBe(404);
    expect((await taskOf(foreign.id, 'client_confirm_start')).status).toBe('pending');
  });

  it('rejects a malformed id and requires authentication', async () => {
    const { admin } = await createTenant();
    expect((await admin.post('/onboarding-tasks/nope/complete')).status).toBe(400);
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await anonymous().post(`/onboarding-tasks/${id}/complete`)).status).toBe(401);
    expect((await admin.post(`/onboarding-tasks/${id}/complete`)).status).toBe(404);
  });
});

// ---------- added by the lead during review (journal ch. 13) ----------
describe('review fixes', () => {
  const hireBody = {
    type: 'employee',
    firstName: 'Rita',
    lastName: 'Review',
    countryCode: 'DE',
    jobTitle: 'Analyst',
    startDate: '2026-01-15',
    salaryMinor: 5_000_000,
    payBasis: 'annual',
  };

  it('refuses to hire-with-invite an email that already has a login, and leaves nothing behind', async () => {
    const { org, admin, adminUser } = await createTenant();
    const res = await admin
      .post('/workers')
      .send({ ...hireBody, email: adminUser.email, sendInvite: true });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_in_use');
    // This failure happens AFTER the worker, tasks and documents were inserted,
    // so it is the real proof that the hire is one transaction.
    expect(await db.select().from(workers).where(eq(workers.organizationId, org.id))).toHaveLength(0);
    expect(await db.select().from(onboardingTasks)).toHaveLength(0);
    expect(await db.select().from(documents)).toHaveLength(0);
  });

  it('refuses that hire even without an invite (they could never get portal access)', async () => {
    const { admin, adminUser } = await createTenant();
    const hired = await admin
      .post('/workers')
      .send({ ...hireBody, email: adminUser.email, sendInvite: false });
    expect(hired.status).toBe(409);
    expect(hired.body.error.code).toBe('email_in_use');
  });

  it('refuses a later invite if the email gained a login in the meantime', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id);
    await createUser('client_manager', org.id, { email: worker.email });

    const invite = await admin.post(`/workers/${worker.id}/invite`);
    expect(invite.status).toBe(409);
    expect(invite.body.error.code).toBe('email_in_use');
  });

  it('cancelling an onboarding hire kills their portal login immediately', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const portal = await loginAsWorker(worker);
    expect((await portal.client.get('/me/worker')).status).toBe(200);

    const res = await admin.post(`/workers/${worker.id}/transition`).send({ to: 'cancelled' });
    expect(res.status).toBe(200);

    expect((await portal.client.get('/me/worker')).status).toBe(401);
    const [user] = await db.select().from(users).where(eq(users.id, portal.user.id));
    expect(user?.isActive).toBe(false);
  });

  it('a terminated worker keeps read access to their own record', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'offboarding', endDate: '2026-03-31' });
    const portal = await loginAsWorker(worker);

    await admin.post(`/workers/${worker.id}/transition`).send({ to: 'terminated' });
    const me = await portal.client.get('/me/worker');
    expect(me.status).toBe(200);
    expect(me.body.status).toBe('terminated');
  });
});
