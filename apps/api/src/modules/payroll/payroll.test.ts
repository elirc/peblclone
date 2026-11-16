import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, expenses, fxRates, invoices, payrollRuns, workers } from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createWorker,
  loginAsWorker,
  type Tenant,
  type TestClient,
} from '../../test/helpers';

// ---------- local helpers ----------

interface Item {
  workerId: string;
  workerName: string;
  workerType: string;
  daysWorked: number;
  daysInPeriod: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
  reimbursementsMinor: number;
  deductions: { key: string; amountMinor: number }[];
  employerCosts: { key: string; amountMinor: number }[];
}

const JAN_2026 = { countryCode: 'DE', periodYear: 2026, periodMonth: 1 };
const FEB_2026 = { countryCode: 'DE', periodYear: 2026, periodMonth: 2 };

/** Insert an expense row directly (the expenses module is someone else's, and may not exist yet). */
async function insertExpense(
  organizationId: string,
  workerId: string,
  overrides: Partial<typeof expenses.$inferInsert> = {},
) {
  const [row] = await db
    .insert(expenses)
    .values({
      organizationId,
      workerId,
      category: 'travel',
      description: 'Train to client site',
      amountMinor: 12_345,
      currency: 'EUR',
      incurredOn: '2026-01-10',
      status: 'approved',
      ...overrides,
    })
    .returning();
  return row!;
}

async function expenseRow(id: string) {
  const [row] = await db.select().from(expenses).where(eq(expenses.id, id));
  return row!;
}

const byKey = (lines: { key: string; amountMinor: number }[]) =>
  Object.fromEntries(lines.map((l) => [l.key, l.amountMinor]));

const sum = (items: Item[], field: keyof Item) =>
  items.reduce((total, item) => total + (item[field] as number), 0);

/** The header must always equal the sum of its lines. */
function expectTotalsMatchItems(run: Record<string, unknown> & { items: Item[] }) {
  expect(run.workerCount).toBe(run.items.length);
  expect(run.grossMinor).toBe(sum(run.items, 'grossMinor'));
  expect(run.deductionsMinor).toBe(sum(run.items, 'deductionsMinor'));
  expect(run.netMinor).toBe(sum(run.items, 'netMinor'));
  expect(run.employerCostMinor).toBe(sum(run.items, 'employerCostMinor'));
  expect(run.reimbursementsMinor).toBe(sum(run.items, 'reimbursementsMinor'));
  expect(run.totalCostMinor).toBe(
    (run.grossMinor as number) +
      (run.employerCostMinor as number) +
      (run.reimbursementsMinor as number),
  );
}

async function createRun(admin: TestClient, body: object = JAN_2026) {
  const res = await admin.post('/payroll/runs').send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; items: Item[] } & Record<string, unknown>;
}

/** Drive a run all the way to `paid` through the API, exactly as the real actors would. */
async function payOut(t: Tenant, runId: string) {
  const platform = await createPlatformAdmin(t.org.id);
  expect((await t.admin.post(`/payroll/runs/${runId}/submit`)).status).toBe(200);
  const approved = await t.admin.post(`/payroll/runs/${runId}/approve`);
  expect(approved.status).toBe(200);
  expect((await t.admin.post(`/invoices/${approved.body.invoiceId}/pay`)).status).toBe(200);
  expect((await platform.client.post(`/payroll/runs/${runId}/process`)).status).toBe(200);
  const paid = await platform.client.post(`/payroll/runs/${runId}/mark-paid`);
  expect(paid.status).toBe(200);
  return paid.body;
}

function monthsFromNow(offset: number) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return { periodYear: d.getUTCFullYear(), periodMonth: d.getUTCMonth() + 1 };
}

// ---------- calculation ----------

