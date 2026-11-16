import { addDays, toIsoDate } from '@meridian/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, expenses, fxRates, invoices } from '../../db/schema';
import {
  anonymous,
  createManager,
  createTenant,
  createWorker,
  loginAsWorker,
  type Tenant,
} from '../../test/helpers';

interface Line {
  kind: string;
  description: string;
  amountMinor: number;
}

/**
 * Invoices are only ever created by approving a payroll run, so that is how
 * these tests make them: create → submit → approve through the API.
 */
async function approvedRun(t: Tenant, period = { periodYear: 2026, periodMonth: 1 }) {
  const created = await t.admin.post('/payroll/runs').send({ countryCode: 'DE', ...period });
  expect(created.status).toBe(201);
  expect((await t.admin.post(`/payroll/runs/${created.body.id}/submit`)).status).toBe(200);
  const approved = await t.admin.post(`/payroll/runs/${created.body.id}/approve`);
  expect(approved.status).toBe(200);
  return { runId: approved.body.id as string, invoiceId: approved.body.invoiceId as string };
}

const lineAmounts = (lines: Line[]) =>
  Object.fromEntries(lines.map((l) => [l.kind, l.amountMinor]));

describe('issuing an invoice on payroll approval', () => {
  it('bills a German full-month run in USD with hand-computed amounts', async () => {
    const t = await createTenant();
    await createWorker(t.org.id); // €60,000/yr: gross €5,000.00, employer cost €1,027.50

    const { runId, invoiceId } = await approvedRun(t);
    const res = await t.admin.get(`/invoices/${invoiceId}`);
    expect(res.status).toBe(200);

    // EUR is 0.92 per USD, so USD = EUR / 0.92, rounded half-up once per line:
    //   gross     500,000 / 0.92 = 543,478.26 -> 543,478
    //   employer  102,750 / 0.92 = 111,684.78 -> 111,685
    //   fee       DE monthly fee 59,900 × 1 employee
    const today = toIsoDate(new Date());
    expect(res.body).toMatchObject({
      id: invoiceId,
      number: `INV-${today.slice(0, 4)}-001001`,
      status: 'issued',
      currency: 'USD',
      subtotalMinor: 655_163,
      feeMinor: 59_900,
      totalMinor: 715_063,
      payrollRunId: runId,
      localCurrency: 'EUR',
      dueDate: addDays(today, 14),
      paidAt: null,
      organizationName: t.org.name,
    });
    expect(Number(res.body.fxRate)).toBe(0.92);
    expect(res.body.lines.map((l: Line) => l.kind)).toEqual([
      'gross_pay',
      'employer_cost',
      'platform_fee',
    ]);
    expect(lineAmounts(res.body.lines)).toEqual({
      gross_pay: 543_478,
      employer_cost: 111_685,
      platform_fee: 59_900,
    });
  });

  it('adds a reimbursement line when the run reimburses expenses', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    await db.insert(expenses).values({
      organizationId: t.org.id,
      workerId: worker.id,
      category: 'equipment',
      description: 'Monitor',
      amountMinor: 12_345,
      currency: 'EUR',
      incurredOn: '2026-01-05',
      status: 'approved',
    });

    const { invoiceId } = await approvedRun(t);
    const res = await t.admin.get(`/invoices/${invoiceId}`);
    expect(res.body.lines.map((l: Line) => l.kind)).toEqual([
      'gross_pay',
      'employer_cost',
      'reimbursement',
      'platform_fee',
    ]);
    // 12,345 / 0.92 = 13,418.48 -> 13,418
    expect(lineAmounts(res.body.lines).reimbursement).toBe(13_418);
    expect(res.body.subtotalMinor).toBe(543_478 + 111_685 + 13_418);
    expect(res.body.totalMinor).toBe(res.body.subtotalMinor + res.body.feeMinor);
  });

  it('omits zero lines and charges the contractor fee for a contractor-only run', async () => {
    const t = await createTenant();
    await createWorker(t.org.id, { type: 'contractor', salaryMinor: 400_000, payBasis: 'monthly' });

    const { invoiceId } = await approvedRun(t);
    const res = await t.admin.get(`/invoices/${invoiceId}`);
    expect(res.body.lines.map((l: Line) => l.kind)).toEqual(['gross_pay', 'platform_fee']);
    // 400,000 / 0.92 = 434,782.61 -> 434,783; contractor fee is a flat $49.00.
    expect(res.body).toMatchObject({
      subtotalMinor: 434_783,
      feeMinor: 4_900,
      totalMinor: 439_683,
    });
  });

  it('charges the country fee per employee plus the contractor fee per contractor', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    await createWorker(t.org.id);
    await createWorker(t.org.id, { type: 'contractor', salaryMinor: 400_000, payBasis: 'monthly' });

    const { invoiceId } = await approvedRun(t);
    const res = await t.admin.get(`/invoices/${invoiceId}`);
    expect(res.body.feeMinor).toBe(2 * 59_900 + 4_900);
    expect(lineAmounts(res.body.lines).platform_fee).toBe(124_700);
  });

  it('numbers invoices from the sequence and audits invoice.issued', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const first = await approvedRun(t, { periodYear: 2026, periodMonth: 1 });
    const second = await approvedRun(t, { periodYear: 2026, periodMonth: 2 });

    const year = new Date().getUTCFullYear();
    expect((await t.admin.get(`/invoices/${first.invoiceId}`)).body.number).toBe(
      `INV-${year}-001001`,
    );
    expect((await t.admin.get(`/invoices/${second.invoiceId}`)).body.number).toBe(
      `INV-${year}-001002`,
    );

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'invoice.issued'));
    expect(logs.map((l) => l.entityId).sort()).toEqual([first.invoiceId, second.invoiceId].sort());
    expect(logs.every((l) => l.organizationId === t.org.id)).toBe(true);
  });

  it('freezes the exchange rate: later rate changes do not rewrite the invoice', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const { invoiceId } = await approvedRun(t);
    const before = (await t.admin.get(`/invoices/${invoiceId}`)).body;

    await db.update(fxRates).set({ perUsd: '0.50' }).where(eq(fxRates.currency, 'EUR'));
    try {
      const after = (await t.admin.get(`/invoices/${invoiceId}`)).body;
      expect(after.totalMinor).toBe(before.totalMinor);
      expect(after.fxRate).toBe(before.fxRate);
    } finally {
      await db.update(fxRates).set({ perUsd: '0.92' }).where(eq(fxRates.currency, 'EUR'));
    }
  });
});

