import {
  addDays,
  countBusinessDays,
  toIsoDate,
  type TimeOffRequestDto,
  type TimeOffStatus,
} from '@meridian/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, timeOffRequests } from '../../db/schema';
import {
  anonymous,
  createManager,
  createTenant,
  createWorker,
  loginAsWorker,
  type TestClient,
  type WorkerRow,
} from '../../test/helpers';

// ---------- dates relative to today ----------
// Most tests file leave in NEXT calendar year: it is always in the future, always
// a full year of entitlement for the default worker (started 2025-01-01), and a
// Monday-to-Friday week there never crosses a year boundary.

const TODAY = toIsoDate(new Date());
const THIS_YEAR = Number(TODAY.slice(0, 4));
const Y = THIS_YEAR + 1;

/** The first date on/after `from` that falls on `weekday` (0 = Sunday … 6 = Saturday). */
function nextWeekday(from: string, weekday: number): string {
  let d = from;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== weekday) d = addDays(d, 1);
  return d;
}

/** Monday–Friday of the n-th week starting on the first Monday of March next year. */
function week(n = 0): { startDate: string; endDate: string } {
  const monday = addDays(nextWeekday(`${Y}-03-01`, 1), 7 * n);
  return { startDate: monday, endDate: addDays(monday, 4) };
}

// ---------- helpers ----------

async function setup(workerOverrides: Parameters<typeof createWorker>[1] = {}) {
  const tenant = await createTenant();
  const worker = await createWorker(tenant.org.id, workerOverrides);
  const login = await loginAsWorker(worker);
  return { ...tenant, worker, workerClient: login.client };
}

function file(
  client: TestClient,
  body: Partial<{ workerId: string; type: string; startDate: string; endDate: string; reason: string }>,
) {
  return client.post('/time-off/requests').send({ type: 'vacation', ...week(), ...body });
}

async function filed(client: TestClient, body: Parameters<typeof file>[1] = {}) {
  const res = await file(client, body);
  expect(res.status).toBe(201);
  return res.body as TimeOffRequestDto;
}

/** Insert a request row directly — for states the API cannot reach on demand (e.g. started). */
async function insertRequest(
  worker: WorkerRow,
  values: { status: TimeOffStatus; startDate: string; endDate: string; type?: 'vacation' | 'sick' },
) {
  const [row] = await db
    .insert(timeOffRequests)
    .values({
      organizationId: worker.organizationId,
      workerId: worker.id,
      type: values.type ?? 'vacation',
      status: values.status,
      startDate: values.startDate,
      endDate: values.endDate,
      days: countBusinessDays(values.startDate, values.endDate),
    })
    .returning();
  return row!;
}

async function auditActions(entityId: string) {
  const rows = await db
    .select({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId));
  return rows.map((r) => r.action);
}

// ---------- create ----------

