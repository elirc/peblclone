# Stories 56–61 — automations

Not implemented. Read [the plan](README.md) and the [groundwork stories](51-55-groundwork.md)
first: every story here uses settings (US-51), the system actor (US-52), jobs (US-53),
the scheduler (US-54) or notifications (US-55).

**No AI in this file.** These are rules — `if` statements that run on their own. Plan
section 1: reach for a rule before a model.

Every automation in this file follows the same five-part checklist. Put it in your pull
request description and tick it off:

1. **Off by default**, switched on by an organization setting.
2. **Acts as the system actor**, so the audit log says "System".
3. **Safe to run twice** — the job or tick can repeat (US-53, US-54).
4. **Tells someone** what it did (a notification), unless that would be noise.
5. **Can be undone or overridden by a person** through the normal screens.

---

## US-56 — Auto-approve small expenses

**Level:** junior · **Size:** ~4 hours

> As an HR manager, I want expenses under a small amount to be approved automatically,
> so that I spend my time on the claims that need judgement.

### Acceptance criteria

- If the organization's `autoApproveExpenseLimitUsdMinor` is set, a newly submitted
  expense whose amount, **converted to USD**, is at or below the limit is approved
  immediately.
- The approval is recorded as the system: `decidedBy` is null, the note says why, and
  the audit action is `expense.auto_approved`.
- An expense above the limit, or any expense when the setting is off, behaves exactly as
  today.
- An expense submitted *by staff on someone's behalf* follows the same rule.
- The worker sees "Approved automatically" on the expense.

### Design notes

**Why convert to USD?** Workers submit in their own currency. A limit of "50" means
nothing when one expense is in euros and the next in yen — and the build journal's worst
bug was yen arithmetic (chapter 17). So the limit is stored in US cents, and the expense
is converted with the **existing** `convertMinor` (which handles zero-decimal currencies)
using the **existing** `fx_rates` table. No new arithmetic.

**Why in the same transaction as the submission?** The expense must never be visible in
an in-between state ("submitted" for a few milliseconds, then "approved"), and the rule
must never be skipped because a second step failed. One transaction: insert, decide,
audit — all or nothing.

**Why not a background job?** Nobody waits on a slow step here; it is two indexed reads.
Doing it inline is simpler and leaves no window for the expense to be decided by a person
first.

### Files

- `apps/api/src/modules/expenses/service.ts`, `expenses.test.ts`
- `apps/api/src/lib/settings.ts` (from US-51)
- `apps/web/src/pages/expenses/ExpensesPage.tsx`
- `docs/api-contract.md`

### Steps

**1. Imports.** In `expenses/service.ts` add `convertMinor` to the `@meridian/shared`
import, `fxRates` to the schema import, and:

```ts
import { getSettings } from '../../lib/settings';
```

**2. A small helper, above `createExpense`:**

```ts
/**
 * Is this expense small enough to approve without a person? Converts to USD with
 * the shared conversion (zero-decimal currencies included). If the rate is missing
 * we answer "no": a missing rate must never cause an approval.
 */
async function isUnderAutoApproveLimit(
  tx: Tx,
  organizationId: string,
  amountMinor: number,
  currency: string,
): Promise<boolean> {
  const settings = await getSettings(tx, organizationId);
  const limit = settings.autoApproveExpenseLimitUsdMinor;
  if (limit === null) return false;

  const [rate] = await tx
    .select({ perUsd: fxRates.perUsd })
    .from(fxRates)
    .where(eq(fxRates.currency, currency))
    .limit(1);
  if (!rate) return false;

  const usdMinor = convertMinor(
    amountMinor,
    { currency, perUsd: rate.perUsd },
    { currency: 'USD', perUsd: '1' },
  );
  return usdMinor <= limit;
}
```

Check the import of `Tx` from `'../../db/client'` exists in the file; add it if not.

**3. Apply it.** In `createExpense`, after the existing `recordAudit(… 'expense.submitted' …)`
call and before `return toExpenseDto(…)` (anchor: the `return toExpenseDto(row, fullName(worker));`
line at the end of the transaction), add:

```ts
    if (await isUnderAutoApproveLimit(tx, orgId, row.amountMinor, row.currency)) {
      const system = systemActor(orgId);
      const [approved] = await tx
        .update(expenses)
        .set({
          status: 'approved',
          decidedBy: null,
          decidedAt: new Date(),
          decisionNote: 'Approved automatically: under your organization’s limit.',
        })
        .where(and(eq(expenses.id, row.id), eq(expenses.status, 'submitted')))
        .returning();
      await recordAudit(tx, system, {
        action: 'expense.auto_approved',
        entityType: 'expense',
        entityId: row.id,
        metadata: { workerId: worker.id, amountMinor: row.amountMinor, currency: row.currency },
      });
      if (approved) return toExpenseDto(approved, fullName(worker));
    }
```

Confirm the local variable holding the organization id is called `orgId` in that function;
if it is named differently, use that name. Import `systemActor` from `'../../lib/actor'`.

Notice the `where … status = 'submitted'` guard, even though nothing else can have touched
the row inside this transaction. It costs nothing, and it keeps the rule from
`CLAUDE.md` (rule 6: state changes are conditional updates) true everywhere — so nobody
copying this code into a background job later loses it.

**4. The UI.** In `ExpensesPage.tsx`, where an approved expense's status is shown, show
"Approved automatically" when `status === 'approved'` and the decision note starts with
"Approved automatically" — or, better, add `decidedByName: string | null` to
`ExpenseDto` and show "by System" when it is null and the status is decided. Pick one and
say why in the pull request.

**5. Contract.** Expenses → Rules: describe the rule, the conversion, the audit action,
and that a missing exchange rate means no auto-approval.

### Tests

In `expenses.test.ts` (use `db.update(organizationSettings)` to configure the tenant):

| Case | Expected |
| --- | --- |
| Setting off, €5 expense | `submitted` |
| Limit $10.00, €5.00 expense (at 0.92 EUR/USD ≈ $5.43) | `approved`, `decidedBy` null, audit `expense.auto_approved` |
| Limit $10.00, €9.50 (≈ $10.33) | `submitted` |
| Limit $10.00, ¥1,000 (151 JPY/USD ≈ $6.62) | `approved` — **the yen case**; work it out by hand first |
| Limit set, currency with no FX row (delete it in the test, restore in `finally`) | `submitted` |
| Another tenant with a limit; this tenant without | this tenant's expense stays `submitted` |

Then: an auto-approved expense is picked up by the next payroll run like any approved one
(insert a run with the existing payroll tests' pattern, or assert it has
`payrollRunId = null` and `status = 'approved'`, the conditions payroll claims on).

### Pitfalls

- Comparing amounts in different currencies.
- A missing FX rate treated as zero (→ everything approved).
- Writing the decision in a second transaction.

### Questions to answer in your pull request

- Why is the limit stored in USD?
- What happens if the exchange-rate table is missing the worker's currency, and why is
  that the right behaviour?

---

## US-57 — Nudge people about overdue onboarding tasks

**Level:** junior · **Size:** ~4 hours

> As a client admin, I want new hires to be reminded about onboarding steps they have
> not finished, and to be told myself about steps waiting on me, so that start dates are
> not delayed.

### Acceptance criteria

- Daily at 07:00 UTC, for organizations with `onboardingNudgesEnabled`:
  - each **worker** with a portal login and a pending worker-assigned task created more
    than 3 days ago gets one notification per task;
  - the organization's client admins get one notification per pending client-assigned
    task older than 3 days.
- A given task is nudged at most once per week.
- Automatic tasks (signing, document verification) link to the page where the person acts.
- No nudges for workers who are no longer onboarding.

### Design notes

This is the reconciliation pattern from part 2's US-40: the task does not ask "is it day
3?", it asks "**which tasks are older than three days and have not been nudged this
week?**" Run it once or ten times, today or tomorrow — the outcome is the same. The
de-duplication is done by the database, through `notify`'s `dedupeKey`.

What makes a good de-duplication key here? It must identify *this task in this week*:

```ts
const week = isoWeekKey(now); // e.g. '2026-W49' — write this small pure function and test it
const dedupeKey = `onboarding-nudge:${task.id}:${week}`;
```

