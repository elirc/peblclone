import type { ContractDetailDto, ContractStatus, ContractTerms } from '@meridian/shared';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, contracts, onboardingTasks, workers } from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createWorker,
  loginAsWorker,
  type TestClient,
  type WorkerRow,
} from '../../test/helpers';
import { renderContract } from './template';

// ---------- helpers ----------

async function setup(
  workerOverrides: Parameters<typeof createWorker>[1] = {},
  options: Parameters<typeof createWorker>[2] = {},
) {
  const tenant = await createTenant();
  const worker = await createWorker(tenant.org.id, workerOverrides, options);
  return { ...tenant, worker };
}

async function generate(admin: TestClient, workerId: string): Promise<ContractDetailDto> {
  const res = await admin.post('/contracts').send({ workerId });
  expect(res.status).toBe(201);
  return res.body as ContractDetailDto;
}

/** Jump a contract straight to a status, to test what each endpoint does from there. */
async function forceStatus(contractId: string, status: ContractStatus) {
  await db.update(contracts).set({ status }).where(eq(contracts.id, contractId));
}

async function auditActions(entityId: string) {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId));
  return rows.map((r) => r.action);
}

async function taskStatus(workerId: string, key: string) {
  const [task] = await db
    .select({ status: onboardingTasks.status })
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.key, key)));
  return task?.status;
}

const signatureOf = (w: WorkerRow) => `${w.firstName} ${w.lastName}`;

// ---------- template (pure) ----------

const baseTerms: ContractTerms = {
  workerName: 'Ada Lovelace',
  workerType: 'employee',
  jobTitle: 'Analyst',
  countryCode: 'DE',
  countryName: 'Germany',
  startDate: '2026-03-01',
  salaryMinor: 6_000_000,
  payBasis: 'annual',
  currency: 'EUR',
  annualLeaveDays: 24,
  noticePeriodDays: 30,
  probationDays: 180,
};

