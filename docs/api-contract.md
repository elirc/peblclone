# Meridian API contract

Base path: `/api/v1`. JSON in, JSON out. This document plus
`packages/shared/src/schemas.ts` (request shapes) and `dto.ts` (response shapes)
**is the specification**. Backend modules implement it; the web app consumes it.

## Conventions

- **Auth**: session cookie `meridian_session`. No cookie / bad cookie → `401 unauthorized`.
- **Roles**: `platform_admin` (Meridian staff), `client_admin`, `client_manager`, `worker`.
  - *staff* = everyone except `worker` · *admin* = `client_admin` + `platform_admin`.
  - Wrong role → `403 forbidden`.
- **Tenancy**: the tenant is `actor.organizationId` (`requireOrgId(actor)`). Platform admins
  select a tenant with the `X-Org-Id` header. A record in another tenant → `404 not_found`.
- **Workers (role)** can only touch their own records. Someone else's → `404`.
- **Errors**: `{ "error": { "code", "message", "details"? } }`.
  `400 validation_error` carries `details: { field: [messages] }`.
- **Lists** return `Paginated<T>` = `{ items, total, limit, offset }` (query `limit` ≤ 100,
  default 25; `offset`). Small fixed lists return `{ items }`.
- **Illegal status change** → `409 invalid_transition`.
- **Created** → `201`. **Deleted / no body** → `204`.
- Every state-changing endpoint writes an audit record (`<entity>.<verb_past>`).

---

## Auth — *done (reference implementation)*

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| POST | `/auth/register` | public | `registerSchema` → 201 `AuthResponse` + cookie |
| POST | `/auth/login` | public | `loginSchema` → `AuthResponse` + cookie |
| POST | `/auth/logout` | any | → 204 |
| GET | `/auth/me` | any | → `AuthResponse` |
| GET | `/auth/invite?token=` | public | → `InvitePreviewDto` |
| POST | `/auth/accept-invite` | public | `acceptInviteSchema` → 201 `AuthResponse` + cookie |

## Organization & team — *done (reference implementation)*

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/organization` | any | → `OrganizationDto` |
| PATCH | `/organization` | admin | `updateOrganizationSchema` → `OrganizationDto` |
| GET | `/admin/organizations` | platform_admin | → `{ items: OrganizationSummaryDto[] }` |
| GET | `/team` | staff | → `{ items: TeamMemberDto[] }` |
| GET | `/team/invites` | admin | → `{ items: InviteDto[] }` |
| POST | `/team/invites` | admin | `createTeamInviteSchema` → 201 `InviteCreatedDto` |
| DELETE | `/team/invites/:id` | admin | → 204 |
| PATCH | `/team/:id` | admin | `updateTeamMemberSchema` → `TeamMemberDto` |

Team invites: `409 email_taken` if the email has a login; `409 email_belongs_to_worker` if it
is one of the organization's workers. Re-inviting replaces earlier *team* invites only.

---

## Countries & quotes — module `countries`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/countries` | any | → `{ items: CountryDto[] }` sorted by name |
| GET | `/countries/:code` | any | → `CountryDto` (404 if unknown) |
| PATCH | `/countries/:code` | platform_admin | `updateCountrySchema` → `CountryDto` |
| POST | `/quotes/calculate` | staff | `calculateQuoteSchema` → `CostBreakdown` (nothing saved) |
| POST | `/quotes` | staff | `saveQuoteSchema` → 201 `QuoteDto` |
| GET | `/quotes` | staff | pagination → `Paginated<QuoteDto>` newest first |
| DELETE | `/quotes/:id` | staff | → 204 |

Rules
- `:code` is case-insensitive (`de` = `DE`).
- Calculation uses `calculateEmploymentCost` from shared with the country's rules. Unknown
  country → `400 unknown_country`. `eorSupported = false` → `400 eor_not_supported`.
- `PATCH /countries` audits `country.updated` with `organizationId: null`.
- Saved quotes store the full breakdown (a snapshot: later rate changes do not rewrite it).

