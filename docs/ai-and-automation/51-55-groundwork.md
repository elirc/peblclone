# Stories 51–55 — groundwork

Not implemented. Read [the plan](README.md) first; it explains why each of these pieces
exists. These five stories add no visible feature on their own — they are the machinery
every automation and AI feature after them stands on.

---

## US-51 — Organization settings and feature flags

**Level:** junior · **Size:** ~4 hours

> As a client admin, I want a settings page where I can switch automations and AI
> features on or off for my company, so that nothing happens to my data that I did not
> agree to.

**Why it comes first.** Plan principle 2: every automation is off by default and
switchable per organization. Plan principle 8: AI can be switched off. Both need
somewhere to store the switch.

### Acceptance criteria

- Each organization has one settings row, created with safe defaults (everything off).
- `GET /organization/settings` (staff) returns the settings.
- `PATCH /organization/settings` (admins) updates them; changes are audited with the
  fields that changed.
- A platform admin can read and change settings for the organization they are working in.
- The settings page in the web app shows the switches.
- Existing organizations get a row in the migration.

### Files

- `apps/api/src/db/schema.ts` → generated migration
- `packages/shared/src/schemas.ts`, `dto.ts`
- `apps/api/src/modules/organizations/service.ts`, `routes.ts`, `organizations.test.ts`
- `apps/api/src/lib/settings.ts` (new — other modules will read settings through it)
- `apps/api/src/test/cleanup.ts`
- `apps/web/src/pages/settings/OrganizationSettingsPage.tsx`, `apps/web/src/api/organization.ts`

### Steps

**1. The table.** In `schema.ts`, after the `organizations` table:

```ts
/**
 * Per-organization switches for automations and AI. One row per organization.
 * Every switch defaults to OFF: nothing automatic happens to a customer's data
 * until an admin turns it on (plan principle 2).
 */
export const organizationSettings = pgTable('organization_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  /** Expenses at or below this USD amount are approved automatically. Null = off. */
  autoApproveExpenseLimitUsdMinor: money('auto_approve_expense_limit_usd_minor'),
  /** Day of month (1–28) on which next month's payroll drafts are created. Null = off. */
  payrollDraftDay: integer('payroll_draft_day'),
  onboardingNudgesEnabled: boolean('onboarding_nudges_enabled').notNull().default(false),
  weeklyDigestEnabled: boolean('weekly_digest_enabled').notNull().default(false),
  /** Monthly AI spend cap, in US cents. */
  aiMonthlyBudgetUsdMinor: money('ai_monthly_budget_usd_minor').notNull().default(2_000),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
```

`money` and `ts` are small helpers defined near the top of `schema.ts`; check they
exist with those names. Day of month stops at 28 so the rule works in February.

**2. Migration with a backfill.**

```bash
npm run db:generate -- --name add_organization_settings
```

Open the generated SQL. It creates the table. Existing organizations would have **no
row** — so add, by hand, at the end of the same file:

```sql
--> statement-breakpoint
INSERT INTO "organization_settings" ("organization_id")
SELECT "id" FROM "organizations"
ON CONFLICT DO NOTHING;
```

(The `--> statement-breakpoint` marker is how Drizzle separates statements in a
migration file — look at `0000_init.sql` to see it.) Then `npm run db:migrate`.

**3. Rows for new organizations.** Registration creates an organization in
`apps/api/src/modules/auth/service.ts` (`register`, inside `db.transaction`). Insert
the settings row in the same transaction, right after the organization insert:

```ts
await tx.insert(organizationSettings).values({ organizationId: org.id });
```

And in `apps/api/src/test/helpers.ts`, `createOrganization` must do the same, or every
test organization will lack settings. Find `createOrganization` and add the insert
after the organization is created.

**4. One reader for everyone.** Create `apps/api/src/lib/settings.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { organizationSettings } from '../db/schema';

export type OrganizationSettingsRow = typeof organizationSettings.$inferSelect;

/**
 * The one way other modules read an organization's switches.
 * Throws if the row is missing: that is a bug (every organization gets one at
 * creation), and failing loudly is better than silently treating "missing" as "on".
 */
export async function getSettings(
  dbOrTx: DbOrTx,
  organizationId: string,
): Promise<OrganizationSettingsRow> {
  const [row] = await dbOrTx
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  if (!row) throw new Error(`No settings row for organization ${organizationId}`);
  return row;
}
```

