import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../db/client';
import { contracts, invitations } from '../db/schema';
import { createInvitation } from '../lib/invites';
import { createPlatformAdmin, createTenant, createUser, createWorker, loginAs } from './helpers';

/**
 * Regression tests for the defects found by the independent review (journal
 * chapter 17). Each test is named after the failure it prevents. The yen test
 * was confirmed to fail before the fix (the seeded invoices showed the wrong
 * amounts). The concurrency test is a guard, not a proof: a deadlock needs
 * unlucky timing, so passing five rounds lowers the odds rather than ruling it out.
 */

describe('review: currencies without a minor unit', () => {
  it('bills a Japanese payroll run at the right magnitude (was 100x too small)', async () => {
    const { org, admin } = await createTenant();
    // ¥8,400,000 / year -> ¥700,000 / month. Yen has no minor unit: 700000 IS ¥700,000.
    await createWorker(org.id, { countryCode: 'JP', salaryMinor: 8_400_000 });
    const now = new Date();

    const run = await admin.post('/payroll/runs').send({
      countryCode: 'JP',
      periodYear: now.getUTCFullYear(),
      periodMonth: now.getUTCMonth() + 1,
    });
    expect(run.status).toBe(201);
    expect(run.body.grossMinor).toBe(700_000);
    // JP employer rules: 9.15% + 5.00% + 0.95% + 0.30% = 15.40% -> ¥107,800
    expect(run.body.employerCostMinor).toBe(107_800);

    await admin.post(`/payroll/runs/${run.body.id}/submit`).expect(200);
    const approved = await admin.post(`/payroll/runs/${run.body.id}/approve`).expect(200);
    const invoice = await admin.get(`/invoices/${approved.body.invoiceId}`).expect(200);

    const line = (kind: string) =>
      (invoice.body.lines as { kind: string; amountMinor: number }[]).find((l) => l.kind === kind)
        ?.amountMinor;
    // At 151 JPY per USD:  ¥700,000 / 151 = $4,635.76  -> 463,576 cents
    expect(line('gross_pay')).toBe(463_576);
    //                      ¥107,800 / 151 = $713.91    ->  71,391 cents
    expect(line('employer_cost')).toBe(71_391);
    expect(line('platform_fee')).toBe(64_900);
    expect(invoice.body.totalMinor).toBe(463_576 + 71_391 + 64_900);
  });
});

describe('review: team invites versus worker invites', () => {
  it('a team invite does not delete a worker’s pending portal invite', async () => {
    const { org, admin, adminUser } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' });
    await createInvitation(db, {
      organizationId: org.id,
      email: worker.email,
      role: 'worker',
      workerId: worker.id,
      invitedBy: adminUser.id,
    });

    const res = await admin
      .post('/team/invites')
      .send({ email: worker.email, role: 'client_manager' });

    // Refused outright: one email is one login is one role.
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_belongs_to_worker');
    const remaining = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.workerId, worker.id), isNull(invitations.acceptedAt)));
    expect(remaining).toHaveLength(1);
  });
});

describe('review: cancelling a hire', () => {
  it('ends a contract that was already countersigned', async () => {
    const { org, admin, adminUser } = await createTenant();
    const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
    const contract = await admin.post('/contracts').send({ workerId: worker.id }).expect(201);
    // Force it to `active` the way an early countersignature would leave it.
    await db
      .update(contracts)
      .set({ status: 'active', activatedAt: new Date(), createdBy: adminUser.id })
      .where(eq(contracts.id, contract.body.id));

    await admin.post(`/workers/${worker.id}/transition`).send({ to: 'cancelled' }).expect(200);

    const [after] = await db.select().from(contracts).where(eq(contracts.id, contract.body.id));
    expect(after?.status).toBe('terminated');
  });
});

describe('review: concurrent sign and cancel', () => {
  it('never answers 500 when a worker signs while the admin cancels the hire', async () => {
    const { org, admin } = await createTenant();
    for (let round = 0; round < 5; round += 1) {
      const worker = await createWorker(org.id, { status: 'onboarding' }, { withTasks: true });
      const user = await createUser('worker', org.id, { email: worker.email });
      const { workers } = await import('../db/schema');
      await db.update(workers).set({ userId: user.id }).where(eq(workers.id, worker.id));
      const portal = await loginAs(user);
      const contract = await admin.post('/contracts').send({ workerId: worker.id }).expect(201);
      await admin.post(`/contracts/${contract.body.id}/send`).expect(200);

      const [sign, cancel] = await Promise.all([
        portal
          .post(`/contracts/${contract.body.id}/sign`)
          .send({ signedByName: `${worker.firstName} ${worker.lastName}`, agree: true }),
        admin.post(`/workers/${worker.id}/transition`).send({ to: 'cancelled' }),
      ]);

      // Either order is a legitimate outcome; a deadlock (500) is not.
      // 401: the cancel won and already killed the worker's session.
      expect([200, 401, 404, 409], `sign answered ${sign.status}`).toContain(sign.status);
      expect([200, 409], `cancel answered ${cancel.status}`).toContain(cancel.status);
    }
  }, 60_000);
});

describe('review: X-Org-Id validation', () => {
  it('answers 400, not 500, for 36 characters that are not a UUID', async () => {
    const user = (await createPlatformAdmin()).user;
    const spoof = await loginAs(user, { 'X-Org-Id': '-'.repeat(36) });
    const res = await spoof.get('/organization');
    expect(res.status).toBe(400);
  });
});