### Files

- `apps/api/src/automations/onboarding-nudges.ts` (new — a home for automations, separate
  from request-handling modules)
- `apps/api/src/jobs-registry.ts`
- `apps/api/src/automations/onboarding-nudges.test.ts`

### Steps

**1. Where automations live.** Create `apps/api/src/automations/`. An automation is not
a module (it has no routes); it reads several tables and writes through `lib/` helpers.
Like modules, automations must not import each other.

**2. The handler.**

```ts
import { registerJob } from '../lib/jobs';
import { registerTask, daily } from '../lib/scheduler';

registerTask({ name: 'onboarding-nudges', schedule: daily(7), jobKind: 'automation.onboarding_nudges' });

registerJob('automation.onboarding_nudges', async () => {
  await sendOnboardingNudges(new Date());
});

/** Exported for tests: takes "now" so a test can choose the date. */
export async function sendOnboardingNudges(now: Date): Promise<number> {
  // 1. organizations with the setting on
  // 2. their pending tasks — automatic ones included: signing a contract is automatic,
  //    but it still waits on the worker to act — whose worker is still 'onboarding'
  //    and was hired more than 3 days before now
  // 3. for each: notify(...) with a weekly dedupeKey
  // return how many notifications were attempted (useful in tests and logs)
}
```

Fill in the body. Hints:

- The onboarding tasks table has no `created_at` — check `schema.ts`. Use the **worker's**
  `created_at` instead (the checklist is created at hire time — read `createWorker`).
  Noticing that a column you assumed exists does not, and adapting, is part of the task.
- One query joining `onboarding_tasks` → `workers` → `organization_settings`, filtered by
  `onboardingNudgesEnabled = true`, `onboarding_tasks.status = 'pending'`,
  `workers.status = 'onboarding'`, and the age condition. Do not loop over organizations
  issuing a query each.
- A worker without `userId` has no portal login — skip worker-assigned nudges for them,
  and consider telling the admin instead.
- Links: `contract_signed` → `/contracts`; `documents_verified` → `/` (the portal home
  lists documents); `bank_details` → `/`; client tasks → `/people/<workerId>?tab=onboarding`.
- Wrap each organization's notifications in a transaction (`notify` takes `Tx`).

**3. Register.** Add `import './automations/onboarding-nudges';` to `jobs-registry.ts`.

### Tests

Call `sendOnboardingNudges(now)` directly with a chosen `now`; no need to go through the
job queue.

- Setting off → 0 notifications.
- Worker hired 4 days ago with pending `bank_details` → the worker gets one.
- Same call again → still one (dedupe).
- Same call 7 days later → a second one (new week).
- Worker hired 2 days ago → none.
- An `active` worker with a stray pending task → none.
- Client task → each active client admin gets one; a manager does not.
- Two tenants, one with the setting on → only that tenant's people are notified.

### Pitfalls

- Notifying every day (no dedupe key, or a daily key).
- Per-organization queries in a loop (an N+1 that grows with customers).
- Forgetting workers without a portal login.

### Questions to answer in your pull request

- What does the dedupe key guarantee, and what would change if it used the date instead
  of the week?

---

## US-58 — Draft next month's payroll automatically

**Level:** junior · **Size:** ~5 hours

> As a client admin, I want next month's payroll runs to be prepared as drafts on a day
> I choose, so that I only have to review and submit them.

### Acceptance criteria

- On the organization's `payrollDraftDay` (06:00 UTC), for each country where the
  organization has payable workers next month, a **draft** run is created — if one does
  not already exist.
- Nothing beyond `draft` happens automatically. Submitting and approving stay human.
- Admins get one notification per draft created, linking to it.
- Countries with no payable workers are skipped silently; any other failure is logged and
  the next country still runs.
- Running the automation twice creates nothing new.

### Design notes

**Reuse, do not rewrite.** Creating a run already exists: `createRun(actor, input)` in
`modules/payroll/service.ts`, with all its rules (period limits, who is payable, claiming
expenses, unique period). The automation must call **that** function with a system actor
— not copy its logic. Two implementations of payroll creation would drift, and payroll is
the worst place for drift.