It lives in `lib/` because the expenses, payroll and AI code will all need it, and
modules do not import each other (`CLAUDE.md`, rule 9).

**5. Contract.** In `packages/shared/src/schemas.ts`, near `updateOrganizationSchema`:

```ts
export const updateOrganizationSettingsSchema = z
  .object({
    aiEnabled: z.boolean(),
    autoApproveExpenseLimitUsdMinor: moneyMinorSchema.max(100_000).nullable(), // ≤ $1,000
    payrollDraftDay: z.number().int().min(1).max(28).nullable(),
    onboardingNudgesEnabled: z.boolean(),
    weeklyDigestEnabled: z.boolean(),
    aiMonthlyBudgetUsdMinor: moneyMinorSchema.max(10_000_000), // ≤ $100,000
  })
  .partial();
export type UpdateOrganizationSettingsInput = z.infer<typeof updateOrganizationSettingsSchema>;
```

and in `dto.ts`, an `OrganizationSettingsDto` with the same fields (all present, not
optional) plus `updatedAt: string`.

The upper limits are a safety rail: a typo of `1000000` for `$10.00` must not
auto-approve every expense in the company.

**6. Service and routes.** In `organizations/service.ts`, add `getOrganizationSettings`
and `updateOrganizationSettings`, modelled exactly on `getOrganization` /
`updateOrganization` in the same file: `requireOrgId(actor)`, a transaction for the
update, `recordAudit` with `action: 'organization.settings_updated'` and
`metadata: { fields: Object.keys(input) }`, and an explicit row-to-DTO mapper. Set
`updatedAt: new Date()` in the update.

In `organizations/routes.ts`, next to the `/organization` routes:

```ts
organizationsRouter.get('/organization/settings', authenticate, requireStaff, async (req, res) => {
  res.json(await service.getOrganizationSettings(getActor(req)));
});

organizationsRouter.patch('/organization/settings', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(updateOrganizationSettingsSchema, req);
  res.json(await service.updateOrganizationSettings(getActor(req), input));
});
```

**7. Test cleanup.** Add `'organization_settings'` to `TENANT_TABLES` in
`apps/api/src/test/cleanup.ts`, **before** `'organizations'` (it references
organizations). If you forget, `cleanup.test.ts` fails and tells you so — that guard
was written for exactly this moment (build journal, chapter 14).

**8. Web.** Add `useOrganizationSettings` / `useUpdateOrganizationSettings` hooks in
`apps/web/src/api/organization.ts` following the existing `useOrganization` pair. Add a
second card to `OrganizationSettingsPage.tsx` titled "Automations and AI" with a
`Checkbox` per boolean and number inputs for the limit (entered in dollars, converted
with `parseMoneyToMinor(value, 'USD')`) and the draft day. Only admins see the save
button; everyone on staff can see the values.

### Tests

In `organizations.test.ts`:

- A new tenant's settings are all off and the budget is the default.
- An admin can update; the response and a fresh `GET` agree; an audit row exists.
- A manager can read but gets 403 on `PATCH`.
- Another tenant's admin changing settings does not affect this tenant.
- `autoApproveExpenseLimitUsdMinor: 100_001` → 400.
- `payrollDraftDay: 31` → 400.

### Verify

```bash
npx tsc -p packages/shared && npx tsc -p apps/api && npx tsc -p apps/web
(cd apps/api && npx vitest run src/modules/organizations src/modules/auth src/test/cleanup.test.ts)
```

### Pitfalls

- Forgetting the backfill → every existing organization breaks `getSettings`.
- Forgetting the test helper → most tests start failing once a later story reads
  settings. Do it now.
- Do not default anything to "on". Customers must opt in.

### Questions to answer in your pull request

- Why does `getSettings` throw instead of returning defaults when the row is missing?
- Why are the limits capped in the schema?

