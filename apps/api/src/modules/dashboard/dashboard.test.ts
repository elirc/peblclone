import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import {
  auditLogs,
  contracts,
  expenses,
  invoices,
  payrollRuns,
  timeOffRequests,
} from '../../db/schema';
import {
  anonymous,
  createManager,
  createPlatformAdmin,
  createTenant,
  createWorker,
  loginAsWorker,
  unique,
  type WorkerRow,
} from '../../test/helpers';

// ---------- direct-insert fixtures (other modules' endpoints are not used here) ----------

/** The first instant of the month `offset` months from now (UTC), plus a few days. */
function inMonth(offset: number, day = 3): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, day, 12));
}

async function insertInvoice(
  organizationId: string,
  totalMinor: number,
  issuedAt: Date,
  status: 'issued' | 'paid' | 'void' = 'issued',
) {
  await db.insert(invoices).values({
    organizationId,
    number: `INV-TEST-${unique()}`,
    status,
    subtotalMinor: totalMinor,
    feeMinor: 0,
    totalMinor,
    fxRate: '1',
    localCurrency: 'USD',
    issuedAt,
    dueDate: '2030-01-01',
  });
}

async function insertPendingWork(organizationId: string, worker: WorkerRow) {
  await db.insert(timeOffRequests).values([
    {
      organizationId,
      workerId: worker.id,
      type: 'vacation',
      status: 'pending',
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      days: 3,
    },
    {
      organizationId,
      workerId: worker.id,
      type: 'vacation',
      status: 'approved',
      startDate: '2026-08-01',
      endDate: '2026-08-03',
      days: 3,
    },
  ]);
  await db.insert(expenses).values([
    {
      organizationId,
      workerId: worker.id,
      category: 'meals',
      description: 'Lunch',
      amountMinor: 1_000,
      currency: 'EUR',
      incurredOn: '2026-01-01',
      status: 'submitted',
    },
    {
      organizationId,
      workerId: worker.id,
      category: 'meals',
      description: 'Dinner',
      amountMinor: 1_000,
      currency: 'EUR',
      incurredOn: '2026-01-01',
      status: 'approved',
    },
  ]);
  await db.insert(payrollRuns).values([
    {
      organizationId,
      countryCode: 'DE',
      currency: 'EUR',
      periodYear: 2026,
      periodMonth: 1,
      status: 'pending_approval',
    },
    {
      organizationId,
      countryCode: 'DE',
      currency: 'EUR',
      periodYear: 2026,
      periodMonth: 2,
      status: 'draft',
    },
  ]);
  await db.insert(contracts).values({
    organizationId,
    workerId: worker.id,
    status: 'sent',
    title: 'Employment agreement',
    body: 'Terms…',
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
  });
  await insertInvoice(organizationId, 100, new Date(), 'issued');
  await insertInvoice(organizationId, 100, new Date(), 'paid');
}

// ---------- tests ----------