But modules must not be imported from elsewhere (`CLAUDE.md`, rule 9)… This is the
moment that rule is tested. Options:

| Option | Trade-off |
| --- | --- |
| A. Import `createRun` from the payroll module into the automation | Breaks the rule; simplest |
| B. Move run creation into `lib/payroll-runs.ts`, have the payroll service call it | Keeps the rule; a refactor of the most important code in the system |
| C. Put the automation **inside** the payroll module (`modules/payroll/automation.ts`) | Keeps the rule (a module may use its own code); the automation lives next to what it automates |

Recommendation: **C.** Write the trade-off in your pull request either way — this is a
real design judgement, and an explained choice is worth more than a "correct" one.

**Idempotence comes for free.** `createRun` already refuses a duplicate period with
`409 run_exists` (a unique index). The automation treats that error as "already done".

**Which month?** "Next month" from the draft day. `createRun` refuses periods more than
one month ahead (`period_too_far`), so next month is always allowed. Compute it in UTC.

### Files

- `apps/api/src/modules/payroll/automation.ts` (new), `automation.test.ts`
- `apps/api/src/jobs-registry.ts`
- `docs/api-contract.md` (a note under Payroll)

### Steps

**1. Who has payable workers next month?** One query: distinct `(organization_id,
country_code)` from `workers` with status `active`, `onboarding` or `offboarding`, joined to
`organization_settings` where `payroll_draft_day = <today's day of month>`. (Include
`onboarding`: someone starting next month should be in next month's draft — but
`createRun` decides who is actually payable. If it says nobody is, skip.)

**2. The run.**

```ts
registerTask({ name: 'payroll-drafts', schedule: daily(6), jobKind: 'automation.payroll_drafts' });
registerJob('automation.payroll_drafts', async () => {
  await draftNextMonthsPayroll(new Date());
});

export async function draftNextMonthsPayroll(now: Date): Promise<{ created: number; skipped: number }> {
  const { year, month } = nextMonth(now); // write and test this
  let created = 0;
  let skipped = 0;
  for (const { organizationId, countryCode } of await dueOrganizationCountries(now)) {
    try {
      const run = await createRun(systemActor(organizationId), {
        countryCode,
        periodYear: year,
        periodMonth: month,
      });
      created += 1;
      await db.transaction((tx) => notifyDraftReady(tx, organizationId, run));
    } catch (err) {
      if (isAppError(err, 'run_exists') || isAppError(err, 'no_payable_workers')) {
        skipped += 1;
        continue;
      }
      logger.error({ err, organizationId, countryCode }, 'Payroll draft automation failed');
      skipped += 1; // one country failing must not stop the others
    }
  }
  return { created, skipped };
}
```

`isAppError(err, code)` does not exist yet — write it in `lib/errors.ts`:
`err instanceof AppError && err.code === code`.

`notifyDraftReady` uses `clientAdminIds` and `notify` (US-55) with
`dedupeKey: \`payroll-draft:${run.id}\`` and `link: \`/payroll/${run.id}\``.

**3. Why the notification is a separate transaction here.** `createRun` opens its own
transaction internally and commits it. You cannot easily put the notification inside it
without changing `createRun`. The consequence: a crash between the two leaves a draft with
no notification. Is that acceptable? (A draft is visible on the payroll page anyway; the
next run of the job would hit `run_exists` and *not* notify.) Decide, and write the
decision as a comment. Part 2's US-27 and US-31 discuss how you would close this gap if it
mattered.

### Tests

Call `draftNextMonthsPayroll(now)` with a chosen date.

- Setting off → no runs.
- `payrollDraftDay = 20`, `now` = the 20th → a draft run for next month per country with
  workers; status `draft`; audit actor is the system.
- Called twice → still one run per country; second result `{ created: 0, skipped: n }`.
- `now` = the 19th → nothing.
- December 20th → the run is for January **of the next year**. (The test that catches the
  `month + 1` bug.)
- A country whose workers all end before next month → skipped, others still created.
- Admins received one notification per draft.

