# Stories 16–20 — mid-level: hardening

Not implemented. See the [index](README.md) for how to use these and for the warning
about line numbers.

These five are about making the system *more correct* rather than adding screens. Three
of them close items on the known-gaps list in the build journal (chapter 20.2). They
involve concurrency, database design and judgement — expect to read more code than you
write.

---

## US-16 — Former workers are read-only

**Level:** mid · **Area:** api · **Size:** ~3 hours

> As a compliance officer, I want a terminated or cancelled worker's record to be frozen,
> so that nobody — including the worker — can alter documents or checklist items after
> they have left.

**Background.** A terminated worker deliberately keeps their login so they can download
their final payslip (build journal, chapter 13.3). The independent review then pointed
out that a few *write* paths do not check the worker's status. The code even admits it —
`apps/api/src/modules/workers/service.ts`, line 533:

```ts
      // paths, e.g. uploading a document, do not check status. Known gap.)
```

This story closes that gap.

### Acceptance criteria

- Uploading a document for a `terminated` or `cancelled` worker → `409 worker_inactive`,
  for every role.
- Completing an onboarding task for such a worker → `409 worker_inactive`.
- A terminated worker can still **read**: their record, documents list, file downloads,
  payslips.
- The "Known gap" comment is gone.

### Files

- `apps/api/src/modules/documents/service.ts` (change)
- `apps/api/src/modules/workers/service.ts` (change)
- `apps/api/src/modules/documents/documents.test.ts`, `workers/workers.test.ts` (add tests)
- `docs/api-contract.md`

### Steps

**1. Documents: use the lock you already take.** In `documents/service.ts`,
`uploadDocument` starts at line 143. Inside its transaction (line 170) is:

```ts
      await lockWorker(tx, orgId, existing.workerId);
```

That module's `lockWorker` (line 45) already returns `{ id, status }` — the return value
is simply being thrown away. Keep it, and check it:

```ts
      const worker = await lockWorker(tx, orgId, existing.workerId);
      // A former worker's file is a record, not a workspace: no new uploads.
      if (worker.status === 'terminated' || worker.status === 'cancelled') {
        throw conflict('This worker’s record is closed', 'worker_inactive');
      }
```

`conflict` is already imported there.

**Why inside the transaction, after the lock?** Because the status can change between
the first read and the write. Checking under the row lock means "the worker was not
terminated *at the moment we wrote*". A check before the transaction would be a
check-then-act race — exactly the pattern the build journal's chapter 17 found twice.

**2. …and mind the orphaned file.** Look a few lines up (163–164): the new file is
written to disk **before** the transaction. Read on to the `catch` block after the
transaction — it deletes that file when the transaction throws. Your new `throw` happens
inside the transaction, so that cleanup already covers it. Confirm this by reading the
code; do not take this document's word for it. If the cleanup were missing, your change
would leak a file on disk for every refused upload.

**3. Tasks.** In `workers/service.ts`, `completeTask` (line 623). After the lock and the
idempotent early return (lines 646–651):

```ts
    const worker = await lockWorker(tx, orgId, task.workerId);

    if (task.status === 'completed') {
      // Idempotent: double-clicks and retries are harmless.
      return { task: toTaskDto(task), workerStatus: worker.status };
    }
```

add:

```ts
    if (worker.status === 'terminated' || worker.status === 'cancelled') {
      throw conflict('This worker’s record is closed', 'worker_inactive');
    }
```

Placing it *after* the idempotent return is deliberate: re-sending a completion that
already happened should still answer `200`, even for a former worker. Retries must be
safe.

**4. Remove the admission.** At line 531–533 of `workers/service.ts` the comment reads:

```ts
      // (A TERMINATED worker deliberately keeps their login — they still need
      // their final payslip. Time off and expenses refuse them; a few minor write
      // paths, e.g. uploading a document, do not check status. Known gap.)
```

Change the last two lines to state what is now true:

```ts
      // (A TERMINATED worker deliberately keeps their login — they still need
      // their final payslip. Every write path refuses them: time off, expenses,
      // document uploads and checklist tasks all check the worker's status.)
```

A comment that describes a gap you have closed is now a lie. Fixing it is part of the
change.

**5. Contract.** In `docs/api-contract.md`:

- Documents → Upload: add "worker `terminated` or `cancelled` → `409 worker_inactive`".
- Workers → Complete task: add the same.

### Tests

**Documents** — in `documents.test.ts`. That file defines a `PDF` buffer at line 22;
reuse it. Create a requested document the way the neighbouring tests do, or directly:

```ts
  it('refuses an upload for a terminated worker, but still lets them read', async () => {
    const { org } = await createTenant();
    const worker = await createWorker(org.id, { status: 'terminated', endDate: '2026-03-31' });
    const [doc] = await db
      .insert(documents)
      .values({ organizationId: org.id, workerId: worker.id, kind: 'passport', title: 'Passport' })
      .returning();
    const portal = await loginAsWorker(worker);

    const upload = await portal.client.post(`/documents/${doc!.id}/file`).send({
      fileName: 'passport.pdf',
      mimeType: 'application/pdf',
      dataBase64: PDF.toString('base64'),
    });
    expect(upload.status).toBe(409);
    expect(upload.body.error.code).toBe('worker_inactive');

    // Read access is intact.
    expect((await portal.client.get(`/workers/${worker.id}/documents`)).status).toBe(200);
    // And the row was not touched.
    const [after] = await db.select().from(documents).where(eq(documents.id, doc!.id));
    expect(after?.status).toBe('requested');
  });

  it('refuses the upload from staff too', async () => {
    // same arrangement, but upload as `admin` → 409 worker_inactive
  });
```

**Tasks** — in `workers.test.ts`:

```ts
  it('refuses to complete a checklist task for a cancelled hire', async () => {
    const { org, admin } = await createTenant();
    const worker = await createWorker(org.id, { status: 'cancelled' }, { withTasks: true });
    const [task] = await db
      .select()
      .from(onboardingTasks)
      .where(and(eq(onboardingTasks.workerId, worker.id), eq(onboardingTasks.key, 'client_confirm_start')));

    const res = await admin.post(`/onboarding-tasks/${task!.id}/complete`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('worker_inactive');
  });
```

### Verify

```bash
cd apps/api && npx vitest run src/modules/documents src/modules/workers src/test/journey.test.ts
```

### Pitfalls

- Do not block **reads**. Run the existing "a terminated worker keeps read access" test
  (it is in `workers.test.ts`, in the `review fixes` block) to be sure.
- Do not put the check in `findDocument`. That helper is used by the *download* path too.
- Check there is no storage leak: after the refused upload test, the storage directory
  for that organization should not contain a new file. (Asserting this in a test is the
  stretch.)

### Stretch

The reviewer listed one more write path: a terminated worker can still **sign** a
contract that was `sent`. Open `apps/api/src/modules/contracts/service.ts`, find
`transition` — it already locks the worker row and reads `workerStatus` under the lock.
Add the refusal for the `sign` action only. Why must `terminate` and `void` still be
allowed for a former worker?

---

## US-17 — Overdue invoices on the dashboard

**Level:** mid · **Area:** shared + api + web · **Size:** ~3 hours

> As a client admin, I want the dashboard to tell me when an invoice is past its due
> date, so that payroll is not held up because I missed a payment.

**Context.** Payroll cannot be processed until its invoice is paid (build journal,
chapter 2). The dashboard's "Needs your attention" card counts *unpaid* invoices, but an
invoice issued this morning and one that is three weeks late look the same. The invoice
*list* already shows an "Overdue" badge, computed in the browser
(`apps/web/src/pages/invoices/invoice-ui.tsx`). The dashboard needs the number from the
server.

### Acceptance criteria

- `GET /dashboard` returns `pending.overdueInvoices`: invoices with status `issued` whose
  `dueDate` is before today.
- An invoice due **today** is not overdue.
- Paid and void invoices never count.
- The count is tenant-scoped.
- The dashboard shows "N overdue invoices" linking to `/invoices`.

### Files

- `packages/shared/src/dto.ts`
- `apps/api/src/modules/dashboard/service.ts`, `dashboard.test.ts`
- `apps/web/src/pages/dashboard/DashboardPage.tsx`, `DashboardPage.test.tsx`
- `docs/api-contract.md`

### Steps

**1. DTO.** `packages/shared/src/dto.ts`, in `DashboardDto.pending` (search for
`unpaidInvoices`, line 390):

```ts
    unpaidInvoices: number;
    /** Issued invoices whose due date has passed. A subset of unpaidInvoices. */
    overdueInvoices: number;
    contractsAwaitingSignature: number;
```

**2. Let the compiler list the work.** `npm run typecheck`. It fails in the dashboard
service (the returned object lacks the field) and in any test fixture that builds a
`DashboardDto`. Work through the list.

**3. Service.** `dashboard/service.ts`. Line 1 is a type-only import; you now need a
value from shared as well:

```ts
import { toIsoDate, type AuditLogDto, type DashboardDto } from '@meridian/shared';
```

`lt` is already imported from `drizzle-orm` (line 2).

The pending counts are computed in one `Promise.all` that destructures five results —
search for:

```ts
  const [timeOff, expenseCount, approvals, unpaid, awaitingSignature] = await Promise.all([
```

Add a sixth name:

```ts
  const [timeOff, expenseCount, approvals, unpaid, awaitingSignature, overdue] = await Promise.all([
```

and a sixth query at the **end** of the array (after the `contracts` one, which closes on
line 118), so the positions still line up:

```ts
    countWhere(
      db
        .select({ n: count() })
        .from(invoices)
        .where(
          and(
            eq(invoices.organizationId, orgId),
            eq(invoices.status, 'issued'),
            // due_date is a calendar date; "overdue" starts the day AFTER it.
            lt(invoices.dueDate, toIsoDate(new Date())),
          ),
        ),
    ),
```

Then in the returned object (line 121):

```ts
    unpaidInvoices: unpaid,
    overdueInvoices: overdue,
    contractsAwaitingSignature: awaitingSignature,
```

**Positional destructuring is fragile.** Insert the new query in the middle of the array
without also moving its name and `unpaid` silently becomes the overdue count — and
TypeScript will not notice, because both are `number`. Adding at the end of both lists is
the safe move. (A sturdier design would be an object of named promises; that is the
stretch.)

**4. Web.** `DashboardPage.tsx`, `ATTENTION_ITEMS` (line 21). After the `unpaidInvoices`
entry (line 35):

```ts
  { key: 'unpaidInvoices', one: 'unpaid invoice', many: 'unpaid invoices', to: '/invoices' },
  { key: 'overdueInvoices', one: 'overdue invoice', many: 'overdue invoices', to: '/invoices' },
```

The list is typed `keyof Pending`, so a typo in `key` is a compile error.

**5. Contract.** Audit & dashboard → Rules: "`pending.overdueInvoices` = `issued`
invoices with `dueDate` before today (UTC); a subset of `unpaidInvoices`."

### Tests — API

In `dashboard.test.ts`. That file already inserts invoices directly for the monthly-spend
test; find that helper and reuse it. You need four invoices in one tenant and one in
another:

| Invoice | status | dueDate | Counts as overdue? |
| --- | --- | --- | --- |
| A | issued | yesterday | yes |
| B | issued | **today** | no — the boundary |
| C | issued | tomorrow | no |
| D | paid | last month | no |
| E (other tenant) | issued | yesterday | no — wrong tenant |

```ts
  it('counts issued invoices past their due date, and only those', async () => {
    // arrange the five invoices above, computing dates with addDays(toIsoDate(new Date()), ±n)
    const res = await admin.get('/dashboard');
    expect(res.body.pending.overdueInvoices).toBe(1);
    expect(res.body.pending.unpaidInvoices).toBe(3); // A, B and C are all unpaid
  });
```

Row B is the one that matters. It is the difference between `<` and `<=`, and it is the
row people leave out.

### Tests — web

`DashboardPage.test.tsx` builds a `DashboardDto` fixture; add `overdueInvoices` to it
(the compiler already told you). Then one test: with `overdueInvoices: 2`, a link named
`/2 overdue invoices/` exists and points to `/invoices`; with `0`, it is absent.

### Verify

```bash
npm run typecheck
(cd apps/api && npx vitest run src/modules/dashboard)
(cd apps/web && npx vitest run src/pages/dashboard)
```

To see it in the app: the seed leaves one unpaid UK invoice. Make it overdue —

```sql
update invoices set due_date = current_date - 3 where status = 'issued';
```

— and reload the dashboard.

### Pitfalls

- Two definitions of "overdue" now exist: this server query and `isOverdue` in
  `invoice-ui.tsx`. Read the browser one. Does it use the same boundary? The same
  timezone? Two implementations of one rule is how a dashboard says "1 overdue" above a
  list showing none.
- "Today" is UTC on the server. Decide whether that is acceptable and write the decision
  in a comment.

### Stretch

Remove the duplication: add `isOverdue: boolean` to `InvoiceDto`, compute it in
`toInvoiceDto` (`apps/api/src/modules/invoices/service.ts`, line 24), and make
`invoice-ui.tsx` read the field instead of calculating. Then refactor the positional
`Promise.all` into named promises.

---

## US-18 — An index for the people list

**Level:** mid · **Area:** database · **Size:** ~3 hours

> As a client with ten thousand workers, I want the People page to stay fast, so that
> paging through my workforce does not take seconds per click.

**What you will learn.** How to *measure* a query, read a query plan, and add an index
with evidence — instead of adding indexes by superstition.

### The query

`listWorkers` (`apps/api/src/modules/workers/service.ts`, lines 201–209) runs:

```sql
SELECT … FROM workers JOIN countries …
WHERE workers.organization_id = $1
ORDER BY workers.last_name, workers.first_name, workers.id
LIMIT 25 OFFSET 0;
```

The `workers` table has an index on `(organization_id, status)` and a unique one on
`(organization_id, email)` (`schema.ts`, lines 194–196). Neither is ordered by name. So
Postgres must fetch **every** worker of the organization, sort them all, and return 25.

### Acceptance criteria

- You have a written before/after measurement (paste it into the commit message).
- A new index makes the first page of an unfiltered list avoid a full sort.
- The migration contains only the index.
- All tests still pass.

