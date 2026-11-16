# Building Meridian — an engineering journal

*A global-employment platform, built in the open by a senior engineer directing AI
agents. Written for a junior engineer who wants to see how the work is actually done.*

---

## How to read this

This is a **working journal**, not a tutorial. A tutorial shows you the finished road. A
journal shows you the surveying, the wrong turns, and why the road bends where it does.

Three voices appear:

- **The lead** — a senior engineer. The lead decides *what* gets built, in what order, to
  what standard, and reviews everything. The lead writes very little code by hand.
- **The assistant** — the AI model the lead works with directly (design discussion,
  foundation code, review).
- **Builders** — additional AI agents the lead delegates whole modules to, in parallel,
  each with a written brief.

Blocks marked **Prompt** are what the lead told an AI. Blocks marked **Result** are what
came back. Blocks marked **Review** are the lead reading that result critically. Blocks
marked **Lesson** are the thing to carry to your next project.

> **A note on honesty.** Everything here happened. Commands, test counts, error messages
> and commit hashes are pasted from the real session. The builder briefs in `docs/briefs/`
> are verbatim what the builders received. The lead's prompts to the assistant are a
> faithful write-up of the decisions as they were made — tidied for reading, not invented
> after the fact. Where something went wrong, it is left in. The mistakes are the most
> useful part.

You do not need to read it in one sitting. Each chapter stands alone, and each ends with
the commit it produced, so you can check out that commit and look at the code as it was.

### Contents

