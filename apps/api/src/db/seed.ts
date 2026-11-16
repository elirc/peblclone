// The seed talks to the API in-process and would otherwise print a log line per request.
process.env.LOG_LEVEL ??= 'warn';

import { addDays, firstDayOfMonth, lastDayOfMonth, toIsoDate } from '@meridian/shared';
import { eq } from 'drizzle-orm';
import type { Response } from 'supertest';

/**
 * Demo data for the development database.   npm run db:seed [-- --reset]
 *
 * Design decision: this script creates almost nothing with INSERT statements.
 * It drives the real API (in-process, no network) through the same steps a
 * person would take — register, hire, sign, verify, run payroll, pay.
 *
 * Why go the long way round?
 *  - Seed data that bypasses the rules drifts into states the app can never
 *    produce (an "active" worker with no signed contract), and then the UI
 *    crashes on data no user could have created.
 *  - It doubles as a smoke test: if the seed runs, the whole flow works.
 *  - Payslip numbers, invoice totals and the audit trail are all REAL.
 *
 * The only direct inserts are the things that have no public endpoint:
 * the platform admin user, and wiping tenant data on --reset.
 */

const PASSWORD = 'meridian-demo-1';
const TINY_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');

// Imported lazily so LOG_LEVEL above is set before config/logger load.
const { config } = await import('../config');
const { db, pool } = await import('./client');
const { runMigrations } = await import('./migrate');
const { seedReferenceData } = await import('./reference-data');
const { users } = await import('./schema');
const { hashPassword } = await import('../lib/crypto');
const { SESSION_COOKIE } = await import('../lib/sessions');
const { client, anonymous } = await import('../test/helpers');
const { resetTenantData } = await import('../test/cleanup');
type TestClient = ReturnType<typeof client>;