describe('POST /payroll/runs: calculation', () => {
  it('pays a German employee on €60,000/yr exactly the hand-computed amounts for a full month', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id); // DE, €60,000/yr, started 2025-01-01

    const run = await createRun(t.admin);

    // Monthly gross = 6,000,000 / 12 = 500,000 (€5,000.00). Every DE cap is above
    // that (pension/unemployment 9,660,000/12 = 805,000; health/care 6,615,000/12 = 551,250).
    //   employee: wage tax 22%     = 110,000
    //             pension 9.3%     =  46,500
    //             health 8.15%     =  40,750
    //             unemployment 1.3% =  6,500   -> deductions 203,750, net 296,250
    //   employer: pension 46,500 + health 40,750 + unemployment 6,500 + care 1.8% 9,000 = 102,750
    expect(run).toMatchObject({
      status: 'draft',
      countryCode: 'DE',
      countryName: 'Germany',
      currency: 'EUR',
      periodYear: 2026,
      periodMonth: 1,
      workerCount: 1,
      grossMinor: 500_000,
      deductionsMinor: 203_750,
      netMinor: 296_250,
      employerCostMinor: 102_750,
      reimbursementsMinor: 0,
      totalCostMinor: 602_750,
      invoiceId: null,
      rejectionReason: null,
    });
    const [item] = run.items;
    expect(item).toMatchObject({
      workerId: worker.id,
      workerName: `Wanda ${worker.lastName}`,
      workerType: 'employee',
      daysWorked: 31,
      daysInPeriod: 31,
      grossMinor: 500_000,
      netMinor: 296_250,
    });
    expect(byKey(item!.deductions)).toEqual({
      income_tax: 110_000,
      pension: 46_500,
      health: 40_750,
      unemployment: 6_500,
    });
    expect(byKey(item!.employerCosts)).toEqual({
      pension: 46_500,
      health: 40_750,
      unemployment: 6_500,
      care: 9_000,
    });
    expectTotalsMatchItems(run);
  });

  it('prorates a mid-month starter by calendar days (hand-computed)', async () => {
    const t = await createTenant();
    await createWorker(t.org.id, { startDate: '2026-03-10' });

    const run = await createRun(t.admin, { countryCode: 'DE', periodYear: 2026, periodMonth: 3 });

    // 10–31 March = 22 of 31 days. Gross = 500,000 × 22 / 31 = 354,838.71 -> 354,839.
    //   wage tax 22%  = 78,064.58 -> 78,065     pension 9.3%  = 33,000.03 -> 33,000
    //   health 8.15%  = 28,919.38 -> 28,919     unemployment 1.3% = 4,612.91 -> 4,613
    //   deductions 144,597, net 210,242
    //   employer: 33,000 + 28,919 + 4,613 + care 1.8% (6,387.10 -> 6,387) = 72,919
    const [item] = run.items;
    expect(item).toMatchObject({
      daysWorked: 22,
      daysInPeriod: 31,
      grossMinor: 354_839,
      deductionsMinor: 144_597,
      netMinor: 210_242,
      employerCostMinor: 72_919,
    });
    expect(byKey(item!.deductions)).toEqual({
      income_tax: 78_065,
      pension: 33_000,
      health: 28_919,
      unemployment: 4_613,
    });
    expect(byKey(item!.employerCosts).care).toBe(6_387);
    expectTotalsMatchItems(run);
  });

  it('caps capped contributions at the monthly ceiling for a high earner', async () => {
    const t = await createTenant();
    await createWorker(t.org.id, { salaryMinor: 12_000_000 }); // €120,000/yr -> 1,000,000/month

    const run = await createRun(t.admin);
    const [item] = run.items;
    // Health and care are charged on at most 551,250/month; pension on at most 805,000.
    expect(byKey(item!.deductions)).toMatchObject({
      income_tax: 220_000, // uncapped: 22% of 1,000,000
      pension: 74_865, // 805,000 × 9.3%
      health: 44_927, // 551,250 × 8.15% = 44,926.875
    });
    expect(byKey(item!.employerCosts).care).toBe(9_923); // 551,250 × 1.8% = 9,922.5 -> half up
  });

  it('pays contractors gross, with no deductions or employer costs', async () => {
    const t = await createTenant();
    await createWorker(t.org.id, { type: 'contractor', salaryMinor: 400_000, payBasis: 'monthly' });

    const run = await createRun(t.admin);
    expect(run.items[0]).toMatchObject({
      workerType: 'contractor',
      grossMinor: 400_000,
      deductionsMinor: 0,
      employerCostMinor: 0,
      netMinor: 400_000,
      deductions: [],
      employerCosts: [],
    });
  });

  it('includes only payable workers of this organization and country', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const active = await createWorker(t.org.id, { lastName: 'Active' });
    const offboarding = await createWorker(t.org.id, {
      lastName: 'Offboarding',
      status: 'offboarding',
      endDate: '2026-03-31',
    });
    // Left on 15 January: paid for 15 of 31 days, and still on this run.
    const leaver = await createWorker(t.org.id, {
      lastName: 'Leaver',
      status: 'terminated',
      endDate: '2026-01-15',
    });
    await createWorker(t.org.id, {
      lastName: 'LeftLastYear',
      status: 'terminated',
      endDate: '2025-12-31',
    });
    await createWorker(t.org.id, { lastName: 'Onboarding', status: 'onboarding' });
    await createWorker(t.org.id, { lastName: 'Cancelled', status: 'cancelled' });
    await createWorker(t.org.id, { lastName: 'StartsLater', startDate: '2026-02-01' });
    await createWorker(t.org.id, { lastName: 'French', countryCode: 'FR' });
    await createWorker(other.org.id, { lastName: 'OtherTenant' });

    const run = await createRun(t.admin);
    expect(run.items.map((i) => i.workerId).sort()).toEqual(
      [active.id, offboarding.id, leaver.id].sort(),
    );
    // Items come back ordered by worker name.
    expect(run.items.map((i) => i.workerName)).toEqual([
      'Wanda Active',
      'Wanda Leaver',
      'Wanda Offboarding',
    ]);
    const leaverItem = run.items.find((i) => i.workerId === leaver.id)!;
    expect(leaverItem).toMatchObject({ daysWorked: 15, grossMinor: 241_935 }); // 500,000 × 15/31
    expectTotalsMatchItems(run);
  });

  it('answers 409 no_payable_workers and leaves nothing behind', async () => {
    const t = await createTenant();
    await createWorker(t.org.id, { status: 'onboarding' });

    const res = await t.admin.post('/payroll/runs').send(JAN_2026);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_payable_workers');
    expect(await db.select().from(payrollRuns)).toHaveLength(0);
  });

  it('rejects an unknown country with 400 unknown_country', async () => {
    const t = await createTenant();
    const res = await t.admin.post('/payroll/runs').send({ ...JAN_2026, countryCode: 'ZZ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_country');
  });

  it('allows next month but refuses anything later with 400 period_too_far', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);

    const tooFar = await t.admin
      .post('/payroll/runs')
      .send({ countryCode: 'DE', ...monthsFromNow(2) });
    expect(tooFar.status).toBe(400);
    expect(tooFar.body.error.code).toBe('period_too_far');

    const next = await t.admin
      .post('/payroll/runs')
      .send({ countryCode: 'DE', ...monthsFromNow(1) });
    expect(next.status).toBe(201);
  });

  it('validates the body', async () => {
    const t = await createTenant();
    const res = await t.admin
      .post('/payroll/runs')
      .send({ countryCode: 'DE', periodYear: 2026, periodMonth: 13 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.periodMonth).toBeDefined();

    const missing = await t.admin.post('/payroll/runs').send({});
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.body.error.details)).toEqual(
      expect.arrayContaining(['countryCode', 'periodYear', 'periodMonth']),
    );
  });

  it('refuses a second run for the same period with 409 run_exists', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    await createRun(t.admin);

    const again = await t.admin.post('/payroll/runs').send(JAN_2026);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('run_exists');
  });

  it('two simultaneous creates for one period give exactly one 201 and one 409', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const expense = await insertExpense(t.org.id, worker.id);

    const results = await Promise.all([
      t.admin.post('/payroll/runs').send(JAN_2026),
      t.admin.post('/payroll/runs').send(JAN_2026),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe('run_exists');

    const runs = await db.select().from(payrollRuns);
    expect(runs).toHaveLength(1);
    expect((await expenseRow(expense.id)).payrollRunId).toBe(runs[0]!.id);
  });

  it('writes a payroll_run.created audit record', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entityId, run.id));
    expect(logs.map((l) => l.action)).toEqual(['payroll_run.created']);
    expect(logs[0]!.organizationId).toBe(t.org.id);
  });
});