## Workers & onboarding — module `workers`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/workers` | staff | `listWorkersQuerySchema` → `Paginated<WorkerDto>` (by lastName, firstName) |
| POST | `/workers` | staff | `createWorkerSchema` → 201 `WorkerCreatedDto` |
| GET | `/workers/:id` | staff, or the worker | → `WorkerDetailDto` |
| PATCH | `/workers/:id` | staff | `updateWorkerSchema` → `WorkerDetailDto` |
| POST | `/workers/:id/transition` | admin | `transitionWorkerSchema` → `WorkerDetailDto` |
| POST | `/workers/:id/invite` | staff | → 201 `InviteCreatedDto` |
| GET | `/me/worker` | worker | → `WorkerDetailDto` |
| POST | `/onboarding-tasks/:id/complete` | see rules | → `OnboardingTaskCompletedDto` |

Rules
- **Hire (`POST /workers`)**, all in one transaction:
  - country must exist (`400 unknown_country`); employees additionally need
    `eorSupported` (`400 eor_not_supported`).
  - `currency` is copied from the country; status starts as `onboarding`.
  - duplicate `(organization, email)` → `409 worker_email_taken` (from the unique index).
  - the email already has a login anywhere in Meridian → `409 email_in_use`, whether or not
    an invite is requested (one email = one login; such a worker could never reach the
    portal to sign). *Added after review.*
  - create the onboarding checklist from `ONBOARDING_TASK_TEMPLATES` (`lib/onboarding.ts`).
  - create one `requested` document per `country.requiredDocuments`
    (title = `DOCUMENT_KIND_LABELS[kind]`). If the country requires none, complete the
    `documents_verified` task immediately.
  - if `sendInvite`, create a `worker` invitation (`lib/invites.ts`) and return `acceptUrl`.
  - audit `worker.created`.
- `search` matches first name, last name, email or job title, case-insensitive, with
  `%`/`_` escaped (they are literal characters, not wildcards).
- `hasPortalAccess` = the worker has a linked `userId`.
- `tasks` are ordered by `sortOrder`.
- **Update**: allowed while `onboarding` or `active` (else `409 worker_not_editable`).
  `startDate` may only change while `onboarding` (`409 start_date_locked`). Audit
  `worker.updated` with the changed field names (and old/new salary when it changes).
- **Transitions** (table `WORKER_TRANSITIONS`):
  - `onboarding → active` through this endpoint is refused with `409 onboarding_incomplete`
    (activation happens automatically when the checklist completes).
  - `→ offboarding` requires `endDate` (`400`), which must be ≥ `startDate`; stores it.
  - `offboarding → active` (rescind) clears `endDate`.
  - `offboarding → terminated`: also sets the worker's `active` contract to `terminated`.
  - `onboarding → cancelled`: voids any `draft|sent|signed` contract, terminates an
    `active` one, deletes the worker's unaccepted invitations, and deactivates their
    portal login (ending its sessions). A *terminated* worker keeps their login.
  - audit `worker.status_changed` `{ from, to, reason }`.
- **Invite**: `409 already_has_access` if the worker has a `userId`; `409 email_in_use` if
  the email has since gained another login; replaces earlier
  unaccepted invitations for that worker; refused for `terminated`/`cancelled` workers (`409`).
- **Complete task**: the task must be in the actor's tenant (and, for a worker, their own).
  - `automatic` tasks → `409 task_is_automatic`.
  - who may complete: `assignee = worker` → that worker or a platform admin;
    `assignee = client` → client staff or a platform admin; `assignee = platform` →
    platform admin. Otherwise `403`.
  - already completed → return it unchanged (idempotent).
  - uses `completeOnboardingTask` so the worker auto-activates on the last task.
    Audit `onboarding_task.completed`.