describe('GET /invoices', () => {
  it('lists newest first, filters by status, paginates', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const jan = await approvedRun(t, { periodYear: 2026, periodMonth: 1 });
    const feb = await approvedRun(t, { periodYear: 2026, periodMonth: 2 });
    await t.admin.post(`/invoices/${jan.invoiceId}/pay`);

    const all = await t.admin.get('/invoices');
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ total: 2, limit: 25, offset: 0 });
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual([feb.invoiceId, jan.invoiceId]);
    expect(all.body.items[0].lines).toBeUndefined();

    const paid = await t.admin.get('/invoices?status=paid');
    expect(paid.body.items.map((i: { id: string }) => i.id)).toEqual([jan.invoiceId]);

    const page = await t.admin.get('/invoices?limit=1&offset=1');
    expect(page.body).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(page.body.items.map((i: { id: string }) => i.id)).toEqual([jan.invoiceId]);

    expect((await t.admin.get('/invoices?status=overdue')).status).toBe(400);
  });

  it('shows the run its invoice', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const { runId, invoiceId } = await approvedRun(t);
    expect((await t.admin.get(`/payroll/runs/${runId}`)).body.invoiceId).toBe(invoiceId);
  });
});

describe('POST /invoices/:id/pay', () => {
  it('marks an issued invoice paid and audits it', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const { invoiceId } = await approvedRun(t);

    const res = await t.admin.post(`/invoices/${invoiceId}/pay`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('paid');
    expect(res.body.paidAt).toEqual(expect.any(String));
    expect(res.body.lines).toHaveLength(3);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, 'invoice.paid'));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ entityId: invoiceId, actorUserId: t.adminUser.id });
  });

  it('cannot pay an invoice twice, or a void one (409 invalid_transition)', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const jan = await approvedRun(t, { periodYear: 2026, periodMonth: 1 });
    const feb = await approvedRun(t, { periodYear: 2026, periodMonth: 2 });

    await t.admin.post(`/invoices/${jan.invoiceId}/pay`);
    const twice = await t.admin.post(`/invoices/${jan.invoiceId}/pay`);
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('invalid_transition');

    await db.update(invoices).set({ status: 'void' }).where(eq(invoices.id, feb.invoiceId));
    const voided = await t.admin.post(`/invoices/${feb.invoiceId}/pay`);
    expect(voided.status).toBe(409);
    expect(voided.body.error.code).toBe('invalid_transition');
  });

  it('two simultaneous payments: one 200, one 409', async () => {
    const t = await createTenant();
    await createWorker(t.org.id);
    const { invoiceId } = await approvedRun(t);
    const results = await Promise.all([
      t.admin.post(`/invoices/${invoiceId}/pay`),
      t.admin.post(`/invoices/${invoiceId}/pay`),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('invoice permissions and tenancy', () => {
  it('a manager can read invoices but not pay them', async () => {
    const t = await createTenant();
    const manager = await createManager(t.org.id);
    await createWorker(t.org.id);
    const { invoiceId } = await approvedRun(t);

    expect((await manager.client.get('/invoices')).status).toBe(200);
    expect((await manager.client.get(`/invoices/${invoiceId}`)).status).toBe(200);
    expect((await manager.client.post(`/invoices/${invoiceId}/pay`)).status).toBe(403);
  });

  it('a worker gets 403 everywhere', async () => {
    const t = await createTenant();
    const worker = await createWorker(t.org.id);
    const { invoiceId } = await approvedRun(t);
    const { client: w } = await loginAsWorker(worker);

    expect((await w.get('/invoices')).status).toBe(403);
    expect((await w.get(`/invoices/${invoiceId}`)).status).toBe(403);
    expect((await w.post(`/invoices/${invoiceId}/pay`)).status).toBe(403);
  });

  it('another tenant’s invoice is 404 and never listed', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createWorker(b.org.id);
    const { invoiceId } = await approvedRun(b);

    expect((await a.admin.get('/invoices')).body.total).toBe(0);
    expect((await a.admin.get(`/invoices/${invoiceId}`)).status).toBe(404);
    expect((await a.admin.post(`/invoices/${invoiceId}/pay`)).status).toBe(404);
    expect((await b.admin.get(`/invoices/${invoiceId}`)).body.status).toBe('issued');
  });

  it('rejects a malformed id and requires authentication', async () => {
    const t = await createTenant();
    expect((await t.admin.get('/invoices/123')).status).toBe(400);
    expect((await anonymous().get('/invoices')).status).toBe(401);
  });
});