### Pitfalls

- Copying `createRun`'s logic.
- `month + 1` without rolling the year.
- One failing country aborting the rest.
- Ever moving a run past `draft` automatically.

### Questions to answer in your pull request

- Which of the three options did you choose for where the automation lives, and why?
- What happens if the process crashes after a draft is created but before the
  notification is written?

---

## US-59 — Probation-ending reminders

**Level:** junior · **Size:** ~3 hours

> As a client admin, I want to be told two weeks before a new hire's probation ends, so
> that I can review how it is going while there is still time to act.

### Acceptance criteria

- Daily, for each active employee whose probation end date is 14 days away **or fewer and
  still in the future**, the organization's client admins get one notification.
- Probation end = worker `startDate` + the country's `probationDays`.
- Each worker's probation produces one reminder, ever.
- Contractors are excluded (probation applies to employment).
- Countries with `probationDays = 0` produce nothing.

### Design notes

The probation end date is a **derived value** (part 2's US-23 discusses these). You could
store it on the worker, but it would go stale if the start date or the country rule
changed. Compute it in the query instead:

```sql
w.start_date + c.probation_days   -- date + integer = date in Postgres
```

and select workers where that date is between today and today + 14. "Fewer than 14 days
and still in the future" (not "exactly 14 days") is the reconciliation idea again: a
missed day still produces the reminder.

The dedupe key is simply `probation-ending:<workerId>` — one per worker, ever.

### Files

- `apps/api/src/automations/probation-reminders.ts`, `probation-reminders.test.ts`
- `apps/api/src/jobs-registry.ts`

### Steps

Follow US-57's structure exactly: `registerTask` + `registerJob` + an exported function
taking `now`. Use a `sql` template for the date arithmetic if Drizzle's query builder makes
it awkward. Link to `/people/<workerId>`. The message names the worker and the date:
"Lena Fischer's probation ends on 12 Dec 2026."

Should this have its own organization switch? It is low-risk and useful by default — but
plan principle 2 says automations are off by default. Add `probationRemindersEnabled` to
the settings (a small migration, US-51's pattern) rather than making an exception.
Consistency in safety rules matters more than convenience in one case.

### Tests

- Probation ends in 10 days → one reminder per admin; again → still one.
- Ends in 20 days → none; ends yesterday → none.
- Contractor → none. Country with 0 probation days → none.
- A worker in another tenant → that tenant's admins, not this one's.

### Questions to answer in your pull request

- Why compute the end date in the query rather than store it?

---

## US-60 — A weekly digest for admins

**Level:** junior · **Size:** ~4 hours

> As a client admin, I want one Monday-morning summary of what is waiting for me, so that
> I do not have to check every page.

### Acceptance criteria

- Mondays at 06:00 UTC, for organizations with `weeklyDigestEnabled`, each active client
  admin gets one notification summarising the pending counts (time off, expenses, payroll
  approvals, unpaid invoices, contracts awaiting signature).
- If nothing is pending, no digest is sent (no noise).
- One digest per admin per week.
- The counts are **exactly** those the dashboard shows.

### Design notes

The dashboard already computes these counts — `pendingCounts(orgId)` in
`modules/dashboard/service.ts` (search for `async function pendingCounts`). The digest must
use the same numbers. If it computed them separately, one day the digest would say "3
expenses" and the dashboard "2", and users would stop trusting both.

But it is a private function inside the dashboard module, and modules do not import each
other. So this story starts with a refactor: **move `pendingCounts` to
`apps/api/src/lib/pending.ts`**, export it, and make the dashboard import it from there.
Run the dashboard tests — they must pass unchanged. Then the digest uses the same function.

This is the third time this plan has hit the "modules do not import modules" rule (US-58
was the second). Each time the answer is the same: if two places need the same logic,
the logic moves to `lib/`. The rule is not an obstacle — it is what tells you something
has become shared.

### Files

- `apps/api/src/lib/pending.ts` (new — moved code)
- `apps/api/src/modules/dashboard/service.ts`
- `apps/api/src/automations/weekly-digest.ts`, `weekly-digest.test.ts`
- `apps/api/src/jobs-registry.ts`

### Steps

1. **Move first, in its own commit**, with no behaviour change. Dashboard tests green.
2. Write the automation following US-57's shape: `weekly(1, 6)` schedule, a function
   taking `now`.
3. Build the message body from the counts, skipping zeros: "2 expenses to review · 1
   payroll run awaiting approval". Link to `/` (the dashboard).
4. Dedupe key: `weekly-digest:<isoWeekKey(now)>` — reuse US-57's helper (move it to
   `lib/` if it is still inside the nudges file).

### Tests

- Something pending → each admin gets one digest whose body contains the right numbers.
- Nothing pending → no digest.
- Same week twice → one digest.
- **Digest equals dashboard:** in the same test, call `GET /dashboard` and compare its
  `pending` object with the numbers in the digest. This is the test that keeps the two
  from drifting.

### Questions to answer in your pull request

- Why move `pendingCounts` instead of copying it?

---

## US-61 — Automation activity and failed jobs

**Level:** junior · **Size:** ~1 day

> As a client admin, I want one page showing what automations did for my company and
> which ones are switched on; as a platform admin, I want to see background jobs that
> failed, so that nothing breaks silently.

### Acceptance criteria

- `GET /audit-logs?actor=system` returns only entries written by the system actor.
- A client "Automations" page (admins): the switches from US-51 grouped by automation, each
  with a one-sentence explanation, plus the last 50 system audit entries.
- A platform-admin "Jobs" page: counts by status and kind; a list of `failed` jobs with
  kind, organization, attempts, last error and time; a **Retry** button.
- Retrying puts the job back to `queued` with attempts reset; it is audited.
- Client admins cannot see the jobs page or other organizations' jobs.

### Design notes

**Why a failed-jobs page is not optional.** A background job that fails does so where no
one is looking. Without a place to see failures, "it broke" and "it worked" look identical
from outside — until a customer asks why payroll was never drafted. Every system with
background work needs this page, and it is better to build it before the first silent
failure than after.

**Showing errors safely.** `last_error` contains error messages, which can contain
internal details. It is shown to platform admins only. Never to clients.

### Files

- `packages/shared/src/schemas.ts` (`listAuditLogsQuerySchema`)
- `apps/api/src/modules/audit/service.ts`
- `apps/api/src/modules/jobs/` (new — platform-admin only)
- `apps/web/src/pages/settings/AutomationsPage.tsx`, `apps/web/src/pages/admin/JobsPage.tsx`
- `apps/web/src/routes.tsx`, `AppShell.tsx` (navigation)

### Steps

**1. Filter by system actor.** In `listAuditLogsQuerySchema` add
`actor: z.enum(['system']).optional()`. In the audit service, when set, add
`isNull(auditLogs.actorUserId)` to the filters. Careful: platform-level events (country
edits) also have no actor user — but they have no organization either, and the tenant
filter already excludes them. Confirm by reading the service.

**2. Jobs module.** Routes, all behind `requirePlatformAdmin`:

```
GET  /admin/jobs/summary          → counts grouped by status and kind
GET  /admin/jobs?status=failed    → paginated list
POST /admin/jobs/:id/retry        → queued again
```

The retry is a conditional update (`WHERE status = 'failed'`) — retrying a job that is
already running must do nothing (→ 409). Audit `job.retried` with `organizationId` set to
the job's organization (or null).

**3. Pages.** The automations page reuses the settings hooks from US-51 and
`useAuditLogs({ actor: 'system' })`. The jobs page is a `Table` plus a `ConfirmDialog` for
retry. Add both to the router with the right `RequireRole` guards, and to the sidebar.

### Tests

- `?actor=system` returns only system entries, only this tenant's.
- Jobs endpoints: 403 for a client admin; list and summary for a platform admin; retry
  moves `failed` → `queued` and resets attempts; retrying a `queued` job → 409.
- A failed job's `last_error` never appears in any response to a non-platform user
  (assert on raw JSON of the client-facing endpoints).

### Questions to answer in your pull request

- What would you add to be told about failures, rather than having to look? (Hint: US-55
  and the platform admins.)
