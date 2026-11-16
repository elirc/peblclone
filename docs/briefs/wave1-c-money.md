# Wave 1 · Builder C — "Money": payroll, invoices, audit log, dashboard

Read `docs/briefs/wave1-common.md` first; everything there applies.

**Test database:** `meridian_test_c`

## You own (create/edit only these)

```
apps/api/src/modules/payroll/     routes.ts, service.ts, payroll.test.ts
apps/api/src/modules/invoices/    routes.ts, service.ts, invoices.test.ts
apps/api/src/modules/audit/       routes.ts, service.ts, audit.test.ts
apps/api/src/modules/dashboard/   routes.ts, service.ts, dashboard.test.ts
apps/api/src/lib/invoicing.ts     (issueInvoiceForRun — called by payroll approve)
```

## Specification

`docs/api-contract.md` sections **Payroll**, **Invoices**, **Audit & dashboard**. Implement
every row of every table and every rule.

## Things that are easy to get wrong

- Your tests need workers and expenses. Other builders are writing those modules at the
  same time, so **do not call their endpoints in your tests**. Use `createWorker(...)` from
  `test/helpers.ts` and insert `expenses` rows directly with `db.insert(expenses)`.
- **All maths comes from shared `calc.ts`** (`grossForPeriod`, `calculatePayslip`) and
  `money.ts` (`convertMinor`). Do not re-implement any arithmetic. Run totals are sums of
  the item rows — assert in tests that `run.grossMinor === sum(items.grossMinor)` etc.
- Write at least one test with **hand-computed expected numbers** for a German employee on
  €60,000/yr (the default factory worker) for a full month, using the DE rules in
  `apps/api/src/db/reference-data.ts`, and one for a mid-month starter (proration).
- **Expense claiming**: create/recalculate set `expenses.payrollRunId`; delete/recalculate
  release them; mark-paid flips them to `reimbursed`. Test that an expense claimed by one
  run is not picked up by a second run, and is released when the draft is deleted.
- **Duplicate period** → rely on the unique index + `isUniqueViolation`, → `409 run_exists`.
  Test with two concurrent creates (`Promise.all`): exactly one 201, one 409.
- **Approve issues the invoice in the same transaction** via `issueInvoiceForRun(tx, run,
  actor)` in `lib/invoicing.ts`. If invoicing throws (e.g. FX rate missing), the run must
  still be `pending_approval` afterwards — test that by deleting the fx rate row in the test
  (and restore it in a `finally`, since reference data is not reset between tests).
- **Invoice numbers** come from `nextval('invoice_number_seq')` (`sql` template), never from
  counting rows.
- **Process** is blocked until the invoice is `paid`. The full chain to test end to end:
  create → submit → approve (invoice issued) → pay invoice → process → mark-paid →
  payslips visible to the worker; and a worker cannot see another worker's payslip (404).
- Role matrix matters here: manager can submit but not approve; client admin cannot
  process/mark-paid; worker gets 403 on all run endpoints.
- **Dashboard** queries must all be tenant-filtered; test with two tenants that numbers do
  not bleed across. `monthlySpend` is always exactly 6 entries.