## Documents — module `documents`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/workers/:id/documents` | staff, or the worker | → `{ items: DocumentDto[] }` |
| POST | `/workers/:id/documents` | staff | `requestDocumentSchema` → 201 `DocumentDto` |
| POST | `/documents/:id/file` | staff, or the worker | `uploadDocumentSchema` → `DocumentDto` |
| GET | `/documents/:id/file` | staff, or the worker | → the file bytes |
| POST | `/documents/:id/review` | platform_admin | `reviewDocumentSchema` → `DocumentDto` |

Rules
- Requesting a new document for an `onboarding` worker re-opens `documents_verified`
  (`reopenOnboardingTask`).
- **Upload**: allowed unless the document is `verified` (`409 document_locked`). Decode the
  base64; reject > `MAX_DOCUMENT_BYTES` (`413 payload_too_large`); the first bytes must match
  the declared `mimeType` (PDF `%PDF`, PNG, JPEG signatures) else `400 invalid_file`.
  Store under `config.storageDir/<organizationId>/<random uuid>` — the storage key is
  generated by the server, never derived from `fileName`. Status → `submitted`.
  Replacing a file deletes the old one. Audit `document.uploaded`.
- **Download**: `Content-Type` = stored mime type, `Content-Disposition: attachment` with a
  sanitised file name. `404` if no file was uploaded.
- **Review**: only from `submitted` (`409 invalid_transition`). `verified` → if every
  document of that worker is now verified, `completeOnboardingTask(documents_verified)`.
  Audit `document.verified` / `document.rejected`.

## Contracts — module `contracts`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/contracts` | staff, worker | `listContractsQuerySchema` → `Paginated<ContractDto>` newest first |
| POST | `/contracts` | staff | `createContractSchema` → 201 `ContractDetailDto` |
| GET | `/contracts/:id` | staff, worker | → `ContractDetailDto` |
| PATCH | `/contracts/:id` | staff | `updateContractSchema` → `ContractDetailDto` |
| POST | `/contracts/:id/send` | staff | → `ContractDetailDto` |
| POST | `/contracts/:id/recall` | staff | → `ContractDetailDto` |
| POST | `/contracts/:id/sign` | worker | `signContractSchema` → `ContractDetailDto` |
| POST | `/contracts/:id/activate` | admin | → `ContractDetailDto` |
| POST | `/contracts/:id/void` | admin | → `ContractDetailDto` |
| POST | `/contracts/:id/terminate` | admin | → `ContractDetailDto` |

Rules
- Workers see only **their own** contracts and never `draft` or `void` ones (404).
- **Generate**: worker must be `onboarding` or `active` (`409 worker_not_eligible`). `terms`
  is a snapshot built from the worker + their country. `title` and `body` are rendered from
  a plain-text template (employee agreement vs contractor agreement) using those terms.
  A second live contract → `409 contract_exists` (from the partial unique index).
- **Edit** only while `draft` (`409 contract_not_editable`).
- **Transitions** (`CONTRACT_TRANSITIONS`): send `draft→sent` (sets `sentAt`); recall
  `sent→draft`; sign `sent→signed`; activate `signed→active`; void `draft|sent|signed→void`;
  terminate `active→terminated`.
- **Sign**: `signedByName` must equal the worker's `"First Last"` ignoring case and extra
  whitespace (`400 signature_mismatch`). Records `signedAt`, `signedByName`,
  `signedByUserId`, `signatureIp`, then `completeOnboardingTask(contract_signed)`.
- **Void** of a `signed` contract re-opens `contract_signed` if the worker is `onboarding`.
- Audit `contract.created|updated|sent|recalled|signed|activated|voided|terminated`.

## Time off — module `time-off`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/time-off/requests` | staff, worker | `listTimeOffQuerySchema` → `Paginated<TimeOffRequestDto>` newest first |
| POST | `/time-off/requests` | staff, worker | `createTimeOffRequestSchema` → 201 `TimeOffRequestDto` |
| POST | `/time-off/requests/:id/decision` | staff | `decisionSchema` → `TimeOffRequestDto` |
| POST | `/time-off/requests/:id/cancel` | staff, the worker | → `TimeOffRequestDto` |
| GET | `/time-off/balance` | staff, worker | `timeOffBalanceQuerySchema` → `TimeOffBalanceDto` |

