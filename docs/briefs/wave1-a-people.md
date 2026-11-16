# Wave 1 · Builder A — "People": countries, quotes, workers, onboarding, documents

Read `docs/briefs/wave1-common.md` first; everything there applies.

**Test database:** `meridian_test_a`

## You own (create/edit only these)

```
apps/api/src/modules/countries/   routes.ts, service.ts, countries.test.ts
apps/api/src/modules/workers/     routes.ts, service.ts, workers.test.ts
apps/api/src/modules/documents/   routes.ts, service.ts, storage.ts, documents.test.ts
```

## Specification

`docs/api-contract.md` sections **Countries & quotes**, **Workers & onboarding**,
**Documents**. Implement every row of every table and every rule.

## Things that are easy to get wrong

- **Hire is one transaction**: worker + tasks + requested documents + invitation + audit.
  If any step fails nothing is left behind. Test that a duplicate email leaves no stray
  tasks/documents.
- **Search** must escape `%` and `_` in user input before `ILIKE`.
- `WorkerDto.countryName` comes from a join on `countries`.
- **Worker transitions** use a conditional update (`WHERE status = <from>`) inside a
  transaction; the side effects on `contracts` / `invitations` are in the same transaction.
- **Task completion** must go through `completeOnboardingTask` (`lib/onboarding.ts`) so
  auto-activation happens. Test: completing the last pending task flips the worker to
  `active`.
- **Documents / file storage** (`storage.ts`): write/read/delete by an opaque server-generated
  key under `config.storageDir`. Never build a path from user input. Verify magic bytes.
  `fs/promises` only. Create directories on demand. Tests should upload a tiny real PDF
  header (`%PDF-1.4\n…`) / PNG signature and assert download returns the same bytes; assert
  a `.pdf`-declared file with PNG bytes is refused; assert the size limit with a buffer just
  over `MAX_DOCUMENT_BYTES`.
- **Document review** is platform-admin only; use `createPlatformAdmin(org.id)` in tests.
  Verifying the last outstanding document completes `documents_verified`.
- A worker-role user hitting any staff-only endpoint → 403; hitting another worker's
  record → 404. Test both.
