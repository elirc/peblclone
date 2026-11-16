import { addDays, firstDayOfMonth, toIsoDate } from '@meridian/shared';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../lib/sessions';
import { anonymous, client, createPlatformAdmin, type TestClient } from './helpers';

/**
 * THE JOURNEY TEST.
 *
 * Every other test file exercises one module, usually with rows inserted by
 * factories. This one uses no factories for business data at all: it walks the
 * whole product through the public API, the way three real people would —
 * a client admin, the worker they hire, and a Meridian platform admin.
 *
 * It exists because modules were built by different engineers in parallel.
 * Each module's own tests prove the module; only a test like this proves the
 * SEAMS between them (hire -> contract -> documents -> activation -> expense ->
 * payroll -> invoice -> payslip).
 */

function sessionFrom(res: { headers: Record<string, unknown> }): TestClient {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error('No session cookie in response');
  return client(cookie.split(';')[0]!.split('=')[1]!);
}

/** The next Monday–Friday date strictly after `date`. */
function nextBusinessDay(date: string): string {
  let d = addDays(date, 1);
  while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = addDays(d, 1);
  return d;
}

const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString(
  'base64',
);

describe('journey: from signup to a paid payslip', () => {
  it('hires, onboards, pays and bills for one employee in Germany', async () => {
    const today = toIsoDate(new Date());
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    // Started on the 1st of last month, so this month is a full month of pay.
    const startDate =
      month === 1 ? firstDayOfMonth(year - 1, 12) : firstDayOfMonth(year, month - 1);

    // ── 1. A company signs up ────────────────────────────────────────────────
    const signup = await anonymous().post('/auth/register').send({
      organizationName: 'Journey Corp',
      countryCode: 'US',
      fullName: 'Casey Client',
      email: 'casey@journey.test',
      password: 'a-long-enough-password',
    });
    expect(signup.status).toBe(201);
    const admin = sessionFrom(signup);
    const orgId: string = signup.body.user.organizationId;
    const platform = (await createPlatformAdmin(orgId)).client;

    // ── 2. They price the hire first ─────────────────────────────────────────
    const quote = await admin
      .post('/quotes/calculate')
      .send({ countryCode: 'DE', annualSalaryMinor: 6_000_000 });
    expect(quote.status).toBe(200);
    expect(quote.body.monthlySalaryMinor).toBe(500_000);
    const quotedEmployerCost: number = quote.body.monthlyEmployerCostMinor;

    // ── 3. They hire ─────────────────────────────────────────────────────────
    const hire = await admin.post('/workers').send({
      type: 'employee',
      firstName: 'Lena',
      lastName: 'Fischer',
      email: 'lena@journey.test',
      countryCode: 'DE',
      jobTitle: 'Backend Engineer',
      startDate,
      salaryMinor: 6_000_000,
      payBasis: 'annual',
      sendInvite: true,
    });
    expect(hire.status).toBe(201);
    const workerId: string = hire.body.worker.id;
    expect(hire.body.worker.status).toBe('onboarding');
    expect(hire.body.worker.currency).toBe('EUR');
    expect(hire.body.worker.tasks).toHaveLength(4);

    // ── 4. The worker accepts the invite and lands in the portal ─────────────
    const token = new URL(hire.body.acceptUrl).searchParams.get('token');
    const accepted = await anonymous()
      .post('/auth/accept-invite')
      .send({ token, fullName: 'Lena Fischer', password: 'another-long-password' });
    expect(accepted.status).toBe(201);
    expect(accepted.body.user).toMatchObject({ role: 'worker', workerId });
    const worker = sessionFrom(accepted);
    expect((await worker.get('/me/worker')).body.id).toBe(workerId);
    // …and can see nothing that belongs to staff.
    expect((await worker.get('/workers')).status).toBe(403);
    expect((await worker.get('/payroll/runs')).status).toBe(403);

    // ── 5. Contract: generate, send, sign, countersign ───────────────────────
    const contract = await admin.post('/contracts').send({ workerId });
    expect(contract.status).toBe(201);
    const contractId: string = contract.body.id;
    expect(contract.body.body).toContain('Lena Fischer');
    // A draft is invisible to the worker.
    expect((await worker.get(`/contracts/${contractId}`)).status).toBe(404);

    expect((await admin.post(`/contracts/${contractId}/send`)).body.status).toBe('sent');
    const wrongName = await worker
      .post(`/contracts/${contractId}/sign`)
      .send({ signedByName: 'Someone Else', agree: true });
    expect(wrongName.status).toBe(400);
    const signed = await worker
      .post(`/contracts/${contractId}/sign`)
      .send({ signedByName: 'lena  fischer', agree: true });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('signed');
    expect((await admin.post(`/contracts/${contractId}/activate`)).body.status).toBe('active');

    // ── 6. Documents: worker uploads, Meridian verifies ──────────────────────
    const docs = await worker.get(`/workers/${workerId}/documents`);
    expect(docs.body.items.length).toBeGreaterThan(0);
    for (const doc of docs.body.items as { id: string; kind: string }[]) {
      const upload = await worker
        .post(`/documents/${doc.id}/file`)
        .send({ fileName: `${doc.kind}.pdf`, mimeType: 'application/pdf', dataBase64: TINY_PDF });
      expect(upload.body.status).toBe('submitted');
      // The client cannot verify its own worker's documents — only Meridian can.
      expect(
        (await admin.post(`/documents/${doc.id}/review`).send({ decision: 'verified' })).status,
      ).toBe(403);
      const review = await platform
        .post(`/documents/${doc.id}/review`)
        .send({ decision: 'verified' });
      expect(review.body.status).toBe('verified');
    }

    // ── 7. The two manual checklist items ────────────────────────────────────
    const tasks = (await worker.get('/me/worker')).body.tasks as {
      id: string;
      key: string;
      status: string;
    }[];
    const byKey = Object.fromEntries(tasks.map((t) => [t.key, t]));
    expect(byKey.contract_signed?.status).toBe('completed');
    expect(byKey.documents_verified?.status).toBe('completed');

    // Still onboarding: two manual tasks remain.
    expect((await admin.get(`/workers/${workerId}`)).body.status).toBe('onboarding');
    // A worker cannot tick the client's task.
    expect(
      (await worker.post(`/onboarding-tasks/${byKey.client_confirm_start!.id}/complete`)).status,
    ).toBe(403);
    await worker.post(`/onboarding-tasks/${byKey.bank_details!.id}/complete`).expect(200);
    const last = await admin.post(`/onboarding-tasks/${byKey.client_confirm_start!.id}/complete`);
    expect(last.status).toBe(200);
    // The last task flips the worker to active — nobody pressed an "activate" button.
    expect(last.body.workerStatus).toBe('active');

    // ── 8. Life as an employee: time off and an expense ──────────────────────
    const dayOff = nextBusinessDay(today);
    const timeOff = await worker
      .post('/time-off/requests')
      .send({ type: 'vacation', startDate: dayOff, endDate: dayOff, reason: 'Long weekend' });
    expect(timeOff.status).toBe(201);
    expect(timeOff.body.days).toBe(1);
    const approvedLeave = await admin
      .post(`/time-off/requests/${timeOff.body.id}/decision`)
      .send({ decision: 'approved' });
    expect(approvedLeave.body.status).toBe('approved');
    const balance = await worker.get(`/time-off/balance?year=${dayOff.slice(0, 4)}`);
    expect(balance.body.usedDays).toBe(1);

    const expense = await worker.post('/expenses').send({
      category: 'equipment',
      description: 'Keyboard',
      amountMinor: 12_345,
      incurredOn: today,
    });
    expect(expense.status).toBe(201);
    expect(expense.body.currency).toBe('EUR');
    await admin
      .post(`/expenses/${expense.body.id}/decision`)
      .send({ decision: 'approved' })
      .expect(200);

    // ── 9. Payroll for this month ────────────────────────────────────────────
    const run = await admin
      .post('/payroll/runs')
      .send({ countryCode: 'DE', periodYear: year, periodMonth: month });
    expect(run.status).toBe(201);
    const runId: string = run.body.id;
    expect(run.body.items).toHaveLength(1);
    expect(run.body.grossMinor).toBe(500_000);
    expect(run.body.reimbursementsMinor).toBe(12_345);
    // The payslip's employer cost equals what the calculator quoted in step 2:
    // two modules, built separately, agreeing because both call the same shared maths.
    expect(run.body.employerCostMinor).toBe(quotedEmployerCost);
    expect(run.body.totalCostMinor).toBe(500_000 + quotedEmployerCost + 12_345);

    expect((await admin.post(`/payroll/runs/${runId}/submit`)).body.status).toBe(
      'pending_approval',
    );
    const approved = await admin.post(`/payroll/runs/${runId}/approve`);
    expect(approved.body.status).toBe('approved');
    const invoiceId: string = approved.body.invoiceId;
    expect(invoiceId).toBeTruthy();

    // ── 10. No money, no payroll ─────────────────────────────────────────────
    const tooEarly = await platform.post(`/payroll/runs/${runId}/process`);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('invoice_unpaid');
    // And the client cannot process payroll themselves.
    expect((await admin.post(`/payroll/runs/${runId}/process`)).status).toBe(403);

    const invoice = await admin.get(`/invoices/${invoiceId}`);
    expect(invoice.body.currency).toBe('USD');
    expect(invoice.body.localCurrency).toBe('EUR');
    const lineTotal = (invoice.body.lines as { amountMinor: number }[]).reduce(
      (sum, line) => sum + line.amountMinor,
      0,
    );
    expect(invoice.body.totalMinor).toBe(lineTotal);
    expect((await admin.post(`/invoices/${invoiceId}/pay`)).body.status).toBe('paid');

    expect((await platform.post(`/payroll/runs/${runId}/process`)).body.status).toBe('processing');
    expect((await platform.post(`/payroll/runs/${runId}/mark-paid`)).body.status).toBe('paid');

    // ── 11. What everyone sees afterwards ────────────────────────────────────
    const payslips = await worker.get('/payslips');
    expect(payslips.body.items).toHaveLength(1);
    expect(payslips.body.items[0].netMinor).toBe(run.body.netMinor);
    expect(payslips.body.items[0].reimbursementsMinor).toBe(12_345);

    const expenses = await worker.get('/expenses');
    expect(expenses.body.items[0].status).toBe('reimbursed');

    const dashboard = await admin.get('/dashboard');
    expect(dashboard.body.headcount).toMatchObject({ total: 1, active: 1, onboarding: 0 });
    expect(dashboard.body.pending).toMatchObject({
      timeOffRequests: 0,
      expenses: 0,
      payrollApprovals: 0,
      unpaidInvoices: 0,
    });

    // The audit trail tells the whole story, in order, with nobody having to remember to write it.
    const audit = await admin.get('/audit-logs?limit=100');
    const actions = new Set((audit.body.items as { action: string }[]).map((a) => a.action));
    for (const expected of [
      'organization.registered',
      'worker.created',
      'invitation.accepted',
      'contract.signed',
      'document.verified',
      'worker.activated',
      'time_off.approved',
      'expense.approved',
      'payroll_run.approved',
      'invoice.issued',
      'invoice.paid',
      'payroll_run.paid',
    ]) {
      expect(actions, `audit trail is missing ${expected}`).toContain(expected);
    }
  }, 60_000);
});
