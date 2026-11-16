# Stories 21–26 — data and domain

Not implemented. See the [part 2 index](README.md) for how to use these.

The theme of this group: **time**. Almost every hard data-modelling problem in a business
system turns out to be about time — what was true *then*, what changes *from when*, and
how to correct the past without rewriting it.

---

## US-21 — Salary history

> As an HR manager, I want to see every salary a worker has had and when each took
> effect, and to schedule a raise for a future date, so that payroll uses the right
> amount for each month.

### Acceptance criteria

- A worker has a list of compensation records, each with an effective-from date.
- A raise can be scheduled in the future; payroll for earlier months is unaffected.
- A payroll run for month M uses the salary in effect during M — and if the salary
  changes mid-month, each part of the month is paid at its own rate.
- The worker page shows the history.
- Past records cannot be edited once a paid payroll run has used them.

### The concept: effective-dated records

Today `workers.salary_minor` is one number. Editing it *overwrites* the truth: after a
raise in June, the system no longer knows what the worker earned in March. Recalculate a
March payroll and it uses June's salary. That is not a bug in the code — the *model*
cannot represent the past.

The fix is to stop storing "the salary" and start storing **facts with a validity
period**:

```
worker_compensation
  worker_id | salary_minor | pay_basis | effective_from | (effective_to)
  ----------+--------------+-----------+----------------+---------------
  lena      |    6,000,000 | annual    | 2025-01-01     | 2026-05-31
  lena      |    7,200,000 | annual    | 2026-06-01     | (open)
```

"What is Lena's salary?" is no longer a valid question. "What is Lena's salary **on 15
March 2026**?" is, and it has exactly one answer. This pattern is called *effective
dating* (or a *temporal table*), and you will meet it everywhere: prices, tax rates,
addresses, org charts, exchange rates (US-26).

### The design decision

**How to represent the period.**

| Option | Shape | Trade-off |
| --- | --- | --- |
| A. `effective_from` only | The period ends where the next row begins | No overlap possible by construction; "which row applies on date D" needs "latest row with `effective_from <= D`" |
| B. `effective_from` + `effective_to` | Each row states both ends | Simple lookup (`D between from and to`); two rows must be kept consistent — gaps and overlaps become possible |
| C. A range column + exclusion constraint | `daterange`, `EXCLUDE USING gist` | The database *guarantees* no overlap; needs the `btree_gist` extension and is less familiar |

Recommendation: **A**. With only a start date there is nothing to keep in sync, and a
unique index on `(worker_id, effective_from)` rules out duplicates. Option C is the most
rigorous and worth reading about; option B is what most people build first and regret.

**What happens to `workers.salary_minor`?** Options: delete it (every reader must change
at once); keep it as a *cache* of the current value (two sources of truth); or keep it
during the transition and remove it afterwards (see US-29 on expand/contract).
Recommendation: migrate in steps — add the table, backfill one row per existing worker
from the current column, switch readers one at a time, then drop the column in a later
migration.

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — new table; note `workers.currency` stays on the worker
  (currency does not change with a raise).
- `packages/shared/src/calc.ts` — `grossForPeriod` takes one `salaryMinor`. It needs to
  handle a month split across two rates. It is a pure function with thorough tests;
  that is exactly where this complexity should go.
- `apps/api/src/modules/payroll/service.ts` — `buildItems` loads workers and calls the
  calculation.
- `apps/api/src/modules/workers/service.ts` — `updateWorker` currently writes the salary
  and audits old/new values.
- `apps/api/src/modules/contracts/` — contracts snapshot their terms; decide whether a
  raise requires a contract amendment (probably out of scope; say so).

### Hints

1. Start in `calc.ts`, not in the database. Write a pure function that takes a list of
   `{ effectiveFrom, salaryMinor, payBasis }` plus the worker's start/end dates and a
   period, and returns the gross. Internally: cut the month into segments at each
   effective date, prorate each segment by calendar days, sum. Test it with hand-worked
   numbers *before* any table exists — including "raise on the 1st" (no split) and "raise
   on the 16th of a 30-day month" (exact halves).
