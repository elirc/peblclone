# User stories — practice tasks

Twenty tasks of the size a junior or mid-level engineer would be handed on this codebase.
Each one is a real improvement to Meridian. **None of them has been implemented** — the
point is for you to do them.

Every story gives you:

- the **story** and why it matters,
- **acceptance criteria** you can check your work against,
- the **files** involved,
- **step-by-step instructions** with the code to add or change,
- the **tests** to write,
- how to **verify**, the **pitfalls** to expect, and a **stretch** goal.

## Read this before you start

**The instructions were written by reading the code, not by running them.** Nobody has
applied these changes and watched the tests pass. They were checked carefully against the
source at commit `6b4946b`, but treat them the way you would treat a senior colleague's
notes: probably right, occasionally wrong, and yours to verify. If a step does not
compile, that is part of the exercise — read the error, read the surrounding code, fix it.

**Line numbers will drift.** They were correct at commit `6b4946b`. As soon as you
complete one story, the numbers in the next may be off by a few lines. Every step
therefore also quotes an **anchor** — a snippet of the existing code to search for. Trust
the anchor over the number.

**Do them on a branch, one story per branch.**

```bash
git switch -c us-01-page-titles
# …work…
git add -A && git commit -m "feat(web): set the browser tab title per page (US-01)"
git switch main
```

That way you can compare your solution with a fresh attempt, or throw one away.

## The loop for every story

1. Read the whole story before touching anything.
2. Open each file listed and find each anchor. Understand the code around it.
3. **Write the test first** where the story has one, and watch it fail. A test you have
   never seen fail has not proven anything (build journal, chapter 9.5).
4. Make the change.
5. Run the checks:

```bash
npx tsc -p packages/shared && npx tsc -p apps/api && npx tsc -p apps/web    # types
(cd packages/shared && npx vitest run)                                     # shared unit tests
(cd apps/api && npx vitest run src/modules/<module>)                       # the module you touched
(cd apps/web && npx vitest run src/pages/<folder>)                         # the page you touched
npx prettier --check .
```

6. Before you commit, run **everything** once: `npm run typecheck && npm test`.
7. If the story changed an endpoint's behaviour, update `docs/api-contract.md` in the
   same commit. The contract is the specification (`CLAUDE.md`, rule 1).

Postgres must be running on port 5443 for the API tests (see the build journal's
Appendix B).

## Stories that change the database

Six stories add a column, a table, an index or an enum value. The routine is always:

```bash
# 1. edit apps/api/src/db/schema.ts (or the shared enum the schema uses)
npm run db:generate -- --name <what_changed>     # writes apps/api/drizzle/000N_<name>.sql
# 2. OPEN the generated .sql file and read it. Never apply a migration you have not read.
npm run db:migrate                               # applies it to meridian_dev
# 3. tests rebuild their database from all migrations on every run — nothing to do there.
```

Migration files are numbered in the order they are generated. If you do these stories
out of order your file numbers will differ from the ones mentioned here. That is fine.

## The stories

Roughly in order of difficulty. "J" = junior, "M" = mid-level.

| # | Level | Area | Story | File |
| --- | --- | --- | --- | --- |
| US-01 | J | web | The browser tab shows which page you are on | [01-05](01-05-junior-web-and-api.md#us-01--the-browser-tab-shows-which-page-you-are-on) |
| US-02 | J | web | Show / hide password | [01-05](01-05-junior-web-and-api.md#us-02--show--hide-password) |
| US-03 | J | web | A helpful "page not found" | [01-05](01-05-junior-web-and-api.md#us-03--a-helpful-page-not-found) |
| US-04 | J | web tests | Tests for the sign-up page | [01-05](01-05-junior-web-and-api.md#us-04--tests-for-the-sign-up-page) |
| US-05 | J | api | Health check that knows about the database | [01-05](01-05-junior-web-and-api.md#us-05--health-check-that-knows-about-the-database) |
| US-06 | J | api | A request id on every response | [06-10](06-10-junior-full-stack.md#us-06--a-request-id-on-every-response) |
| US-07 | J | api + web | Log out of all devices | [06-10](06-10-junior-full-stack.md#us-07--log-out-of-all-devices) |
| US-08 | J | api | Refuse start dates more than a year away | [06-10](06-10-junior-full-stack.md#us-08--refuse-start-dates-more-than-a-year-away) |
| US-09 | J | data | Hire in South Korea | [06-10](06-10-junior-full-stack.md#us-09--hire-in-south-korea) |
| US-10 | J | web | Show which organization a platform admin is inside | [06-10](06-10-junior-full-stack.md#us-10--show-which-organization-a-platform-admin-is-inside) |
| US-11 | M | db + api | A new time-off type: bereavement | [11-15](11-15-mid-features.md#us-11--a-new-time-off-type-bereavement) |
| US-12 | M | api + web | Filter the audit log by action and date | [11-15](11-15-mid-features.md#us-12--filter-the-audit-log-by-action-and-date) |
| US-13 | M | db + api + web | A tax ID on the organization | [11-15](11-15-mid-features.md#us-13--a-tax-id-on-the-organization) |
| US-14 | M | api | Change my password | [11-15](11-15-mid-features.md#us-14--change-my-password) |
| US-15 | M | api + web | Export people to CSV | [11-15](11-15-mid-features.md#us-15--export-people-to-csv) |
| US-16 | M | api | Former workers are read-only | [16-20](16-20-mid-hardening.md#us-16--former-workers-are-read-only) |
| US-17 | M | api + web | Overdue invoices on the dashboard | [16-20](16-20-mid-hardening.md#us-17--overdue-invoices-on-the-dashboard) |
| US-18 | M | db | An index for the people list | [16-20](16-20-mid-hardening.md#us-18--an-index-for-the-people-list) |
| US-19 | M | db + api | Four-eyes approval on payroll | [16-20](16-20-mid-hardening.md#us-19--four-eyes-approval-on-payroll) |
| US-20 | M | db + api | A login rate limiter that survives a restart | [16-20](16-20-mid-hardening.md#us-20--a-login-rate-limiter-that-survives-a-restart) |

Several of these close items on the known-gaps list in the build journal (chapter 20.2):
US-16 (former workers' write paths), US-19 (no four-eyes rule), US-20 (in-memory rate
limiter).

## When you get stuck

- **Find the nearest example.** Every pattern these stories need already exists
  somewhere. Adding an endpoint? `apps/api/src/modules/organizations/` is the reference
  module. Adding a page test? `apps/web/src/pages/auth/LoginPage.test.tsx`.
- **Read the test helpers.** `apps/api/src/test/helpers.ts` (`createTenant`,
  `createWorker`, `loginAsWorker`, `createPlatformAdmin`) and
  `apps/web/src/test/render.tsx` (`renderApp`, `mockFetch`, `jsonResponse`).
- **Run one test, not the suite.** `npx vitest run path/to/file.test.ts -t "part of the test name"`.
- **Check the rules.** `CLAUDE.md` lists ten non-negotiable rules. If your change breaks
  one — a query without a tenant filter, a row returned without a DTO mapping — the
  change is not done, whatever the tests say.