---

## US-52 — A system actor for automated changes

**Level:** junior · **Size:** ~3 hours

> As an auditor, I want changes made by automations to be recorded as "System", so that
> I never confuse an automatic approval with a decision a person made.

**Why.** Every service function takes an `Actor` (build journal, chapter 8.5), and an
`Actor` today always has a `userId`. An automation is nobody. Pretending it is the
organization's admin would put a person's name on decisions they never made — exactly
what an audit trail must not do.

### Acceptance criteria

- `Actor` can represent the system: `kind: 'system'`, no user.
- `systemActor(organizationId)` creates one.
- Audit entries written by the system show `actorName: null` and display as "System".
- Code that genuinely needs a person (signing a contract, changing a password) refuses
  a system actor with a clear error.
- No behaviour changes for real users. All existing tests pass.

### Files

- `apps/api/src/lib/actor.ts`
- `apps/api/src/middleware/auth.ts`
- the ~16 places that read `actor.userId` (the compiler will list them)
- `apps/api/src/lib/actor.test.ts` (new)

### Steps

**1. Change the type.** In `lib/actor.ts`, the interface starts at line 13 with
`userId: string;`. Change it to:

```ts
export interface Actor {
  /** 'user' for a signed-in person; 'system' for automations and scheduled jobs. */
  kind: 'user' | 'system';
  /** Null only when kind === 'system'. */
  userId: string | null;
  fullName: string;
  role: UserRole;
  organizationId: string | null;
  workerId: string | null;
}
```

**2. A constructor for the system.** In the same file:

```ts
/**
 * The actor for work nobody clicked: automations and scheduled jobs. It acts
 * inside ONE organization (never across tenants) with admin-level rights,
 * and audit entries it writes have no user — the UI shows them as "System".
 */
export function systemActor(organizationId: string): Actor {
  return {
    kind: 'system',
    userId: null,
    fullName: 'System',
    role: 'client_admin',
    organizationId,
    workerId: null,
  };
}

/** For operations only a person may perform (signing, changing a password). */
export function requireUserId(actor: Actor): string {
  if (actor.kind !== 'user' || !actor.userId) {
    throw forbidden('This action must be performed by a person');
  }
  return actor.userId;
}
```

`forbidden` comes from `./errors`; add the import.

Why `role: 'client_admin'`? Services use role checks like `isAdmin(actor)`. The system
acts with an admin's rights **within one organization** — it never gets
`platform_admin`, which would let it cross tenants.

**3. Set `kind` for real users.** In `middleware/auth.ts`, where `req.actor` is built
(search for `req.actor = {`), add `kind: 'user'`.

**4. Let the compiler find every use.** Run `npx tsc -p apps/api`. Every place that
passed `actor.userId` where a `string` is required now fails. For each one, decide:

| What the code does with the id | Change |
| --- | --- |
| Stores it in a nullable "who did this" column (`createdBy`, `decidedBy`, `reviewedBy`, `invitedBy`) | Nothing — `null` is the right value for "the system" |
| Something only a person can do (signing a contract stores `signedByUserId`; anything password-related) | `requireUserId(actor)` |
| Looks up "my" record (`getSessionUser(actor.userId)`) | Only reachable from HTTP routes, so `requireUserId(actor)` |

Do not silence errors with `actor.userId!`. The whole point is to make each place decide
on purpose — and a non-null assertion is a decision you did not make.

**5. The audit log.** `recordAudit` already accepts `userId: null` (look at its
signature in `lib/audit.ts`), and the audit service already left-joins users, so a null
actor comes out as `actorName: null`. The web audit page shows `actorName ?? 'System'`
— check `AuditLogPage.tsx` and confirm.

### Tests

`apps/api/src/lib/actor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { requireUserId, systemActor } from './actor';

describe('systemActor', () => {
  it('belongs to one organization and to no user', () => {
    const actor = systemActor('00000000-0000-4000-8000-000000000001');
    expect(actor).toMatchObject({ kind: 'system', userId: null, role: 'client_admin' });
  });
  it('is refused where a person is required', () => {
    expect(() => requireUserId(systemActor('00000000-0000-4000-8000-000000000001'))).toThrow();
  });
});
```