// ---------- expense claiming ----------

describe('expense claiming', () => {
  it('claims only approved, unclaimed expenses and adds them to net pay', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const approvedA = await insertExpense(t.org.id, worker.id, { amountMinor: 10_000 });
    const approvedB = await insertExpense(t.org.id, worker.id, { amountMinor: 2_500 });
    const submitted = await insertExpense(t.org.id, worker.id, { status: 'submitted' });
    const rejected = await insertExpense(t.org.id, worker.id, { status: 'rejected' });

    const run = await createRun(t.admin);
    const [item] = run.items;
    expect(item!.reimbursementsMinor).toBe(12_500);
    expect(item!.netMinor).toBe(296_250 + 12_500);
    expect(run.reimbursementsMinor).toBe(12_500);
    expect(run.totalCostMinor).toBe(602_750 + 12_500);
    expectTotalsMatchItems(run);

    expect((await expenseRow(approvedA.id)).payrollRunId).toBe(run.id);
    expect((await expenseRow(approvedB.id)).payrollRunId).toBe(run.id);
    expect((await expenseRow(submitted.id)).payrollRunId).toBeNull();
    expect((await expenseRow(rejected.id)).payrollRunId).toBeNull();
  });

  it('an expense claimed by one run is not picked up by a second, and is released when the draft is deleted', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const expense = await insertExpense(t.org.id, worker.id, { amountMinor: 7_000 });

    const january = await createRun(t.admin, JAN_2026);
    expect(january.reimbursementsMinor).toBe(7_000);

    const february = await createRun(t.admin, FEB_2026);
    expect(february.reimbursementsMinor).toBe(0);
    expect((await expenseRow(expense.id)).payrollRunId).toBe(january.id);

    expect((await t.admin.delete(`/payroll/runs/${january.id}`)).status).toBe(204);
    expect((await expenseRow(expense.id)).payrollRunId).toBeNull();

    // February, recalculated, now picks it up.
    const recalculated = await t.admin.post(`/payroll/runs/${february.id}/recalculate`);
    expect(recalculated.status).toBe(200);
    expect(recalculated.body.reimbursementsMinor).toBe(7_000);
    expect((await expenseRow(expense.id)).payrollRunId).toBe(february.id);
  });

  it('recalculate releases and re-claims, and picks up changed salaries', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const first = await insertExpense(t.org.id, worker.id, { amountMinor: 1_000 });
    const run = await createRun(t.admin);

    const late = await insertExpense(t.org.id, worker.id, { amountMinor: 500 });
    await db.update(expenses).set({ status: 'rejected' }).where(eq(expenses.id, first.id));
    await db.update(workers).set({ salaryMinor: 7_200_000 }).where(eq(workers.id, worker.id));

    const res = await t.admin.post(`/payroll/runs/${run.id}/recalculate`);
    expect(res.status).toBe(200);
    expect(res.body.grossMinor).toBe(600_000);
    expect(res.body.reimbursementsMinor).toBe(500);
    expect(res.body.items).toHaveLength(1);
    expectTotalsMatchItems(res.body);
    expect((await expenseRow(first.id)).payrollRunId).toBeNull();
    expect((await expenseRow(late.id)).payrollRunId).toBe(run.id);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entityId, run.id));
    expect(logs.map((l) => l.action).sort()).toEqual([
      'payroll_run.created',
      'payroll_run.recalculated',
    ]);
  });

  it('a failed recalculation changes nothing', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const expense = await insertExpense(t.org.id, worker.id);
    const run = await createRun(t.admin);

    await db.update(workers).set({ status: 'cancelled' }).where(eq(workers.id, worker.id));
    const res = await t.admin.post(`/payroll/runs/${run.id}/recalculate`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('no_payable_workers');

    const after = await t.admin.get(`/payroll/runs/${run.id}`);
    expect(after.body.items).toHaveLength(1);
    expect((await expenseRow(expense.id)).payrollRunId).toBe(run.id);
  });

  it('mark-paid flips the run’s claimed expenses to reimbursed', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const expense = await insertExpense(t.org.id, worker.id);
    const run = await createRun(t.admin);

    await payOut(t, run.id);
    const row = await expenseRow(expense.id);
    expect(row.status).toBe('reimbursed');
    expect(row.payrollRunId).toBe(run.id);
  });
});

