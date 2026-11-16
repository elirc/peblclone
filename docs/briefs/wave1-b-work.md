# Wave 1 · Builder B — "Work": contracts, time off, expenses

Read `docs/briefs/wave1-common.md` first; everything there applies.

**Test database:** `meridian_test_b`

## You own (create/edit only these)

```
apps/api/src/modules/contracts/   routes.ts, service.ts, template.ts, contracts.test.ts
apps/api/src/modules/time-off/    routes.ts, service.ts, time-off.test.ts
apps/api/src/modules/expenses/    routes.ts, service.ts, expenses.test.ts
```

## Specification

`docs/api-contract.md` sections **Contracts**, **Time off**, **Expenses**. Implement every
row of every table and every rule.

## Things that are easy to get wrong

- Your tests need workers. Builder A is writing the workers module at the same time, so
  **do not call `/workers` endpoints in your tests** — use the factories
  `createWorker(org.id, overrides, { withTasks })` and `loginAsWorker(worker)` from
  `test/helpers.ts`.
- **Contract template** (`template.ts`): a pure function `renderContract(terms) ->
  { title, body }`. Plain text, sections numbered, money formatted with `formatMoney`.
  Two variants: employee agreement and independent contractor agreement. Unit-test it
  directly as well as through HTTP.
- **Live-contract uniqueness** is enforced by the partial unique index
  `contracts_one_live_per_worker`; translate that violation (`isUniqueViolation`) into
  `409 contract_exists` — do not rely on a SELECT-then-INSERT check.
- **Every transition** is a conditional `UPDATE … WHERE id = ? AND organization_id = ? AND
  status = <from>` in a transaction; zero rows updated → work out whether it is a 404 or a
  `409 invalid_transition`.
- **Signing** is worker-only (a client admin must get 403), own-contract-only (404), and
  calls `completeOnboardingTask(tx, workerId, 'contract_signed', actor.userId)`. Test that
  signing the contract of a worker whose other tasks are already complete activates them.
  `signatureIp` comes from `req.ip` passed into the service as a plain string.
- **Time off** create must lock the worker row (`.for('update')`) before the overlap and
  balance checks. Write a test that fires two overlapping requests concurrently
  (`Promise.all`) and asserts exactly one 201 and one 409.
- Dates: use the helpers in shared `dates.ts`. "Today" = `toIsoDate(new Date())`.
  For tests that depend on today, compute dates relative to today rather than hard-coding.
- **Expenses**: `payrollRunId` is managed by the payroll module (Builder C). You only set
  status. An expense with a non-null `payrollRunId` must not be deletable.