/** Assert a response status; on mismatch, fail with the API's own error so the cause is obvious. */
function ok(res: Response, expected: number, what: string): Response {
  if (res.status !== expected) {
    throw new Error(`${what}: expected ${expected}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res;
}

function sessionFrom(res: Response): TestClient {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error('No session cookie in response');
  return client(cookie.split(';')[0]!.split('=')[1]!);
}

// ---------- dates relative to "now", so the demo always looks current ----------
const now = new Date();
const today = toIsoDate(now);
function monthOffset(offset: number): { year: number; month: number } {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}
const firstOf = (offset: number) => {
  const { year, month } = monthOffset(offset);
  return firstDayOfMonth(year, month);
};
/** The first Monday on or after the 1st of the month `offset` months from now. */
function firstMondayOf(offset: number): string {
  let d = firstOf(offset);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
}

interface Hire {
  firstName: string;
  lastName: string;
  type: 'employee' | 'contractor';
  countryCode: string;
  jobTitle: string;
  department: string;
  salaryMinor: number;
  payBasis: 'annual' | 'monthly';
  /** Months before now that they started (first of that month). */
  startedMonthsAgo: number;
}

interface HiredWorker {
  id: string;
  email: string;
  portal: TestClient | null;
}

async function main() {
  if (config.isProduction) throw new Error('Refusing to seed a production database');
  const reset = process.argv.includes('--reset');

  await runMigrations();
  await seedReferenceData(db);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'admin@acme.test'))
    .limit(1);
  if (existing && !reset) {
    console.log('Already seeded. Run `npm run db:seed -- --reset` to wipe tenant data and reseed.');
    return;
  }
  if (reset) {
    await resetTenantData();
    console.log('Tenant data wiped.');
  }

  // ---- platform admin: the one user with no public way in ----
  await db.insert(users).values({
    email: 'ops@meridian.test',
    passwordHash: await hashPassword(PASSWORD),
    fullName: 'Olivia Ops',
    role: 'platform_admin',
    organizationId: null,
  });
  const platformLogin = ok(
    await anonymous().post('/auth/login').send({ email: 'ops@meridian.test', password: PASSWORD }),
    200,
    'platform login',
  );
  const platformToken = (platformLogin.headers['set-cookie'] as unknown as string[])[0]!
    .split(';')[0]!
    .split('=')[1]!;
  const platformFor = (orgId: string) => client(platformToken, { 'X-Org-Id': orgId });

  // ---- Acme Robotics ----
  const signup = ok(
    await anonymous().post('/auth/register').send({
      organizationName: 'Acme Robotics',
      countryCode: 'US',
      fullName: 'Alex Morgan',
      email: 'admin@acme.test',
      password: PASSWORD,
    }),
    201,
    'register Acme',
  );
  const admin = sessionFrom(signup);
  const acmeId: string = signup.body.user.organizationId;
  const platform = platformFor(acmeId);

  const invite = ok(
    await admin.post('/team/invites').send({ email: 'manager@acme.test', role: 'client_manager' }),
    201,
    'invite manager',
  );
  ok(
    await anonymous().post('/auth/accept-invite').send({
      token: new URL(invite.body.acceptUrl).searchParams.get('token'),
      fullName: 'Morgan Lee',
      password: PASSWORD,
    }),
    201,
    'manager accepts',
  );
  // A second invite left pending, so the Team page has something to show.
  ok(
    await admin.post('/team/invites').send({ email: 'finance@acme.test', role: 'client_admin' }),
    201,
    'pending invite',
  );

  async function hire(person: Hire, sendInvite = true): Promise<HiredWorker & { acceptUrl: string | null }> {
    const email = `${person.firstName}.${person.lastName}@acme.test`.toLowerCase();
    const res = ok(
      await admin.post('/workers').send({
        type: person.type,
        firstName: person.firstName,
        lastName: person.lastName,
        email,
        countryCode: person.countryCode,
        jobTitle: person.jobTitle,
        department: person.department,
        startDate: firstOf(-person.startedMonthsAgo),
        salaryMinor: person.salaryMinor,
        payBasis: person.payBasis,
        sendInvite,
      }),
      201,
      `hire ${person.firstName}`,
    );
    return { id: res.body.worker.id, email, portal: null, acceptUrl: res.body.acceptUrl };
  }

  async function acceptPortalInvite(person: Hire, acceptUrl: string): Promise<TestClient> {
    const res = ok(
      await anonymous().post('/auth/accept-invite').send({
        token: new URL(acceptUrl).searchParams.get('token'),
        fullName: `${person.firstName} ${person.lastName}`,
        password: PASSWORD,
      }),
      201,
      `${person.firstName} accepts invite`,
    );
    return sessionFrom(res);
  }

  /** Hire someone and take them all the way through onboarding to `active`. */
  async function hireAndActivate(person: Hire): Promise<HiredWorker> {
    const hired = await hire(person);
    const portal = await acceptPortalInvite(person, hired.acceptUrl!);

    const contract = ok(await admin.post('/contracts').send({ workerId: hired.id }), 201, 'contract');
    ok(await admin.post(`/contracts/${contract.body.id}/send`), 200, 'send contract');
    ok(
      await portal
        .post(`/contracts/${contract.body.id}/sign`)
        .send({ signedByName: `${person.firstName} ${person.lastName}`, agree: true }),
      200,
      'sign contract',
    );
    ok(await admin.post(`/contracts/${contract.body.id}/activate`), 200, 'activate contract');

    const docs = ok(await portal.get(`/workers/${hired.id}/documents`), 200, 'list documents');
    for (const doc of docs.body.items as { id: string; kind: string }[]) {
      ok(
        await portal
          .post(`/documents/${doc.id}/file`)
          .send({ fileName: `${doc.kind}.pdf`, mimeType: 'application/pdf', dataBase64: TINY_PDF }),
        200,
        'upload document',
      );
      ok(await platform.post(`/documents/${doc.id}/review`).send({ decision: 'verified' }), 200, 'verify');
    }

    const detail = ok(await admin.get(`/workers/${hired.id}`), 200, 'worker detail');
    for (const task of detail.body.tasks as { id: string; assignee: string; status: string; automatic: boolean }[]) {
      if (task.status === 'completed' || task.automatic) continue;
      const actor = task.assignee === 'worker' ? portal : admin;
      ok(await actor.post(`/onboarding-tasks/${task.id}/complete`), 200, 'complete task');
    }
    const after = ok(await admin.get(`/workers/${hired.id}`), 200, 'worker detail');
    if (after.body.status !== 'active') {
      throw new Error(`${person.firstName} should be active but is ${after.body.status}`);
    }
    return { id: hired.id, email: hired.email, portal };
  }

  console.log('Hiring and onboarding the Acme team…');
  const lena = await hireAndActivate({
    firstName: 'Lena', lastName: 'Fischer', type: 'employee', countryCode: 'DE',
    jobTitle: 'Senior Backend Engineer', department: 'Engineering',
    salaryMinor: 7_200_000, payBasis: 'annual', startedMonthsAgo: 8,
  });
  const tom = await hireAndActivate({
    firstName: 'Tom', lastName: 'Becker', type: 'employee', countryCode: 'DE',
    jobTitle: 'Product Designer', department: 'Design',
    salaryMinor: 5_800_000, payBasis: 'annual', startedMonthsAgo: 5,
  });
  const priya = await hireAndActivate({
    firstName: 'Priya', lastName: 'Sharma', type: 'employee', countryCode: 'IN',
    jobTitle: 'QA Engineer', department: 'Engineering',
    salaryMinor: 240_000_000, payBasis: 'annual', startedMonthsAgo: 6,
  });
  await hireAndActivate({
    firstName: 'Maria', lastName: 'Santos', type: 'employee', countryCode: 'PH',
    jobTitle: 'Customer Support Lead', department: 'Support',
    salaryMinor: 120_000_000, payBasis: 'annual', startedMonthsAgo: 4,
  });
  const james = await hireAndActivate({
    firstName: 'James', lastName: 'Wilson', type: 'employee', countryCode: 'GB',
    jobTitle: 'Account Executive', department: 'Sales',
    salaryMinor: 6_500_000, payBasis: 'annual', startedMonthsAgo: 7,
  });
  await hireAndActivate({
    firstName: 'Sofia', lastName: 'Garcia', type: 'contractor', countryCode: 'ES',
    jobTitle: 'Brand Illustrator', department: 'Design',
    salaryMinor: 450_000, payBasis: 'monthly', startedMonthsAgo: 3,
  });
  const kenji = await hireAndActivate({
    firstName: 'Kenji', lastName: 'Tanaka', type: 'employee', countryCode: 'JP',
    jobTitle: 'Solutions Engineer', department: 'Sales',
    salaryMinor: 8_400_000, payBasis: 'annual', startedMonthsAgo: 10,
  });

  // Kenji has resigned: last day is the end of next month.
  const next = monthOffset(1);
  ok(
    await admin.post(`/workers/${kenji.id}/transition`).send({
      to: 'offboarding',
      endDate: lastDayOfMonth(next.year, next.month),
      reason: 'Resignation — relocating',
    }),
    200,
    'offboard Kenji',
  );

  // Diego is mid-onboarding: accepted the invite, contract waiting for his signature,
  // one document uploaded and awaiting verification.
  const diegoSpec: Hire = {
    firstName: 'Diego', lastName: 'Ramirez', type: 'employee', countryCode: 'MX',
    jobTitle: 'Data Analyst', department: 'Operations',
    salaryMinor: 72_000_000, payBasis: 'annual', startedMonthsAgo: -1, // starts next month
  };
  const diego = await hire(diegoSpec);
  const diegoPortal = await acceptPortalInvite(diegoSpec, diego.acceptUrl!);
  const diegoContract = ok(await admin.post('/contracts').send({ workerId: diego.id }), 201, 'contract');
  ok(await admin.post(`/contracts/${diegoContract.body.id}/send`), 200, 'send contract');
  const diegoDocs = ok(await diegoPortal.get(`/workers/${diego.id}/documents`), 200, 'documents');
  const firstDoc = (diegoDocs.body.items as { id: string }[])[0];
  if (firstDoc) {
    ok(
      await diegoPortal
        .post(`/documents/${firstDoc.id}/file`)
        .send({ fileName: 'passport.pdf', mimeType: 'application/pdf', dataBase64: TINY_PDF }),
      200,
      'upload',
    );
  }

  // Chloe was hired today: nothing done yet, invite link not yet opened.
  await hire({
    firstName: 'Chloe', lastName: 'Martin', type: 'employee', countryCode: 'FR',
    jobTitle: 'Marketing Manager', department: 'Marketing',
    salaryMinor: 6_000_000, payBasis: 'annual', startedMonthsAgo: -1,
  });

  // ---- time off ----
  console.log('Time off, expenses, payroll…');
  const lastMonthMonday = firstMondayOf(-1);
  const lenaLeave = ok(
    await lena.portal!.post('/time-off/requests').send({
      type: 'vacation', startDate: lastMonthMonday, endDate: addDays(lastMonthMonday, 2),
      reason: 'Family visit',
    }),
    201,
    'Lena leave',
  );
  ok(
    await admin.post(`/time-off/requests/${lenaLeave.body.id}/decision`).send({ decision: 'approved' }),
    200,
    'approve leave',
  );
  const nextMonthMonday = firstMondayOf(1);
  if (nextMonthMonday.slice(0, 4) === addDays(nextMonthMonday, 4).slice(0, 4)) {
    ok(
      await lena.portal!.post('/time-off/requests').send({
        type: 'vacation', startDate: nextMonthMonday, endDate: addDays(nextMonthMonday, 4),
        reason: 'Winter break',
      }),
      201,
      'Lena pending leave',
    );
    ok(
      await tom.portal!.post('/time-off/requests').send({
        type: 'sick', startDate: nextMonthMonday, endDate: nextMonthMonday, reason: 'Medical appointment',
      }),
      201,
      'Tom pending leave',
    );
  }

  // ---- expenses ----
  const expense = async (who: HiredWorker, category: string, description: string, amountMinor: number, daysAgo: number) =>
    ok(
      await who.portal!.post('/expenses').send({
        category, description, amountMinor, incurredOn: addDays(today, -daysAgo),
      }),
      201,
      `expense ${description}`,
    ).body.id as string;
  const decide = async (id: string, decision: 'approved' | 'rejected', note?: string) =>
    ok(await admin.post(`/expenses/${id}/decision`).send({ decision, note }), 200, 'expense decision');

  // Approved BEFORE last month's run is created, so that run reimburses it.
  await decide(await expense(lena, 'equipment', 'Mechanical keyboard', 14_900, 40), 'approved');

  // ---- payroll: a history of paid runs, plus runs stopped at each interesting stage ----
  async function runPayroll(
    countryCode: string,
    offset: number,
    until: 'draft' | 'pending_approval' | 'approved' | 'paid',
  ): Promise<void> {
    const { year, month } = monthOffset(offset);
    const run = ok(
      await admin.post('/payroll/runs').send({ countryCode, periodYear: year, periodMonth: month }),
      201,
      `payroll ${countryCode} ${year}-${month}`,
    );
    const id: string = run.body.id;
    if (until === 'draft') return;
    ok(await admin.post(`/payroll/runs/${id}/submit`), 200, 'submit');
    if (until === 'pending_approval') return;
    const approved = ok(await admin.post(`/payroll/runs/${id}/approve`), 200, 'approve');
    if (until === 'approved') return;
    ok(await admin.post(`/invoices/${approved.body.invoiceId}/pay`), 200, 'pay invoice');
    ok(await platform.post(`/payroll/runs/${id}/process`), 200, 'process');
    ok(await platform.post(`/payroll/runs/${id}/mark-paid`), 200, 'mark paid');
  }

  for (const offset of [-3, -2, -1]) await runPayroll('DE', offset, 'paid');
  for (const offset of [-2, -1]) await runPayroll('IN', offset, 'paid');
  for (const offset of [-2, -1]) await runPayroll('JP', offset, 'paid');
  await runPayroll('PH', -1, 'paid');
  await runPayroll('GB', -1, 'approved'); // invoice issued, waiting for payment
  await runPayroll('ES', -1, 'paid');

  // Expenses decided after last month's runs: these wait for the next run.
  await decide(await expense(lena, 'travel', 'Train to client workshop', 8_950, 6), 'approved');
  await expense(priya, 'software', 'Test device farm subscription', 249_900, 4);
  await expense(tom, 'training', 'Design systems course', 39_900, 9);
  await decide(
    await expense(james, 'meals', 'Team dinner', 28_400, 12),
    'rejected',
    'Team meals need pre-approval — please resubmit with the approval email.',
  );

  await runPayroll('DE', 0, 'pending_approval'); // waiting for the admin to approve
  await runPayroll('IN', 0, 'draft');

  // ---- saved quotes ----
  for (const [countryCode, annualSalaryMinor, label] of [
    ['NL', 7_000_000, 'Senior engineer, Amsterdam'],
    ['BR', 24_000_000, 'Support lead, São Paulo'],
  ] as const) {
    ok(await admin.post('/quotes').send({ countryCode, annualSalaryMinor, label }), 201, 'quote');
  }

  // ---- a second, smaller client, so tenant isolation is visible in the demo ----
  const globex = ok(
    await anonymous().post('/auth/register').send({
      organizationName: 'Globex Labs',
      countryCode: 'GB',
      fullName: 'Hank Scorpio',
      email: 'admin@globex.test',
      password: PASSWORD,
    }),
    201,
    'register Globex',
  );
  const globexAdmin = sessionFrom(globex);
  for (const [firstName, lastName, countryCode, salaryMinor] of [
    ['Ines', 'Dubois', 'FR', 5_500_000],
    ['Arjun', 'Mehta', 'SG', 9_600_000],
  ] as const) {
    ok(
      await globexAdmin.post('/workers').send({
        type: 'employee', firstName, lastName,
        email: `${firstName}.${lastName}@globex.test`.toLowerCase(),
        countryCode, jobTitle: 'Research Scientist', department: 'R&D',
        startDate: firstOf(1), salaryMinor, payBasis: 'annual', sendInvite: false,
      }),
      201,
      `Globex hire ${firstName}`,
    );
  }

  console.log(`
Seeded ${new URL(config.databaseUrl).pathname.slice(1)}.  Password for every account: ${PASSWORD}

  Client admin      admin@acme.test
  Client manager    manager@acme.test
  Worker (active)   lena.fischer@acme.test
  Worker (onboard)  diego.ramirez@acme.test
  Platform admin    ops@meridian.test
  Second tenant     admin@globex.test
`);
}

main()
  .catch((err) => {
    console.error('\nSeed failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