Rules
- The target worker comes from `resolveWorkerId(actor, input.workerId)`.
- **Create** (inside a transaction that locks the worker row `FOR UPDATE`, so two
  simultaneous requests cannot both pass the checks):
  - worker must be `active` (`409 worker_not_active`) and an `employee`
    (`409 not_applicable_to_contractors`).
  - `startDate` ≥ worker `startDate` (`400 before_start_date`); start and end in the same
    calendar year (`400 spans_years`).
  - `days` = `countBusinessDays`; zero → `400 no_working_days`.
  - overlaps one of the worker's `pending`/`approved` requests → `409 overlapping_request`.
  - `vacation` only: `days` > remaining balance → `409 insufficient_balance`.
- **Balance** (year defaults to the current year): `entitlementDays` =
  `leaveEntitlementForYear` with the country's `annualLeaveDays`; `usedDays` = approved
  vacation days starting in that year; `pendingDays` likewise for pending;
  `remainingDays = entitlement − used − pending`. Contractors: all zeros.
- **Decision**: `pending → approved|rejected`, records `decidedBy/At`, `decisionNote`.
- **Cancel**: `pending|approved → cancelled`. A worker may not cancel an approved request
  whose `startDate` is today or earlier (`409 already_started`); staff may.
- Audit `time_off.requested|approved|rejected|cancelled`.

## Expenses — module `expenses`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/expenses` | staff, worker | `listExpensesQuerySchema` → `Paginated<ExpenseDto>` newest first |
| POST | `/expenses` | staff, worker | `createExpenseSchema` → 201 `ExpenseDto` |
| POST | `/expenses/:id/decision` | staff | `decisionSchema` → `ExpenseDto` |
| DELETE | `/expenses/:id` | staff, the worker | → 204 |

Rules
- Worker from `resolveWorkerId`. Worker must be `active` or `offboarding`
  (`409 worker_not_active`). `currency` = the worker's currency.
- `incurredOn` may not be in the future (`400 future_date`) nor older than
  `EXPENSE_MAX_AGE_DAYS` (`400 too_old`).
- **Decision**: `submitted → approved|rejected`; rejecting requires a `note`
  (`400 note_required`).
- **Delete** only while `submitted` (`409 invalid_transition`).
- `approved → reimbursed` is performed by the payroll module, not here.
- Audit `expense.submitted|approved|rejected|deleted`.

## Payroll — module `payroll`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/payroll/runs` | staff | `listPayrollRunsQuerySchema` → `Paginated<PayrollRunDto>` newest period first |
| POST | `/payroll/runs` | admin | `createPayrollRunSchema` → 201 `PayrollRunDetailDto` |
| GET | `/payroll/runs/:id` | staff | → `PayrollRunDetailDto` (items by worker name) |
| POST | `/payroll/runs/:id/recalculate` | admin | → `PayrollRunDetailDto` |
| DELETE | `/payroll/runs/:id` | admin | → 204 |
| POST | `/payroll/runs/:id/submit` | staff | → `PayrollRunDetailDto` |
| POST | `/payroll/runs/:id/approve` | admin | → `PayrollRunDetailDto` |
| POST | `/payroll/runs/:id/reject` | admin | `rejectPayrollRunSchema` → `PayrollRunDetailDto` |
| POST | `/payroll/runs/:id/process` | platform_admin | → `PayrollRunDetailDto` |
| POST | `/payroll/runs/:id/mark-paid` | platform_admin | → `PayrollRunDetailDto` |
| GET | `/payslips` | staff, worker | `listPayslipsQuerySchema` → `Paginated<PayslipDto>` newest first |
| GET | `/payslips/:id` | staff, worker | → `PayslipDto` |