And one integration test proving the audit display: call a service function directly
with `systemActor(org.id)` — for example `updateOrganization` — then
`GET /audit-logs` as the admin and assert the entry's `actorName` is `null`.

### Verify

`npm run typecheck` and the full API suite — this touches shared types, so run all of it.

### Pitfalls

- Giving the system actor `platform_admin`. It would bypass tenant scoping.
- `!` assertions to make the compiler quiet.
- Forgetting `kind: 'user'` in the middleware: TypeScript will catch it, which is why
  `kind` is required and not optional.

### Questions to answer in your pull request

- Why is it wrong for automations to act "as" the organization's admin?
- Which of the call sites needed `requireUserId`, and why those?

---

## US-53 — A minimal background job runner

**Level:** junior · **Size:** ~1 day

> As a developer, I want a way to say "do this later" from inside a request, so that
> slow or scheduled work does not keep a user waiting.

Part 2's US-39 describes the full design (leases, backoff, idempotence) in depth. This
is the **minimal** version a junior can build and the rest of this plan needs. Read
US-39's "The concept" section first.

### Acceptance criteria

- `enqueue(tx, kind, payload, { runAt? })` records a job **in the caller's transaction**.
- A worker process claims due jobs one at a time, runs the handler registered for the
  kind, and marks the job `done`, or `failed` after three attempts.
- Two workers never run the same job (`FOR UPDATE SKIP LOCKED`).
- A worker that crashes mid-job does not leave the job stuck forever.
- `npm run worker` starts the worker; `npm run dev` starts it alongside the API.
- Tests can run "everything that is due" synchronously.

### Files

- `apps/api/src/db/schema.ts` → generated migration
- `apps/api/src/lib/jobs.ts` (new), `apps/api/src/lib/jobs.test.ts` (new)
- `apps/api/src/worker.ts` (new)
- `apps/api/package.json`, root `package.json`
- `apps/api/src/test/cleanup.ts`

### Steps

**1. The table.** In `schema.ts`:

```ts
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const;
export const jobStatusEnum = pgEnum('job_status', JOB_STATUSES);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    /** Null for platform-wide jobs. */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind').notNull(),
    /** IDs and small values only — never documents or personal data. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    runAt: ts('run_at').notNull().defaultNow(),
    /** While running: if this passes, the worker is presumed dead and the job is claimable again. */
    lockedUntil: ts('locked_until'),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_due_idx').on(t.status, t.runAt)],
);
```

Generate and read the migration (`--name add_jobs`), then migrate. Add `'jobs'` to
`TENANT_TABLES` before `'organizations'`.

**2. Enqueue — only inside a transaction.** `apps/api/src/lib/jobs.ts`:

```ts
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client';
import { jobs } from '../db/schema';
import { logger } from './logger';

/**
 * Record work to do later. Takes a Tx, not DbOrTx, ON PURPOSE: the job must
 * commit together with the change that caused it. If the transaction rolls
 * back, the job never existed. (Part 2, US-31: the dual-write problem.)
 */
export async function enqueue(
  tx: Tx,
  kind: string,
  payload: Record<string, unknown>,
  options: { organizationId?: string | null; runAt?: Date } = {},
): Promise<void> {
  await tx.insert(jobs).values({
    kind,
    payload,
    organizationId: options.organizationId ?? null,
    runAt: options.runAt ?? new Date(),
  });
}
```

**3. Handlers.** In the same file, a registry:

```ts
export type JobHandler = (payload: Record<string, unknown>, job: { id: string; organizationId: string | null }) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/** Called once at startup by each feature that has background work. */
export function registerJob(kind: string, handler: JobHandler): void {
  if (handlers.has(kind)) throw new Error(`Job kind registered twice: ${kind}`);
  handlers.set(kind, handler);
}
```

**4. Claim one job.** Claiming must be atomic. One statement selects a due job, locks
it, skips jobs other workers have locked, and marks it running:

```ts
const MAX_ATTEMPTS = 3;
const LEASE_SECONDS = 300;

/** Atomically take the next due job, or null. Safe with any number of workers. */
async function claimNext() {
  const result = await db.execute<{ id: string; kind: string; payload: Record<string, unknown>; organization_id: string | null; attempts: number }>(sql`
    update jobs set
      status = 'running',
      attempts = attempts + 1,
      locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
    where id = (
      select id from jobs
      where (status = 'queued' and run_at <= now())
         or (status = 'running' and locked_until < now())   -- a worker died holding it
      order by run_at
      limit 1
      for update skip locked
    )
    returning id, kind, payload, organization_id, attempts
  `);
  return result.rows[0] ?? null;
}
```

Read it slowly — every clause is a design decision:

- `for update skip locked`: two workers running this at once each get a different job.
- The second `or` branch is crash recovery: a job whose lease ran out goes back into
  play.
- `attempts + 1` happens on **claim**, so a job that crashes the worker repeatedly still
  counts towards its limit.

**5. Run it.**

```ts
/** Run one due job. Returns false when there was nothing to do. */
export async function runOne(): Promise<boolean> {
  const job = await claimNext();
  if (!job) return false;

  const handler = handlers.get(job.kind);
  try {
    if (!handler) throw new Error(`No handler registered for job kind "${job.kind}"`);
    await handler(job.payload, { id: job.id, organizationId: job.organization_id });
    await db.execute(sql`update jobs set status = 'done', locked_until = null where id = ${job.id}`);
  } catch (err) {
    const failed = job.attempts >= MAX_ATTEMPTS;
    // Exponential-ish backoff: 1, 4, 9 minutes.
    const retryInMinutes = job.attempts * job.attempts;
    logger.warn({ err, jobId: job.id, kind: job.kind, attempts: job.attempts }, 'Job failed');
    await db.execute(sql`
      update jobs set
        status = ${failed ? 'failed' : 'queued'},
        locked_until = null,
        last_error = ${String(err instanceof Error ? err.message : err).slice(0, 2000)},
        run_at = now() + make_interval(mins => ${retryInMinutes})
      where id = ${job.id}
    `);
  }
  return true;
}

/** Tests: run everything currently due, then stop. */
export async function drainJobs(limit = 100): Promise<number> {
  let ran = 0;
  while (ran < limit && (await runOne())) ran += 1;
  return ran;
}
```

**6. The worker process.** `apps/api/src/worker.ts`:

```ts
import { pool } from './db/client';
import { runOne } from './lib/jobs';
import { logger } from './lib/logger';
import './jobs-registry'; // imports every module that calls registerJob (create this file, empty for now)

let stopping = false;

async function loop() {
  while (!stopping) {
    const didWork = await runOne().catch((err) => {
      logger.error({ err }, 'Worker loop error');
      return false;
    });
    // Busy: go straight to the next job. Idle: wait a second, do not spin.
    if (!didWork) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await pool.end();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`${signal}: finishing the current job, then stopping`);
    stopping = true;
  });
}

logger.info('Worker started');
void loop();
```

Create `apps/api/src/jobs-registry.ts` containing only a comment for now:
`// Each feature with background work adds an import here.` Later stories add lines.

**7. Scripts.** In `apps/api/package.json`, add `"worker": "tsx watch src/worker.ts"`.
In the root `package.json`, extend `dev` to run three processes:

```json
"dev": "concurrently -n api,worker,web -c blue,magenta,green \"npm run dev -w @meridian/api\" \"npm run worker -w @meridian/api\" \"npm run dev -w @meridian/web\"",
```

### Tests

`apps/api/src/lib/jobs.test.ts` — register test handlers in the test file itself:

- **Atomic with the transaction:** inside `db.transaction`, `enqueue(...)` then throw;
  assert the `jobs` table is empty.
- **Runs and finishes:** enqueue, `drainJobs()`, handler called once, status `done`.
- **Retries then fails:** a handler that always throws; call `drainJobs` three times,
  moving `run_at` into the past between calls (`update jobs set run_at = now() - interval '1 minute'`);
  final status `failed`, `last_error` set.
