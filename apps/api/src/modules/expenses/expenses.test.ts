import {
  EXPENSE_MAX_AGE_DAYS,
  addDays,
  toIsoDate,
  type ExpenseDto,
  type ExpenseStatus,
} from '@meridian/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, expenses, payrollRuns } from '../../db/schema';
import {
  anonymous,
  createManager,
  createTenant,
  createWorker,
  loginAsWorker,
  type TestClient,
  type WorkerRow,
} from '../../test/helpers';

// "Today" is computed, never hard-coded, so the date rules test the same thing every day.
const TODAY = toIsoDate(new Date());

// ---------- helpers ----------

async function setup(workerOverrides: Parameters<typeof createWorker>[1] = {}) {
  const tenant = await createTenant();
  const worker = await createWorker(tenant.org.id, workerOverrides);
  const login = await loginAsWorker(worker);
  return { ...tenant, worker, workerClient: login.client };
}

function submit(
  client: TestClient,
  body: Partial<{
    workerId: string;
    category: string;
    description: string;
    amountMinor: number;
    incurredOn: string;
    currency: string;
  }> = {},
) {
  return client.post('/expenses').send({
    category: 'travel',
    description: 'Train to client site',
    amountMinor: 12_345,
    incurredOn: TODAY,
    ...body,
  });
}

async function submitted(client: TestClient, body: Parameters<typeof submit>[1] = {}) {
  const res = await submit(client, body);
  expect(res.status).toBe(201);
  return res.body as ExpenseDto;
}

async function forceStatus(expenseId: string, status: ExpenseStatus) {
  await db.update(expenses).set({ status }).where(eq(expenses.id, expenseId));
}

/** What the payroll module does when a draft run claims an expense. */
async function claimByPayrollRun(worker: WorkerRow, expenseId: string) {
  const [run] = await db
    .insert(payrollRuns)
    .values({
      organizationId: worker.organizationId,
      countryCode: worker.countryCode,
      currency: worker.currency,
      periodYear: 2026,
      periodMonth: 1,
    })
    .returning();
  await db.update(expenses).set({ payrollRunId: run!.id }).where(eq(expenses.id, expenseId));
  return run!;
}

async function auditActions(entityId: string) {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId));
  return rows.map((r) => r.action);
}

// ---------- create ----------