### Files

- `apps/api/src/db/schema.ts` → generated migration
- nothing else

### Steps

**1. Create realistic data.** With eleven workers every plan is "scan the table", because
that *is* fastest for eleven rows — and it tells you nothing. Make 50,000 workers in a
scratch organization of your dev database:

```sql
-- psql -h localhost -p 5443 -U postgres -d meridian_dev
insert into organizations (name, legal_name, country_code, billing_email)
values ('Perf Test Inc', 'Perf Test Inc', 'US', 'perf@example.test')
returning id;      -- copy the id into :org below

insert into workers (organization_id, type, status, first_name, last_name, email,
                     country_code, job_title, start_date, salary_minor, pay_basis, currency)
select :'org', 'employee', 'active',
       'First' || (g % 500), 'Last' || lpad((g % 9973)::text, 5, '0'), 'perf' || g || '@example.test',
       'DE', 'Engineer', date '2025-01-01', 6000000, 'annual', 'EUR'
from generate_series(1, 50000) g;

analyze workers;
```

(`\set org '<the uuid>'` first.) `analyze` updates the statistics the planner uses.
Skipping it is the most common reason a plan "does not use my index".

**2. Measure before.**

```sql
explain (analyze, buffers)
select w.id from workers w
where w.organization_id = :'org'
order by w.last_name, w.first_name, w.id
limit 25;
```

Run it three times and note the last result. Look for:

- a **`Sort`** node (probably "top-N heapsort") fed by a scan that reads all ~50,000
  rows of the organization;
- **`Execution Time`**.

Save the whole output.

**3. Add the index.** `schema.ts`, the `workers` table's third argument (line 193–199),
after `workers_org_status_idx`:

```ts
    index('workers_org_status_idx').on(t.organizationId, t.status),
    // Serves the People list: filter by tenant, already sorted by name.
    index('workers_org_name_idx').on(t.organizationId, t.lastName, t.firstName, t.id),
```

Column order is the entire design: the equality filter (`organization_id`) first, then
the columns in the exact order of the `ORDER BY`. Postgres can then walk the index in
order and stop after 25 entries. Swap two columns and the index is useless for this
query.

**4. Generate, read, apply.**

```bash
npm run db:generate -- --name add_workers_org_name_index
```

Expected: one `CREATE INDEX "workers_org_name_idx" ON "workers" USING btree (…)`.
Then `npm run db:migrate`, and `analyze workers;` again in psql.

**5. Measure after.** Same `explain (analyze, buffers)`. You are hoping for an
`Index Scan` (or `Index Only Scan`) on `workers_org_name_idx` directly under the `Limit`
— with **no `Sort` node** — and far fewer buffers read.

**6. Now be honest about what did not improve.** Run these too:

```sql
-- page 400
… limit 25 offset 10000;
-- a filter the index does not lead with
… where w.organization_id = :'org' and w.status = 'active' order by …;
-- the search box
… where w.organization_id = :'org' and w.last_name ilike '%son%' order by …;
```

Record what each plan does. Deep `OFFSET` still walks 10,000 index entries. `ILIKE
'%…%'` cannot use a b-tree at all. An index is a specific answer to a specific query, not
a general "make it fast" switch.

**7. Clean up.** Delete the scratch data — workers first, then the organization, because
of the foreign key:

```sql
delete from workers where organization_id = :'org';
delete from organizations where id = :'org';
```

### Tests

No new test: an index changes speed, not behaviour, and a test that asserts timing is
flaky. The safety net is the existing suite — `cd apps/api && npx vitest run
src/modules/workers` — which also proves the migration applies from scratch.

### Commit message

Put the evidence where the next person will find it:

```
perf(db): index workers by (organization_id, last_name, first_name, id)

The People list sorted every worker of the tenant to return one page.
50k workers, first page:
  before  Sort (top-N heapsort) over 50,000 rows   — <your number> ms
  after   Index Scan on workers_org_name_idx        — <your number> ms
Does not help: deep OFFSET, the ILIKE search, status-filtered lists.
```

Fill in **your** measured numbers. Do not copy numbers from anywhere else — including
from this document, which has none, because nobody has run this.

### Pitfalls

- **Every index slows down writes** and takes disk space. That is why you measure first
  and add only what a real query needs.