- **Not before its time:** `runAt` one hour ahead → `drainJobs()` returns 0.
- **Crash recovery:** set a job to `running` with `locked_until` in the past → it is
  claimed again.
- **No double claim:** enqueue one job, call `runOne()` twice with `Promise.all`; the
  handler runs once.

Because registrations are module-level, give test kinds unique names (`test.ok`,
`test.fails`) so they do not collide with real ones.

### Verify

```bash
(cd apps/api && npx vitest run src/lib/jobs.test.ts src/test/cleanup.test.ts)
npm run dev   # three coloured processes; the worker logs "Worker started"
```

### Pitfalls

- Doing the work inside the claim statement's transaction (it would hold a lock for
  the whole job).
- `enqueue(db, …)` "just this once" — the signature takes `Tx` so that this does not
  compile.
- Putting documents or names in `payload`. Ids only; the handler loads what it needs.
- A handler that is not safe to run twice. **Every handler can run more than once**
  (crash after the work, before `done`). Each story that adds a handler must say why
  running it twice is harmless.

### Questions to answer in your pull request

- What happens, step by step, if the worker process is killed halfway through a job?
- Why does `enqueue` take `Tx` and not `DbOrTx`?

---

## US-54 — A scheduler that is safe on many servers

**Level:** junior · **Size:** ~4 hours

> As a developer, I want to say "run this every day at 06:00 UTC" once, and have it run
> exactly once per day even with several API servers and even after a missed day.

Read part 2's US-40, "The concept" — it explains why `setInterval` is not a scheduler
and why scheduled work must be safe to run any number of times.

### Acceptance criteria

- Tasks are registered with a name and a schedule (`daily at HH:MM UTC`, `weekly on
  Monday at HH:MM UTC`, `hourly`).
- Each due occurrence produces **one** job, however many processes check, however late
  they check.
- If the worker was down at 06:00, the task still runs when it comes back that day.
- Occurrences are recorded, so an admin can see when a task last ran.

### The idea

Give every occurrence a **name**: the daily digest due on 2026-12-01 is
`weekly-digest/2026-12-01`. Recording that name in a table with a unique constraint turns
"has this already been scheduled?" into a question the database answers atomically:

```sql
INSERT INTO scheduled_runs (task, occurrence) VALUES ('weekly-digest', '2026-12-01')
ON CONFLICT DO NOTHING
RETURNING id;
```

One row back → this process won, it enqueues the job. Zero rows → someone else already
did. No locks, no leader election, nothing to clean up after a crash.

### Files

- `apps/api/src/db/schema.ts` → migration
- `apps/api/src/lib/scheduler.ts` (new), `scheduler.test.ts` (new)
- `apps/api/src/worker.ts`
- `apps/api/src/test/cleanup.ts` (decide: is this tenant data?)

### Steps

**1. The table.**

```ts
export const scheduledRuns = pgTable(
  'scheduled_runs',
  {
    id: id(),
    task: text('task').notNull(),
    /** A stable name for one occurrence: '2026-12-01' for daily, '2026-12-01T13' for hourly. */
    occurrence: text('occurrence').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('scheduled_runs_task_occurrence_unique').on(t.task, t.occurrence)],
);
```

It is not tenant data, but tests must start empty — add it to `TENANT_TABLES` with a
comment saying so (it has no foreign keys, so its position does not matter).

**2. Schedules as pure functions.** `lib/scheduler.ts`:

```ts
/** Given "now", return the name of the occurrence that is due, or null if none is due yet. */
export type Schedule = (now: Date) => string | null;

export const daily = (hourUtc: number, minuteUtc = 0): Schedule => (now) => {
  const due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc));
  return now >= due ? due.toISOString().slice(0, 10) : null;
};

export const weekly = (weekdayUtc: number, hourUtc: number): Schedule => (now) =>
  now.getUTCDay() === weekdayUtc ? daily(hourUtc)(now) : null;

export const hourly: Schedule = (now) => now.toISOString().slice(0, 13); // '2026-12-01T13'
```