2. Rounding: prorate each segment and round each, or sum and round once? They can differ
   by a cent. Pick one, write it in a comment, test the case where they differ.
3. "Latest row with `effective_from <= D`" in SQL: `ORDER BY effective_from DESC LIMIT 1`
   per worker. For many workers at once, look up `DISTINCT ON (worker_id)` — a Postgres
   feature built for exactly this.
4. The backfill belongs **in the migration**, as an `INSERT … SELECT` from `workers`.
   Drizzle generates the `CREATE TABLE`; you add the data statement to the same `.sql`
   file by hand. A migration that creates an empty history table leaves every existing
   worker with no salary.
5. Immutability: a compensation row whose period overlaps a `paid` payroll run must not
   change. Enforce it in the service by checking for such a run — and consider what the
   error should say to the user ("create a new record effective from …").
6. Scheduling a future raise is then free: it is just a row whose `effective_from` is
   later than today.

### How to test it

- Pure tests for the split-month maths (most of your tests should be here).
- Integration: hire at €60k, add a record at €72k effective mid-next-month, run payroll
  for this month and next; assert each run's gross.
- Recalculating an old draft run after a raise does **not** change its numbers.
- Tenant isolation on the new endpoints (another tenant's worker → 404).

### What goes wrong

- **Backfill forgotten** → every payroll run reports "no payable workers".
- **Using today's salary for a past period** — the exact bug this story exists to remove.
  Search for every reader of `salaryMinor`.
- **Time zones**: `effective_from` is a calendar date. Keep it a `date`, never a
  timestamp.
- **The cost calculator and contract terms** also read the salary. Decide deliberately
  what each should show.

### Questions to be able to answer

- Why is "the worker's salary" not a meaningful value any more?
- A raise is entered today, back-dated to three months ago, and those months are already
  paid. What should happen? (This is US-22.)
- What does your unique index prevent, and what does it not?

---

## US-22 — Off-cycle payroll adjustments

> As a payroll administrator, I want to correct a mistake in a month that has already
> been paid — or pay someone for days that were missed — without reopening the old run.

This closes two known gaps from the build journal (chapter 20.2): *no back-pay* for a
worker activated after their first month's run, and *stranded expenses* approved after a
leaver's final run.

### Acceptance criteria

- An admin can add an **adjustment** for a worker: an amount (positive or negative), a
  reason, and the period it relates to.
- Adjustments are picked up by the worker's **next** payroll run and appear as their own
  lines on the payslip.
- A paid run is never modified.
- An adjustment is claimed by exactly one run, and released if that draft run is deleted.
- Every adjustment is audited with who, why and how much.

### The concept: you do not edit history, you append to it

A paid payroll run is a record of something that *happened*: money left an account. If
you edit the run to "fix" it, your books say one thing and the bank says another, and
nobody can ever work out what was actually paid.

Accounting solved this centuries ago: **entries are never changed. Mistakes are corrected
by adding a new entry that offsets the old one.** Paid €100 too little in March? You do
not change March. You add "+€100, correction for March" to April. March stays true to
what happened; April carries the correction; the total is right.

This is the *append-only ledger*, and the same idea powers event sourcing, git history,
and the audit log in this very codebase.

### The design decision

The codebase already contains a working example of the mechanism you need. Read how
**expenses** work:

- an approved expense has `payroll_run_id IS NULL`;
- creating a run *claims* it by setting `payroll_run_id`;
- deleting or recalculating the draft *releases* it;
- marking the run paid makes it final.

An adjustment is the same shape with a different meaning. So the question is: **reuse the
expenses table or add a new one?**

| Option | For | Against |
| --- | --- | --- |
| A. New `payroll_adjustments` table, same claim/release mechanics | Clear meaning; can be negative; own approval rules | Some duplicated plumbing |
| B. Add a `kind` column to `expenses` | Less code | Expenses are worker-submitted, positive, need receipts — an adjustment is none of those. One table, two meanings |

Recommendation: **A**. Two things that merely *behave* alike are not the same thing. But
extract the shared claim/release logic into one helper so the mechanics are written once.

**Tax treatment.** A reimbursement is not pay: no deductions, no employer contributions.
Back-pay *is* pay: both apply. So an adjustment needs a flag — is it *gross pay*
(subject to the country's rules) or *net* (passed straight through)? `calculatePayslip`
already separates `grossMinor` from `reimbursementsMinor`; a taxable adjustment adds to
the first, a non-taxable one to the second.

### Where it touches this codebase

- `apps/api/src/modules/payroll/service.ts` — `buildItems`, `releaseClaimedExpenses`.
- `packages/shared/src/calc.ts` — `calculatePayslip`, `PayslipLine`.
- `apps/api/src/db/schema.ts` — `expenses.payrollRunId` with `ON DELETE SET NULL` is the
  pattern.
- `apps/api/src/lib/invoicing.ts` — adjustments change run totals, so the invoice
  follows automatically *if* totals remain sums of the items. Verify.

### Hints

1. Decide the rule for **negative net pay** first. A −€500 adjustment on a €300 payslip
   gives −€200. Options: refuse the run; cap at zero and carry the remainder forward;
   allow it. The simplest correct answer is to refuse with a clear error — and write the
   test.
2. Who is payable? A leaver with a pending adjustment has `daysWorked = 0` for the next
   period, so `buildItems` skips them — that is exactly how expenses got stranded. A
   worker with unclaimed adjustments or expenses must be included even with zero days.
3. Keep a payslip line per adjustment, with its reason, in the item's JSON breakdown. A
   worker who sees "+€100" with no explanation will ask HR.
4. The invariant to protect: *run total = sum of items*, and *each adjustment is in at
   most one run*. The second is a job for the database — think about what a unique or
   partial index can guarantee.
5. Concurrency: two draft runs created at the same instant for the same worker in
   different countries cannot happen (a worker has one country) — but confirm *why* the
   existing claim is race-free before you copy it. It is a single conditional `UPDATE`.

### How to test it

- Adjustment claimed by the next run; not by a second run; released when the draft is
  deleted; final after mark-paid.
- A taxable adjustment increases deductions and employer cost; a non-taxable one does
  not. Hand-compute one of each.
- A leaver with only an adjustment gets a payslip.
- The invoice total still equals the sum of its lines.
- A paid run's rows are byte-for-byte unchanged after an adjustment is created.

### What goes wrong

- Quietly allowing edits to paid runs "just this once".
- Forgetting the zero-days case, re-creating the stranded-expense bug.
- An adjustment in a different currency from the run. Refuse it.

### Questions to be able to answer

- Why is correcting by a new entry better than editing the old one, even when editing
  would be less code?
- How would an auditor reconstruct what a worker was paid in March from your data?
- What stops one adjustment being paid twice?

---

## US-23 — Public holidays in time off

> As an employee in Germany, I want a public holiday inside my vacation not to use up a
> vacation day, so that my balance is correct.

### Acceptance criteria

- Each country has a list of public holidays (date, name).
- The days counted for a time-off request exclude weekends **and** that country's
  holidays.
- The request form shows the count live, and it matches what the server stores.
- Platform admins can maintain the list.
- Changing the holiday list later does not change the day count of existing requests.

### The concept: derived values, and when to freeze them

`time_off_requests.days` is a *derived* value: it is computed from the dates and the
calendar. There are two ways to handle a derived value.

- **Compute on read.** Always correct for the *current* rules. But if the rules change,
  the past changes with them: add a holiday today and a request approved last year
  silently becomes one day shorter, and the balance moves.
- **Compute on write and store.** The stored value is a *snapshot* of the rules at that
  moment. History is stable. But it can become "wrong" relative to new rules — on
  purpose.

For anything that was **approved, agreed or paid**, snapshot. The build journal makes the
same choice for contract terms and for the FX rate on an invoice (chapter 7.4). `days` is
already stored; this story must keep it that way.

### The design decision

**Where does the calculation live?** Today `countBusinessDays` is a pure function in
`packages/shared/src/dates.ts`, used by the server and — for the live count — by the
browser. Holidays are data in the database. A pure function cannot query a database.

| Option | How | Trade-off |
| --- | --- | --- |
| A. Pass the holidays in | `countBusinessDays(start, end, holidays: Set<string>)` | Stays pure and shared. The browser must fetch the holiday list |
| B. Server-only count, browser asks | New endpoint returns the count | One implementation; the form needs a request per date change |
| C. Duplicate | Server counts with holidays, browser without | The form shows 5, the server stores 4. **No.** |

Recommendation: **A**. Keep the function pure by giving it its data as an argument — the
same move as passing the country's contribution rules into `calculateEmploymentCost`.
The holiday list for one country and one year is tiny; fetch it once.

### Where it touches this codebase

- `packages/shared/src/dates.ts` and its tests in `primitives.test.ts`.
- `apps/api/src/db/schema.ts` — a reference table like `countries` and `fx_rates`
  (global, not tenant-owned).
- `apps/api/src/test/cleanup.ts` — a new table must be classified (`REFERENCE_TABLES`),
  or the guard test fails.
- `apps/api/src/db/reference-data.ts` — seed a few holidays.
- `apps/api/src/modules/time-off/service.ts` — `createRequest`, the balance.
- `apps/web/src/pages/time-off/RequestTimeOffModal.tsx` — the live count.

### Hints

1. Give `countBusinessDays` a third parameter with a default of an empty set. Every
   existing call and test keeps working; you add behaviour without breaking anything.
2. Key: `(country_code, date)` primary key. A holiday on a Saturday must not be
   subtracted twice — test it.
3. The worker's country decides the calendar, not the employer's.
4. Requests may not span years today (`400 spans_years`), so you only ever need one
   year's holidays. Notice how an earlier simplification made this story easier.
5. Regional holidays (Bavaria has days Berlin does not) are real and out of scope. Write
   that down as a known gap rather than half-modelling it.
6. Because reference data is not reset between tests, tests that add holidays must clean
   up after themselves — look at how the countries tests restore seeds in `afterEach`.

### How to test it

- Pure: a Mon–Fri week with a Wednesday holiday counts 4; a holiday on a Sunday changes
  nothing; a range consisting only of holidays and weekends counts 0 (→ `no_working_days`).
- Integration: create a request across a holiday, assert `days`; add another holiday
  afterwards, assert the stored request did **not** change.
- Web: the modal's displayed count equals the server's for the same dates.

### What goes wrong

- Recomputing `days` on read "to be accurate".
- The browser and server disagreeing because one of them did not get the holiday list.
- Forgetting the cleanup-list classification, which fails the whole API suite at once.

### Questions to be able to answer

- Which values in this system are snapshots, and what would break if each were live?
- Why is passing data into a pure function better than letting it fetch?

---

## US-24 — Half-day time off

> As an employee with a dentist appointment, I want to take a morning off, so that I do
> not burn a whole vacation day.

### Acceptance criteria

- A request can be for a half day (single-day requests only: morning or afternoon).
- Balances count in halves: entitlement 20, used 0.5, remaining 19.5.
- Two half-day requests on the same date for different halves do not overlap; two for
  the same half do.
- Existing requests keep their meaning.

### The concept: changing the meaning of stored data

`time_off_requests.days` is an `integer`. You need 0.5. This looks like a one-line type
change, and it is the kind of change that corrupts data when done carelessly, because
**the rows already in the table were written under the old meaning.**

There are three honest ways to store "half a day":

| Option | Column | Trade-off |
| --- | --- | --- |
| A. `numeric(4,1)` days | `0.5`, `3.0` | Readable. `numeric` arrives in JavaScript as a **string** — every reader must parse |
| B. Integer **half-days** | `1` = half, `6` = three days | Integers everywhere (the money rule, applied to time). Every existing value must be doubled, and every reader changed *at the same time* |
| C. Keep whole `days` + a `half_day` flag | `days=1, portion='am'` | No change to existing rows. Arithmetic becomes conditional everywhere |

Notice that B is precisely the build journal's money rule (chapter 6.3): pick the
smallest unit, store integers. It is the most robust — and the most dangerous to migrate,
because a reader that still thinks the column means whole days is silently wrong by 2×.
(Compare the 100× yen bug in chapter 17: same family. A number without its unit.)

Recommendation: **B, with the unit in the name.** Rename the column to `half_days` in the
same migration that doubles the values. After that, no code can read it under the old
meaning — the old name no longer exists, so stale code fails to compile instead of
running wrong.

### Where it touches this codebase

- `apps/api/src/db/schema.ts`, migration (rename + `UPDATE … SET half_days = days * 2`).
- `packages/shared/src/dto.ts` — `TimeOffRequestDto.days`, `TimeOffBalanceDto`.
  `leaveEntitlementForYear` in `calc.ts` *already* rounds to half days.
- `packages/shared/src/schemas.ts` — `createTimeOffRequestSchema`.
- `apps/api/src/modules/time-off/service.ts` — overlap check, balance sums.
- `apps/api/src/modules/dashboard/` and the web pages that display days.

### Hints

1. Decide the API's unit separately from the storage unit. The DTO can keep saying
   `days: 0.5` (friendly) while the database stores `half_days: 1` (safe). The mapper
   converts. Storage and wire format are allowed to differ — that is what a DTO is for.
2. The migration must do the rename and the doubling **in one transaction**. Read the
   generated SQL: a rename may be generated as drop-and-add, which would destroy the
   data. If so, write the `ALTER TABLE … RENAME COLUMN` by hand.
3. Overlap today is "date ranges intersect". With portions, two requests on the same day
   conflict only if their portions conflict: full vs anything, am vs am, pm vs pm.
   Express that as a small pure function and test the table of cases.
4. Validation: a portion is only allowed when `startDate == endDate`. That is a
   cross-field rule → a `refine` on the schema.
5. The balance check compares requested against remaining; both must be in the same
   unit. This is where a mixed-unit bug would hide.

### How to test it

- Migration: seed whole-day rows, migrate, assert each value doubled. (The test suite
  rebuilds from migrations with an empty database, so this needs its own small test, or
  a manual check against your dev database — say which you did.)
- The overlap truth table.
- Balance with halves: 20 entitlement, two half-days → 19 remaining.
- An am + pm pair on one day is accepted; am + am is `409 overlapping_request`.

### What goes wrong

- Changing the type but not the name, leaving old readers silently off by 2×.
- `numeric` returned as `"0.5"` (a string) and concatenated instead of added.
- Float arithmetic: `0.1 + 0.2`. Halves happen to be exact in binary; do not rely on it.

### Questions to be able to answer

- Why does renaming the column make the migration *safer*?
- Where else in this codebase is "an integer in the smallest unit" used, and why?

---

## US-25 — Notes that cannot overwrite each other

> As an HR manager, I want to keep internal notes on a worker, and to be warned if a
> colleague changed the notes while I was editing, so that neither of us loses work.

### Acceptance criteria

- A worker has a free-text notes field visible to staff only (never to the worker).
- Saving notes that someone else changed since you loaded them is refused with
  `409 stale_version`, and the UI offers to reload.
- The API uses standard HTTP headers for this.

### The concept: the lost update, and optimistic concurrency

Alice and Bob both open the same worker. Alice adds a paragraph and saves. Bob, still
looking at the version from before Alice's save, fixes a typo and saves. Bob's save
writes *his whole copy* — which does not contain Alice's paragraph. Her work is gone, and
nothing reported an error. This is the **lost update**.

Two cures:

- **Pessimistic locking**: Alice "checks out" the notes; Bob cannot edit until she is
  done. Safe, but if Alice goes to lunch, Bob is blocked — and someone has to build
  "unlock" for when Alice's laptop dies.
- **Optimistic concurrency**: let both edit. Each save says *"I am changing version 7"*.
  If the current version is no longer 7, the save is refused. Nobody is ever blocked; a
  conflict is only reported when one actually happens.

For human edits to shared records, conflicts are rare and blocking is expensive, so
optimistic is almost always right. This codebase already uses the idea for state changes
— `UPDATE … WHERE status = <expected>` (`CLAUDE.md`, rule 6). A version number
generalises it from "the status" to "anything on the row".

HTTP has had this built in for decades:

```
GET /workers/42          →  200, header  ETag: "7"
PATCH /workers/42        →  header  If-Match: "7"
                         →  200 (and a new ETag) if still version 7
                         →  412 Precondition Failed if not
```

### The design decision

| Question | Options | Recommendation |
| --- | --- | --- |
| What is the version? | an integer column; `updated_at`; a hash of the row; Postgres `xmin` | An **integer column** incremented in the same `UPDATE`. Timestamps can collide; `xmin` is a Postgres internal |
| Header or body? | `If-Match` header; a `version` field in the body | Header is the standard and keeps the body clean; a body field is easier for a simple client. Either — but pick one for the whole API |
| Status code | `412` (the HTTP-correct one); `409` (what this API uses for conflicts) | This contract uses `409` + a code for every conflict. Consistency with the existing API beats textbook purity — but say so in the contract |
| Missing `If-Match` | reject (`428 Precondition Required`); allow | **Reject.** If it is optional, clients that forget it silently bring the lost update back |

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — `notes`, `version` on `workers`.
- `apps/api/src/modules/workers/service.ts` — `updateWorker` already locks the row and
  does a conditional update on status; add the version to the same `WHERE`.
- `packages/shared/src/dto.ts` — notes must be on the staff-facing detail DTO only.
  `GET /me/worker` and `GET /workers/:id` *as a worker* return the same DTO type today —
  this is the real design problem in this story.
- `apps/web/src/lib/api.ts` — sending a header, reading a response header.

### Hints

1. **The leak risk is the interesting part.** `WorkerDetailDto` is returned to staff and
   to the worker themselves. Adding `notes` to it sends HR's private notes to the person
   they are about. Options: a separate `GET /workers/:id/notes` endpoint (cleanest —
   staff-only guard, own ETag); or two DTO types. Prefer the separate endpoint; then a
   forgotten `if (isWorker)` cannot leak anything because the field is simply not there.
2. Increment in SQL, not in JavaScript: `SET version = version + 1 … WHERE version = $n`,
   then check the affected row count. Zero rows → load the row to tell "not found" (404)
   from "version moved on" (409).
3. Quote the ETag (`"7"`); the HTTP specification requires the quotes.
4. In the web client, on a 409 keep the user's text on screen. Losing their typing while
   *preventing lost updates* would be an irony. Show both versions, or at least let them
   copy theirs before reloading.
5. Do not put the notes text in the audit log metadata — record that notes changed, and
   the versions, not the content.

### How to test it

- Two clients load version N; the first save succeeds (N+1); the second with `If-Match:
  N` gets 409 and the stored text is the first one's.
- Same race with `Promise.all`: exactly one 200.
- No `If-Match` → refused.
- A worker-role user cannot read the notes by any route. Write this test **first**.

### What goes wrong

- Leaking staff notes to the worker (see hint 1).
- Making `If-Match` optional.
- Comparing versions in application code after a separate `SELECT` — a check-then-act
  race, the very thing you are fixing.

### Questions to be able to answer

- Why is optimistic better than pessimistic here, and when would you choose the
  opposite?
- What would go wrong if the version were `updated_at`?

---

## US-26 — Exchange-rate history

> As a finance controller, I want invoices to use the exchange rate that was in force on
> the day of issue, and to see how the rate has moved, so that I can explain any invoice
> total.

### Acceptance criteria

- Exchange rates are stored with the date from which they apply; setting a new rate does
  not destroy the old one.
- Issuing an invoice uses the rate in force on the issue date.
- Platform admins can add a rate with an effective date (today or later).
- A rate that an issued invoice has used can never be changed.
- There is an endpoint returning the rate history for a currency.

### The concept: "as of" lookups — and why the snapshot still matters

`fx_rates` holds **one row per currency**. Updating the euro rate overwrites it. That is
the same shape of problem as US-21, with the same cure: store each rate with an
`effective_from` and ask "what was the rate *as of* date D?".

But there is a second idea here, and it is worth separating from the first:

- The **history table** answers *"what was the rate on a given day?"*
- The **snapshot on the invoice** (`invoices.fx_rate`, which already exists) answers
  *"what rate did this invoice actually use?"*

You might think the history makes the snapshot redundant — just look the rate up again.
It does not. A history table can be corrected, re-imported, or changed by a bug. The
invoice is a legal document sent to a customer; its numbers must be reproducible from
*itself*, forever. Keep both. The snapshot is the truth about the invoice; the history is
the truth about the market.

### The design decision

| Question | Options | Recommendation |
| --- | --- | --- |
| Key | `(currency, effective_from)` | Composite primary key; no surrogate id needed |
| Lookup | latest row with `effective_from <= D` | Same query as US-21; an index on `(currency, effective_from DESC)` makes it one index probe |
| No rate on/before D | fail; use the earliest; use the latest | **Fail** (`409 fx_rate_missing`), as today. A guessed rate bills a made-up amount — build journal, chapter 13.4 |
| Editing a past rate | allow; forbid | **Forbid.** Corrections are new rows with a later date. Append-only, as in US-22 |
| Precision | `numeric(18,8)` as today | Keep. Rates are decimal strings in JS; never parse to float and store back |

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — `fxRates` primary key changes: a migration that must
  preserve existing rows (give them an early `effective_from`).
- `apps/api/src/lib/invoicing.ts` — the single lookup, near the top of
  `issueInvoiceForRun`.
- `apps/api/src/db/reference-data.ts` — `seedReferenceData` upserts on `currency`; the
  conflict target changes.
- `apps/api/src/modules/countries/` — a natural home for rate endpoints (platform admin).
- Tests in `invoices.test.ts` that delete or change the EUR rate.

### Hints

1. Changing a primary key on a populated table: add the new column with a default for
   existing rows, drop the old key, add the new one — in one migration. Read the
   generated SQL closely; this is exactly the kind of migration a generator gets
   "technically right" in a way that loses data.
2. Which date is "the issue date"? `issueInvoiceForRun` uses `new Date()` for `issuedAt`.
   Use the **same instant** for the rate lookup, converted to a calendar date in UTC. If
   you call `new Date()` twice you can straddle midnight.
3. Future-dated rates are useful (finance sets next month's rate ahead of time) and
   should not affect today's invoices. Your "as of" query handles it for free — test it.
4. Reference data is not reset between tests. A test that inserts rates must remove them,
   or it changes the totals asserted by *other* tests. Look at how the existing invoice
   tests restore the EUR rate in a `finally`.
5. Do not let the client send the rate when issuing an invoice. The server looks it up.

### How to test it

- Rates on Jan 1 and Feb 1; an invoice issued Jan 20 uses January's; one issued Feb 1
  uses February's (the boundary).
- A future-dated rate is ignored today.
- No rate on or before the issue date → 409, and the payroll run is still
  `pending_approval` (the approval rolled back — build journal, chapter 13).
- An issued invoice's `fxRate` is unchanged after a new rate is added.

### What goes wrong

- Looking up "the latest rate" instead of "the latest rate as of the issue date" — works
  until someone enters a future rate.
- Rewriting history to "fix" a rate.
- Deciding the snapshot is redundant and removing it.

### Questions to be able to answer

- Why does the invoice store the rate when a history table exists?
- What is the difference between a rate that is *wrong* and a rate that has *changed*,
  and how does your design treat each?
- US-21 and US-26 are the same pattern. What would a shared helper look like, and is it
  worth writing?