- On a large production table, plain `CREATE INDEX` blocks writes for the duration. The
  production form is `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction —
  and the migration runner uses one. This is a real deployment problem; find out how your
  migration tool handles it before you need it at 3am.
- If the "after" plan still sorts, check: did you `analyze`? Is the `ORDER BY` in the
  query identical to the index's column order?

### Stretch

Replace offset pagination with **keyset pagination** for this list: instead of
`OFFSET 10000`, send "the last row I saw was (`Last09971`, `First12`, id)" and query
`WHERE (last_name, first_name, id) > ($1, $2, $3)`. Page 400 becomes as fast as page 1.
What does that change in the `Paginated<T>` contract and in the web `Pagination`
component?

---

## US-19 — Four-eyes approval on payroll

**Level:** mid · **Area:** database + api · **Size:** ~5 hours

> As a finance controller, I want the person who submits a payroll run to be unable to
> approve it themselves, so that no single person can push a payment through.

**Context.** Listed in the build journal's known gaps: *"No four-eyes rule on payroll:
the admin who submits a run can approve it."* The rule is called **separation of duties**
and it is standard for anything that moves money.

**The design problem.** The system does not record *who* submitted a run — only *when*
(`submittedAt`). And a small company with one admin must still be able to run payroll.
Good stories have a wrinkle like this; solving it is the job.

### Acceptance criteria

- A run records who submitted it.
- If the submitter tries to approve their own run and the organization has **more than
  one** active client admin → `409 self_approval`.
- If the organization has only one active client admin, self-approval is allowed
  (otherwise they could never pay anyone).
- Platform admins are exempt (they act on a client's behalf, with their own audit trail).
- A run submitted by a manager and approved by an admin works as before.
- Rejecting and resubmitting records the *new* submitter.

### Files

- `apps/api/src/db/schema.ts` → generated migration
- `apps/api/src/modules/payroll/service.ts`
- `apps/api/src/modules/payroll/payroll.test.ts`
- `docs/api-contract.md`

### Steps

**1. Column.** `schema.ts`, `payrollRuns` (line 360). Next to `submittedAt` (line 382):

```ts
    submittedAt: ts('submitted_at'),
    /** Who submitted it for approval — needed for the four-eyes rule. */
    submittedBy: uuid('submitted_by').references(() => users.id),
```

Nullable: existing runs were submitted before this column existed and have no value.

**2. Migration.** `npm run db:generate -- --name add_payroll_submitted_by`. Expect an
`ADD COLUMN "submitted_by" uuid` and an `ADD CONSTRAINT … FOREIGN KEY`. Read, then
`npm run db:migrate`.

**3. Record the submitter.** `payroll/service.ts`, `submitRun` (line 507):

```ts
// anchor:
    set: { submittedAt: new Date() },
// change to:
    set: { submittedAt: new Date(), submittedBy: actor.userId },