Note what `daily` returns *after* 06:00: today's name, all day. That is how a late check
still catches today's run — "due and not yet recorded", not "it is exactly 06:00".

What about a run missed on a **previous** day? This design does not catch up yesterday's
occurrence — the plan's automations are written to be "ensure the current state" tasks
(part 2, US-40), so today's run covers yesterday's work. Write that limitation in a
comment.

**3. Registration and the tick.**

```ts
interface Task { name: string; schedule: Schedule; jobKind: string }
const tasks: Task[] = [];

export function registerTask(task: Task): void {
  tasks.push(task);
}

/**
 * Check every task once. Run this every minute from any number of processes:
 * the unique index guarantees each occurrence is scheduled exactly once.
 */
export async function tick(now = new Date()): Promise<string[]> {
  const scheduled: string[] = [];
  for (const task of tasks) {
    const occurrence = task.schedule(now);
    if (!occurrence) continue;
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(scheduledRuns)
        .values({ task: task.name, occurrence })
        .onConflictDoNothing()
        .returning({ id: scheduledRuns.id });
      if (inserted.length > 0) {
        await enqueue(tx, task.jobKind, { occurrence });
        scheduled.push(`${task.name}/${occurrence}`);
      }
    });
  }
  return scheduled;
}
```

The scheduled-run row and the job are written in **one** transaction: either both exist
or neither does.

**4. Run the tick.** In `worker.ts`, start a once-a-minute timer that calls `tick()`
and logs errors (copy the `setInterval` + `.unref()` pattern from `server.ts`). Also
call `tick()` once at startup.

### Tests

`lib/scheduler.test.ts` — the schedule functions are pure, so most tests need no
database:

- `daily(6)` at 05:59 → null; at 06:00 → today's date; at 23:00 → today's date.
- `weekly(1, 6)` on a Monday at 07:00 → the date; on a Tuesday → null.
- `tick` twice with the same `now` → one job.
- `tick` twice concurrently (`Promise.all`) → one job.
- `tick` at 06:00 and again at 09:00 on the same day → still one job.
- `tick` the next day → a second job.

Register a test task inside the test file with a unique name.

### Pitfalls

- Using local time. Everything here is UTC; say "06:00 UTC" in the UI too.
- Writing "if it is exactly 06:00" — the classic bug that misses every run the process
  was restarted across.
- Enqueuing outside the transaction that records the occurrence.

### Questions to answer in your pull request

- Three servers run `tick()` at 06:00:00.000. Walk through what happens.
- The worker is down from 05:00 to 11:00. What happens at 11:00, and why?

---

## US-55 — In-app notifications and the bell

**Level:** junior · **Size:** ~1 day

> As a client admin, I want a bell in the header that shows things that need my
> attention, so that automations can tell me what they did and what is waiting for me.

There is no email service (it is out of scope). Notifications are rows in a table shown
in the app; `lib/notify.ts` is the one place a future email or Slack channel would
plug in.

### Acceptance criteria

- `notify(tx, …)` creates notifications for specific users, optionally de-duplicated by
  a key.
- `GET /notifications` returns my notifications, newest first, paginated.
- `GET /notifications/unread-count` returns a number.
- `POST /notifications/:id/read` and `POST /notifications/read-all`.
- I can only ever see or change my own notifications.
- A bell with an unread count in the app header, and a panel listing them; each item
  links to the relevant page.

### Files

- `apps/api/src/db/schema.ts` → migration
- `apps/api/src/lib/notify.ts` (new)
- `apps/api/src/modules/notifications/routes.ts`, `service.ts`, `notifications.test.ts` (new module)
- `apps/api/src/modules/index.ts`, `apps/api/src/test/cleanup.ts`
- `packages/shared/src/dto.ts`, `schemas.ts`
- `apps/web/src/api/notifications.ts`, `apps/web/src/components/layout/NotificationBell.tsx`,
  `AppShell.tsx`, `apps/web/src/lib/query.ts`

### Steps

**1. The table.**