describe('contract template', () => {
  it('renders an employment agreement for employees with numbered sections', () => {
    const { title, body } = renderContract(baseTerms);
    expect(title).toBe('Employment Agreement — Ada Lovelace');
    expect(body).toContain('1. PARTIES');
    expect(body).toMatch(/\n2\. POSITION AND START DATE\n/);
    expect(body).toContain('Employer of Record in Germany');
    expect(body).toContain('€60,000.00 per year');
    expect(body).toContain('24 days of paid annual leave');
    expect(body).toContain('first 180 days of employment are a probationary period');
    expect(body).toContain('30 days written notice');
    expect(body).toContain('Analyst');
    expect(body).toContain('2026-03-01');
  });

  it('numbers sections consecutively with no gaps', () => {
    const { body } = renderContract(baseTerms);
    const numbers = [...body.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(numbers.length).toBeGreaterThanOrEqual(5);
  });

  it('renders an independent contractor agreement without employee-only terms', () => {
    const { title, body } = renderContract({
      ...baseTerms,
      workerType: 'contractor',
      payBasis: 'monthly',
      salaryMinor: 500_000,
    });
    expect(title).toBe('Independent Contractor Agreement — Ada Lovelace');
    expect(body).toContain('INDEPENDENT CONTRACTOR AGREEMENT');
    expect(body).toContain('€5,000.00 per month');
    expect(body).toContain('not an employee');
    expect(body).not.toMatch(/probation/i);
    expect(body).not.toContain('paid annual leave per calendar year');
  });

  it('formats money in the contract currency, including zero-decimal currencies', () => {
    const { body } = renderContract({ ...baseTerms, currency: 'JPY', salaryMinor: 8_000_000 });
    expect(body).toContain('¥8,000,000 per year');
  });

  it('says so when there is no probation period', () => {
    expect(renderContract({ ...baseTerms, probationDays: 0 }).body).toContain(
      'There is no probationary period.',
    );
  });
});

// ---------- generate ----------

describe('POST /contracts (generate)', () => {
  it('creates a draft whose terms are a snapshot of the worker and their country', async () => {
    const { admin, worker } = await setup({ jobTitle: 'Data Scientist' });
    const contract = await generate(admin, worker.id);

    expect(contract).toMatchObject({
      workerId: worker.id,
      workerName: signatureOf(worker),
      status: 'draft',
      title: `Employment Agreement — ${signatureOf(worker)}`,
      sentAt: null,
      signedAt: null,
    });
    expect(contract.terms).toEqual({
      workerName: signatureOf(worker),
      workerType: 'employee',
      jobTitle: 'Data Scientist',
      countryCode: 'DE',
      countryName: 'Germany',
      startDate: '2025-01-01',
      salaryMinor: 6_000_000,
      payBasis: 'annual',
      currency: 'EUR',
      annualLeaveDays: 24,
      noticePeriodDays: 30,
      probationDays: 180,
    });
    expect(contract.body).toBe(renderContract(contract.terms).body);
    expect(await auditActions(contract.id)).toEqual(['contract.created']);
  });

  it('uses the contractor template for contractors', async () => {
    const { admin, worker } = await setup({ type: 'contractor' });
    const contract = await generate(admin, worker.id);
    expect(contract.title).toMatch(/^Independent Contractor Agreement/);
  });

  it('does not change when the worker’s salary changes later', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    await db.update(workers).set({ salaryMinor: 9_999_900 }).where(eq(workers.id, worker.id));

    const res = await admin.get(`/contracts/${contract.id}`);
    expect(res.body.terms.salaryMinor).toBe(6_000_000);
  });

  it('works for onboarding workers and for managers', async () => {
    const { org, worker } = await setup({ status: 'onboarding' });
    const manager = await createManager(org.id);
    const res = await manager.client.post('/contracts').send({ workerId: worker.id });
    expect(res.status).toBe(201);
  });

  for (const status of ['offboarding', 'terminated', 'cancelled'] as const) {
    it(`refuses a ${status} worker with 409 worker_not_eligible`, async () => {
      const { admin, worker } = await setup({ status, endDate: '2026-12-31' });
      const res = await admin.post('/contracts').send({ workerId: worker.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('worker_not_eligible');
    });
  }

  it('refuses a second live contract with 409 contract_exists', async () => {
    const { admin, worker } = await setup();
    await generate(admin, worker.id);
    const res = await admin.post('/contracts').send({ workerId: worker.id });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('contract_exists');
  });

  it('allows a new contract once the previous one is void', async () => {
    const { admin, worker } = await setup();
    const first = await generate(admin, worker.id);
    expect((await admin.post(`/contracts/${first.id}/void`)).status).toBe(200);
    await generate(admin, worker.id);
  });

  it('lets exactly one of two simultaneous generate requests win', async () => {
    const { admin, worker } = await setup();
    const results = await Promise.all([
      admin.post('/contracts').send({ workerId: worker.id }),
      admin.post('/contracts').send({ workerId: worker.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await db.select().from(contracts).where(eq(contracts.workerId, worker.id));
    expect(rows).toHaveLength(1);
  });

  it('validates the body', async () => {
    const { admin } = await setup();
    const missing = await admin.post('/contracts').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_error');
    expect(missing.body.error.details.workerId).toBeDefined();
    expect((await admin.post('/contracts').send({ workerId: 'nope' })).status).toBe(400);
  });

  it('answers 404 for a worker in another organization', async () => {
    const a = await createTenant();
    const b = await setup();
    const res = await a.admin.post('/contracts').send({ workerId: b.worker.id });
    expect(res.status).toBe(404);
  });

  it('is staff-only and needs a session', async () => {
    const { worker } = await setup();
    const { client } = await loginAsWorker(worker);
    expect((await client.post('/contracts').send({ workerId: worker.id })).status).toBe(403);
    expect((await anonymous().post('/contracts').send({ workerId: worker.id })).status).toBe(401);
  });

  it('lets a platform admin generate inside a chosen tenant only', async () => {
    const { org, worker } = await setup();
    const inTenant = await createPlatformAdmin(org.id);
    const noTenant = await createPlatformAdmin();
    const missing = await noTenant.client.post('/contracts').send({ workerId: worker.id });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('organization_required');
    expect((await inTenant.client.post('/contracts').send({ workerId: worker.id })).status).toBe(
      201,
    );
  });
});

// ---------- read ----------

describe('GET /contracts and /contracts/:id', () => {
  it('lists newest first with pagination and filters', async () => {
    const { org, admin } = await setup();
    const w1 = await createWorker(org.id);
    const w2 = await createWorker(org.id);
    const c1 = await generate(admin, w1.id);
    const c2 = await generate(admin, w2.id);
    await admin.post(`/contracts/${c2.id}/send`);

    const all = await admin.get('/contracts');
    expect(all.status).toBe(200);
    expect(all.body.items.map((c: { id: string }) => c.id)).toEqual([c2.id, c1.id]);
    expect(all.body).toMatchObject({ total: 2, limit: 25, offset: 0 });
    // List rows are summaries: the body is only on the detail endpoint.
    expect(all.body.items[0].body).toBeUndefined();

    const page = await admin.get('/contracts?limit=1&offset=1');
    expect(page.body.items.map((c: { id: string }) => c.id)).toEqual([c1.id]);
    expect(page.body.total).toBe(2);

    const sent = await admin.get('/contracts?status=sent');
    expect(sent.body.items.map((c: { id: string }) => c.id)).toEqual([c2.id]);
    const byWorker = await admin.get(`/contracts?workerId=${w1.id}`);
    expect(byWorker.body.items.map((c: { id: string }) => c.id)).toEqual([c1.id]);

    expect((await admin.get('/contracts?limit=500')).status).toBe(400);
  });

  it('never lists another organization’s contracts and 404s on their ids', async () => {
    const a = await createTenant();
    const b = await setup();
    const theirs = await generate(b.admin, b.worker.id);

    const list = await a.admin.get('/contracts');
    expect(list.body.items).toHaveLength(0);
    expect((await a.admin.get(`/contracts/${theirs.id}`)).status).toBe(404);
  });

  it('returns the full body on the detail endpoint', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    const res = await admin.get(`/contracts/${contract.id}`);
    expect(res.status).toBe(200);
    expect(res.body.body).toContain('1. PARTIES');
    expect(res.body.signatureIp).toBeUndefined();
  });

  it('shows a worker only their own contracts, and never drafts or voids', async () => {
    const { org, admin, worker } = await setup();
    const other = await createWorker(org.id);
    const { client } = await loginAsWorker(worker);

    const old = await generate(admin, worker.id);
    await admin.post(`/contracts/${old.id}/void`);
    const live = await generate(admin, worker.id);
    const othersContract = await generate(admin, other.id);
    await admin.post(`/contracts/${othersContract.id}/send`);

    // Draft: invisible to the worker.
    expect((await client.get('/contracts')).body.items).toHaveLength(0);
    expect((await client.get(`/contracts/${live.id}`)).status).toBe(404);

    await admin.post(`/contracts/${live.id}/send`);
    const list = await client.get('/contracts');
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([live.id]);
    expect(list.body.total).toBe(1);
    expect((await client.get(`/contracts/${live.id}`)).status).toBe(200);

    expect((await client.get(`/contracts/${old.id}`)).status).toBe(404);
    expect((await client.get(`/contracts/${othersContract.id}`)).status).toBe(404);
    expect((await client.get(`/contracts?workerId=${other.id}`)).status).toBe(404);
  });

  it('rejects a malformed id with 400', async () => {
    const { admin } = await setup();
    expect((await admin.get('/contracts/not-a-uuid')).status).toBe(400);
  });
});

// ---------- edit ----------

describe('PATCH /contracts/:id', () => {
  it('edits a draft and audits the changed fields', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    const res = await admin
      .patch(`/contracts/${contract.id}`)
      .send({ title: 'Custom title', body: 'Custom body' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Custom title', body: 'Custom body', status: 'draft' });

    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, contract.id), eq(auditLogs.action, 'contract.updated')));
    expect(log?.metadata).toEqual({ fields: ['title', 'body'] });
  });

  for (const status of ['sent', 'signed', 'active', 'terminated', 'void'] as const) {
    it(`refuses to edit a ${status} contract with 409 contract_not_editable`, async () => {
      const { admin, worker } = await setup();
      const contract = await generate(admin, worker.id);
      await forceStatus(contract.id, status);
      const res = await admin.patch(`/contracts/${contract.id}`).send({ title: 'Too late' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('contract_not_editable');
    });
  }

  it('validates the body', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    const res = await admin.patch(`/contracts/${contract.id}`).send({ title: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.title).toBeDefined();
  });

  it('is staff-only and tenant-scoped', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    const other = await createTenant();
    const { client } = await loginAsWorker(worker);

    expect((await client.patch(`/contracts/${contract.id}`).send({ title: 'x' })).status).toBe(403);
    expect((await other.admin.patch(`/contracts/${contract.id}`).send({ title: 'x' })).status).toBe(
      404,
    );
  });
});

// ---------- transitions ----------

describe('contract lifecycle', () => {
  it('goes draft -> sent -> signed -> active -> terminated, auditing each step', async () => {
    const { admin, worker } = await setup();
    const { client } = await loginAsWorker(worker);
    const contract = await generate(admin, worker.id);

    const sent = await admin.post(`/contracts/${contract.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.status).toBe('sent');
    expect(sent.body.sentAt).toEqual(expect.any(String));

    const signed = await client
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: true });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('signed');

    const active = await admin.post(`/contracts/${contract.id}/activate`);
    expect(active.body).toMatchObject({ status: 'active', activatedAt: expect.any(String) });

    const terminated = await admin.post(`/contracts/${contract.id}/terminate`);
    expect(terminated.body).toMatchObject({
      status: 'terminated',
      terminatedAt: expect.any(String),
    });

    expect(await auditActions(contract.id)).toEqual([
      'contract.created',
      'contract.sent',
      'contract.signed',
      'contract.activated',
      'contract.terminated',
    ]);
  });

  it('recall puts a sent contract back to draft so it can be edited', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    await admin.post(`/contracts/${contract.id}/send`);

    const recalled = await admin.post(`/contracts/${contract.id}/recall`);
    expect(recalled.status).toBe(200);
    expect(recalled.body).toMatchObject({ status: 'draft', sentAt: null });
    expect((await admin.patch(`/contracts/${contract.id}`).send({ title: 'Fixed' })).status).toBe(
      200,
    );
    expect(await auditActions(contract.id)).toContain('contract.recalled');
  });

  for (const from of ['draft', 'sent', 'signed'] as const) {
    it(`voids a ${from} contract`, async () => {
      const { admin, worker } = await setup();
      const contract = await generate(admin, worker.id);
      await forceStatus(contract.id, from);
      const res = await admin.post(`/contracts/${contract.id}/void`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('void');
      expect(await auditActions(contract.id)).toContain('contract.voided');
    });
  }

  // Every (action, status) pair the contract does not allow must be a 409.
  const LEGAL_FROM: Record<string, ContractStatus[]> = {
    send: ['draft'],
    recall: ['sent'],
    activate: ['signed'],
    void: ['draft', 'sent', 'signed'],
    terminate: ['active'],
  };
  const ALL: ContractStatus[] = ['draft', 'sent', 'signed', 'active', 'terminated', 'void'];
  for (const [action, legal] of Object.entries(LEGAL_FROM)) {
    for (const status of ALL.filter((s) => !legal.includes(s))) {
      it(`refuses to ${action} a ${status} contract with 409 invalid_transition`, async () => {
        const { admin, worker } = await setup();
        const contract = await generate(admin, worker.id);
        await forceStatus(contract.id, status);
        const res = await admin.post(`/contracts/${contract.id}/${action}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('invalid_transition');
        const [row] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
        expect(row?.status).toBe(status);
      });
    }
  }

  it('enforces roles: managers may send/recall but not activate, void or terminate', async () => {
    const { org, admin, worker } = await setup();
    const manager = await createManager(org.id);
    const contract = await generate(admin, worker.id);

    expect((await manager.client.post(`/contracts/${contract.id}/send`)).status).toBe(200);
    expect((await manager.client.post(`/contracts/${contract.id}/recall`)).status).toBe(200);
    for (const action of ['activate', 'void', 'terminate']) {
      expect((await manager.client.post(`/contracts/${contract.id}/${action}`)).status).toBe(403);
    }
  });

  it('keeps workers out of staff transitions', async () => {
    const { admin, worker } = await setup();
    const { client } = await loginAsWorker(worker);
    const contract = await generate(admin, worker.id);
    for (const action of ['send', 'recall', 'activate', 'void', 'terminate']) {
      expect((await client.post(`/contracts/${contract.id}/${action}`)).status).toBe(403);
    }
  });

  it('answers 404 for transitions on another organization’s contract', async () => {
    const b = await setup();
    const a = await createTenant();
    const contract = await generate(b.admin, b.worker.id);
    for (const action of ['send', 'void']) {
      expect((await a.admin.post(`/contracts/${contract.id}/${action}`)).status).toBe(404);
    }
    const [row] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
    expect(row?.status).toBe('draft');
  });

  it('lets only one of two simultaneous sends succeed', async () => {
    const { admin, worker } = await setup();
    const contract = await generate(admin, worker.id);
    const results = await Promise.all([
      admin.post(`/contracts/${contract.id}/send`),
      admin.post(`/contracts/${contract.id}/send`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await auditActions(contract.id)).filter((a) => a === 'contract.sent')).toHaveLength(1);
  });
});

// ---------- signing ----------

describe('POST /contracts/:id/sign', () => {
  async function sentContract(
    workerOverrides: Parameters<typeof createWorker>[1] = {},
    options: Parameters<typeof createWorker>[2] = {},
  ) {
    const ctx = await setup(workerOverrides, options);
    const contract = await generate(ctx.admin, ctx.worker.id);
    await ctx.admin.post(`/contracts/${contract.id}/send`);
    const login = await loginAsWorker(ctx.worker);
    return { ...ctx, contract, workerClient: login.client, workerUser: login.user };
  }

  it('records the signature, ignoring case and extra whitespace', async () => {
    const { contract, worker, workerClient, workerUser } = await sentContract();
    const typed = `  ${worker.firstName.toLowerCase()}    ${worker.lastName.toUpperCase()} `;

    const res = await workerClient
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: typed, agree: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'signed',
      signedAt: expect.any(String),
      signedByName: `${worker.firstName.toLowerCase()} ${worker.lastName.toUpperCase()}`,
    });

    const [row] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
    expect(row?.signedByUserId).toBe(workerUser.id);
    expect(row?.signatureIp).toMatch(/127\.0\.0\.1|::1/);
  });

  it('refuses a name that does not match with 400 signature_mismatch', async () => {
    const { contract, workerClient } = await sentContract();
    const res = await workerClient
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: 'Somebody Else', agree: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('signature_mismatch');
    const [row] = await db.select().from(contracts).where(eq(contracts.id, contract.id));
    expect(row?.status).toBe('sent');
  });

  it('requires agree: true and a name', async () => {
    const { contract, worker, workerClient } = await sentContract();
    const noAgree = await workerClient
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: false });
    expect(noAgree.status).toBe(400);
    expect(noAgree.body.error.details.agree).toBeDefined();
    const noName = await workerClient.post(`/contracts/${contract.id}/sign`).send({ agree: true });
    expect(noName.status).toBe(400);
  });

  it('is worker-only: a client admin gets 403', async () => {
    const { admin, contract, worker } = await sentContract();
    const res = await admin
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: true });
    expect(res.status).toBe(403);
  });

  it('answers 404 when a worker tries to sign someone else’s contract', async () => {
    const { org, contract, worker } = await sentContract();
    const intruder = await loginAsWorker(await createWorker(org.id));
    const res = await intruder.client
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: true });
    expect(res.status).toBe(404);
  });

  for (const status of ['signed', 'active', 'terminated'] as const) {
    it(`refuses to sign a ${status} contract with 409`, async () => {
      const { contract, worker, workerClient } = await sentContract();
      await forceStatus(contract.id, status);
      const res = await workerClient
        .post(`/contracts/${contract.id}/sign`)
        .send({ signedByName: signatureOf(worker), agree: true });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_transition');
    });
  }

  for (const status of ['draft', 'void'] as const) {
    it(`answers 404 for a ${status} contract, which the worker cannot see`, async () => {
      const { contract, worker, workerClient } = await sentContract();
      await forceStatus(contract.id, status);
      const res = await workerClient
        .post(`/contracts/${contract.id}/sign`)
        .send({ signedByName: signatureOf(worker), agree: true });
      expect(res.status).toBe(404);
    });
  }

  it('completes the contract_signed onboarding task', async () => {
    const { contract, worker, workerClient } = await sentContract(
      { status: 'onboarding' },
      { withTasks: true },
    );
    await workerClient
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: true });

    expect(await taskStatus(worker.id, 'contract_signed')).toBe('completed');
    // Other tasks are still pending, so the worker stays onboarding.
    const [row] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(row?.status).toBe('onboarding');
  });

  it('activates a worker whose other onboarding tasks are already complete', async () => {
    const { contract, worker, workerClient } = await sentContract(
      { status: 'onboarding' },
      { withTasks: true },
    );
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(onboardingTasks.workerId, worker.id));
    await db
      .update(onboardingTasks)
      .set({ status: 'pending', completedAt: null })
      .where(
        and(eq(onboardingTasks.workerId, worker.id), eq(onboardingTasks.key, 'contract_signed')),
      );

    const res = await workerClient
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: true });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(row?.status).toBe('active');
    const activated = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, worker.id), eq(auditLogs.action, 'worker.activated')));
    expect(activated).toHaveLength(1);
  });
});