describe('GET /dashboard', () => {
  it('counts headcount excluding terminated and cancelled workers, by country largest first', async () => {
    const t = await createTenant();
    const other = await createTenant();
    await createWorker(t.org.id, { countryCode: 'DE' });
    await createWorker(t.org.id, { countryCode: 'DE', type: 'contractor' });
    await createWorker(t.org.id, {
      countryCode: 'DE',
      status: 'offboarding',
      endDate: '2027-01-31',
    });
    await createWorker(t.org.id, { countryCode: 'GB', status: 'onboarding' });
    await createWorker(t.org.id, { countryCode: 'GB', status: 'onboarding', type: 'contractor' });
    await createWorker(t.org.id, { countryCode: 'FR' });
    await createWorker(t.org.id, {
      countryCode: 'FR',
      status: 'terminated',
      endDate: '2025-06-30',
    });
    await createWorker(t.org.id, { countryCode: 'FR', status: 'cancelled' });
    // Another tenant's workers must not bleed in.
    await createWorker(other.org.id, { countryCode: 'US' });
    await createWorker(other.org.id, { countryCode: 'FR' });

    const res = await t.admin.get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.headcount).toEqual({
      total: 6,
      active: 3,
      onboarding: 2,
      employees: 4,
      contractors: 2,
    });
    expect(res.body.byCountry).toEqual([
      { countryCode: 'DE', countryName: 'Germany', count: 3 },
      { countryCode: 'GB', countryName: 'United Kingdom', count: 2 },
      { countryCode: 'FR', countryName: 'France', count: 1 },
    ]);
  });

  it('counts pending work in this tenant only', async () => {
    const t = await createTenant();
    const other = await createTenant();
    await insertPendingWork(t.org.id, await createWorker(t.org.id));
    await insertPendingWork(other.org.id, await createWorker(other.org.id));

    const res = await t.admin.get('/dashboard');
    expect(res.body.pending).toEqual({
      timeOffRequests: 1,
      expenses: 1,
      payrollApprovals: 1,
      unpaidInvoices: 1,
      contractsAwaitingSignature: 1,
    });
  });

  it('reports six months of spend, oldest first, zero-filled, ignoring void and old invoices', async () => {
    const t = await createTenant();
    const other = await createTenant();
    await insertInvoice(t.org.id, 1_000, inMonth(0), 'issued');
    await insertInvoice(t.org.id, 2_500, inMonth(0, 1), 'paid');
    await insertInvoice(t.org.id, 9_999, inMonth(0), 'void');
    await insertInvoice(t.org.id, 4_000, inMonth(-2), 'paid');
    await insertInvoice(t.org.id, 7_000, inMonth(-5), 'paid');
    await insertInvoice(t.org.id, 8_888, inMonth(-6), 'paid'); // seven months ago: outside the window
    await insertInvoice(other.org.id, 123_456, inMonth(0), 'paid');

    const res = await t.admin.get('/dashboard');
    const spend = res.body.monthlySpend as { year: number; month: number; totalUsdMinor: number }[];
    expect(spend).toHaveLength(6);

    const expectedMonths = [-5, -4, -3, -2, -1, 0].map((offset) => {
      const d = inMonth(offset);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
    });
    expect(spend.map(({ year, month }) => ({ year, month }))).toEqual(expectedMonths);
    expect(spend.map((m) => m.totalUsdMinor)).toEqual([7_000, 0, 0, 4_000, 0, 3_500]);
  });

  it('always returns six zero months for a brand-new tenant', async () => {
    const t = await createTenant();
    const res = await t.admin.get('/dashboard');
    expect(res.body.monthlySpend).toHaveLength(6);
    expect(
      res.body.monthlySpend.every((m: { totalUsdMinor: number }) => m.totalUsdMinor === 0),
    ).toBe(true);
    expect(res.body.headcount.total).toBe(0);
    expect(res.body.byCountry).toEqual([]);
  });

  it('shows the 10 newest audit entries of this tenant', async () => {
    const t = await createTenant();
    const other = await createTenant();
    const now = Date.now();
    for (let i = 0; i < 12; i += 1) {
      await db.insert(auditLogs).values({
        organizationId: t.org.id,
        actorUserId: t.adminUser.id,
        action: `step.${i}`,
        entityType: 'thing',
        createdAt: new Date(now - (12 - i) * 1_000),
      });
    }
    await db.insert(auditLogs).values({
      organizationId: other.org.id,
      action: 'theirs.newest',
      entityType: 'thing',
      createdAt: new Date(now),
    });

    const res = await t.admin.get('/dashboard');
    const activity = res.body.recentActivity as { action: string; actorName: string | null }[];
    expect(activity.map((a) => a.action)).toEqual(
      [11, 10, 9, 8, 7, 6, 5, 4, 3, 2].map((i) => `step.${i}`),
    );
    expect(activity[0]!.actorName).toBe(t.adminUser.fullName);
  });

  it('is for staff: managers and platform admins (with a tenant) yes, workers no', async () => {
    const t = await createTenant();
    const manager = await createManager(t.org.id);
    const worker = await loginAsWorker(await createWorker(t.org.id));
    const platformIn = await createPlatformAdmin(t.org.id);
    const platformOut = await createPlatformAdmin();

    expect((await manager.client.get('/dashboard')).status).toBe(200);
    const asPlatform = await platformIn.client.get('/dashboard');
    expect(asPlatform.status).toBe(200);
    expect(asPlatform.body.headcount.total).toBe(1);
    expect((await worker.client.get('/dashboard')).status).toBe(403);
    expect((await platformOut.client.get('/dashboard')).status).toBe(400);
    expect((await anonymous().get('/dashboard')).status).toBe(401);
  });
});
