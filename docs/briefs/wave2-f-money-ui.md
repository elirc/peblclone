# Wave 2 · Builder F — "Money UI": payroll, invoices, payslips, team, settings, audit, organizations

Read `docs/briefs/wave2-common.md` first; everything there applies.

## You own (create/edit only these)

```
apps/web/src/api/payroll.ts         runs + payslips
apps/web/src/api/invoices.ts
apps/web/src/api/organization.ts    organization, team, invites, admin organizations
apps/web/src/api/audit.ts
apps/web/src/pages/payroll/         PayrollRunsPage.tsx, PayrollRunDetailPage.tsx (+ helpers, tests)
apps/web/src/pages/invoices/        InvoicesPage.tsx, InvoiceDetailPage.tsx (+ helpers, tests)
apps/web/src/pages/payslips/        PayslipsPage.tsx (+ helpers)
apps/web/src/pages/settings/        TeamPage.tsx, OrganizationSettingsPage.tsx (+ helpers)
apps/web/src/pages/audit/           AuditLogPage.tsx
apps/web/src/pages/admin/           OrganizationsPage.tsx
```

Contract sections: **Payroll**, **Invoices**, **Organization & team**, **Audit &
dashboard** (audit only), and `GET /countries` for the create-run country picker (write
your own small hook for it in `api/payroll.ts`; do not import another builder's api file).

## Pages

**PayrollRunsPage** (`/payroll`) — `GET /payroll/runs` with status + country filters,
pagination. Columns: period (`formatPeriod(year, month)` from shared), country, workers,
total cost (`formatMoney(totalCostMinor, currency)`), status badge. Row click → detail.
Admins get "New payroll run": modal with country, year, month (default: current month) →
`POST /payroll/runs` → navigate to detail. Show `409 run_exists`, `409 no_payable_workers`,
`400 period_too_far` with their messages.

**PayrollRunDetailPage** (`/payroll/:id`) — `GET /payroll/runs/:id`. This is the most
important screen in the product; make the state and the next step unmistakable.
- A **stepper** across the top: Draft → Pending approval → Approved → Processing → Paid,
  current step highlighted.
- A "what happens next" callout that changes with status and role, e.g. approved + invoice
  unpaid → "Waiting for invoice INV-… to be paid" with a link to the invoice; processing →
  "Meridian is paying your team".
- Totals: gross, employer costs, reimbursements, **total cost**, deductions, net to workers.
- Items table: worker (+ type badge), days worked / days in period (flag proration when
  they differ), gross, deductions, employer cost, reimbursements, net. Each row expands (or
  opens a modal) to show the deduction and employer-cost lines with rates.
- If `rejectionReason` is set on a draft, show it prominently.
- Actions, driven by `PAYROLL_RUN_TRANSITIONS` + role per the contract:
  draft → Recalculate, Delete (admin), Submit for approval (staff);
  pending_approval → Approve (admin, confirm: explain that approving issues an invoice),
  Reject (admin, requires a reason);
  approved → Process (platform admin only; if the API answers `409 invoice_unpaid`, show
  it); processing → Mark paid (platform admin only).
  After approve, invalidate invoices and dashboard too.

**InvoicesPage** (`/invoices`) — `GET /invoices`, status filter, pagination. Columns:
number, issued, due, total (USD, right-aligned), status. Row click → detail.

**InvoiceDetailPage** (`/invoices/:id`) — `GET /invoices/:id`. Laid out like an invoice:
number, bill-to (`organizationName`), issued / due dates, status badge; line items table;
subtotal, fee, **total**; a note of the FX rate used (`1 USD = <fxRate> <localCurrency>`)
when the local currency is not USD; link to the payroll run. Admins on an `issued` invoice
get "Pay invoice" (confirm; make clear it is a simulated payment) → `POST /invoices/:id/pay`;
invalidate invoices, payroll, dashboard. Add a "Print" button (`window.print()`).

**PayslipsPage** (`/payslips`) — `GET /payslips`. Workers see their own; staff see all and
can filter by worker (your own small `GET /workers` hook, `limit: 100`). Columns: period,
(worker — staff only), gross, deductions, net, paid date. Clicking opens a payslip modal:
earnings (gross), each deduction line with rate, reimbursements, **net pay**, and for
staff the employer-cost lines.

**TeamPage** (`/team`) — `GET /team`; admins also `GET /team/invites`. Members table: name,
email, role, active badge. Admins: "Invite teammate" (modal, `createTeamInviteSchema`; on
success show the `acceptUrl` with a Copy button and the note that no email is sent), change
role, deactivate / reactivate (confirm) via `PATCH /team/:id` — not available on your own
row (`400 cannot_modify_self` exists server-side; hide the controls for self). Pending
invites list with Revoke.

**OrganizationSettingsPage** (`/settings`, admin) — `GET /organization` → form (name, legal
name, billing email, country) → `PATCH /organization`.

**AuditLogPage** (`/audit`, admin) — `GET /audit-logs`, pagination, optional entity-type
filter. Columns: when, who (`actorName` or "System"), action (`humanize`), entity, and a
compact rendering of `metadata` (key: value pairs; never raw JSON dumps of nested objects
without truncation).

**OrganizationsPage** (`/admin/organizations`, platform admin) — `GET /admin/organizations`.
Table: name, country, billing email, workers, created. Each row has "Work in this
organization" → `useAuth().setActingOrg(org.id)` then navigate to `/`. Explain at the top
that platform admins pick a client organization to act inside.

## Tests (at least)

- `PayrollRunDetailPage.test.tsx`: a client admin on a `pending_approval` run sees
  Approve/Reject and not Process; a platform admin on an `approved` run sees Process;
  a manager on a `draft` sees Submit but not Delete; totals render formatted money.
- `InvoiceDetailPage.test.tsx`: lines and totals render; Pay is offered only on `issued`
  to admins; confirming Pay posts to `/invoices/:id/pay`.