describe('POST /expenses', () => {
  it('lets a worker submit an expense in their own pay currency', async () => {
    const { worker, workerClient } = await setup({ countryCode: 'GB' });
    // Any currency the client sends is ignored: the schema has no such field.
    const res = await submit(workerClient, { currency: 'USD' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workerId: worker.id,
      workerName: `${worker.firstName} ${worker.lastName}`,
      category: 'travel',
      description: 'Train to client site',
      amountMinor: 12_345,
      currency: 'GBP',
      incurredOn: TODAY,
      status: 'submitted',
      decisionNote: null,
      decidedAt: null,
      payrollRunId: null,
    });
    expect(await auditActions(res.body.id)).toEqual(['expense.submitted']);
  });

  it('lets staff submit for a worker, naming the worker', async () => {
    const { org, admin, worker } = await setup();
    const manager = await createManager(org.id);
    expect((await submit(admin)).status).toBe(400);
    const res = await submit(manager.client, { workerId: worker.id });
    expect(res.status).toBe(201);
    expect(res.body.workerId).toBe(worker.id);
  });

  it('accepts offboarding workers', async () => {
    const { workerClient } = await setup({ status: 'offboarding', endDate: addDays(TODAY, 30) });
    expect((await submit(workerClient)).status).toBe(201);
  });

  for (const status of ['onboarding', 'terminated', 'cancelled'] as const) {
    it(`refuses a ${status} worker with 409 worker_not_active`, async () => {
      const { admin, worker } = await setup({ status });
      const res = await submit(admin, { workerId: worker.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('worker_not_active');
    });
  }

  it('refuses a future date with 400 future_date', async () => {
    const { workerClient } = await setup();
    const res = await submit(workerClient, { incurredOn: addDays(TODAY, 1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('future_date');
  });

  it(`accepts an expense exactly ${EXPENSE_MAX_AGE_DAYS} days old but not one day older`, async () => {
    const { workerClient } = await setup();
    const oldest = await submit(workerClient, {
      incurredOn: addDays(TODAY, -EXPENSE_MAX_AGE_DAYS),
    });
    expect(oldest.status).toBe(201);

    const tooOld = await submit(workerClient, {
      incurredOn: addDays(TODAY, -EXPENSE_MAX_AGE_DAYS - 1),
    });
    expect(tooOld.status).toBe(400);
    expect(tooOld.body.error.code).toBe('too_old');
  });

  it('validates the body', async () => {
    const { workerClient } = await setup();
    const zero = await submit(workerClient, { amountMinor: 0 });
    expect(zero.status).toBe(400);
    expect(zero.body.error.code).toBe('validation_error');
    expect(zero.body.error.details.amountMinor).toBeDefined();

    expect((await submit(workerClient, { category: 'yacht' })).status).toBe(400);
    expect((await submit(workerClient, { description: '  ' })).status).toBe(400);
    expect((await submit(workerClient, { amountMinor: 10.5 })).status).toBe(400);
    expect((await submit(workerClient, { incurredOn: 'yesterday' })).status).toBe(400);
  });

  it('answers 404 when a worker submits for somebody else, or staff for another tenant', async () => {
    const { org, workerClient } = await setup();
    const colleague = await createWorker(org.id);
    expect((await submit(workerClient, { workerId: colleague.id })).status).toBe(404);

    const other = await createTenant();
    expect((await submit(other.admin, { workerId: colleague.id })).status).toBe(404);
  });

  it('requires a session', async () => {
    expect((await submit(anonymous())).status).toBe(401);
  });
});

// ---------- list ----------

describe('GET /expenses', () => {
  it('lists newest first with pagination and filters for staff', async () => {
    const { org, admin, worker } = await setup();
    const colleague = await createWorker(org.id);
    const e1 = await submitted(admin, { workerId: worker.id });
    const e2 = await submitted(admin, { workerId: colleague.id });
    await admin.post(`/expenses/${e2.id}/decision`).send({ decision: 'approved' });

    const all = await admin.get('/expenses');
    expect(all.status).toBe(200);
    expect(all.body.items.map((e: { id: string }) => e.id)).toEqual([e2.id, e1.id]);
    expect(all.body).toMatchObject({ total: 2, limit: 25, offset: 0 });

    const page = await admin.get('/expenses?limit=1&offset=1');
    expect(page.body.items.map((e: { id: string }) => e.id)).toEqual([e1.id]);
    expect(page.body.total).toBe(2);

    const approved = await admin.get('/expenses?status=approved');
    expect(approved.body.items.map((e: { id: string }) => e.id)).toEqual([e2.id]);
    const byWorker = await admin.get(`/expenses?workerId=${worker.id}`);
    expect(byWorker.body.items.map((e: { id: string }) => e.id)).toEqual([e1.id]);

    expect((await admin.get('/expenses?status=lost')).status).toBe(400);
  });

  it('shows a worker only their own expenses', async () => {
    const { org, admin, worker, workerClient } = await setup();
    const colleague = await createWorker(org.id);
    const own = await submitted(workerClient);
    await submitted(admin, { workerId: colleague.id });

    const res = await workerClient.get('/expenses');
    expect(res.body.items.map((e: { id: string }) => e.id)).toEqual([own.id]);
    expect(res.body.total).toBe(1);
    expect((await workerClient.get(`/expenses?workerId=${colleague.id}`)).status).toBe(404);
    expect((await workerClient.get(`/expenses?workerId=${worker.id}`)).status).toBe(200);
  });

  it('never shows another organization’s expenses', async () => {
    const a = await createTenant();
    const b = await setup();
    await submitted(b.workerClient);
    expect((await a.admin.get('/expenses')).body.items).toHaveLength(0);
  });
});

// ---------- decision ----------

describe('POST /expenses/:id/decision', () => {
  it('approves a submitted expense, recording who and when', async () => {
    const { org, workerClient } = await setup();
    const manager = await createManager(org.id);
    const expense = await submitted(workerClient);

    const res = await manager.client
      .post(`/expenses/${expense.id}/decision`)
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'approved', decidedAt: expect.any(String) });
    const [row] = await db.select().from(expenses).where(eq(expenses.id, expense.id));
    expect(row?.decidedBy).toBe(manager.user.id);
    // Approval does not touch payroll: the payroll module claims it later.
    expect(row?.payrollRunId).toBeNull();
    expect(await auditActions(expense.id)).toEqual(['expense.submitted', 'expense.approved']);
  });

  it('rejects with a note', async () => {
    const { admin, workerClient } = await setup();
    const expense = await submitted(workerClient);
    const res = await admin
      .post(`/expenses/${expense.id}/decision`)
      .send({ decision: 'rejected', note: 'No receipt attached' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', decisionNote: 'No receipt attached' });
    expect(await auditActions(expense.id)).toContain('expense.rejected');
  });

  it('requires a note to reject (400 note_required), blank counts as missing', async () => {
    const { admin, workerClient } = await setup();
    const expense = await submitted(workerClient);
    for (const body of [{ decision: 'rejected' }, { decision: 'rejected', note: '   ' }]) {
      const res = await admin.post(`/expenses/${expense.id}/decision`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('note_required');
    }
    const [row] = await db.select().from(expenses).where(eq(expenses.id, expense.id));
    expect(row?.status).toBe('submitted');
  });

  for (const status of ['approved', 'rejected', 'reimbursed'] as const) {
    it(`refuses to decide a ${status} expense with 409 invalid_transition`, async () => {
      const { admin, workerClient } = await setup();
      const expense = await submitted(workerClient);
      await forceStatus(expense.id, status);
      for (const body of [{ decision: 'approved' }, { decision: 'rejected', note: 'x' }]) {
        const res = await admin.post(`/expenses/${expense.id}/decision`).send(body);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('invalid_transition');
      }
    });
  }

  it('validates the decision', async () => {
    const { admin, workerClient } = await setup();
    const expense = await submitted(workerClient);
    const res = await admin
      .post(`/expenses/${expense.id}/decision`)
      .send({ decision: 'reimbursed' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('is staff-only, and 404 across tenants', async () => {
    const { workerClient } = await setup();
    const other = await createTenant();
    const expense = await submitted(workerClient);
    const body = { decision: 'approved' };
    expect((await workerClient.post(`/expenses/${expense.id}/decision`).send(body)).status).toBe(
      403,
    );
    expect((await other.admin.post(`/expenses/${expense.id}/decision`).send(body)).status).toBe(
      404,
    );
    const [row] = await db.select().from(expenses).where(eq(expenses.id, expense.id));
    expect(row?.status).toBe('submitted');
  });

  it('lets only one of two simultaneous decisions win', async () => {
    const { admin, workerClient } = await setup();
    const expense = await submitted(workerClient);
    const results = await Promise.all([
      admin.post(`/expenses/${expense.id}/decision`).send({ decision: 'approved' }),
      admin.post(`/expenses/${expense.id}/decision`).send({ decision: 'rejected', note: 'no' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

// ---------- delete ----------

describe('DELETE /expenses/:id', () => {
  it('lets a worker delete their own submitted expense, and audits it', async () => {
    const { workerClient } = await setup();
    const expense = await submitted(workerClient);

    expect((await workerClient.delete(`/expenses/${expense.id}`)).status).toBe(204);
    expect(await db.select().from(expenses).where(eq(expenses.id, expense.id))).toHaveLength(0);
    expect(await auditActions(expense.id)).toEqual(['expense.submitted', 'expense.deleted']);
  });

  it('lets staff delete a submitted expense', async () => {
    const { admin, workerClient } = await setup();
    const expense = await submitted(workerClient);
    expect((await admin.delete(`/expenses/${expense.id}`)).status).toBe(204);
  });

  for (const status of ['approved', 'rejected', 'reimbursed'] as const) {
    it(`refuses to delete a ${status} expense with 409 invalid_transition`, async () => {
      const { admin, workerClient } = await setup();
      const expense = await submitted(workerClient);
      await forceStatus(expense.id, status);
      for (const client of [admin, workerClient]) {
        const res = await client.delete(`/expenses/${expense.id}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('invalid_transition');
      }
      expect(await db.select().from(expenses).where(eq(expenses.id, expense.id))).toHaveLength(1);
    });
  }

  it('never deletes an expense a payroll run has claimed', async () => {
    const { admin, worker, workerClient } = await setup();
    const approved = await submitted(workerClient);
    await forceStatus(approved.id, 'approved');
    await claimByPayrollRun(worker, approved.id);
    expect((await admin.delete(`/expenses/${approved.id}`)).status).toBe(409);

    // Even if a claimed row were somehow still `submitted`, it stays put.
    const odd = await submitted(workerClient);
    await db
      .update(expenses)
      .set({ payrollRunId: (await db.select().from(payrollRuns))[0]!.id })
      .where(eq(expenses.id, odd.id));
    const res = await admin.delete(`/expenses/${odd.id}`);
    expect(res.status).toBe(409);
    expect(await db.select().from(expenses).where(eq(expenses.id, odd.id))).toHaveLength(1);
  });

  it('answers 404 for another worker’s expense and across tenants', async () => {
    const { org, admin, workerClient } = await setup();
    const colleague = await createWorker(org.id);
    const theirs = await submitted(admin, { workerId: colleague.id });
    const other = await createTenant();

    expect((await workerClient.delete(`/expenses/${theirs.id}`)).status).toBe(404);
    expect((await other.admin.delete(`/expenses/${theirs.id}`)).status).toBe(404);
    expect(await db.select().from(expenses).where(eq(expenses.id, theirs.id))).toHaveLength(1);
    expect((await admin.delete('/expenses/not-a-uuid')).status).toBe(400);
  });
});