- **Part I — Before any code**
  - [1. The assignment](#1-the-assignment)
  - [2. Understanding the domain](#2-understanding-the-domain-what-is-an-eor)
  - [3. Scope: deciding what *not* to build](#3-scope-deciding-what-not-to-build)
  - [4. Choosing the stack](#4-choosing-the-stack)
  - [5. Setting up the workshop](#5-setting-up-the-workshop)
- **Part II — The foundation (built by the lead and the assistant)**
  - [6. The contract package](#6-the-contract-package)
  - [7. Modelling the data](#7-modelling-the-data)
  - [8. The API kernel](#8-the-api-kernel)
  - [9. The reference module and the test harness](#9-the-reference-module-and-the-test-harness)
  - [10. Committing the foundation](#10-committing-the-foundation)
- **Part III — Delegation**
  - [11. Preparing to delegate](#11-preparing-to-delegate)
  - *(continues below as the build proceeds)*
- **Appendices** — [Glossary](#appendix-a--glossary) ·
  [Command cheat-sheet](#appendix-b--command-cheat-sheet)

---

# Part I — Before any code

## 1. The assignment

The request, in full:

> Build a clone of the Velocity Global / Pebl main web app, using TypeScript, Node, React
> and Postgres. The main goal is a journal a junior engineer can read to follow how modern
> software engineering is done: a senior engineer commanding an LLM to build separate
> parts and subsystems in a logical, organised manner, following agent-assisted
> development best practices.

Two deliverables hide in that paragraph, and the lead names them before doing anything
else:

1. **A working product** — a web app for employing people in other countries.
2. **This journal** — which is the *primary* deliverable. The product exists so the
   journal has something real to be about.

That ordering changes decisions. When "clever" and "clear" pull apart, clear wins. When a
shortcut would hide an interesting problem, we take the long way and write it down.

**Lesson — restate the goal in your own words before starting.** Half of all wasted
engineering effort is building the wrong thing well. The lead's first act was not to open
an editor; it was to split the request into deliverables and rank them.

We are not copying anyone's brand, text or design. The product here is called
**Meridian**. It does the same *kind* of job as the products named in the request, built
from our own understanding of the domain.

---

## 2. Understanding the domain: what is an EOR?

You cannot model what you do not understand, and an AI will happily generate a plausible
schema for a business it has misunderstood. So the lead starts by writing the domain down
in plain language. If you cannot explain it to a friend, you are not ready to design it.

**The problem.** A company in Texas wants to hire an engineer who lives in Germany. To
employ someone in Germany legally you need a German legal entity, German payroll, German
social-insurance registration, a contract that complies with German labour law, and
somebody who knows all of that. Setting up an entity takes months and real money. For one
hire, it is absurd.

**The solution.** An **Employer of Record (EOR)** already has entities in many countries.
The EOR becomes the engineer's *legal* employer in Germany: it issues the compliant
contract, runs payroll, withholds tax, pays social contributions. The Texas company
directs the day-to-day work and pays the EOR an invoice each month: the engineer's cost
plus a management fee.

That gives us the **actors**:

| Actor | Who they are | What they do in the product |
| --- | --- | --- |
| **Client** | The company that wants the work done | Hires workers, approves time off, expenses and payroll, pays invoices |
| **Worker** | The person doing the work | Signs their contract, uploads documents, requests time off, files expenses, reads payslips |
| **Platform** (Meridian staff) | The EOR itself | Maintains country rules, verifies documents, actually moves the money |

…and the **core nouns**. Notice each has a *lifecycle* — a sequence of states. Lifecycles
are where most business rules live, so the lead sketches them now:

```
Worker:    onboarding ──▶ active ──▶ offboarding ──▶ terminated
               │                          │
               ▼                          ▼
           cancelled                 (rescinded → active)

Contract:  draft ──▶ sent ──▶ signed ──▶ active ──▶ terminated
             └────────┴─────────┴──▶ void

Payroll:   draft ──▶ pending_approval ──▶ approved ──▶ processing ──▶ paid
                          │                   │
                          ▼ (rejected)        └─ issues an invoice;
                        draft                    processing waits until it is paid

Invoice:   issued ──▶ paid
Time off:  pending ──▶ approved | rejected ;  pending/approved ──▶ cancelled
Expense:   submitted ──▶ approved ──▶ reimbursed (by a payroll run) ; or rejected
```

Two kinds of worker matter because the law treats them differently:

- an **employee** is employed by the EOR: statutory deductions come out of their pay and
  the employer pays contributions on top;
- a **contractor** is self-employed: paid gross, no deductions, no employer contributions.

**The money flow for one month** (the heart of the product):

```
client creates a payroll run for (country, month)
   → system computes each worker's payslip
   → client reviews, submits, approves
   → system issues an invoice in USD (pay + employer costs + fee)
   → client pays the invoice
   → platform processes payroll and marks it paid
   → workers see their payslips; approved expenses are marked reimbursed
```

> **Prompt (lead → assistant)**
> Before we design anything: explain the EOR business back to me in your own words — the
> actors, the main objects and their lifecycles, and how money moves in one month. Flag
> anything you are unsure about rather than guessing.

> **Result** — the summary above. The assistant flagged one thing as genuinely uncertain:
> real statutory payroll (progressive tax bands, thresholds, year-end reconciliation) is
> far more complex than anything we can responsibly model, and inventing precise-looking
> tax numbers would be misleading.

> **Review** — agreed, and that flag turned into a design decision: statutory rules will
> be *data* (a list of named percentage rules per country, with optional caps), clearly
> labelled as illustrative. What we teach is the shape — rules as data, pure calculation,
> one rounding function — not German tax law.

**Lesson — make the AI explain the domain back before it designs anything.** It costs one
message and it surfaces misunderstandings while they are still free to fix. And notice
the instruction *"flag anything you are unsure about rather than guessing."* Models are
agreeable by default; you have to ask for the doubt explicitly.

---

## 3. Scope: deciding what *not* to build

A real EOR platform is thousands of engineer-years of work. Ours must be finishable,
coherent, and complete *along one path*: you can hire someone, onboard them, pay them and
bill for it, end to end, with every step enforced by the server.

The lead's rule: **a thin slice through every layer beats a thick slab of one layer.**
A beautiful hiring wizard with no payroll behind it teaches nothing about systems.

| In scope (built for real) | Out of scope (and why) |
| --- | --- |
| Sign-up, login, sessions, roles, invitations | SSO / MFA — valuable, but orthogonal to the domain |
| Multi-tenant isolation (many client companies) | Per-tenant databases — one shared schema is the common case |
| Country catalogue with statutory rules as data | Real tax engines — see chapter 2 |
| Employment cost calculator, saved quotes | Benefits marketplaces, equity, visas |
| Hiring, onboarding checklist, documents with file upload | Antivirus scanning, e-signature providers, object storage (local disk instead) |
| Contracts: generate, send, sign, activate | Clause libraries, legal review workflows |
| Time off with balances; expenses with approval | Public-holiday calendars, receipts OCR |
| Payroll runs, payslips, proration | Bank payouts — "mark paid" is a button, not a wire transfer |
| Invoices in USD with FX conversion | Payment processing, dunning, tax on invoices |
| Audit trail, dashboard | Email delivery — invite links are shown on screen instead |
| Worker self-service portal | Mobile apps |

Every "out of scope" line is a **stub with a clean seam**, not a hole. "Mark paid" is one
function; a real bank integration would replace its body. That is what makes a cut
*honest*: the place where the real thing would go is obvious.

**Lesson — write the "no" list down.** Scope creep rarely arrives as a decision; it
arrives as "while I'm here…". An AI agent is even more prone to it than a person — give
one a vague goal and it will cheerfully build an email system you never asked for. An
explicit out-of-scope list is the cheapest guard rail you will ever write.

---

## 4. Choosing the stack

The request fixed the big pieces: TypeScript, Node, React, Postgres. The rest are the
lead's choices. Each is recorded as a short **ADR** (Architecture Decision Record) in
`docs/adr/` — context, decision, consequences. The summary:

| Concern | Choice | The reasoning in one line |
| --- | --- | --- |
| Repo shape | npm workspaces monorepo: `packages/shared`, `apps/api`, `apps/web` | One repo, one install, and the API and web app can share types |
| API framework | Express 5 | The most widely-known Node framework; v5 finally handles async errors natively |
| Database access | Drizzle ORM + SQL migrations | Schema is TypeScript, queries look like SQL, migrations are plain `.sql` you can read |
| Validation | zod | One schema gives a runtime validator *and* a static type |
| Auth | Server-side sessions in an httpOnly cookie | Instant revocation; no token in JavaScript's reach (ADR 0004) |
| Password hashing | scrypt from Node's standard library | Memory-hard, OWASP-recommended, zero native dependencies |
| Web | React 19 + Vite + React Router + TanStack Query + Tailwind | The mainstream SPA toolkit; TanStack Query owns server state |
| Tests | Vitest; API tests hit a **real** Postgres through HTTP | Mocks of your own database prove your mocks work, not your code |

### An instructive wobble: "latest" is not a version

Before writing any `package.json`, the lead had the assistant *look up* current versions
instead of trusting memory:

```
$ npm view typescript version      →  7.0.2
$ npm view vite version            →  8.3.8
$ npm view vitest version          →  5.1.0
$ npm view react-router version    →  8.5.1
```

Several of those are new major versions. New majors mean changed APIs, and an AI model's
knowledge of a library ends at its training date — it will write confident code for the
version it remembers.

> **Prompt (lead → assistant)**
> Those majors are newer than what you know well. Don't guess at their APIs. Pin
> TypeScript to 5.9 exactly, and pin Vite 7 / Vitest 3 / React Router 7 by major. We
> upgrade later, deliberately, in its own commit — not by accident on day one.

So `package.json` says `"typescript": "5.9.3"` (exact) and `"vite": "^7.0.0"` (that
major). It is not timidity. It is choosing *when* to pay the upgrade cost.

**Lesson — an AI's library knowledge has an expiry date; check versions with a command,
then pin.** The failure mode is subtle: nothing errors at install time. You get an API
that changed shape, the model writes code for the old shape, and you lose an hour to an
error message that makes no sense. `npm view <pkg> version` takes two seconds.

---

## 5. Setting up the workshop

Unexciting, and it decides how pleasant the next thousand commands are.

**A repository of its own.** The project folder turned out to be sitting inside a larger,
unrelated git repository (the home directory had a stray `.git`). Left alone, every
commit would have gone into the wrong history.

```
$ git rev-parse --show-toplevel
C:/Users/Owner            ← not our project!
$ git init -b main        ← inside the project folder: now it has its own
```

**Lesson — know which repository you are in before your first commit.**
`git rev-parse --show-toplevel` answers it.

**A database of its own.** This machine already runs other projects' Postgres servers.
Sharing one would mean one project's test run can truncate another's tables. So Meridian
gets its own Postgres cluster on its own port:

```
$ initdb -D ~/pgdata-peblclone -U postgres -A scram-sha-256 --pwfile=… -E UTF8
$ pg_ctl -D ~/pgdata-peblclone -o "-p 5443" start
$ pg_isready -h localhost -p 5443
localhost:5443 - accepting connections
```

and **separate databases for separate purposes**:

| Database | Purpose |
| --- | --- |
| `meridian_dev` | What you look at in the browser. Seeded with demo data. |
| `meridian_test` | Wiped and rebuilt by every test run. Never contains anything you care about. |
| `meridian_test_a`, `_b`, `_c` | One per parallel builder agent (chapter 11 explains why). |

The test harness **drops the whole schema** at the start of each run. So there is a guard
that refuses to do that to any database whose name does not contain `test`:

```ts
if (!config.isTest || !dbName.includes('test')) {
  throw new Error(`Refusing to reset database "${dbName}": not a test database`);
}
```

**Lesson — any code that destroys data should check, itself, that it is pointed at
something disposable.** Do not rely on the caller having the right environment variable.
Everybody eventually runs the wrong command in the wrong terminal.

**One install.** `npm install` at the root, once, for all three workspaces: 374 packages,
about two minutes. One lockfile means every package agrees on every version.

---

# Part II — The foundation

The lead builds the foundation directly with the assistant, in one conversation, and does
**not** delegate any of it. Why:

> Delegation works when the pieces are independent. Pieces are independent only when the
> things they *share* are already decided. So the lead personally owns everything shared:
> the vocabulary (enums, types), the database schema, the cross-cutting rules (auth,
> tenancy, errors, audit), and one complete example module. Get those right and ten
> agents can build in parallel without ever talking to each other. Get them wrong and you
> have ten agents confidently building ten incompatible things.

## 6. The contract package

`packages/shared` is imported by **both** the API and the web app. It holds everything
the two must agree on.

> **Prompt (lead → assistant)**
> Create `packages/shared`. It exports TypeScript source directly — no build step. Put in
> it, and nowhere else:
> 1. every closed set of values as an `as const` tuple plus its union type;
> 2. the state machines as data — a table of allowed transitions per status;
> 3. money helpers: integer minor units only, basis points for percentages, exactly one
>    rounding function;
> 4. calendar-date helpers working on `YYYY-MM-DD` strings in UTC;
> 5. the pure payroll maths — cost of employment, prorated gross, a payslip — with no
>    database, no clock and no I/O;
> 6. zod schemas for every request body and query string;
> 7. TypeScript interfaces for every response.
> Write unit tests for 2–5 with expected values I can check by hand.

### 6.1 One source of truth for every enum

```ts
// packages/shared/src/enums.ts
export const WORKER_STATUSES = ['onboarding', 'active', 'offboarding', 'terminated', 'cancelled'] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];
```

That one tuple is used three ways:

```ts
pgEnum('worker_status', WORKER_STATUSES)   // the database column can hold only these
z.enum(WORKER_STATUSES)                    // the API accepts only these
WORKER_STATUSES.map(s => <option>…)        // the UI offers only these
```

Add a status and all three change together. Forget one place and the compiler tells you.
The classic bug this kills: the backend adds `'suspended'`, the frontend's `switch` has no
case for it, and a page renders blank in production.

### 6.2 State machines as data

```ts
export const PAYROLL_RUN_TRANSITIONS: TransitionMap<PayrollRunStatus> = {
  draft: ['pending_approval'],
  pending_approval: ['approved', 'draft'],   // a rejected run returns to draft
  approved: ['processing'],
  processing: ['paid'],
  paid: [],
};
```

The alternative is `if (run.status === 'approved' || …)` scattered across handlers, each
slightly different. With a table, "may this run go from X to Y?" has one answer, in one
file, that a non-programmer could read and a test can enumerate.

> **Review** — an earlier project of the lead's had a wart: a *rejected* payroll run
> became a dead `rejected` row that blocked re-creating the same period forever (the
> period was unique). Here rejection sends the run back to `draft` with a reason attached,
> so the same run is fixed and resubmitted. A design decision made by remembering an old
> bug.

### 6.3 Money: the four rules

They are written at the top of `money.ts`, because every money bug the lead has ever seen
breaks one of them:

1. **Integers in minor units.** `€1,234.56` is `123456`. Never a float:
   `0.1 + 0.2 === 0.30000000000000004` in every language that uses IEEE-754 doubles.
2. **An amount always travels with its currency.** `123456` of *what*?
3. **Percentages are basis points.** 21.5 % is `2150`. Integer in, integer out.
4. **Rounding happens in exactly one function.** If two code paths round differently, the
   invoice and the payslip disagree by a cent and somebody spends a week finding it.

```ts
export function applyBps(amountMinor: number, rateBps: number): number {
  return roundHalfUp((amountMinor * rateBps) / 10_000);
}
```

> **Review** — "Is `number` safe for money in JavaScript?" Integers are exact up to
> 2⁵³−1 ≈ 9 quadrillion. The request schema caps any single amount at 10¹² minor units
> (ten billion in major units), so sums stay comfortably inside the safe range. In
> Postgres they are `bigint`. The decision and its ceiling are written down (ADR 0003)
> rather than assumed.

### 6.4 Pure functions for the scary maths

`calc.ts` computes employment cost, prorated gross pay, and a payslip. Its defining
property is what it does **not** do: no database, no HTTP, no `Date.now()`. Numbers in,
numbers out.

```ts
export function calculatePayslip(input: {
  workerType: WorkerType;
  grossMinor: number;
  employerContributions: readonly ContributionRule[];
  employeeDeductions: readonly ContributionRule[];
  reimbursementsMinor: number;
}): PayslipCalculation {
  const isEmployee = input.workerType === 'employee';
  const deductions    = isEmployee ? payslipLines(input.grossMinor, input.employeeDeductions) : [];
  const employerCosts = isEmployee ? payslipLines(input.grossMinor, input.employerContributions) : [];
  …
}
```

The legal difference between an employee and a contractor is those two `isEmployee`
lines. That is what good domain code looks like: the business rule is visible.

Because the functions are pure, their tests are trivial to write and run in milliseconds:

```ts
it('prorates by calendar days for a mid-month start', () => {
  // starts 16 June: 15 of 30 days
  expect(grossForPeriod({ ...base, startDate: '2026-06-16', year: 2026, month: 6 }))
    .toEqual({ grossMinor: 250_000, daysWorked: 15, daysInPeriod: 30 });
});
```

The comment `// starts 16 June: 15 of 30 days` is not decoration. The lead asked for
"expected values I can check by hand", and that comment *is* the hand check. A test whose
expected value was produced by running the code proves only that the code does what the
code does.

**Lesson — push the hard logic into pure functions, and keep I/O at the edges.** This is
the single highest-leverage structural habit in backend work. Pure code is easy to test,
easy to reuse (here: the API uses it for payroll, the web app could use it for a live
preview), and easy for an AI to get right because the whole problem fits in view.

### 6.5 Schemas in, DTOs out

Requests are zod schemas; the TypeScript type is *derived* from the schema, so they
cannot drift:

```ts
export const createWorkerSchema = z.object({
  type: z.enum(WORKER_TYPES),
  email: emailSchema,                 // trims + lower-cases + validates
  countryCode: countryCodeSchema,     // trims + upper-cases + /^[A-Z]{2}$/
  startDate: isoDateSchema,           // a real calendar date, not just a pattern
  salaryMinor: positiveMoneyMinorSchema,
  …
});
export type CreateWorkerInput = z.infer<typeof createWorkerSchema>;
```

Notice the schemas **normalise** as well as validate: emails are lower-cased here, once,
at the boundary. Every later comparison can then be a plain `=`. A system that sometimes
stores `Ada@x.com` and sometimes `ada@x.com` has a duplicate-account bug waiting in it.

Responses are hand-written interfaces (`WorkerDto`, `InvoiceDto`, …) with a rule stated
at the top of the file: **database rows are never returned directly.** Chapter 9 shows
why.

**Result of this chapter:** `packages/shared`, 26 unit tests.

```
 ✓ src/calc.test.ts (13 tests) 27ms
 ✓ src/primitives.test.ts (13 tests) 106ms
 Test Files  2 passed (2)
      Tests  26 passed (26)
```

*Commit `4078116` — feat(shared): contract package.*

---

## 7. Modelling the data

The schema is the most expensive thing to change later — code is easy to rewrite, data
that already exists in the wrong shape is not. So the lead designs it **whole**, up front,
for every module, including the ones that will not be built for hours. The builders will
receive it as a finished fact.

> **Prompt (lead → assistant)**
> Write the complete Drizzle schema in one file. Conventions, all mandatory:
> - UUID primary keys generated by Postgres;
> - **every tenant-owned table has `organization_id`**, even where it could be reached
>   through a parent;
> - money is `bigint` minor units next to a currency column;
> - `timestamptz` for instants, `date` for calendar days;
> - enums come from the shared tuples;
> - foreign keys RESTRICT by default; only pure child rows CASCADE;
> - wherever a business rule can be a database constraint, make it one. List those for me.

### 7.1 The tables

Seventeen tables in five groups:

```
reference   countries, fx_rates                       (global, shared by all tenants)
identity    organizations, users, sessions, invitations
people      workers, onboarding_tasks, documents, quotes
work        contracts, time_off_requests, expenses
money       payroll_runs, payroll_items, invoices, invoice_lines
            audit_logs
```

### 7.2 `organization_id` on everything (ADR 0002)

This is a **multi-tenant** system: many client companies share one database, and the
worst possible bug is company A seeing company B's payroll. The defence is a habit so
uniform it becomes impossible to forget — *every* query on tenant data has
`WHERE organization_id = <the caller's org>`.

A payroll item could find its organization through its run:
`payroll_items → payroll_runs → organization_id`. Storing it on the item too is redundant.
We do it anyway:

```ts
export const payrollItems = pgTable('payroll_items', {
  id: id(),
  organizationId: uuid('organization_id').notNull().references(() => organizations.id),
  payrollRunId: uuid('payroll_run_id').notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  …
```

Because then the rule is "filter by `organization_id`", full stop — not "filter by
`organization_id`, or join to the parent and filter there, depending on the table". Rules
with exceptions get forgotten. This one has none.

### 7.3 Constraints: the database as the last line of defence

Application code checks rules. Then two requests arrive in the same millisecond, both
check, both pass, both write. This is a **race condition**, and no amount of careful
`if` statements in one request can see the other request. The database can, because it is
the one place both requests meet. The constraints the assistant listed:

| Rule | Enforced by |
| --- | --- |
| No two users share an email | `UNIQUE (email)` |
| A worker's email is unique within their company | `UNIQUE (organization_id, email)` |
| One payroll run per company + country + month | `UNIQUE (organization_id, country_code, period_year, period_month)` |
| A worker has at most one *live* contract | **partial** unique index (below) |
| A payroll run is invoiced at most once | partial unique index on `invoices(payroll_run_id) WHERE status <> 'void'` |
| A worker appears once per payroll run | `UNIQUE (payroll_run_id, worker_id)` |
| Salary and expense amounts are positive | `CHECK (… > 0)` |
| End date is not before start date | `CHECK` |
| Platform admins have no organization; everyone else has one | `CHECK ((role = 'platform_admin') = (organization_id IS NULL))` |

The partial unique index deserves a second look:

```sql
CREATE UNIQUE INDEX contracts_one_live_per_worker
  ON contracts (worker_id)
  WHERE status IN ('draft', 'sent', 'signed', 'active');
```

A worker can have any number of `void` or `terminated` contracts (history), but only one
that is in play. Try expressing that with an `if` and you have a race. As an index it is
simply true, always.

And the last row of the table is a favourite. A user's role and their organization must
agree: Meridian staff belong to no client; everyone else belongs to exactly one. One
`CHECK` makes the invalid combination unrepresentable — no code path, no migration
script, no manual `psql` session at 2am can create a platform admin who is also inside a
tenant.

**Lesson — "make illegal states unrepresentable".** Every rule you can move from code
into the type system or the schema is a rule you can never forget to check.

### 7.4 Small decisions that prevent large incidents

- **Invoice numbers come from a sequence**, not `MAX(number) + 1`. Two concurrent
  `MAX()+1` queries read the same maximum and produce the same number. A sequence hands
  out each number once, even across transactions.
- **Sessions and invitations store a hash of the token**, not the token. If the database
  leaks, the rows cannot be used as cookies or invite links.
- **A worker's `currency` is copied from the country at hire time.** If someone later
  edits the country, existing workers are not silently re-denominated.
- **Contracts store a `terms` snapshot** (salary, start date, notice period) as JSON. A
  contract is a record of what was agreed *then*; it must not change because the worker
  got a raise.
- **`ON DELETE` is RESTRICT almost everywhere.** Deleting a worker who has payroll history
  fails. Good. Financial history that can be deleted by accident is not history.

### 7.5 Migrations

The schema is TypeScript, but what runs against the database is SQL. `drizzle-kit
generate` compares the schema file with the last snapshot and writes the difference:

```
$ npx drizzle-kit generate --name init
[✓] Your SQL migration file ➜ drizzle\0000_init.sql
```

That `.sql` file is committed. The lead **opens it and reads it** — not because the tool
is untrustworthy, but because this is the artefact that will touch production data:

```
$ grep -n -iE "CHECK|SEQUENCE|WHERE" apps/api/drizzle/0000_init.sql
 17: CREATE SEQUENCE "public"."invoice_number_seq" … START WITH 1001 …
 96: CONSTRAINT "expenses_amount_positive" CHECK ("expenses"."amount_minor" > 0)
255: CONSTRAINT "users_org_matches_role" CHECK (("users"."role" = 'platform_admin') = ("users"."organization_id" is null))
325: CREATE UNIQUE INDEX "contracts_one_live_per_worker" ON "contracts" … WHERE "contracts"."status" in ('draft', 'sent', 'signed', 'active');
334: CREATE UNIQUE INDEX "invoices_one_per_run" ON "invoices" … WHERE "invoices"."status" <> 'void';
```

Every constraint the design called for is really in the SQL.

**Lesson — never apply a generated migration you have not read.** Generators are right
almost always. "Almost" is the problem: a rename that the tool interprets as
drop-column-then-add-column deletes your data, and the SQL says so plainly if you look.

*Commit `95d2d4b` — feat(api): database schema, first migration and reference data.*

---

## 8. The API kernel

The kernel is everything a request passes through *before and after* the business logic.
Build it once and every module inherits it; forget a piece and every module reinvents it
differently.

> **Prompt (lead → assistant)**
> Build the API kernel. No business modules yet. I want:
> - config validated at startup, and `process.env` read in exactly one file;
> - one `AppError` type and one error handler that produces `{ error: { code, message,
>   details? } }`; unexpected errors are logged in full and return a bare 500;
> - session auth: opaque random token in an httpOnly SameSite=Lax cookie, SHA-256 of it in
>   the database;
> - an `Actor` object built by the auth middleware and passed into services — services
>   must never see `req`;
> - tenant resolution in one place;
> - an audit helper that takes the caller's transaction;
> - helpers to validate body, query and UUID path params against the shared schemas.
> Explain every security-relevant choice in a comment a junior can follow.

### 8.1 Configuration fails fast

```ts
const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', …);
  process.exit(1);
}
```

A missing `DATABASE_URL` stops the process at boot with a readable message. The
alternative is finding `undefined` inside a connection string during the first request,
in production, at night. And because `config.ts` is the *only* file that reads
`process.env`, "what configuration does this app need?" has a one-file answer.

One line in there is a deliberate safety catch:

```ts
/** Tests ALWAYS get the test database; there is no way to point a test at dev data. */
databaseUrl: isTest ? env.TEST_DATABASE_URL : env.DATABASE_URL,
```

### 8.2 Expected errors versus bugs

There are two kinds of failure and they must be treated differently:

- **Expected**: bad input, not logged in, not allowed, not found, conflict. These are part
  of the API. Code throws `AppError` with a status and a stable `code`; the client gets a
  helpful message.
- **Unexpected**: a bug, the database is down. The client gets `500 internal_error` and
  nothing else — no stack trace, no SQL — while the full error goes to the log.

```ts
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
```

Services just `throw notFound('Worker')`. One error middleware turns it into JSON.
Express 5 forwards a rejected promise from an `async` handler to that middleware by
itself, so handlers contain no `try/catch` at all.

### 8.3 Sessions, and why not JWT (ADR 0004)

A common first instinct is a JWT in `localStorage`. The lead chose server-side sessions:

| | JWT in localStorage | Session cookie (ours) |
| --- | --- | --- |
| Can page JavaScript read it? | Yes → any XSS bug steals it | No (`httpOnly`) |
| Revoke immediately (logout, fired employee)? | Not without extra infrastructure | Delete one row |
| Role changed — when does it apply? | When the token expires | Next request |
| Cost | No lookup per request | One indexed lookup per request |

For a payroll system, "deactivate this user *now*" is not optional. One indexed lookup per
request is a price worth paying.

```ts
const cookieOptions = (): CookieOptions => ({
  httpOnly: true,               // JavaScript cannot read it, so XSS cannot steal it
  sameSite: 'lax',              // not sent on cross-site POSTs: the first CSRF defence
  secure: config.isProduction,  // HTTPS only in production
  …
});
```

Cookies bring **CSRF** (another site making the browser send a request with your cookie).
Two layers answer it: `SameSite=Lax`, and an `Origin` header check on every non-GET
request that refuses anything not coming from our own web app.

### 8.4 Passwords and timing

Three details in the login path that are easy to miss and that reviewers look for:

```ts
// Always run one scrypt verification, even for an unknown email, so response
// time does not reveal which emails have accounts.
const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));

// One message for every failure. "No such user" vs "wrong password" would be
// a free account-enumeration oracle.
if (!user || !passwordOk || !user.isActive) throw unauthorized('Invalid email or password');
```

1. Unknown email and wrong password return the **same message**…
2. …and take the **same time**, because a real hash is verified either way.
3. The hash comparison itself uses `timingSafeEqual`.

There is also a small rate limiter on login. It lives in process memory, and its comment
says so bluntly: it does not survive a restart and is not shared between servers. It is
on the known-gaps list. A limitation you have written down is a decision; one you have
not is a surprise.

### 8.5 The Actor

The single most important structural idea in the API:

```ts
export interface Actor {
  userId: string;
  fullName: string;
  role: UserRole;
  organizationId: string | null;   // the tenant this request operates on
  workerId: string | null;         // set when role === 'worker'
}
```

The `authenticate` middleware builds it from the session; every service function takes it
as its first argument:

```ts
export async function updateTeamMember(actor: Actor, userId: string, input: UpdateTeamMemberInput)
```

Consequences:

- **The permission question is in every signature.** You cannot call a service without
  saying who is asking.
- **Services know nothing about HTTP.** They can be called from a test, a script or a
  background job.
- **The tenant comes from the server's own records**, never from the request. A client
  cannot send `organizationId: <someone else>` because no endpoint reads one.

Platform admins (Meridian staff) belong to no tenant, so they name the one they are
working in with an `X-Org-Id` header. That header is honoured **only** for platform
admins — for anyone else it is ignored, and there is a test that proves it (chapter 9).

### 8.6 The audit trail joins your transaction

```ts
export async function recordAudit(dbOrTx: DbOrTx, actor, entry: AuditEntry): Promise<void>
```

It takes `dbOrTx`. Pass the transaction you are already in, and the change and its audit
record **commit or roll back together**. An audit log written *after* the commit can miss
events when the process dies in between; one written *before* can record things that
never happened. Inside the same transaction, neither is possible.

*This chapter and the next were committed together as `97b9c76`.*

---

## 9. The reference module and the test harness

Before delegating anything, the lead wants **one module built completely**: routes,
service, tests. Not because it is the most important module — because it becomes the
example every builder copies. An AI matches the style of what it is shown far more
reliably than the style it is told about.

> **Prompt (lead → assistant)**
> Build `auth` and `organizations` (profile, team, invitations) to the standard I want
> every module at. Routes do three things only: parse, call one service function, respond.
> Then build the test harness: tests run against real Postgres through HTTP; factories
> take overrides; a `client(sessionToken)` wrapper so tests read like a user's actions.
> Then write tests — and I specifically want tests for tenant isolation and for the
> security properties from chapter 8, not just happy paths.

### 9.1 Thin routes

```ts
organizationsRouter.patch('/team/:id', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(updateTeamMemberSchema, req);                             // 1. parse
  res.json(await service.updateTeamMember(getActor(req), uuidParam(req), input));   // 2. call  3. respond
});
```

Read the middleware list left to right and you know the access rule: *must be logged in,
must be an admin*. No logic to review in the handler because there is no logic in it.

### 9.2 A service function, annotated

```ts
export async function updateTeamMember(actor: Actor, userId: string, input: UpdateTeamMemberInput) {
  const orgId = requireOrgId(actor);
  if (userId === actor.userId) {
    // Otherwise the last admin can lock the whole organization out.
    throw badRequest('You cannot change your own role or status', 'cannot_modify_self');
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set(input)
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId), ne(users.role, 'worker')))
      .returning();
    if (!row) throw notFound('Team member');

    // Deactivation must bite immediately, not when the session cookie expires.
    if (input.isActive === false) await deleteUserSessions(tx, userId);

    await recordAudit(tx, actor, { action: 'team.member_updated', … });
    return { id: row.id, email: row.email, fullName: row.fullName, role: row.role, … };
  });
}
```

Four habits in twenty lines:

1. **The tenant filter is inside the `WHERE`.** There is no "load it, then check it
   belongs to us" step that someone could forget. A user id from another company simply
   matches zero rows.
2. **Zero rows → 404, not 403.** Answering "forbidden" would confirm that the id exists in
   someone else's tenant. "Not found" leaks nothing.
3. **Side effects share the transaction**: the update, the session purge and the audit
   record all commit together.
4. **The return value is an explicit list of fields.** Look at what is *not* there:
   `passwordHash`. If the function returned `row`, the hash would go out over the wire
   today — and even if you remembered to delete it, the next sensitive column somebody
   adds would leak by default. Mapping row → DTO makes new columns private until someone
   deliberately exposes them.

### 9.3 The harness

```ts
const { org, admin } = await createTenant();                 // an organization + logged-in admin
const worker = await createWorker(org.id, { countryCode: 'DE' });
const res = await admin.patch(`/team/${someone.id}`).send({ isActive: false });
expect(res.status).toBe(200);
```

- **Factories** insert rows directly (fast) with sensible defaults and take overrides, so
  a test states only what it is about.
- **`client(token)`** wraps `supertest` and attaches the session cookie. The Express app
  is created in-process — no port, no network.
- **Real Postgres.** Constraints, transactions and SQL are exactly what we need to test;
  a mocked database has none of them.
- **Isolation between tests**: a `beforeEach` truncates all tenant data. Each test starts
  from the same empty state, so tests cannot affect each other and can run in any order.
- **Migrations are exercised every run**: the global setup drops the schema and replays
  every migration from zero. A broken migration fails the test run, not a deploy.

### 9.4 Tests that are about behaviour

Each test name is a sentence stating a promise the system makes:

```
✓ rejects a duplicate email with 409 and leaves no orphan organization
✓ gives the same 401 for a wrong password and an unknown email
✓ sets an httpOnly, SameSite=Lax cookie and stores only a hash of the token
✓ logout revokes the session server-side
✓ stops working the moment the user is deactivated
✓ blocks state-changing requests from another origin
✓ answers 404 when modifying a user from another organization
✓ ignores X-Org-Id from anyone who is not a platform admin
✓ deactivating a teammate kills their sessions immediately
✓ does not let an admin demote or deactivate themselves
✓ rejects a malformed id with 400 instead of a database error
```

Look at the first one more closely, because it tests something a happy-path test never
would:

```ts
it('rejects a duplicate email with 409 and leaves no orphan organization', async () => {
  await anonymous().post('/auth/register').send(validRegistration);
  const res = await anonymous().post('/auth/register')
    .send({ ...validRegistration, organizationName: 'Second Org' });

  expect(res.status).toBe(409);
  // The transaction rolled back: the second organization must not exist.
  expect(await db.select().from(organizations)).toHaveLength(1);
});
```

Registration inserts an organization, *then* a user. If the user insert fails on the
duplicate email and there were no transaction, the organization would be left behind —
an orphan row nobody can log in to. The test asserts the *absence* of that row. Tests
that check what did **not** happen are the ones that catch missing transactions.

### 9.5 The first run

```
$ cd apps/api && npx vitest run
 ✓ src/modules/auth/auth.test.ts (20 tests)
 ✓ src/modules/organizations/organizations.test.ts (18 tests) 9802ms
 Test Files  2 passed (2)
      Tests  38 passed (38)
   Duration  37.31s
```

All 38 passed on the first run. Treat that with suspicion rather than pride:

> **Review** — a suite that is green first time has not yet proven it can go red. The lead
> spot-checks by reading several assertions and asking "what change to the code would make
> this fail?" For the orphan-organization test: remove `db.transaction`. For the X-Org-Id
> test: read the header before checking the role. If you cannot name the breaking change,
> the test is not testing anything.

One number in that output does bother the lead: **37 seconds for 38 tests** — about a
second each. The suite will grow five- or ten-fold. This is noted and deliberately *not*
fixed yet; chapter 14 comes back to it with measurements. Optimising before measuring is
guessing.

---

## 10. Committing the foundation

The work so far went in as **four commits, not one**:

```
97b9c76 feat(api): kernel, auth and organizations modules with integration tests
95d2d4b feat(api): database schema, first migration and reference data
4078116 feat(shared): contract package - enums, state machines, money/date maths, zod schemas, DTOs
87855b9 chore: scaffold npm-workspaces monorepo (shared, api, web)
```

Each is one coherent idea a reviewer can hold in their head, and each leaves the
repository in a working state. The message says *what* in the subject and *why* in the
body:

```
feat(api): database schema, first migration and reference data

17 tables; tenant id on every tenant-owned table; money as bigint minor
units; partial unique indexes guard one-live-contract-per-worker and
one-invoice-per-payroll-run.
```

Two small real-world snags on the way, kept here because you will meet both:

**Git did not know who we were.**

```
fatal: unable to auto-detect email address (got 'Owner@DESKTOP-….(none)')
```

A fresh repository with no identity configured. The fix is `git config user.name` /
`user.email` **for this repository** (no `--global`), matching the identity the owner's
other repositories use. And note what the lead did *not* do: guess an identity and move
on. A wrong author on every commit is tedious to repair later.

**Line endings.** Git warned `LF will be replaced by CRLF` on every file — Windows.
A one-line `.gitattributes` (`* text=auto eol=lf`) settles it for everyone who ever clones
the repo, on any OS, forever.

**Lesson — commit in units of meaning.** `git log` is documentation that cannot go out of
date. "wip", "fix", "more changes" throw that away. When a bug appears three months from
now, `git bisect` can only point you at a commit — it helps a great deal if that commit
is one idea rather than a day's work.

---

# Part III — Delegation

## 11. Preparing to delegate

Twelve backend modules remain. The lead could build them one by one with the assistant.
Instead: three builder agents, in parallel. This chapter is about what makes that safe,
because *"just run three agents"* is how you get three incompatible codebases and a
corrupted `node_modules`.

### 11.1 What goes wrong (learned the hard way)

The lead has run parallel agents before and kept notes on what actually broke. In order
of how much time each cost:

1. **Concurrent installs destroy the workspace.** Two agents each notice a "missing"
   dependency and both run the package manager at once.
2. **A shared test database.** Suite A truncates tables while suite B is mid-test. B
   fails in ways that look *exactly* like real bugs, and an hour disappears into chasing
   a bug that does not exist.
3. **Overlapping file ownership.** Told "build the workers module", an agent that needs a
   helper will add it to a shared file — which another agent is rewriting at that moment.
4. **Trusting reported results.** "All tests pass" from an agent means "passed in my
   context, once". Under concurrency, suites give false readings in *both* directions.

Each has a specific countermeasure, and together they are the delegation checklist:

| Risk | Countermeasure |
| --- | --- |
| Incompatible interfaces | Everything shared is **already written**: schema, DTOs, request schemas, lib helpers, test factories, even the router stubs each module must export |
| Diverging style | A complete reference module to copy, named in the brief |
| Ambiguous requirements | A written API contract: every endpoint, every rule, every error code |
| File collisions | Each brief lists the exact files that builder owns; everything else is read-only |
| Install races | One install, done before they start; briefs forbid installing |
| Test database collisions | One database **per builder** (`meridian_test_a/b/c`) via `TEST_DATABASE_URL` |
| Cross-builder dependencies | Seams pre-written in `lib/` (below); tests use factories, never another builder's endpoints |
| Unreliable self-reports | Briefs demand exact commands and counts, two runs; the lead re-runs everything afterwards |

### 11.2 The contract document

`docs/api-contract.md` specifies every endpoint — method, path, who may call it, request
schema, response DTO — and then the business rules as bullet points with **exact error
codes**. A fragment:

```
- **Process** requires that invoice to be `paid` (`409 invoice_unpaid`): Meridian does not
  move money it has not received.
```

Why so precise? Because two parties read this document: the builder implementing the
endpoint now, and the *frontend* builder who will consume it tomorrow without ever seeing
the backend code. If the contract says `409 invoice_unpaid`, the UI can show "Waiting for
invoice payment" for exactly that code. Vague contract, guessed integration.

Writing it also forced decisions that would otherwise have been made three different ways
by three builders. For example: *who verifies a worker's documents?* The lead decided:
only platform admins — it is the EOR's compliance duty, not the client's. That is one line
in the contract and a completely different permission model if left to chance.

### 11.3 Pre-writing the seams

Splitting twelve modules across three builders creates places where one builder's module
must trigger another's behaviour:

- signing a **contract** (Builder B) completes an **onboarding** task (Builder A's area);
- verifying the last **document** (A) does the same;
- completing the last task **activates the worker**.

If B imports A's service, B's code cannot compile until A is finished, and their work is
no longer parallel. So the lead wrote the seam *first*, in `lib/onboarding.ts`:

```ts
export async function completeOnboardingTask(tx, workerId, key, actorUserId)
  : Promise<{ completed: boolean; activated: boolean }>
```

Both builders call this function. Neither imports the other. The rule in `CLAUDE.md` —
*modules do not import other modules; shared behaviour lives in `lib/`* — is what keeps
the work parallel.

There is a subtlety inside that function worth pausing on:

```ts
// FOR UPDATE: two tasks completing at the same instant must not both decide
// "one task still pending" from stale reads. The row lock makes them queue.
const [worker] = await tx.select(…).from(workers).where(eq(workers.id, workerId)).for('update');
```

Picture a worker with two tasks left. The contract is signed and the last document is
verified in the same instant, in two transactions. Each completes its own task, then
checks "anything still pending?" — and each still sees the *other's* task as pending,
because the other transaction has not committed yet. Both conclude "not ready". Both
tasks end up complete and the worker is stuck in `onboarding` forever. Locking the worker
row makes the second transaction wait for the first, see its result, and activate. This
is the kind of bug that never shows up in a demo and always shows up in production.

### 11.4 `CLAUDE.md`: standing instructions

An agent starts with no memory of this project. `CLAUDE.md` at the repo root is read
automatically at the start of every session, so it holds what must *always* be true: the
layout, the commands, and ten non-negotiable rules. Three of them:

```
2. **Tenant isolation.** Every query on a tenant-owned table filters by `organizationId`
   taken from the `Actor`, never from the request body/query. A record in another tenant
   is a **404**, not a 403.
6. **State changes** go through the transition tables … and use a conditional
   `UPDATE … WHERE status = <expected>` so concurrent requests cannot both win.
10. **Tests are integration tests** … Every module tests: the happy path, validation,
    permissions per role, **cross-tenant access (404)**, and every illegal state transition.
```

Keep this file short and imperative. It is not documentation; it is the house rules.
Anything written there is paid for in every agent's context on every task, so each line
should earn its place.

### 11.5 The briefs

Each builder got two files: a common one and its own. The briefs are in `docs/briefs/` —
read one in full, it is short. Their anatomy:

1. **What to read first, in order** — rules, contract, shared types, schema, the reference
   module. Pointing at files beats pasting their contents: the agent reads the real,
   current thing.
2. **Exactly which files you own.** And explicitly, which you must not touch.
3. **"Things that are easy to get wrong."** The lead's experience, front-loaded. For
   Builder C:
   > Write at least one test with **hand-computed expected numbers** for a German employee
   > on €60,000/yr … for a full month … and one for a mid-month starter (proration).

   > Test with two concurrent creates (`Promise.all`): exactly one 201, one 409.
4. **How to verify** — the exact command, with that builder's own database.
5. **What "done" means and the report format** — files, commands run, pass/fail counts
   *for two runs*, every ambiguity and how it was resolved, anything needed outside the
   file list, known gaps "honestly".

Two instructions in there are worth copying into every brief you ever write:

> If something there is wrong or missing, work around it locally and **report it** — do
> not fix it.

An agent that "helpfully" fixes a shared file breaks two other agents. Reporting keeps the
decision with the person who can see the whole board.

> Run your suites **twice** before reporting. A suite that passes once and fails once is a
> bug in the code or the test — find it.

Intermittent failures hide behind single green runs.

**Lesson — a good brief is the same thing as a good ticket for a human.** Goal, context,
boundaries, known traps, definition of done. The better your tickets, the better your
results from people *and* from agents. If you cannot write the brief, you do not yet
understand the task well enough to hand it to anyone.

*Commit `676c575` — docs: project instructions, API contract and wave-1 builder briefs.*

The three builders were then started together. While they worked, the lead moved on to
the one piece of the frontend that is also "shared foundation": the web shell.

---

## 12. The web shell

The frontend has the same shape of problem as the backend: twenty pages to build, most of
them independent, all of them needing the same plumbing. So the same move — the lead
builds the shared part once, by hand with the assistant, and delegates the pages.

> **Prompt (lead → assistant)**
> Build the web shell and nothing else: Vite + React + Tailwind config; ONE module that
> calls `fetch`; TanStack Query set up with a central list of query keys; an auth context;
> a small form hook that validates with the shared zod schemas; a UI kit (button, inputs,
> table, modal, badge, tabs, toast, loading/empty/error states); the app frame with
> role-aware navigation; the router with guards; and the three auth pages as the reference
> implementation. Create every other page as a stub so the router compiles today.

### 12.1 One door to the network

```ts
// apps/web/src/lib/api.ts — the ONLY place in the web app that calls fetch
export const api = {
  get:    <T>(path: string, params?: Params) => json<T>('GET', path, { params }),
  post:   <T>(path: string, body?: unknown)  => json<T>('POST', path, { body: body ?? {} }),
  patch:  <T>(path: string, body: unknown)   => json<T>('PATCH', path, { body }),
  delete: <T = void>(path: string)           => json<T>('DELETE', path),
  blob:   async (path: string) => (await send('GET', path)).blob(),
};
```

Because every request goes through one function, these are solved once rather than twenty
times: sending the cookie, JSON encoding, turning the API's error envelope into a typed
`ApiError` with the server's stable `code`, and noticing a `401` anywhere in the app and
dropping the user back to the login page.

The development proxy is worth understanding because it removes a whole category of
problem:

```ts
// vite.config.ts
proxy: { '/api': { target: 'http://localhost:4000' } }
```

The browser only ever talks to `localhost:5173`. Vite forwards `/api/*` to the API. So in
development the page and the API are the **same origin**, exactly as they will be in
production behind a reverse proxy. No CORS headers to configure, and the `SameSite`
cookie behaves in development the way it will behave for real users.

### 12.2 Server state is not your state

The most common React mistake: fetch in `useEffect`, store in `useState`, then spend the
rest of the project keeping that copy in sync with the server. TanStack Query replaces all
of it. A page asks for data by key:

```ts
useQuery({ queryKey: [...keys.workers, 'list', query], queryFn: () => api.get('/workers', query) })
```

and after a change, says which data is now stale:

```ts
onSuccess: () => invalidate(keys.workers, keys.dashboard)
```

The library refetches whatever is on screen. The lead pre-wrote **all** the top-level keys
in one file (`lib/query.ts`) for a reason specific to delegation: approving a payroll run
(Builder F's page) must refresh the dashboard (Builder D's page). If each builder invented
their own keys, that cross-page invalidation would silently not happen. A shared list of
names is the smallest possible contract that makes it work.

### 12.3 The same schema on both sides

```tsx
const form = useZodForm(loginSchema, { email: '', password: '' });
<form onSubmit={form.handleSubmit(async (data) => { await login(data); })}>
  <Input label="Work email" type="email" {...form.field('email')} />
```

`loginSchema` is the *same object* the API validates with. The browser checks first for
instant feedback; if the server still rejects the request, its field-level `details` are
mapped onto the same inputs. The comment in the hook states the principle:

> The browser check is a convenience — the server check is the real one.

Never treat client-side validation as security. Anyone can call your API with `curl`.

### 12.4 Guards are courtesy, not security

```tsx
<Route element={<RequireRole roles={ADMINS} />}>
  <Route path="/audit" element={page(<AuditLogPage />)} />
```

The route guard and the role-aware sidebar decide what to *show*. They stop a manager
landing on a page that would only tell them "forbidden". They are not what protects the
audit log — the API's `requireAdmin` is. The comment sits right on the guard so nobody
later "secures" something by hiding a link.

### 12.5 A UI kit small enough to read

Seven files in `components/ui/`. Two decisions worth copying:

**The modal is the native `<dialog>` element.** The browser supplies the focus trap,
Escape-to-close, the backdrop and the screen-reader semantics. Hand-rolled modals get at
least one of those wrong.

**Every status has its colour defined once.**

```ts
const STATUS_TONES: Record<string, BadgeTone> = {
  active: 'green', approved: 'green', paid: 'green', …
  pending: 'amber', pending_approval: 'amber', submitted: 'amber', …
  rejected: 'red', terminated: 'red', void: 'red', …
};
```

`<StatusBadge status={run.status} />` anywhere in the app. "Approved" is the same green on
the payroll page, the expenses page and the dashboard, because no page gets to choose.

### 12.6 A test that proves the wiring

Three component tests on the login page, using a `mockFetch` helper that fails the test
loudly on any request it was not told about. The interesting assertion:

```ts
await userEvent.type(screen.getByLabelText(/work email/i), '  Ada@Example.COM ');
…
// The shared schema trimmed and lower-cased the email before it left the browser.
expect(login?.body).toEqual({ email: 'ada@example.com', password: 'wrong-password' });
```

It finds the input **by its label**, the way a person (or a screen reader) would. If that
query fails, the form is inaccessible — the test doubles as an accessibility check.

**Verification**

```
$ npx tsc -p apps/web          → exit 0
$ npx vitest run               → 3 passed (3)
$ npx vite build               → ✓ built in 19.38s   (index 420 kB / 131 kB gzip; each page its own chunk)
```

Note the build output: every page is a separate file of ~0.17 kB right now. They are
stubs — but the *code-splitting* already works, so as pages become real, the login screen
will not get heavier.

*Commit `20ccb99` — feat(web): app shell.*

**Lesson — "the shell first" is the frontend version of "the schema first".** Everything
twenty pages would otherwise each decide for themselves — how to fetch, how to show an
error, what a button looks like, what a query key is called — is decided once, and the
decisions are *code the builders import*, not prose they might skim.

---

## 13. Wave 1 comes back: reading three reports

Roughly twenty minutes after they were started, the three backend builders reported.
The headline numbers they claimed:

| Builder | Modules | Tests claimed | Runs |
| --- | --- | --- | --- |
| A — People | countries, quotes, workers, onboarding, documents | 108 | passed twice |
| B — Work | contracts, time off, expenses | 156 | passed twice |
| C — Money | payroll, invoices, audit, dashboard | 70 | passed twice |

It would be easy to type `git commit` here. This chapter is about the four things the
lead did instead.

### 13.1 Re-run everything yourself

A builder's "all tests pass" is a *claim about its own environment*. The lead re-ran each
builder's suites on a database none of them had touched:

```
$ npx vitest run src/modules/payroll src/modules/invoices src/modules/audit src/modules/dashboard
 Test Files  4 passed (4)
      Tests  70 passed (70)

$ npx vitest run src/modules/countries src/modules/workers src/modules/documents
 Test Files  3 passed (3)
      Tests  108 passed (108)
```

The claims held. That is the expected outcome — and it is still not optional. The one
time in twenty that a report is wrong is the time it matters, and you cannot know in
advance which time that is.

### 13.2 Read the "ambiguities" section first

The briefs required each builder to list every place the contract was unclear and what
they decided. This section of a report is worth more than the code, because it is a list
of **decisions somebody made on your behalf**. Between them the builders listed about
forty. Most were sensible and are now simply how the system behaves:

- *"A worker acting on their own draft or void contract gets 404, not 409, because they
  are not allowed to see those contracts."* (B) — exactly right: you must not reveal that
  an invisible thing exists.
- *"`nextval` is not rolled back, so a failed approval uses up an invoice number. That is
  acceptable for a gap-tolerant sequence; it is not a reuse."* (C) — correct, and it shows
  the builder understood *why* the brief demanded a sequence.
- *"Re-uploading a file clears `reviewNote`, `reviewedAt` and `reviewedBy`, because the
  new file is a new submission."* (A) — a rule the lead had not thought to write.

Builder A also did something the brief had asked for but which is easy to skip. Its first
search-escaping test used the string `under_score` — and it noticed that string happens
to contain the letters the pattern would match *anyway*, so the test passed whether or
not escaping worked:

> Workers had 1 failure, caused by my own test: `under_score` really contains `r_s`, so it
> was not proving the escaping. I replaced it with `Eng_neer` and `1%remote`, which would
> only match if `_` and `%` acted as wildcards.

That is the question from chapter 9 — *"what change to the code would make this test
fail?"* — being asked by the builder of its own test.

### 13.3 Read the "known gaps" section as a bug list

The brief said: *known gaps or shortcuts, honestly.* Builder A's list contained two items
that are not gaps. They are defects:

> **Hiring doesn't check for an existing user login:** if a `users` row already has the
> worker's email … the worker invite is created but can't be accepted later. I didn't add
> a check because the contract doesn't specify one.

> **No session cleanup:** terminating or cancelling a worker doesn't deactivate their
> portal login or end their sessions. That isn't in the contract.

Both sentences end the same way: *the contract doesn't say.* The builder was right not to
invent behaviour — that was the instruction — and right to say so. **The gap was in the
lead's specification**, and the lead fixes it.

> **Prompt (lead → assistant)**
> Two fixes in the workers service. (1) Hiring with an invite, or inviting later, must
> refuse with `409 email_in_use` if that email already has a login — and I want the test
> for it to also prove the hire transaction rolls back, because this failure happens
> *after* the worker row is inserted. (2) Cancelling an onboarding hire must deactivate
> the portal login and delete its sessions in the same transaction. But a *terminated*
> worker keeps read access: they still need their final payslip, and every write path
> already requires an active worker. Write that reasoning into the code.

The second fix contains a product decision hiding inside a security fix. "Kill access
when someone leaves" sounds obviously right — until you remember the person who left
still needs to download their last payslip and, later, their tax documents. Cancelled
(never started) and terminated (worked here, now gone) are different situations and get
different answers:

```ts
// If they had already accepted their invite, the portal login must die with
// the hire: deactivate it and end its sessions now, in this transaction.
// (A TERMINATED worker deliberately keeps read access — they still need
// their final payslip. Every write path already requires an active worker.)
```

And the first fix paid an unexpected dividend. Builder A had confessed another weakness:

> The test asking that a duplicate email leaves nothing behind passes, but in that case
> the failure comes from the very first insert. No test makes a later step of the hire
> fail.

In other words, the "hire is one transaction" test would have passed *without* a
transaction, because the failing statement was the first one. The new `email_in_use`
check fails **after** the worker, the checklist and the documents have all been inserted —
so its test is the first real proof of the rollback:

```ts
expect(res.body.error.code).toBe('email_in_use');
// This failure happens AFTER the worker, tasks and documents were inserted,
// so it is the real proof that the hire is one transaction.
expect(await db.select().from(workers).where(eq(workers.organizationId, org.id))).toHaveLength(0);
expect(await db.select().from(onboardingTasks)).toHaveLength(0);
expect(await db.select().from(documents)).toHaveLength(0);
```

**Lesson — when you ask for honesty, read the answer.** "Known gaps" is the most valuable
paragraph an engineer (human or AI) will ever hand you, and it is the first one a busy
reviewer skims. An agent that reports its own weak spots is giving you a prioritised
review for free. The corollary: *ask for that section explicitly*. Without the
instruction, the default report is "everything works".

### 13.4 Read some of the code — especially at the boundaries

The lead did not read 3,000 lines. The lead read the places where a mistake is expensive:
file storage, invoicing, and the worker state transitions.

File storage is a classic source of security bugs (path traversal: a file named
`../../etc/passwd`). Builder A's version:

```ts
/** Key -> absolute path, refusing anything that is not exactly `<uuid>/<uuid>`. */
function resolveKey(key: string): string {
  const match = KEY_PATTERN.exec(key);
  if (!match?.[1] || !match[2]) throw new Error('Invalid storage key');
  const root = path.resolve(config.storageDir);
  const full = path.resolve(root, match[1], match[2]);
  // Belt and braces: the regex already rules out `..`, but check containment anyway.
  if (!full.startsWith(root + path.sep)) throw new Error('Storage key escapes the storage root');
  return full;
}
```

The user's file name never reaches the filesystem at all — it is stored only as a label.
The path is built from two UUIDs the server generated, validated by a pattern, *and then*
checked for containment. Two independent defences for one threat is called **defence in
depth**: if one is ever broken by a future edit, the other still holds.

Invoicing showed the same care in a different form:

```ts
if (!rate) {
  // Refusing is the only safe answer: guessing a rate would bill the client a made-up amount.
  throw conflict(`No exchange rate for ${run.currency}; cannot issue the invoice`, 'fx_rate_missing');
}
```

When data is missing, the two options are to fail or to guess. For money, always fail.

### 13.5 The first integrated run

Each builder ran only its own suites, on its own database. Nobody had yet run all of it
together. That first combined run is the real moment of truth for a parallel build:

```
$ cd apps/api && npx vitest run
 Test Files  13 passed (13)
      Tests  378 passed (378)
   Duration  120.01s
```

Three engineers, twelve modules, written simultaneously without seeing each other's code,
and no integration fixes needed. That is not luck and it is not the builders being
clever. It is chapter 11: the schema, the DTOs, the shared helpers and the seams were all
fixed before anyone started, so there was nothing left to disagree about.

*Commits `cae657e`, `0e812a7`, `471bccd` — one per builder, so `git blame` still tells you
which brief produced which code.*

---

## 14. Measure, then optimise: the slow test suite

Chapter 9 noted a worry and deliberately left it: 38 tests took 37 seconds. Builder B's
report raised the same flag from the other side:

> Each test takes about 0.5s, almost all of it the per-test truncate. One run of all three
> suites takes 2.5 to 3.5 minutes.

A test suite that takes five minutes gets run less often. A suite that gets run less
often catches bugs later. So this is worth fixing — but **not by guessing**. The builder
says it is the truncate. Is it?

> **Prompt (lead → assistant)**
> Before changing anything: time the cleanup statement by itself in `psql`, three times.
> Then time the alternative — plain `DELETE`s in dependency order. I want numbers.

```
truncate table organizations, users, audit_logs restart identity cascade;
Time: 371.425 ms
Time: 349.824 ms
Time: 350.094 ms

delete from audit_logs;  delete from invoice_lines;  …  delete from organizations;
Time: 5.939 ms   Time: 3.035 ms   Time: 7.157 ms   …   (16 statements, ~80 ms in total)
```

There it is. `TRUNCATE` is the right tool for emptying a *big* table: it throws away the
table's files instead of deleting rows one by one. But it pays a fixed cost per table —
heavy locks, new files, a sync to disk — whether the table holds a million rows or none.
Our tests hold a handful of rows in each of sixteen tables, which is the worst case for
`TRUNCATE` and the best case for `DELETE`.

The original one-liner had a real virtue, though: `CASCADE` meant a new table was cleaned
automatically. A hand-written list of tables can go stale — someone adds a table, forgets
the list, and rows leak from one test into the next, causing failures that make no sense.

So the change came with a guard:

```ts
it('names every table in the schema', async () => {
  const result = await db.execute(sql`select table_name from information_schema.tables
                                      where table_schema = 'public' and table_type = 'BASE TABLE'`);
  expect(actual, 'A table exists that src/test/cleanup.ts does not know about. Add it to ' +
    'TENANT_TABLES (before the tables it references) or to REFERENCE_TABLES.').toEqual(listed);
});
```

The test asks the database what tables actually exist and compares that with the list.
Forget to update the list and this fails immediately, with a message that says what to
do. The trade-off — speed for a manual list — was made safe by making the manual step
impossible to forget.

Result, on the full suite:

| | Before | After |
| --- | --- | --- |
| Time spent in tests | ~0.8 s per test | ~0.16 s per test |
| Whole API suite (378 tests) | would be ≈ 5 min | **2 min** (59 s in the tests themselves) |

*Commit `e89429d` — test(api): replace TRUNCATE CASCADE with ordered DELETEs.*

**Lesson — measure before you optimise, and write the measurement down.** The builder's
guess was right this time. It would have been just as plausible for the cost to be the
scrypt password hashing, or opening database connections. One minute with `\timing`
turned a guess into a fact, and the numbers went into the commit message so the next
person does not have to wonder whether the change was worth its complexity.

**Lesson — when you trade safety for speed, buy the safety back with a test.**

---

## 15. The journey test: proving the seams

378 passing tests, and still a real question nobody has answered: **do the modules work
together?**

Look at how each builder's tests were constructed. The brief told Builder C: *"do not call
their endpoints in your tests. Use `createWorker(...)` and insert `expenses` rows
directly."* That was necessary — the other modules did not exist yet. But it means
payroll was tested against workers *as the test factory creates them*, not as the hiring
endpoint creates them. If those two ever differ — a field the factory sets that the real
endpoint leaves null — every unit of the system is green and the product is broken.

So the lead wrote one more test, of a different kind:

> **Prompt (lead → assistant)**
> Write a single test that uses **no factories for business data**. Three actors — a
> client admin who signs up, the worker they hire, a platform admin — walking the whole
> product through the public API: register → quote → hire → accept invite → contract
> generate/send/sign/activate → upload and verify documents → finish the checklist →
> time off → expense → payroll create/submit/approve → try to process before paying →
> pay the invoice → process → mark paid → payslip. Assert the cross-module facts along
> the way.

It is about 250 lines and it reads like a story. The assertions that matter most are the
ones that *span* modules:

```ts
// The payslip's employer cost equals what the calculator quoted in step 2:
// two modules, built separately, agreeing because both call the same shared maths.
expect(run.body.employerCostMinor).toBe(quotedEmployerCost);
```

Builder A wrote the cost calculator. Builder C wrote payroll. Neither saw the other's
code. The number a client is quoted before hiring and the number they are billed
afterwards agree to the cent, because both modules call `packages/shared/src/calc.ts`.
*That* is what "single source of truth" buys you, demonstrated rather than asserted.

```ts
// The last task flips the worker to active — nobody pressed an "activate" button.
expect(last.body.workerStatus).toBe('active');
```

Four tasks, completed by three different modules (contracts, documents, workers) written
by two different builders, all funnelling through the seam function from chapter 11.

```ts
const tooEarly = await platform.post(`/payroll/runs/${runId}/process`);
expect(tooEarly.status).toBe(409);
expect(tooEarly.body.error.code).toBe('invoice_unpaid');
```

And the audit trail at the end — written by twelve modules, none of which coordinated —
contains every step in order.

```
$ npx vitest run src/test/journey.test.ts
 ✓ journey: from signup to a paid payslip > hires, onboards, pays and bills for one employee in Germany  4762ms
```

It passed first time. Had it failed, it would have failed at exactly the seam that was
wrong, with the step number in the stack trace.

**Lesson — the test pyramid has a top for a reason.** Many fast, focused tests tell you
*which* piece is broken. A very small number of end-to-end tests tell you whether the
pieces *fit*. You need both, and when work is split between people (or agents), the
second kind is the only thing that checks the splitting itself.

---

## 16. Seed data that cannot lie

A demo needs data: a company, a dozen workers at different stages, some payroll history.
The obvious way is a file of `INSERT` statements. The lead rejected it.

> **Prompt (lead → assistant)**
> Write the seed script so that it creates data by calling the real API in-process — the
> same way the journey test does. Direct inserts only where no endpoint exists (the
> platform admin). Dates relative to today, so the demo never looks stale. Make it
> idempotent, with an explicit `--reset`, and refuse to run against production.

The reasoning is in the header comment of `apps/api/src/db/seed.ts`:

```ts
 * Why go the long way round?
 *  - Seed data that bypasses the rules drifts into states the app can never
 *    produce (an "active" worker with no signed contract), and then the UI
 *    crashes on data no user could have created.
 *  - It doubles as a smoke test: if the seed runs, the whole flow works.
 *  - Payslip numbers, invoice totals and the audit trail are all REAL.
```

Hand-written seed rows are the reason "it only breaks on the demo database" is a phrase
every engineer has heard. If `status = 'active'` is typed into an INSERT, nothing checks
that the contract was signed, the documents verified, the checklist complete. The seed is
then a second, unofficial, untested implementation of your business rules — and it will
disagree with the real one.

Driving the API instead, the seed takes each worker through real onboarding, then
deliberately *stops* people at interesting points, so every screen has something to show:

| Who | State | Why they are there |
| --- | --- | --- |
| Lena, Tom, Priya, Maria, James | active employees | payroll history, time off, expenses |
| Sofia | active contractor | paid gross — a different payslip shape |
| Kenji | offboarding | end date next month → a prorated final payslip later |
| Diego | onboarding | contract *sent* but unsigned, one document awaiting review |
| Chloe | onboarding | hired today, invite link not yet opened |
| payroll: DE ×3, IN ×2, JP ×2, PH, ES | paid | a spend history for the dashboard |
| payroll: GB last month | approved, **invoice unpaid** | shows the "waiting for payment" state |
| payroll: DE this month | pending approval | something for the admin to approve |
| payroll: IN this month | draft | something to recalculate or submit |
| Globex Labs | a second company | so tenant isolation is visible, not theoretical |

```
$ npm run db:seed
Hiring and onboarding the Acme team…
Time off, expenses, payroll…
Seeded meridian_dev.  Password for every account: meridian-demo-1
```

Afterwards the dev database holds 11 workers, 12 payroll runs, 10 invoices — and **209
audit log entries**, none of them written by the seed script itself. Every one was
produced by the application as a side effect of doing real work.

*Commit `4066fa3` — journey test and API-driven seed.*

**Lesson — if two pieces of code must agree, make one of them call the other.** The seed
calls the API rather than re-implementing it. The API calls `calc.ts` rather than
re-implementing the maths. The web form uses the API's zod schema rather than
re-implementing validation. It is the same idea at every level of the system.

---

## 17. The independent review, and the bug that was the lead's

Everything is green: 378 module tests, a journey test, a seed that runs. This is the
most dangerous moment in a project, because all the evidence says "done" and all of that
evidence was produced by the people who wrote the code.

So the lead commissioned a review from someone who had seen none of it.

> **Prompt (lead → a fresh reviewer agent)** *(abridged; the real one is longer)*
> READ-ONLY review. Do not edit or run anything. The API was built by three engineers,
> module by module; their suites pass. Nobody has read the code across modules with fresh
> eyes. Hunt for real defects in this priority order: tenant isolation; authorization;
> money and state integrity; contract deviations; data leaks; cross-module
> inconsistencies.
> Do NOT report style, naming, coverage wishes or "could be better". Only report something
> if you can state a concrete scenario — who does what, in what state — that produces a
> wrong result. For each candidate, re-read the surrounding code and try to **disprove**
> it before reporting. Finish with a "checked and found sound" list so I know what was
> covered.

Three things in that prompt are deliberate:

1. **It does not say what the lead thinks is wrong.** A reviewer handed your suspicion
   tends to come back confirming it. A reviewer handed the code and a priority list comes
   back with what is actually there.
2. **It demands a concrete failure scenario** and tells the reviewer to try to disprove
   its own findings. Without that, review output is a long list of maybes, and the real
   bug is item 14 of 30.
3. **It asks what was checked and found fine.** Otherwise "no findings in tenant
   isolation" is indistinguishable from "did not look at tenant isolation".

### 17.1 What came back

> I found one high-severity money defect and five low-severity ones. Tenant isolation and
> authorization came out clean.

The high one:

> **HIGH — Japan invoices are under-billed 100x.** `convertMinor` divides minor units by
> the FX rate and never accounts for JPY having 0 minor digits while USD has 2. … monthly
> gross is 666,667. On approve, `toUsd(666667)` gives 4415, stored as USD cents: the
> `gross_pay` line is $44.15 instead of $4,415.01. … The line description still prints
> the correct "¥666,667", so the invoice contradicts itself.

Look at where it is: `packages/shared/src/money.ts`. That file was not written by a
builder. **The lead and the assistant wrote it, in chapter 6** — the chapter with the
four confident rules about money.

Here is the function as originally written:

```ts
export function convertMinor(amountMinor: number, fromPerUsd: string, toPerUsd: string): number {
  …
  return roundHalfUp((amountMinor / from) * to);
}
```

It converts *minor units* using a rate that relates *major units*. Between euros and
dollars that is fine by accident: both have 100 minor units per major unit, so the two
factors of 100 cancel. For yen there is no minor unit — ¥700,000 is stored as `700000` —
so one factor of 100 has nothing to cancel against.

**First, confirm it.** A review finding is a hypothesis until you have seen it happen.
The seed had created Japanese payroll runs, so the evidence was already sitting in the
database:

```
$ psql … -c "select number, currency, gross_minor, kind, amount_minor, description …"
INV-2026-001006 | JPY | 700000 | gross_pay | 4636 | Gross pay, Japan, September 2026 (¥700,000)
```

¥700,000 of salary, billed to the client as **$46.36**. Real, and it had been sitting in
the demo data the whole time.

### 17.2 Why did 378 tests not catch it?

This question matters more than the fix.

- The unit test for `convertMinor` used EUR → USD. Both are two-decimal currencies. The
  test verified the arithmetic and happened to choose the one family of inputs where the
  bug is invisible.
- Builder C wrote a hand-computed invoice test — for a German worker. The brief said
  *"a German employee on €60,000/yr"*. The builder did exactly what was asked.
- The journey test hires in Germany.
- The seed *did* create Japanese invoices. Nothing looked at them.

Every test used the same comfortable example. And the really uncomfortable part: the
codebase **knew** yen was special. `money.ts` contained, twenty lines below the bug,

```ts
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP']);
```

used by `formatMoney` — which is why the invoice line printed the correct "¥700,000"
next to the wrong dollar amount. The knowledge existed in one function and was missing
from its neighbour.

**Lesson — your test data has a comfort zone, and bugs live outside it.** When every
example is the same shape (one country, one currency, one happy month), you are testing
one point in a large space. Ask of every calculation: *what is the weirdest legal input?*
A currency with no cents. A February in a leap year. A worker who starts on the 31st.
A salary at the cap. Put those in the tests *by name*.

**Lesson — the author is the worst person to review their own code**, and that includes
the lead, and it includes an AI reviewing its own output. The lead read `invoicing.ts`
in chapter 13 and thought it was careful. It *was* careful. The defect was one layer
down, in a helper the lead trusted because the lead had written it.

### 17.3 The fix

```ts
export function convertMinor(
  amountMinor: number,
  from: { currency: string; perUsd: string },
  to:   { currency: string; perUsd: string },
): number {
  …
  const major = amountMinor / 10 ** minorUnitDigits(from.currency);   // minor -> major
  const convertedMajor = (major / fromRate) * toRate;                 // apply the rate
  return roundHalfUp(convertedMajor * 10 ** minorUnitDigits(to.currency)); // major -> minor
}
```

Notice the **signature** changed, not just the body. The old function took two rate
strings; nothing in its type said "I need to know which currencies these are". The new
one cannot be called without the currency codes. A bug that came from a function not
having the information it needed is fixed by making that information mandatory — the
compiler then found the one call site that had to change.

The regression test uses numbers a person can check on a calculator:

```ts
// At 151 JPY per USD:  ¥700,000 / 151 = $4,635.76  -> 463,576 cents
expect(line('gross_pay')).toBe(463_576);
//                      ¥107,800 / 151 = $713.91    ->  71,391 cents
expect(line('employer_cost')).toBe(71_391);
```

And the comment above the function now tells the story, so the next reader knows this
line has history:

```ts
 * The first version of this function skipped steps one and three. That is
 * harmless between two 2-decimal currencies (the factors cancel) and silently
 * wrong by 100x for yen. See journal chapter 17.
```

### 17.4 The five smaller findings

Each is a real scenario; each is small. Together they show what "fresh eyes across
modules" finds that per-module tests cannot.

**A team invite could destroy a worker's portal invite.** Inviting a teammate deletes any
earlier pending invite for that email (so only one link is ever live). It did not check
whether the earlier invite was a *worker's*. Invite a worker's address as a teammate and
their portal link silently died; if they accepted the teammate invite they became a
client user with no worker record, and could then never sign their contract. This one
was in the **lead's** reference module, which the builders had faithfully copied the
*style* of. Fix: scope the delete to team invites, and refuse a team invite for an email
that belongs to a worker.

**The lead's own fix from chapter 13 was incomplete.** The `email_in_use` check only ran
when an invite was requested. Hiring with "don't send an invite" succeeded — creating a
worker who could never be given portal access, never sign, never activate. The reviewer
caught a hole in a fix made two hours earlier. Fix: check on every hire.

**A deadlock between signing and cancelling.** Signing a contract locked the *contract*
row, then (through the onboarding seam) the *worker* row. Cancelling a hire locked the
*worker* row, then updated the *contract*. Two transactions taking the same two locks in
opposite orders can each end up waiting for the other; Postgres detects the cycle and
kills one, which the user sees as a 500. The rule that prevents this is old and simple:

> **Always take locks in the same order.**

Fix: contract transitions now lock the worker first — the same order the workers module
uses. This bug existed *between* Builder A's module and Builder B's. Neither could have
seen it; each was correct alone.

**A stale read when voiding a contract** — the same cure (read the worker's status under
the lock).

**A sloppy regex**: the `X-Org-Id` check accepted any 36 characters from `[0-9a-f-]`,
including 36 dashes, which then crashed in Postgres as a 500. The codebase already had a
strict UUID pattern in another file. Fix: use it. One pattern, one place.

### 17.5 Honest about the tests for these

The lead wrote regression tests for all of them, and then caught something in the first
draft of the test file's own header comment. It claimed every test "was written to FAIL
against the code as it was before the fix". That was true of the yen test — the seeded
data proved it. It was **not verified** for the deadlock test: a deadlock needs unlucky
timing, and a test that runs the race five times might simply never hit it, before or
after the fix. The comment was rewritten to say so:

```ts
 * The concurrency test is a guard, not a proof: a deadlock needs unlucky timing,
 * so passing five rounds lowers the odds rather than ruling it out.
```

**Lesson — do not claim more than you checked, even in a comment.** A test that is
described as proving something it does not prove is worse than no test: it stops the next
person from looking.

### 17.6 What the review did *not* find

> **Tenant isolation:** none. **Authorization:** none. **Data leaks:** none.
> Every tenant-table query in all 12 modules filters on `requireOrgId(actor)`. … Every
> response is mapped with an explicit field list. `storageKey`, `signatureIp`,
> `passwordHash` and token hashes never leave.

Those are the categories the lead worried about most and wrote the most rules about:
the `Actor`, rule 2 in `CLAUDE.md`, the cross-tenant test required in every brief. The
defects all turned up in places the rules did *not* cover — a helper function, the
interaction between two modules, a specification the lead had left incomplete.

That is the pattern to take away. **Rules, briefs and reference code prevent the bugs you
anticipated. Independent review finds the ones you did not.** You need both, and you need
the second precisely *because* the first works well enough to make you confident.

The reviewer also listed four behaviours that are "the code follows the contract, but is
the contract right?" — for example, a worker activated after their first month's payroll
was already run is never back-paid for those days. Those are product decisions rather
than bugs, and they go on the known-gaps list in the final chapter instead of being
quietly patched.

```
$ npx vitest run        (after all fixes)
 Test Files  15 passed (15)
      Tests  385 passed (385)
$ npm run db:seed -- --reset
gross_pay | 463576 | Gross pay, Japan, September 2026 (¥700,000)      ← was 4636
```

*Commit `fix: independent review findings`.*

<!-- JOURNAL:APPEND-BELOW -->

---

# Appendices

## Appendix A — Glossary

- **ADR (Architecture Decision Record)** — a short note recording one significant
  decision: context, decision, consequences. Lives in `docs/adr/`.
- **Actor** — our name for "who is making this request and for which tenant".
- **Basis point (bps)** — one hundredth of a percent. 2150 bps = 21.5 %.
- **CSRF** — cross-site request forgery: another website causing your browser to send an
  authenticated request. Defended with SameSite cookies and an Origin check.
- **DTO (Data Transfer Object)** — the shape of data crossing the API boundary; distinct
  from the database row.
- **EOR (Employer of Record)** — a company that legally employs workers on behalf of
  client companies in countries where the client has no entity.
- **Idempotent** — doing it twice has the same effect as doing it once.
- **IDOR** — insecure direct object reference: reading someone else's record by guessing
  its id. Our defence is the tenant filter inside every `WHERE`.
- **Integration test** — a test that exercises several real layers together (here: HTTP →
  service → Postgres).
- **Migration** — a versioned script that changes the database schema.
- **Minor units** — the smallest unit of a currency (cents). Money is stored as integers
  of these.
- **Multi-tenant** — one running system serving many customer organizations whose data
  must stay separate.
- **Pure function** — output depends only on input; no I/O, no hidden state.
- **Race condition** — a bug that depends on the timing of concurrent operations.
- **Seam** — a place where two parts of a system meet through a small, deliberate
  interface.
- **State machine** — a set of states plus the allowed moves between them.
- **Transaction** — a group of database writes that all succeed or all fail together.

## Appendix B — Command cheat-sheet

```bash
# start Postgres for this project (port 5443)
pg_ctl -D ~/pgdata-peblclone -o "-p 5443" start

# typecheck
npx tsc -p packages/shared && npx tsc -p apps/api && npx tsc -p apps/web

# tests
(cd packages/shared && npx vitest run)
(cd apps/api && npx vitest run)                       # everything
(cd apps/api && npx vitest run src/modules/payroll)   # one module

# database
npm run db:generate -- --name add_something   # after editing schema.ts
npm run db:migrate
npm run db:seed

# run the app
npm run dev        # API on :4000, web on :5173
```
