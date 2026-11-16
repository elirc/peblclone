# Wave 2 · Builder D — "People UI": dashboard, people, hiring, worker detail, calculator, countries

Read `docs/briefs/wave2-common.md` first; everything there applies.

## You own (create/edit only these)

```
apps/web/src/api/workers.ts        workers, onboarding tasks, documents hooks
apps/web/src/api/countries.ts      countries + quotes hooks
apps/web/src/api/dashboard.ts
apps/web/src/pages/dashboard/      DashboardPage.tsx (+ helpers, tests)
apps/web/src/pages/workers/        WorkersPage.tsx, HireWorkerPage.tsx, WorkerDetailPage.tsx (+ helpers, tests)
apps/web/src/pages/quotes/         CostCalculatorPage.tsx (+ helpers, tests)
apps/web/src/pages/countries/      CountriesPage.tsx (+ helpers)
```

Contract sections: **Countries & quotes**, **Workers & onboarding**, **Documents**,
**Audit & dashboard** (dashboard only).

## Pages

**DashboardPage** (`/`, staff) — `GET /dashboard`.
Stat tiles: total headcount, active, onboarding, employees vs contractors. A "Needs your
attention" card listing each non-zero `pending` count as a link to the right page
(time-off → `/time-off`, expenses → `/expenses`, payroll approvals → `/payroll`, unpaid
invoices → `/invoices`, contracts awaiting signature → `/contracts`); when all are zero say
so. "Headcount by country" as horizontal bars (plain divs with widths; no chart library).
"Monthly spend" for the 6 months as a simple bar chart built from divs, each bar labelled
with the month and `formatMoney(total, 'USD')`. "Recent activity" list from
`recentActivity` (`humanize(action)`, actor name, `formatDateTime`). A brand-new company
with no workers gets an empty state inviting them to hire their first person.

**WorkersPage** (`/people`) — `GET /workers` with search box (debounced ~300 ms), status,
type and country filters, pagination. Columns: name + email, job title, country, type
badge, status badge, start date, salary (formatted with its currency and `/yr` or `/mo`).
Row click → `/people/:id`. Header action "Hire someone" → `/people/new`. Keep filters in
the URL query string (`useSearchParams`) so a filtered list can be bookmarked and survives
the back button.

**HireWorkerPage** (`/people/new`) — `POST /workers` with `createWorkerSchema`.
Sections: who (first/last name, email), role (job title, department), where & what kind
(country select from `GET /countries`; employee/contractor radio), pay (salary in major
units — currency shown from the selected country; annual/monthly), start date,
"send portal invite" checkbox. For employees, show a **live cost preview** beside the form
by calling `calculateEmploymentCost` from `@meridian/shared` in the browser with the
selected country's rules (no network call) — monthly salary, each employer contribution
line, total monthly cost, Meridian fee. On success: if `acceptUrl` is returned, show a
modal with the invite link and a "Copy link" button (there is no email service — say so),
then continue to the worker page.

**WorkerDetailPage** (`/people/:id`) — `GET /workers/:id`; tabs kept in `?tab=`:
- *Overview*: details (DescriptionList), an Edit modal (`PATCH`, `updateWorkerSchema`),
  portal access state with "Create invite link" (`POST /workers/:id/invite`), and status
  actions for admins driven by `WORKER_TRANSITIONS`: Start offboarding (asks end date +
  reason), Rescind offboarding, Mark terminated, Cancel onboarding — each confirmed.
- *Onboarding*: the checklist with progress (n of m). Automatic tasks show how they get
  completed instead of a button. Manual tasks show "Mark complete" only to roles allowed
  by the contract (`POST /onboarding-tasks/:id/complete`).
- *Documents*: `GET /workers/:id/documents`; request a document (modal); upload a file per
  document (`fileToBase64` → `POST /documents/:id/file`; accept pdf/png/jpeg; check the
  5 MB limit client-side with `MAX_DOCUMENT_BYTES`); download (`api.blob` + `saveBlob`);
  platform admins get Verify / Reject (reject asks for a note).
Handle a 404 with a clear "worker not found" state.

**CostCalculatorPage** (`/calculator`) — country select + annual salary input →
`POST /quotes/calculate`; show the full `CostBreakdown`: monthly salary, each employer
contribution with its rate (`formatBps`), total monthly & annual employer cost, Meridian
fee (USD), and the indicative employee side (deductions and net). "Save quote" with an
optional label (`POST /quotes`); saved quotes listed below (`GET /quotes`) with delete.
State plainly on the page that the rates are illustrative, not tax advice.

**CountriesPage** (`/countries`, platform admin) — table of countries (name, currency,
leave days, notice, fee, EOR supported); clicking opens a modal to edit
`monthlyFeeUsdMinor`, `annualLeaveDays`, `noticePeriodDays`, `probationDays`,
`eorSupported` (`PATCH /countries/:code`). Contribution rules are shown read-only.

## Tests (at least)

- `WorkersPage.test.tsx`: renders rows from a mocked list; empty state; typing in search
  sends a request containing `search=`.
- `HireWorkerPage.test.tsx`: validation errors without a network call; successful submit
  sends minor units (e.g. typing `60000` → `6000000`) and upper-case country code.
