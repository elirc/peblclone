# Wave 1 — backend modules: instructions common to every builder

You are one of three engineers building backend modules of **Meridian** in parallel,
in the same working tree (`C:\Users\Owner\Desktop\peblclone`). The foundation is already
built, tested and committed. Your job is to fill in the modules named in your own brief.

## Read these first, in this order

1. `CLAUDE.md` — project rules. They are binding.
2. `docs/api-contract.md` — the sections for your modules are your specification.
3. `packages/shared/src/` — `schemas.ts`, `dto.ts`, `enums.ts`, `state-machines.ts`,
   `calc.ts`, `money.ts`, `dates.ts`, `constants.ts`. Use them; do not re-declare them.
4. `apps/api/src/db/schema.ts` — the tables (final; do not edit).
5. The reference module — copy its shape exactly:
   `apps/api/src/modules/organizations/{routes.ts,service.ts,organizations.test.ts}`
   and `apps/api/src/modules/auth/`.
6. `apps/api/src/lib/` — `actor.ts`, `errors.ts`, `http.ts`, `audit.ts`, `onboarding.ts`,
   `invites.ts` — and `apps/api/src/test/helpers.ts` (factories + clients for tests).

## Ground rules

- **Stay inside your file list.** Other engineers are editing the other modules right now.
  Never edit `packages/shared`, `apps/api/src/db`, `apps/api/src/lib/*` (unless your brief
  lists a file there), `apps/api/src/test`, `apps/api/src/app.ts`, `modules/index.ts`,
  `package.json`, or another module's folder. If something there is wrong or missing,
  work around it locally and **report it** — do not fix it.
- Each module's `routes.ts` already exists as a stub exporting the router name that
  `modules/index.ts` imports. Keep that export name.
- No `npm install`, no new dependencies, no git commands that change state, no dev servers.
- Other modules' *tables* may be read/written inside your transactions where the contract
  says so, but never import another module's code.

## Verifying your work

- Typecheck: `npx tsc -p apps/api` from the repo root. Other engineers' half-written files
  may produce errors — only errors in **your** files are yours to fix.
- Tests: from `apps/api`, with the test database named in your brief:
  `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5443/<your_db> npx vitest run src/modules/<module>`
  (bash syntax). Run only your own modules' tests. Never use another database.
- Run your suites **twice** before reporting. A suite that passes once and fails once is a
  bug in the code or the test — find it.
- Write tests the way the reference tests are written: through HTTP with the helpers;
  every test names one behaviour. Cover, per module: happy path, validation errors,
  each role's permissions, cross-tenant access → 404, worker-accessing-another-worker →
  404, and each illegal state transition → 409.

## Final report (this is what the lead reviews — be exact)

1. Files created/changed.
2. The exact commands you ran and their pass/fail counts (both runs).
3. Every place the contract was ambiguous and what you decided.
4. Anything you needed outside your file list.
5. Known gaps or shortcuts, honestly.