Rules
- **Create / recalculate** (one transaction):
  - country must exist; the period may not be later than next month (`400 period_too_far`).
  - payable workers = workers of this org **and** country with status `active`,
    `offboarding` or `terminated`, for whom `grossForPeriod(...)` gives `daysWorked > 0`.
    None → `409 no_payable_workers`.
  - per worker: reimbursements = their `approved` expenses with `payrollRunId IS NULL`;
    **claim** them by setting `payrollRunId` to this run. `calculatePayslip(...)` with the
    country's rules. Store one `payroll_items` row per worker and the run totals.
  - duplicate period → `409 run_exists` (from the unique index).
  - recalculate / delete are `draft` only (`409 invalid_transition`); both first release
    claimed expenses (`payrollRunId = null`).
- `totalCostMinor` = gross + employer cost + reimbursements. `invoiceId` = the run's
  non-void invoice, if any.
- **Transitions** (`PAYROLL_RUN_TRANSITIONS`): submit `draft→pending_approval`
  (`submittedAt`); reject `pending_approval→draft` (stores `rejectionReason`); approve
  `pending_approval→approved` (clears `rejectionReason`, sets `approvedBy/At`);
  process `approved→processing`; mark-paid `processing→paid` (`paidAt`).
- **Approve** also issues the invoice **in the same transaction** (see Invoices).
- **Process** requires that invoice to be `paid` (`409 invoice_unpaid`): Meridian does not
  move money it has not received.
- **Mark paid** sets every expense claimed by the run to `reimbursed`.
- **Payslips** are `payroll_items` of `paid` runs only. Workers see only their own;
  staff may filter by `workerId`.
- Audit `payroll_run.created|recalculated|deleted|submitted|approved|rejected|processing|paid`.

## Invoices — module `invoices`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/invoices` | staff | `listInvoicesQuerySchema` → `Paginated<InvoiceDto>` newest first |
| GET | `/invoices/:id` | staff | → `InvoiceDetailDto` (lines by sortOrder) |
| POST | `/invoices/:id/pay` | admin | → `InvoiceDetailDto` |

Rules
- **Issuing** (called from payroll approve; lives in `apps/api/src/lib/invoicing.ts`):
  - always billed in **USD**. Convert each local total with `convertMinor` (which accounts
    for currencies with no minor unit, e.g. JPY)
    using `fx_rates` for the run currency; freeze that rate in `fxRate` / `localCurrency`.
    Missing rate → `409 fx_rate_missing`.
  - lines: `gross_pay`, `employer_cost` (omit if 0), `reimbursement` (omit if 0), and
    `platform_fee` = `country.monthlyFeeUsdMinor × employees` +
    `CONTRACTOR_MONTHLY_FEE_USD_MINOR × contractors` in the run.
  - `subtotalMinor` = non-fee lines; `feeMinor` = fee line; `totalMinor` = both.
  - `number` = `INV-<year>-<6-digit zero-padded nextval('invoice_number_seq')>`.
  - `dueDate` = issue date + `INVOICE_DUE_DAYS`. Status `issued`.
- **Pay** (simulated payment): `issued → paid`, sets `paidAt`. Audit `invoice.paid`.
- Audit `invoice.issued` at creation.

## Audit & dashboard — modules `audit`, `dashboard`

| Method | Path | Who | Body → Response |
| --- | --- | --- | --- |
| GET | `/audit-logs` | admin | `listAuditLogsQuerySchema` → `Paginated<AuditLogDto>` newest first |
| GET | `/dashboard` | staff | → `DashboardDto` |

Rules
- Audit logs are scoped to the tenant; `actorName` is the actor's full name (null if the
  user row is gone or the event was system-generated).
- Dashboard: `headcount` excludes `terminated`/`cancelled` workers; `byCountry` counts the
  same set, largest first; `monthlySpend` = sum of non-void invoice totals by `issuedAt`
  month for the last 6 calendar months including the current one (zero-filled, oldest
  first); `recentActivity` = the 10 newest audit entries.