```

Resubmitting after a rejection goes through this same function, so the column is
overwritten with the new submitter. Nothing else to do for that criterion — but write the
test.

**4. Imports.** At the top of the file:

```ts
// line 20 — add `users`:
import { countries, expenses, invoices, payrollItems, payrollRuns, users, workers } from '../../db/schema';
// line 21 — add `isPlatformAdmin`:
import { isPlatformAdmin, isWorker, requireOrgId, type Actor } from '../../lib/actor';
```

`count`, `and`, `eq` and `conflict` are already imported.

**5. The rule.** `approveRun` (line 526) passes a spec to `transition`. The spec type
(line 444) has a `before` hook, documented as *"Extra checks before the status changes"*,
which runs inside the transaction after the run is loaded. Add one:

```ts
export function approveRun(actor: Actor, runId: string) {
  return transition(actor, runId, {
    to: 'approved',
    verb: 'approved',
    auditAction: 'payroll_run.approved',
    set: { rejectionReason: null, approvedBy: actor.userId, approvedAt: new Date() },
    // Separation of duties: whoever submitted a run may not also approve it —
    // unless there is nobody else who could.
    before: async (tx, run) => {
      if (isPlatformAdmin(actor)) return;
      if (run.submittedBy === null || run.submittedBy !== actor.userId) return;

      const [row] = await tx
        .select({ n: count() })
        .from(users)
        .where(
          and(
            eq(users.organizationId, run.organizationId),
            eq(users.role, 'client_admin'),
            eq(users.isActive, true),
          ),
        );
      if ((row?.n ?? 0) > 1) {
        throw conflict(
          'You submitted this run, so another admin must approve it',
          'self_approval',
        );
      }
    },
    // …the existing `after` hook stays exactly as it is
```

Read `transition` (line 465) to see where `before` is called: after the status check,
before the `UPDATE`. So an illegal transition still wins over `self_approval` — a run
that is not pending says "invalid transition", which is the more useful message.

Note the query filters by `organizationId`. It is a query on a tenant-owned table, so
rule 2 in `CLAUDE.md` applies even though the value comes from a row you already
tenant-checked.

**6. Contract.** Payroll → Rules, under Approve:

```
- **Four eyes**: the user who submitted a run cannot approve it (`409 self_approval`)
  when the organization has more than one active client admin. Platform admins are exempt.
```

### Tests

In `payroll.test.ts`. Use that file's existing helpers for creating a submittable run
(look at how the approve tests arrange one). To get a second admin:

```ts
const secondAdminUser = await createUser('client_admin', org.id);
const secondAdmin = await loginAs(secondAdminUser);
```

Add `createUser` and `loginAs` to that file's import from `'../../test/helpers'` if they are
not already there, and `invoices` to its import from `'../../db/schema'`.

Write these six:

1. **Blocked.** Two admins. Admin A creates, submits, approves → `409 self_approval`.
   The run is still `pending_approval` and **no invoice exists**.
2. **Allowed for the other admin.** Admin A submits, admin B approves → `200`.
3. **Single-admin organization.** One admin submits and approves → `200`. (Every existing
   test in the file is in this situation — which is why none of them break.)
4. **Manager submits, admin approves** → `200`.
5. **Platform admin exempt.** Two client admins; a platform admin
   (`createPlatformAdmin(org.id)`) submits and approves → `200`.
6. **Deactivated colleagues do not count.** Two admins, the second with
   `isActive: false`; the first submits and approves → `200`.

```ts
  it('stops an admin approving a run they submitted when another admin exists', async () => {
    const { org, admin } = await createTenant();
    await createUser('client_admin', org.id);
    await createWorker(org.id);
    const run = await admin.post('/payroll/runs').send(currentPeriod('DE')).expect(201);
    await admin.post(`/payroll/runs/${run.body.id}/submit`).expect(200);

    const res = await admin.post(`/payroll/runs/${run.body.id}/approve`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('self_approval');
    expect((await admin.get(`/payroll/runs/${run.body.id}`)).body.status).toBe('pending_approval');
    expect(await db.select().from(invoices)).toHaveLength(0);
  });
```

(`currentPeriod` stands for however that file builds `{ countryCode, periodYear,
periodMonth }` — use what is there.)

The last assertion in test 1 matters. Approval issues an invoice *in the same
transaction* (build journal, chapter 13.4). Your refusal must happen before any of that.

### Verify

```bash
cd apps/api
npx vitest run src/modules/payroll src/modules/invoices src/test/journey.test.ts
npx tsx src/db/seed.ts --reset
```

The journey test and the seed both submit and approve as one admin. Both organizations
have a single client admin, so they pass — **but check this rather than assume it**. If
the seed fails with `self_approval`, find out who the second admin is before changing
anything.

### Pitfalls

- **Count active admins, not users.** A manager cannot approve, so a manager does not
  make self-approval avoidable.
- **Pending invitations are not users.** The seed leaves an unaccepted admin invite for
  `finance@acme.test`. That is a row in `invitations`, not `users`, so Acme still has one
  admin.
- **A race you should think about.** Admin B is deactivated at the same instant admin A
  self-approves. Depending on timing, A is allowed or refused. Both outcomes are
  defensible; the audit log records what happened. Decide that this is acceptable and
  say so in a comment — or lock the organization row.
- The web app needs no change to stay *correct*: the detail page surfaces server errors
  as a toast. It could be *kinder* — see the stretch.

### Stretch

Add `submittedByName: string | null` to `PayrollRunDto` (join `users` in `loadRunDetail`
and the list query), show "Submitted by …" on the run page, and replace the Approve
button with an explanation when the viewer is the submitter. The UI cannot know the
single-admin exemption — how would you let the server tell it? (One option: a
`canApprove: boolean` field computed for the caller.)

---

## US-20 — A login rate limiter that survives a restart

**Level:** mid · **Area:** database + api · **Size:** ~5 hours

> As a security engineer, I want failed-login counting to be stored in the database, so
> that an attacker cannot reset their attempts by waiting for a deploy, or dodge the
> limit by hitting a different server.

**Context.** `apps/api/src/lib/rate-limit.ts` says it plainly in its own header comment:
the limiter lives in process memory, resets on restart, and is not shared between
instances. It is on the known-gaps list. This story replaces it for login.

**What you will learn.** Doing a read-modify-write **atomically in one SQL statement**,
so that concurrent requests cannot both read "9 attempts" and both proceed.

### Acceptance criteria

- Attempts are stored in Postgres. Restarting the API does not reset them.
- The 11th failed attempt inside 5 minutes for the same (IP, email) → `429`, as today.
- A successful login clears that key's counter.
- After the window passes, counting starts again from 1.
- Twenty simultaneous failed attempts are counted as twenty.
- The stored key does not contain the email address in clear text.
- All existing auth tests pass unchanged.

### Files

- `apps/api/src/db/schema.ts` → generated migration
- `apps/api/src/lib/rate-limit.ts`
- `apps/api/src/modules/auth/service.ts`
- `apps/api/src/test/cleanup.ts`, `setup.ts`
- `apps/api/src/server.ts`
- `apps/api/src/modules/auth/auth.test.ts`

### Steps

**1. Table.** In `schema.ts`, after the `sessions` table (ends near line 165):

```ts
/**
 * Fixed-window attempt counters for rate limiting (currently: login).
 * Not tenant-owned — an attacker is not a tenant. `key` is a SHA-256, so the
 * table never stores an email address or an IP in readable form.
 */
export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  /** When this window ends. Compared against the DATABASE's clock, not the app's. */
  resetAt: ts('reset_at').notNull(),
});
```

**2. Migration.** `npm run db:generate -- --name add_rate_limits`, read it (one
`CREATE TABLE`), `npm run db:migrate`.

**3. Run the tests now and watch one fail.**

```bash
cd apps/api && npx vitest run src/test/cleanup.test.ts
```

It fails with a message telling you a table exists that the cleanup list does not know
about. That guard was written in the build journal's chapter 14 for exactly this moment.
Fix it in `apps/api/src/test/cleanup.ts`: add `'rate_limits'` to `TENANT_TABLES`
(anywhere in the list — it has no foreign keys):

```ts
  'sessions',
  'rate_limits',
  'workers',
```

It is not really "tenant" data, but it must be wiped between tests, and that list is the
set of tables that are. Add a short comment saying so.

**4. The limiter.** In `apps/api/src/lib/rate-limit.ts`, keep the existing
`createRateLimiter` (other code may use it; the stories US-14 and this one will decide)
and add below it:

```ts
import { eq, lt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { rateLimits } from '../db/schema';
import { hashToken } from './crypto';
```

(put the imports at the top of the file, with the existing one), then:

```ts
/**
 * A fixed-window rate limiter stored in Postgres: survives restarts and is
 * shared by every API instance.
 *
 * The whole "read the count, decide, write it back" step is ONE statement.
 * Two requests arriving together cannot both read 9 and both write 10 — the
 * row lock taken by INSERT … ON CONFLICT makes the second wait for the first.
 */
export function createDbRateLimiter(options: { limit: number; windowMs: number }) {
  const windowSeconds = options.windowMs / 1000;
  // Keys contain an IP and an email; store only a hash of them.
  const keyOf = (key: string) => hashToken(key);

  return {
    /** Count one attempt for `key`; throws 429 once the limit is exceeded. */
    async hit(key: string): Promise<void> {
      const windowEnd = sql`now() + make_interval(secs => ${windowSeconds})`;
      const [row] = await db
        .insert(rateLimits)
        .values({ key: keyOf(key), count: 1, resetAt: windowEnd })
        .onConflictDoUpdate({
          target: rateLimits.key,
          set: {
            // Window expired -> start again at 1. Otherwise add one.
            count: sql`case when ${rateLimits.resetAt} <= now() then 1 else ${rateLimits.count} + 1 end`,
            resetAt: sql`case when ${rateLimits.resetAt} <= now() then ${windowEnd} else ${rateLimits.resetAt} end`,
          },
        })
        .returning({ count: rateLimits.count });
      if ((row?.count ?? 0) > options.limit) throw tooManyRequests();
    },

    /** Forget a key (e.g. after a successful login). */
    async clear(key: string): Promise<void> {
      await db.delete(rateLimits).where(eq(rateLimits.key, keyOf(key)));
    },
  };
}

/** Housekeeping: windows that ended are useless rows. */
export async function deleteExpiredRateLimits(): Promise<void> {
  await db.delete(rateLimits).where(lt(rateLimits.resetAt, sql`now()`));
}
```

Three things to understand before you move on — do not skip them:

- **Why `now()` in SQL and not `new Date()` in JavaScript?** With several API servers,
  each has its own clock, and they drift. Letting the database stamp and compare every
  time means there is exactly one clock.
- **Inside `DO UPDATE SET`, a column reference means the *existing* row.** So
  `${rateLimits.count} + 1` is "what is stored, plus one". If the generated SQL is
  ambiguous on your Drizzle version, print it (`.toSQL()`) and compare with the Postgres
  documentation for `INSERT … ON CONFLICT`.
- **Does the CASE see the old `reset_at` in both assignments?** Yes: in a single
  `UPDATE`, every expression on the right-hand side is evaluated against the row as it
  was *before* the update. If that were not true, `reset_at` would be advanced first and
  `count` would never reset.

**5. Use it.** `auth/service.ts`:

```ts
// line ~14, the import:
import { createDbRateLimiter } from '../../lib/rate-limit';
// line 18:
export const loginLimiter = createDbRateLimiter({ limit: 10, windowMs: 5 * 60 * 1000 });
```

The two call sites become asynchronous — **add `await`**:

```ts
// line 111
  await loginLimiter.hit(limiterKey);
// line 132
  await loginLimiter.clear(limiterKey);
```

If you forget an `await`, `hit` returns a promise nobody waits for: the 429 is thrown
into the void (an unhandled rejection) and the login proceeds. TypeScript will not stop
you — a floating promise is legal. This is the single most likely bug in this story, and
the existing rate-limit test is what catches it.

**6. Test setup.** `apps/api/src/test/setup.ts` calls `loginLimiter.reset()` (line 14)
and imports `loginLimiter` (line 4). The new limiter has no `reset` — the table is
emptied by `resetTenantData()` instead. Delete both lines.

**7. Housekeeping.** `apps/api/src/server.ts` has an hourly interval that calls
`deleteExpiredSessions()`. Add `deleteExpiredRateLimits()` beside it (import it from
`'./lib/rate-limit'`), with the same `.catch(...)` logging.

**8. Honest comments.** Update the header comment of `rate-limit.ts`: the in-memory
limiter's warning stays on `createRateLimiter`, but note that login no longer uses it.

### Tests

The existing test `rate-limits repeated failures for the same email` in `auth.test.ts`
must pass **unchanged** — it is your regression test. Add, in the same `describe`:

```ts
  it('counts concurrent attempts without losing any', async () => {
    const { adminUser } = await createTenant();
    const attempt = () =>
      anonymous().post('/auth/login').send({ email: adminUser.email, password: 'nope-nope-nope' });

    const results = await Promise.all(Array.from({ length: 20 }, attempt));

    // Exactly 10 were allowed through to a password check; the rest were limited.
    expect(results.filter((r) => r.status === 401)).toHaveLength(10);
    expect(results.filter((r) => r.status === 429)).toHaveLength(10);
  });

  it('a successful login clears the counter', async () => {
    const { adminUser } = await createTenant();
    const wrong = () =>
      anonymous().post('/auth/login').send({ email: adminUser.email, password: 'nope-nope-nope' });
    for (let i = 0; i < 9; i += 1) await wrong();

    await anonymous().post('/auth/login').send({ email: adminUser.email, password: TEST_PASSWORD }).expect(200);

    // Had the counter survived, this would be the 11th attempt -> 429.
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
  });

  it('starts counting again once the window has passed', async () => {
    const { adminUser } = await createTenant();
    const wrong = () =>
      anonymous().post('/auth/login').send({ email: adminUser.email, password: 'nope-nope-nope' });
    for (let i = 0; i < 11; i += 1) await wrong();
    expect((await wrong()).status).toBe(429);

    // Move the window into the past instead of sleeping for five minutes.
    await db.update(rateLimits).set({ resetAt: new Date(Date.now() - 1000) });

    expect((await wrong()).status).toBe(401);
  });

  it('stores a hash, not the email address', async () => {
    const { adminUser } = await createTenant();
    await anonymous().post('/auth/login').send({ email: adminUser.email, password: 'nope-nope-nope' });
    const rows = await db.select().from(rateLimits);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).not.toContain(adminUser.email);
    expect(rows[0]?.key).toMatch(/^[0-9a-f]{64}$/);
  });
```

Add `rateLimits` to that file's import from `'../../db/schema'`.

The concurrency test is the proof of the atomic statement. To *see* why it matters,
temporarily rewrite `hit` as a `select` followed by an `update` and run it: far more than
ten attempts get through. Then put the single statement back.

### Verify

```bash
cd apps/api && npx vitest run src/modules/auth src/test/cleanup.test.ts
npx vitest run          # everything — the setup file changed, so every suite is affected
```

Then the real point of the story: start the API, fail a login 10 times with `curl`,
**restart the API**, and try again. Before this change the 11th attempt succeeded in
being checked; now it is `429`.

### Pitfalls

- **Floating promises** — step 5.
- **The concurrency test and the connection pool.** Twenty simultaneous requests need
  twenty statements; the pool has ten connections (`apps/api/src/db/client.ts`). They
  queue, which is fine, but it means the test is slower than you expect. If it times out,
  that is the cause — not your SQL.
- **Each failed login also runs scrypt.** Twenty at once is CPU-heavy. If the test is too
  slow on your machine, lower it to 14 attempts and adjust the expected counts (10 and 4).
- **Rate limiting by IP behind a proxy.** `req.ip` is only the real client address when
  `trust proxy` is configured correctly (`app.ts`, line 24). Misconfigure it and every
  user shares one IP — the proxy's — and one person's failures lock everyone out.
- **This table grows.** Without step 7 it accumulates a row per (IP, email) forever.

### Stretch

1. If you did US-14, its `changePassword` uses `loginLimiter` too — make sure both of its
   calls are awaited.
2. Add a second, broader limit keyed by IP alone (say 100 attempts per 5 minutes), so an
   attacker cannot cycle through a list of emails from one address.
3. This closes a known gap. Add a short entry to `docs/JOURNAL.md` under "Next entries"
   describing what changed, and remove the item from chapter 20.2 — the journal is meant
   to be kept current.
