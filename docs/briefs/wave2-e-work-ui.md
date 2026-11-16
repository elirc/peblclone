# Wave 2 · Builder E — "Work UI": contracts, time off, expenses, worker portal home

Read `docs/briefs/wave2-common.md` first; everything there applies.

## You own (create/edit only these)

```
apps/web/src/api/contracts.ts
apps/web/src/api/time-off.ts
apps/web/src/api/expenses.ts
apps/web/src/api/portal.ts          GET /me/worker, the worker's own documents + task completion
apps/web/src/pages/contracts/       ContractsPage.tsx, ContractDetailPage.tsx (+ helpers, tests)
apps/web/src/pages/time-off/        TimeOffPage.tsx (+ helpers, tests)
apps/web/src/pages/expenses/        ExpensesPage.tsx (+ helpers, tests)
apps/web/src/pages/portal/          PortalHomePage.tsx (+ helpers)
```

Contract sections: **Contracts**, **Time off**, **Expenses**, plus from **Workers &
onboarding** only `GET /me/worker` and `POST /onboarding-tasks/:id/complete`, and from
**Documents** the list/upload/download endpoints (for the portal).

Builder D owns `api/workers.ts`. Do **not** import from it (it may not exist yet when you
typecheck). Where you need a list of workers for a picker, write your own small hook in
your own api file calling `GET /workers` (`limit: 100`, `status: 'active'` where relevant).

**These pages serve two audiences.** `/contracts`, `/time-off` and `/expenses` are reached
by client staff *and* by workers. Branch on `isWorkerRole(useUser())`: staff see everyone
and get approval actions; a worker sees only their own records (the API already filters)
and gets self-service actions. Never show a worker a worker-picker.

## Pages

**ContractsPage** (`/contracts`) — `GET /contracts` with status filter + pagination.
Columns: worker, title, status badge, sent, signed. Row click → detail. Staff get
"New contract": a modal with a worker picker → `POST /contracts` → navigate to the detail.
Surface `409 contract_exists` and `409 worker_not_eligible` with their messages. For a
worker with no contract yet, an empty state explaining their employer has not sent one.

**ContractDetailPage** (`/contracts/:id`) — `GET /contracts/:id`. Header: title, status
badge, worker name. A terms summary card from `terms` (salary formatted with currency and
basis, start date, leave days, notice, probation). The body rendered as pre-wrapped text
in a document-like panel. A timeline of sent / signed (with `signedByName`) / activated /
terminated timestamps. Actions by status + role, driven by `CONTRACT_TRANSITIONS`:
- staff, `draft`: Edit (modal with title + body textarea → `PATCH`), Send to worker;
- staff, `sent`: Recall;
- **worker**, `sent`: a signing card — type full legal name, tick "I have read and agree",
  Sign (`POST …/sign` with `signContractSchema`). Show `400 signature_mismatch` on the
  name field. After signing show a success state;
- admin, `signed`: Activate (countersign);
- admin, `draft|sent|signed`: Void (confirm, danger);
- admin, `active`: Terminate (confirm, danger).

**TimeOffPage** (`/time-off`) —
- worker: a balance card (`GET /time-off/balance`: entitlement, used, pending, remaining),
  "Request time off" (modal: type, start, end, reason; `createTimeOffRequestSchema`; show
  the business-day count live with `countBusinessDays` from shared), and their requests
  with Cancel where allowed (`pending`, or `approved` with a future start).
- staff: tabs "Pending" / "All" (status filter), table with worker, type, dates, days,
  status, reason; Approve / Reject on pending rows (reject asks for an optional note);
  "Request on behalf" with a worker picker; Cancel on pending/approved.
Show `409 insufficient_balance`, `overlapping_request` etc. as form errors with the
server's message.

**ExpensesPage** (`/expenses`) —
- worker: "Submit expense" (modal: category, description, amount in major units of **their**
  currency — get it from `GET /me/worker` — date; `createExpenseSchema`), their expenses
  with status, Delete on `submitted` ones.
- staff: tabs "To review" (`submitted`) / "All", table with worker, category, description,
  date, amount (right-aligned, in the expense currency), status; Approve / Reject (reject
  **requires** a note — enforce in the UI as well); "Submit on behalf" with worker picker.
A `reimbursed` expense shows that it was paid through payroll.

**PortalHomePage** (`/` for workers) — `GET /me/worker`.
A welcome header with their name, job title, employer and status badge. If status is
`onboarding`: the checklist with progress, where each task has the right call to action —
`contract_signed` → link to their agreement (find it via `GET /contracts`; if none has been
sent yet, say so); `documents_verified` → the documents list below; `bank_details` →
"Mark complete" button (`POST /onboarding-tasks/:id/complete`); client tasks show as
"Waiting on your employer". A documents card: each requested document with status, upload
button (pdf/png/jpeg, ≤ `MAX_DOCUMENT_BYTES`, `fileToBase64` → `POST /documents/:id/file`),
reviewer note when rejected, download for uploaded files. If `active`: quick links to time
off, expenses, payslips and a short summary of their employment details.

## Tests (at least)

- `ContractDetailPage.test.tsx`: a worker viewing a `sent` contract sees the signing card
  and no staff actions; staff viewing a `draft` see Edit/Send and no signing card; signing
  posts `{ signedByName, agree: true }`.
- `ExpensesPage.test.tsx`: rejecting without a note does not call the API; submitting an
  expense converts major units to minor.