describe('POST /time-off/requests', () => {
  it('lets a worker file for themselves, counting business days', async () => {
    const { worker, workerClient } = await setup();
    const range = { startDate: week().startDate, endDate: addDays(week().startDate, 8) };
    const res = await file(workerClient, { ...range, reason: 'Family trip' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workerId: worker.id,
      workerName: `${worker.firstName} ${worker.lastName}`,
      type: 'vacation',
      status: 'pending',
      ...range,
      days: 7, // Mon..Tue of the following week, weekend excluded
      reason: 'Family trip',
      decisionNote: null,
      decidedAt: null,
    });
    expect(await auditActions(res.body.id)).toEqual(['time_off.requested']);
  });

  it('lets staff file for a worker, but they must say which one', async () => {
    const { org, admin, worker } = await setup();
    const manager = await createManager(org.id);

    const missing = await file(admin, {});
    expect(missing.status).toBe(400);

    const res = await file(manager.client, { workerId: worker.id });
    expect(res.status).toBe(201);
    expect(res.body.workerId).toBe(worker.id);
  });

  it('answers 404 when a worker files for somebody else', async () => {
    const { org, workerClient } = await setup();
    const other = await createWorker(org.id);
    const res = await file(workerClient, { workerId: other.id });
    expect(res.status).toBe(404);
  });

  it('answers 404 for a worker in another organization', async () => {
    const a = await createTenant();
    const b = await setup();
    expect((await file(a.admin, { workerId: b.worker.id })).status).toBe(404);
  });

  it('validates the body', async () => {
    const { workerClient } = await setup();
    const backwards = await file(workerClient, {
      startDate: week().endDate,
      endDate: week().startDate,
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe('validation_error');
    expect(backwards.body.error.details.endDate).toBeDefined();

    expect((await file(workerClient, { type: 'sabbatical' })).status).toBe(400);
    expect((await file(workerClient, { startDate: `${Y}-02-30` })).status).toBe(400);
  });

  it('requires a session', async () => {
    expect((await file(anonymous(), {})).status).toBe(401);
  });

  for (const status of ['onboarding', 'offboarding', 'terminated', 'cancelled'] as const) {
    it(`refuses a ${status} worker with 409 worker_not_active`, async () => {
      const { admin, worker } = await setup({ status, endDate: `${Y}-12-31` });
      const res = await file(admin, { workerId: worker.id });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('worker_not_active');
    });
  }

  it('refuses contractors with 409 not_applicable_to_contractors', async () => {
    const { workerClient } = await setup({ type: 'contractor' });
    const res = await file(workerClient, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_applicable_to_contractors');
  });

  it('refuses leave before the worker’s start date with 400 before_start_date', async () => {
    const { workerClient } = await setup({ startDate: `${Y}-06-01` });
    const monday = nextWeekday(`${Y}-05-01`, 1);
    const res = await file(workerClient, { startDate: monday, endDate: addDays(monday, 4) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('before_start_date');
  });

  it('refuses a range across two calendar years with 400 spans_years', async () => {
    const { workerClient } = await setup();
    const res = await file(workerClient, { startDate: `${Y}-12-28`, endDate: `${Y + 1}-01-05` });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('spans_years');
  });

  it('refuses a weekend-only range with 400 no_working_days', async () => {
    const { workerClient } = await setup();
    const saturday = nextWeekday(`${Y}-03-01`, 6);
    const res = await file(workerClient, { startDate: saturday, endDate: addDays(saturday, 1) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('no_working_days');
  });

  it('refuses a range overlapping a pending or approved request with 409', async () => {
    const { admin, workerClient } = await setup();
    const first = await filed(workerClient, week(0));

    const overlapping = { startDate: addDays(week(0).endDate, -1), endDate: week(1).endDate };
    const pendingClash = await file(workerClient, overlapping);
    expect(pendingClash.status).toBe(409);
    expect(pendingClash.body.error.code).toBe('overlapping_request');

    await admin.post(`/time-off/requests/${first.id}/decision`).send({ decision: 'approved' });
    expect((await file(workerClient, { ...overlapping, type: 'sick' })).status).toBe(409);

    // A touching-but-not-overlapping range is fine.
    expect((await file(workerClient, week(1))).status).toBe(201);
  });

  it('ignores rejected and cancelled requests when checking overlap', async () => {
    const { worker, workerClient } = await setup();
    await insertRequest(worker, { status: 'rejected', ...week(0) });
    await insertRequest(worker, { status: 'cancelled', ...week(0) });
    expect((await file(workerClient, week(0))).status).toBe(201);
  });

  it('only counts the worker’s own requests as overlaps', async () => {
    const { org, workerClient } = await setup();
    const colleague = await createWorker(org.id);
    await insertRequest(colleague, { status: 'approved', ...week(0) });
    expect((await file(workerClient, week(0))).status).toBe(201);
  });

  it('refuses vacation beyond the remaining balance, counting pending days', async () => {
    // Philippines: 5 days of annual leave.
    const { workerClient } = await setup({ countryCode: 'PH' });
    await filed(workerClient, week(0)); // 5 days pending -> 0 remaining

    const res = await file(workerClient, { startDate: week(1).startDate, endDate: week(1).startDate });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_balance');

    // Balance applies to vacation only.
    expect((await file(workerClient, { ...week(1), type: 'sick' })).status).toBe(201);
  });

  it('allows vacation that uses exactly the remaining balance', async () => {
    const { workerClient } = await setup({ countryCode: 'PH' });
    expect((await file(workerClient, week(0))).status).toBe(201);
  });

  it('lets exactly one of two simultaneous overlapping requests through', async () => {
    const { worker, workerClient } = await setup();
    const results = await Promise.all([
      file(workerClient, week(0)),
      file(workerClient, { startDate: addDays(week(0).startDate, 2), endDate: week(1).endDate }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const rows = await db
      .select()
      .from(timeOffRequests)
      .where(eq(timeOffRequests.workerId, worker.id));
    expect(rows).toHaveLength(1);
  });

  it('cannot overspend the balance with two simultaneous non-overlapping requests', async () => {
    const { worker, workerClient } = await setup({ countryCode: 'PH' });
    const results = await Promise.all([file(workerClient, week(0)), file(workerClient, week(2))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser?.body.error.code).toBe('insufficient_balance');
    const rows = await db
      .select()
      .from(timeOffRequests)
      .where(eq(timeOffRequests.workerId, worker.id));
    expect(rows).toHaveLength(1);
  });
});

// ---------- balance ----------

describe('GET /time-off/balance', () => {
  it('reports entitlement, used, pending and remaining vacation days', async () => {
    const { admin, worker, workerClient } = await setup();
    const approved = await filed(workerClient, week(0)); // 5 days
    await admin.post(`/time-off/requests/${approved.id}/decision`).send({ decision: 'approved' });
    await filed(workerClient, { startDate: week(2).startDate, endDate: addDays(week(2).startDate, 2) }); // 3 pending
    await filed(workerClient, { ...week(4), type: 'sick' }); // not vacation: ignored

    const res = await workerClient.get(`/time-off/balance?year=${Y}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      workerId: worker.id,
      year: Y,
      entitlementDays: 24, // Germany
      usedDays: 5,
      pendingDays: 3,
      remainingDays: 16,
    });
  });

  it('defaults to the current year', async () => {
    const { workerClient } = await setup();
    const res = await workerClient.get('/time-off/balance');
    expect(res.body.year).toBe(THIS_YEAR);
    expect(res.body.entitlementDays).toBe(24);
  });

  it('prorates entitlement for a worker who starts part-way through the year', async () => {
    const { workerClient } = await setup({ startDate: `${Y}-07-15` });
    const res = await workerClient.get(`/time-off/balance?year=${Y}`);
    expect(res.body.entitlementDays).toBe(12); // July..December = 6/12 of 24
  });

  it('is all zeros for contractors', async () => {
    const { workerClient, worker } = await setup({ type: 'contractor' });
    const res = await workerClient.get(`/time-off/balance?year=${Y}`);
    expect(res.body).toEqual({
      workerId: worker.id,
      year: Y,
      entitlementDays: 0,
      usedDays: 0,
      pendingDays: 0,
      remainingDays: 0,
    });
  });

  it('lets staff read any worker’s balance in their tenant, and only there', async () => {
    const { admin, worker } = await setup();
    const other = await createTenant();
    expect((await admin.get(`/time-off/balance?workerId=${worker.id}`)).status).toBe(200);
    expect((await admin.get('/time-off/balance')).status).toBe(400);
    expect((await other.admin.get(`/time-off/balance?workerId=${worker.id}`)).status).toBe(404);
  });

  it('answers 404 when a worker asks for someone else’s balance', async () => {
    const { org, workerClient } = await setup();
    const other = await createWorker(org.id);
    expect((await workerClient.get(`/time-off/balance?workerId=${other.id}`)).status).toBe(404);
  });

  it('validates the query', async () => {
    const { workerClient } = await setup();
    expect((await workerClient.get('/time-off/balance?year=1999')).status).toBe(400);
  });
});

// ---------- list ----------

describe('GET /time-off/requests', () => {
  it('lists newest first with pagination and filters for staff', async () => {
    const { org, admin, worker } = await setup();
    const colleague = await createWorker(org.id);
    const r1 = await filed(admin, { workerId: worker.id, ...week(0) });
    const r2 = await filed(admin, { workerId: colleague.id, ...week(0) });
    await admin.post(`/time-off/requests/${r2.id}/decision`).send({ decision: 'rejected' });

    const all = await admin.get('/time-off/requests');
    expect(all.body.items.map((r: { id: string }) => r.id)).toEqual([r2.id, r1.id]);
    expect(all.body).toMatchObject({ total: 2, limit: 25, offset: 0 });

    const page = await admin.get('/time-off/requests?limit=1&offset=1');
    expect(page.body.items.map((r: { id: string }) => r.id)).toEqual([r1.id]);

    const rejected = await admin.get('/time-off/requests?status=rejected');
    expect(rejected.body.items.map((r: { id: string }) => r.id)).toEqual([r2.id]);
    const mine = await admin.get(`/time-off/requests?workerId=${worker.id}`);
    expect(mine.body.items.map((r: { id: string }) => r.id)).toEqual([r1.id]);
  });

  it('shows a worker only their own requests', async () => {
    const { org, admin, worker, workerClient } = await setup();
    const colleague = await createWorker(org.id);
    const own = await filed(workerClient, week(0));
    await filed(admin, { workerId: colleague.id, ...week(0) });

    const res = await workerClient.get('/time-off/requests');
    expect(res.body.items.map((r: { id: string }) => r.id)).toEqual([own.id]);
    expect(res.body.total).toBe(1);
    expect((await workerClient.get(`/time-off/requests?workerId=${colleague.id}`)).status).toBe(404);
    expect((await workerClient.get(`/time-off/requests?workerId=${worker.id}`)).status).toBe(200);
  });

  it('never shows another organization’s requests', async () => {
    const a = await createTenant();
    const b = await setup();
    await filed(b.workerClient, week(0));
    expect((await a.admin.get('/time-off/requests')).body.items).toHaveLength(0);
  });
});

// ---------- decision ----------

describe('POST /time-off/requests/:id/decision', () => {
  it('approves a pending request, recording who, when and the note', async () => {
    const { org, workerClient } = await setup();
    const manager = await createManager(org.id);
    const request = await filed(workerClient, week(0));

    const res = await manager.client
      .post(`/time-off/requests/${request.id}/decision`)
      .send({ decision: 'approved', note: 'Enjoy' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'approved',
      decisionNote: 'Enjoy',
      decidedAt: expect.any(String),
    });
    const [row] = await db.select().from(timeOffRequests).where(eq(timeOffRequests.id, request.id));
    expect(row?.decidedBy).toBe(manager.user.id);
    expect(await auditActions(request.id)).toEqual(['time_off.requested', 'time_off.approved']);
  });

  it('rejects a pending request', async () => {
    const { admin, workerClient } = await setup();
    const request = await filed(workerClient, week(0));
    const res = await admin
      .post(`/time-off/requests/${request.id}/decision`)
      .send({ decision: 'rejected' });
    expect(res.body.status).toBe('rejected');
    expect(await auditActions(request.id)).toContain('time_off.rejected');
  });

  for (const status of ['approved', 'rejected', 'cancelled'] as const) {
    it(`refuses to decide a ${status} request with 409 invalid_transition`, async () => {
      const { admin, worker } = await setup();
      const row = await insertRequest(worker, { status, ...week(0) });
      for (const decision of ['approved', 'rejected']) {
        const res = await admin.post(`/time-off/requests/${row.id}/decision`).send({ decision });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('invalid_transition');
      }
    });
  }

  it('validates the decision', async () => {
    const { admin, workerClient } = await setup();
    const request = await filed(workerClient, week(0));
    const res = await admin
      .post(`/time-off/requests/${request.id}/decision`)
      .send({ decision: 'cancelled' });
    expect(res.status).toBe(400);
  });

  it('is staff-only, and 404 across tenants', async () => {
    const { workerClient } = await setup();
    const other = await createTenant();
    const request = await filed(workerClient, week(0));
    const body = { decision: 'approved' };
    expect((await workerClient.post(`/time-off/requests/${request.id}/decision`).send(body)).status).toBe(403);
    expect((await other.admin.post(`/time-off/requests/${request.id}/decision`).send(body)).status).toBe(404);
  });

  it('lets only one of two simultaneous decisions win', async () => {
    const { admin, workerClient } = await setup();
    const request = await filed(workerClient, week(0));
    const results = await Promise.all([
      admin.post(`/time-off/requests/${request.id}/decision`).send({ decision: 'approved' }),
      admin.post(`/time-off/requests/${request.id}/decision`).send({ decision: 'rejected' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

// ---------- cancel ----------

describe('POST /time-off/requests/:id/cancel', () => {
  it('lets a worker cancel their own pending request', async () => {
    const { workerClient } = await setup();
    const request = await filed(workerClient, week(0));
    const res = await workerClient.post(`/time-off/requests/${request.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(await auditActions(request.id)).toContain('time_off.cancelled');
  });

  it('lets a worker cancel an approved request that has not started, freeing the days', async () => {
    const { admin, workerClient } = await setup({ countryCode: 'PH' });
    const request = await filed(workerClient, week(0));
    await admin.post(`/time-off/requests/${request.id}/decision`).send({ decision: 'approved' });

    expect((await workerClient.post(`/time-off/requests/${request.id}/cancel`)).status).toBe(200);
    const balance = await workerClient.get(`/time-off/balance?year=${Y}`);
    expect(balance.body.remainingDays).toBe(5);
    expect((await file(workerClient, week(1))).status).toBe(201);
  });

  it('refuses a worker cancelling approved leave that has started (409 already_started)', async () => {
    const { worker, workerClient } = await setup();
    const started = await insertRequest(worker, {
      status: 'approved',
      startDate: TODAY,
      endDate: addDays(TODAY, 3),
    });
    const res = await workerClient.post(`/time-off/requests/${started.id}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_started');
  });

  it('lets staff cancel approved leave that has already started', async () => {
    const { admin, worker } = await setup();
    const started = await insertRequest(worker, {
      status: 'approved',
      startDate: addDays(TODAY, -2),
      endDate: addDays(TODAY, 2),
    });
    const res = await admin.post(`/time-off/requests/${started.id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('lets a worker cancel a pending request even if its start date has passed', async () => {
    const { worker, workerClient } = await setup();
    const stale = await insertRequest(worker, {
      status: 'pending',
      startDate: addDays(TODAY, -3),
      endDate: addDays(TODAY, -1),
    });
    expect((await workerClient.post(`/time-off/requests/${stale.id}/cancel`)).status).toBe(200);
  });

  for (const status of ['rejected', 'cancelled'] as const) {
    it(`refuses to cancel a ${status} request with 409 invalid_transition`, async () => {
      const { admin, worker, workerClient } = await setup();
      const row = await insertRequest(worker, { status, ...week(0) });
      for (const client of [admin, workerClient]) {
        const res = await client.post(`/time-off/requests/${row.id}/cancel`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('invalid_transition');
      }
    });
  }

  it('answers 404 for another worker’s request and across tenants', async () => {
    const { org, admin, workerClient } = await setup();
    const colleague = await createWorker(org.id);
    const theirs = await filed(admin, { workerId: colleague.id, ...week(0) });
    const other = await createTenant();

    expect((await workerClient.post(`/time-off/requests/${theirs.id}/cancel`)).status).toBe(404);
    expect((await other.admin.post(`/time-off/requests/${theirs.id}/cancel`)).status).toBe(404);
    expect((await admin.post('/time-off/requests/not-a-uuid/cancel')).status).toBe(400);
  });
});