```ts
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull().references(() => organizations.id),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),               // e.g. 'payroll.draft_ready'
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** In-app path to open, e.g. '/payroll/<id>'. Always a relative path. */
    link: text('link'),
    /** Same key twice for the same user = one notification. */
    dedupeKey: text('dedupe_key'),
    readAt: ts('read_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('notifications_user_unread_idx').on(t.userId, t.readAt),
    uniqueIndex('notifications_user_dedupe_unique').on(t.userId, t.dedupeKey),
  ],
);
```

A unique index treats NULLs as distinct in Postgres, so notifications *without* a key are
never de-duplicated — which is what you want. Migration `--name add_notifications`;
add `'notifications'` to `TENANT_TABLES` before `'users'`.

**2. `lib/notify.ts`.**

```ts
/**
 * Tell users something. Takes a Tx so a notification about a change commits
 * with that change. dedupeKey makes repeats harmless — a job that runs twice
 * (US-53: every job can) does not notify twice.
 */
export async function notify(
  tx: Tx,
  input: {
    organizationId: string;
    userIds: string[];
    kind: string;
    title: string;
    body?: string;
    link?: string;
    dedupeKey?: string;
  },
): Promise<void> {
  if (input.userIds.length === 0) return;
  await tx
    .insert(notifications)
    .values(
      input.userIds.map((userId) => ({
        organizationId: input.organizationId,
        userId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? '',
        link: input.link ?? null,
        dedupeKey: input.dedupeKey ?? null,
      })),
    )
    .onConflictDoNothing();
}

/** Active client admins of an organization — the usual audience for automation news. */
export async function clientAdminIds(dbOrTx: DbOrTx, organizationId: string): Promise<string[]> {
  const rows = await dbOrTx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.role, 'client_admin'), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}
```

**3. The module.** Create `modules/notifications/` following `modules/organizations/`.
Every query filters by **both** `userId = actor.userId` and
`organizationId = requireOrgId(actor)`. Marking one as read:

```ts
const [row] = await db
  .update(notifications)
  .set({ readAt: new Date() })
  .where(and(eq(notifications.id, id), eq(notifications.userId, userId), eq(notifications.organizationId, orgId)))
  .returning({ id: notifications.id });
if (!row) throw notFound('Notification');
```

Someone else's notification id → 404, the same rule as tenant isolation, applied to
users. Use `requireUserId(actor)` (US-52) to get `userId` — the system has no inbox.

Register `notificationsRouter` in `modules/index.ts`. Add a `NotificationDto` to
`dto.ts`.

**4. Never trust `link` from data.** `link` is always set by our own code, but treat it
as untrusted anyway in the web app: only follow it if it starts with `/` and not `//`
(the login page already does this check — see `LoginPage.tsx`). A notification must
never be able to send a user to another site.

**5. Web.**

- `keys.notifications` in `lib/query.ts`.
- `api/notifications.ts`: `useUnreadCount()` with `refetchInterval: 60_000` (polling once
  a minute is plenty; part 2's US-44 covers live updates), `useNotifications()`,
  `useMarkRead()`, `useMarkAllRead()` — both mutations invalidate `keys.notifications`.
- `NotificationBell.tsx`: a button with a `Bell` icon and an unread badge; clicking opens
  a panel (a `Modal` is fine to start) listing notifications, unread ones in bold, each
  clickable to mark read and navigate. Give the button `aria-label="Notifications, 3 unread"`.
- Put the bell in `AppShell.tsx`'s header, before `<UserMenu />`. Workers get it too.

### Tests

API (`notifications.test.ts`):

- `notify` for two users → each sees only their own.
- Same `dedupeKey` twice → one notification.
- `notify` inside a transaction that then throws → no notification.
- Marking another user's notification → 404; and it stays unread.
- `read-all` marks only mine.
- Unread count is correct before and after.

Web: the bell shows the count from a mocked `/notifications/unread-count` and the
accessible name includes it.

### Pitfalls

- Filtering by organization but not by user: a manager would read the admin's inbox.
- Storing absolute URLs in `link`.
- Polling every second.

### Questions to answer in your pull request

- Why does `notify` take a transaction?
- What stops a job that runs twice from notifying twice?