// ---------- lifecycle ----------

describe('payroll run lifecycle', () => {
  it('runs the whole chain: create → submit → approve → pay invoice → process → mark-paid → payslip', async () => {
    const t = await createTenant();
    const manager = await createManager(t.org.id);
    const platform = await createPlatformAdmin(t.org.id);
    const worker = await createWorker(t.org.id);
    const workerLogin = await loginAsWorker(worker);

    const run = await createRun(t.admin);

    const submitted = await manager.client.post(`/payroll/runs/${run.id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('pending_approval');
    expect(submitted.body.submittedAt).not.toBeNull();

    const approved = await t.admin.post(`/payroll/runs/${run.id}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approvedAt).not.toBeNull();
    expect(approved.body.invoiceId).toEqual(expect.any(String));
    const [approvedRow] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
    expect(approvedRow!.approvedBy).toBe(t.adminUser.id);

    // Meridian will not move money it has not been paid.
    const tooEarly = await platform.client.post(`/payroll/runs/${run.id}/process`);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('invoice_unpaid');

    // Nothing is visible to the worker until the run is paid.
    expect((await workerLogin.client.get('/payslips')).body.items).toHaveLength(0);

    expect((await t.admin.post(`/invoices/${approved.body.invoiceId}/pay`)).status).toBe(200);

    const processing = await platform.client.post(`/payroll/runs/${run.id}/process`);
    expect(processing.status).toBe(200);
    expect(processing.body.status).toBe('processing');
    expect((await workerLogin.client.get('/payslips')).body.items).toHaveLength(0);

    const paid = await platform.client.post(`/payroll/runs/${run.id}/mark-paid`);
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe('paid');
    expect(paid.body.paidAt).not.toBeNull();

    const slips = await workerLogin.client.get('/payslips');
    expect(slips.status).toBe(200);
    expect(slips.body.total).toBe(1);
    expect(slips.body.items[0]).toMatchObject({
      workerId: worker.id,
      payrollRunId: run.id,
      currency: 'EUR',
      periodYear: 2026,
      periodMonth: 1,
      grossMinor: 500_000,
      netMinor: 296_250,
      paidAt: paid.body.paidAt,
    });

    const logs = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'payroll_run'), eq(auditLogs.entityId, run.id)));
    expect(logs.map((l) => l.action).sort()).toEqual(
      [
        'payroll_run.approved',
        'payroll_run.created',
        'payroll_run.paid',
        'payroll_run.processing',
        'payroll_run.submitted',
      ].sort(),
    );
  });

  it('reject sends the run back to draft with a reason; approval clears it', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    await t.admin.post(`/payroll/runs/${run.id}/submit`);

    const rejected = await t.admin
      .post(`/payroll/runs/${run.id}/reject`)
      .send({ reason: 'Bonus missing' });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ status: 'draft', rejectionReason: 'Bonus missing' });

    // Back in draft, it can be recalculated and resubmitted.
    expect((await t.admin.post(`/payroll/runs/${run.id}/recalculate`)).status).toBe(200);
    expect((await t.admin.post(`/payroll/runs/${run.id}/submit`)).status).toBe(200);
    const approved = await t.admin.post(`/payroll/runs/${run.id}/approve`);
    expect(approved.body).toMatchObject({ status: 'approved', rejectionReason: null });

    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, run.id), eq(auditLogs.action, 'payroll_run.rejected')));
    expect(log!.metadata).toMatchObject({
      from: 'pending_approval',
      to: 'draft',
      reason: 'Bonus missing',
    });
  });

  it('reject requires a reason', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    await t.admin.post(`/payroll/runs/${run.id}/submit`);
    const res = await t.admin.post(`/payroll/runs/${run.id}/reject`).send({ reason: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBeDefined();
  });

  it('if the invoice cannot be issued, approval rolls back and the run stays pending', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    await t.admin.post(`/payroll/runs/${run.id}/submit`);

    const [saved] = await db.select().from(fxRates).where(eq(fxRates.currency, 'EUR'));
    await db.delete(fxRates).where(eq(fxRates.currency, 'EUR'));
    try {
      const res = await t.admin.post(`/payroll/runs/${run.id}/approve`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('fx_rate_missing');
    } finally {
      // Reference data is not reset between tests: put it back no matter what.
      await db.insert(fxRates).values(saved!).onConflictDoNothing();
    }

    const after = await t.admin.get(`/payroll/runs/${run.id}`);
    expect(after.body).toMatchObject({
      status: 'pending_approval',
      approvedAt: null,
      invoiceId: null,
    });
    expect(await db.select().from(invoices)).toHaveLength(0);
    const approvals = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'payroll_run.approved'));
    expect(approvals).toHaveLength(0);
  });

  it('two simultaneous approvals: one wins, one gets 409, exactly one invoice', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    await t.admin.post(`/payroll/runs/${run.id}/submit`);

    const results = await Promise.all([
      t.admin.post(`/payroll/runs/${run.id}/approve`),
      t.admin.post(`/payroll/runs/${run.id}/approve`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.select().from(invoices)).toHaveLength(1);
  });

  describe('illegal transitions answer 409 invalid_transition', () => {
    async function runIn(
      status: 'draft' | 'pending_approval' | 'approved' | 'processing' | 'paid',
    ) {
      const t = await createTenant();
      const platform = await createPlatformAdmin(t.org.id);
      await createWorker(t.org.id);
      const run = await createRun(t.admin);
      if (status !== 'draft') await t.admin.post(`/payroll/runs/${run.id}/submit`);
      if (['approved', 'processing', 'paid'].includes(status)) {
        const approved = await t.admin.post(`/payroll/runs/${run.id}/approve`);
        await t.admin.post(`/invoices/${approved.body.invoiceId}/pay`);
      }
      if (['processing', 'paid'].includes(status))
        await platform.client.post(`/payroll/runs/${run.id}/process`);
      if (status === 'paid') await platform.client.post(`/payroll/runs/${run.id}/mark-paid`);
      const [row] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, run.id));
      expect(row!.status).toBe(status);
      return { t, platform, runId: run.id };
    }

    const expect409 = (res: { status: number; body: { error: { code: string } } }) => {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('invalid_transition');
    };

    it('from draft: approve, reject, process, mark-paid', async () => {
      const { t, platform, runId } = await runIn('draft');
      expect409(await t.admin.post(`/payroll/runs/${runId}/approve`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/reject`).send({ reason: 'x' }));
      expect409(await platform.client.post(`/payroll/runs/${runId}/process`));
      expect409(await platform.client.post(`/payroll/runs/${runId}/mark-paid`));
    });

    it('from pending_approval: submit, recalculate, delete, process, mark-paid', async () => {
      const { t, platform, runId } = await runIn('pending_approval');
      expect409(await t.admin.post(`/payroll/runs/${runId}/submit`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/recalculate`));
      expect409(await t.admin.delete(`/payroll/runs/${runId}`));
      expect409(await platform.client.post(`/payroll/runs/${runId}/process`));
      expect409(await platform.client.post(`/payroll/runs/${runId}/mark-paid`));
    });

    it('from approved: submit, approve, reject, recalculate, delete, mark-paid', async () => {
      const { t, platform, runId } = await runIn('approved');
      expect409(await t.admin.post(`/payroll/runs/${runId}/submit`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/approve`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/reject`).send({ reason: 'x' }));
      expect409(await t.admin.post(`/payroll/runs/${runId}/recalculate`));
      expect409(await t.admin.delete(`/payroll/runs/${runId}`));
      expect409(await platform.client.post(`/payroll/runs/${runId}/mark-paid`));
    });

    it('from processing: process again, approve, reject, delete', async () => {
      const { t, platform, runId } = await runIn('processing');
      expect409(await platform.client.post(`/payroll/runs/${runId}/process`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/approve`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/reject`).send({ reason: 'x' }));
      expect409(await t.admin.delete(`/payroll/runs/${runId}`));
    });

    it('from paid: everything', async () => {
      const { t, platform, runId } = await runIn('paid');
      expect409(await t.admin.post(`/payroll/runs/${runId}/submit`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/approve`));
      expect409(await t.admin.post(`/payroll/runs/${runId}/reject`).send({ reason: 'x' }));
      expect409(await t.admin.post(`/payroll/runs/${runId}/recalculate`));
      expect409(await t.admin.delete(`/payroll/runs/${runId}`));
      expect409(await platform.client.post(`/payroll/runs/${runId}/process`));
      expect409(await platform.client.post(`/payroll/runs/${runId}/mark-paid`));
    });
  });
});

// ---------- reading runs ----------

describe('GET /payroll/runs', () => {
  it('lists newest period first, with filters and pagination', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    await createWorker(t.org.id, { countryCode: 'GB' });
    const jan = await createRun(t.admin, JAN_2026);
    const feb = await createRun(t.admin, FEB_2026);
    const gb = await createRun(t.admin, { countryCode: 'GB', periodYear: 2025, periodMonth: 12 });
    await t.admin.post(`/payroll/runs/${jan.id}/submit`);

    const all = await t.admin.get('/payroll/runs');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 3, limit: 25, offset: 0 });
    expect(all.body.items.map((r: { id: string }) => r.id)).toEqual([feb.id, jan.id, gb.id]);
    expect(all.body.items[0].items).toBeUndefined(); // the list is headers only

    const pending = await t.admin.get('/payroll/runs?status=pending_approval');
    expect(pending.body.items.map((r: { id: string }) => r.id)).toEqual([jan.id]);

    const uk = await t.admin.get('/payroll/runs?countryCode=gb');
    expect(uk.body.items.map((r: { id: string }) => r.id)).toEqual([gb.id]);

    const page = await t.admin.get('/payroll/runs?limit=1&offset=1');
    expect(page.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.body.items.map((r: { id: string }) => r.id)).toEqual([jan.id]);

    expect((await t.admin.get('/payroll/runs?status=bogus')).status).toBe(400);
    expect((await t.admin.get('/payroll/runs?limit=101')).status).toBe(400);
  });

  it('never shows another tenant’s runs, and answers 404 for them', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createWorker(b.org.id);
    const theirs = await createRun(b.admin);

    expect((await a.admin.get('/payroll/runs')).body.items).toHaveLength(0);
    expect((await a.admin.get(`/payroll/runs/${theirs.id}`)).status).toBe(404);
    expect((await a.admin.post(`/payroll/runs/${theirs.id}/submit`)).status).toBe(404);
    expect((await a.admin.post(`/payroll/runs/${theirs.id}/recalculate`)).status).toBe(404);
    expect((await a.admin.delete(`/payroll/runs/${theirs.id}`)).status).toBe(404);

    await b.admin.post(`/payroll/runs/${theirs.id}/submit`);
    expect((await a.admin.post(`/payroll/runs/${theirs.id}/approve`)).status).toBe(404);
    expect(
      (await a.admin.post(`/payroll/runs/${theirs.id}/reject`).send({ reason: 'x' })).status,
    ).toBe(404);
    const platformInA = await createPlatformAdmin(a.org.id);
    expect((await platformInA.client.post(`/payroll/runs/${theirs.id}/process`)).status).toBe(404);
    expect((await platformInA.client.post(`/payroll/runs/${theirs.id}/mark-paid`)).status).toBe(
      404,
    );

    // Still untouched in B.
    expect((await b.admin.get(`/payroll/runs/${theirs.id}`)).body.status).toBe('pending_approval');
  });

  it('rejects a malformed id with 400', async () => {
    const t = await createTenant();
    expect((await t.admin.get('/payroll/runs/not-a-uuid')).status).toBe(400);
  });
});

// ---------- permissions ----------

describe('payroll permissions', () => {
  it('a manager can read and submit, but not create, recalculate, delete, approve or reject', async () => {
    const t = await createTenant();
    const manager = await createManager(t.org.id);
    await createWorker(t.org.id);
    const run = await createRun(t.admin);

    expect((await manager.client.post('/payroll/runs').send(FEB_2026)).status).toBe(403);
    expect((await manager.client.get('/payroll/runs')).status).toBe(200);
    expect((await manager.client.get(`/payroll/runs/${run.id}`)).status).toBe(200);
    expect((await manager.client.post(`/payroll/runs/${run.id}/recalculate`)).status).toBe(403);
    expect((await manager.client.delete(`/payroll/runs/${run.id}`)).status).toBe(403);
    expect((await manager.client.post(`/payroll/runs/${run.id}/submit`)).status).toBe(200);
    expect((await manager.client.post(`/payroll/runs/${run.id}/approve`)).status).toBe(403);
    expect(
      (await manager.client.post(`/payroll/runs/${run.id}/reject`).send({ reason: 'x' })).status,
    ).toBe(403);
  });

  it('a client admin cannot process or mark paid', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    await t.admin.post(`/payroll/runs/${run.id}/submit`);
    const approved = await t.admin.post(`/payroll/runs/${run.id}/approve`);
    await t.admin.post(`/invoices/${approved.body.invoiceId}/pay`);

    expect((await t.admin.post(`/payroll/runs/${run.id}/process`)).status).toBe(403);
    expect((await t.admin.post(`/payroll/runs/${run.id}/mark-paid`)).status).toBe(403);
  });

  it('a worker gets 403 on every run endpoint', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const run = await createRun(t.admin);
    const { client: w } = await loginAsWorker(worker);

    const calls = [
      w.get('/payroll/runs'),
      w.post('/payroll/runs').send(FEB_2026),
      w.get(`/payroll/runs/${run.id}`),
      w.post(`/payroll/runs/${run.id}/recalculate`),
      w.delete(`/payroll/runs/${run.id}`),
      w.post(`/payroll/runs/${run.id}/submit`),
      w.post(`/payroll/runs/${run.id}/approve`),
      w.post(`/payroll/runs/${run.id}/reject`).send({ reason: 'x' }),
      w.post(`/payroll/runs/${run.id}/process`),
      w.post(`/payroll/runs/${run.id}/mark-paid`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(403);
  });

  it('a platform admin must pick a tenant first', async () => {
    const { client: platform } = await createPlatformAdmin();
    const res = await platform.get('/payroll/runs');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('organization_required');
  });

  it('a platform admin can create runs inside a chosen tenant', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const { client: platform } = await createPlatformAdmin(t.org.id);
    const res = await platform.post('/payroll/runs').send(JAN_2026);
    expect(res.status).toBe(201);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, res.body.id));
    expect(log!.organizationId).toBe(t.org.id);
  });

  it('requires authentication', async () => {
    expect((await anonymous().get('/payroll/runs')).status).toBe(401);
    expect((await anonymous().get('/payslips')).status).toBe(401);
  });
});

// ---------- payslips ----------

describe('payslips', () => {
  async function paidRunWithTwoWorkers() {
    const t = await createTenant();
    const alice = await createWorker(t.org.id, { firstName: 'Alice', lastName: 'Adams' });
    const bob = await createWorker(t.org.id, { firstName: 'Bob', lastName: 'Brown' });
    const run = await createRun(t.admin);
    await payOut(t, run.id);
    const slips = await t.admin.get('/payslips');
    const slipOf = (workerId: string) =>
      slips.body.items.find((s: { workerId: string }) => s.workerId === workerId) as { id: string };
    return { t, alice, bob, run, aliceSlip: slipOf(alice.id), bobSlip: slipOf(bob.id) };
  }

  it('exist only for paid runs', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const run = await createRun(t.admin);
    expect((await t.admin.get('/payslips')).body.total).toBe(0);
    const [item] = run.items as unknown as { id: string }[];
    expect((await t.admin.get(`/payslips/${item!.id}`)).status).toBe(404);
  });

  it('a worker sees only their own; someone else’s is 404', async () => {
    const { alice, aliceSlip, bobSlip, bob } = await paidRunWithTwoWorkers();
    const { client: asAlice } = await loginAsWorker(alice);

    const mine = await asAlice.get('/payslips');
    expect(mine.body.total).toBe(1);
    expect(mine.body.items[0].id).toBe(aliceSlip.id);
    expect(mine.body.items[0].workerName).toBe('Alice Adams');

    expect((await asAlice.get(`/payslips/${aliceSlip.id}`)).status).toBe(200);
    expect((await asAlice.get(`/payslips/${bobSlip.id}`)).status).toBe(404);
    expect((await asAlice.get(`/payslips?workerId=${bob.id}`)).status).toBe(404);
  });

  it('staff see everyone and may filter by worker', async () => {
    const { t, bob, bobSlip } = await paidRunWithTwoWorkers();
    const manager = await createManager(t.org.id);

    const all = await manager.client.get('/payslips');
    expect(all.body.total).toBe(2);
    expect(all.body.items.map((s: { workerName: string }) => s.workerName)).toEqual([
      'Alice Adams',
      'Bob Brown',
    ]);

    const bobs = await manager.client.get(`/payslips?workerId=${bob.id}`);
    expect(bobs.body.items.map((s: { id: string }) => s.id)).toEqual([bobSlip.id]);
    expect((await manager.client.get(`/payslips/${bobSlip.id}`)).body).toMatchObject({
      id: bobSlip.id,
      currency: 'EUR',
      periodYear: 2026,
      periodMonth: 1,
    });
    expect((await manager.client.get('/payslips?workerId=nope')).status).toBe(400);
  });

  it('lists newest period first', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const jan = await createRun(t.admin, JAN_2026);
    const feb = await createRun(t.admin, FEB_2026);
    await payOut(t, jan.id);
    await payOut(t, feb.id);
    const { client: w } = await loginAsWorker(worker);
    const res = await w.get('/payslips');
    expect(res.body.items.map((s: { periodMonth: number }) => s.periodMonth)).toEqual([2, 1]);
  });

  it('another tenant’s payslip is 404', async () => {
    const { aliceSlip } = await paidRunWithTwoWorkers();
    const other = await createTenant();
    expect((await other.admin.get(`/payslips/${aliceSlip.id}`)).status).toBe(404);
    expect((await other.admin.get('/payslips')).body.total).toBe(0);
  });
});