describe('voiding a signed contract', () => {
  it('re-opens contract_signed for an onboarding worker', async () => {
    const { admin, worker } = await setup({ status: 'onboarding' }, { withTasks: true });
    const { client } = await loginAsWorker(worker);
    const contract = await generate(admin, worker.id);
    await admin.post(`/contracts/${contract.id}/send`);
    await client
      .post(`/contracts/${contract.id}/sign`)
      .send({ signedByName: signatureOf(worker), agree: true });
    expect(await taskStatus(worker.id, 'contract_signed')).toBe('completed');

    expect((await admin.post(`/contracts/${contract.id}/void`)).status).toBe(200);
    expect(await taskStatus(worker.id, 'contract_signed')).toBe('pending');
  });

  it('leaves the checklist alone for an active worker', async () => {
    const { admin, worker } = await setup({ status: 'active' }, { withTasks: true });
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(onboardingTasks.workerId, worker.id));
    const contract = await generate(admin, worker.id);
    await forceStatus(contract.id, 'signed');

    expect((await admin.post(`/contracts/${contract.id}/void`)).status).toBe(200);
    expect(await taskStatus(worker.id, 'contract_signed')).toBe('completed');
  });

  it('does not re-open the task when voiding an unsigned contract', async () => {
    const { admin, worker } = await setup({ status: 'onboarding' }, { withTasks: true });
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(
        and(eq(onboardingTasks.workerId, worker.id), eq(onboardingTasks.key, 'contract_signed')),
      );
    const contract = await generate(admin, worker.id);
    await admin.post(`/contracts/${contract.id}/send`);

    expect((await admin.post(`/contracts/${contract.id}/void`)).status).toBe(200);
    expect(await taskStatus(worker.id, 'contract_signed')).toBe('completed');
  });
});
