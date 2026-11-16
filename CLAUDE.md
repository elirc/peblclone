# Meridian — project instructions for AI agents (and humans)

Meridian is a global-employment (Employer of Record) platform: companies hire,
onboard, pay and manage employees and contractors in other countries. This repo
is also a **teaching codebase** — clarity beats cleverness everywhere.

Read `docs/JOURNAL.md` for the story of how and why it was built.

## Layout

```
packages/shared   zod request schemas, response DTOs, enums, state machines, pure maths
apps/api          Express 5 + Drizzle ORM + Postgres   (src/modules/<name>/{routes,service}.ts)
apps/web          React 19 + Vite + Tailwind 4 + TanStack Query + React Router 7
docs/             JOURNAL.md, api-contract.md, adr/, briefs/
```

## Commands (run from the repo root unless noted)

| What | Command |
| --- | --- |
| Typecheck one package | `npx tsc -p packages/shared` / `apps/api` / `apps/web` |
| Shared unit tests | `cd packages/shared && npx vitest run` |
| API tests (one module) | `cd apps/api && npx vitest run src/modules/<name>` |
| API tests (all) | `cd apps/api && npx vitest run` |
| New migration after editing schema.ts | `npm run db:generate -- --name <what_changed>` |
| Apply migrations / seed dev DB | `npm run db:migrate` / `npm run db:seed` |
| Run everything | `npm run dev` (API :4000, web :5173) |

Postgres 18 runs on **localhost:5443** (user/password `postgres`). Databases:
`meridian_dev`, `meridian_test` (+ `meridian_test_a|b|c` for parallel agents).
Tests pick their database from `TEST_DATABASE_URL`.

## Non-negotiable rules

1. **Contract first.** Request shapes are zod schemas in `packages/shared/src/schemas.ts`;
   response shapes are DTO interfaces in `dto.ts`; endpoints and business rules are in
   `docs/api-contract.md`. If code and contract disagree, the contract wins — or change
   the contract first, in its own commit.
2. **Tenant isolation.** Every query on a tenant-owned table filters by
   `organizationId` taken from the `Actor` (`requireOrgId(actor)`), never from the
   request body/query. A record in another tenant is a **404**, not a 403.
3. **Routes are thin; services hold the rules.** A handler parses input
   (`parseBody`/`parseQuery`/`uuidParam`), calls one service function, sends the result.
   Services take an `Actor`, never `req`/`res`.
4. **Never return a database row.** Map row -> DTO with an explicit field list.
5. **Money** is integer minor units + currency. All arithmetic goes through
   `packages/shared/src/money.ts` and `calc.ts`. No floats, no ad-hoc rounding.
6. **State changes** go through the transition tables in `state-machines.ts`
   (409 `invalid_transition` otherwise) and use a conditional
   `UPDATE … WHERE status = <expected>` so concurrent requests cannot both win.
7. **Multi-row writes run in `db.transaction`**, and every state-changing action writes
   an audit record with `recordAudit(tx, actor, …)` inside that same transaction.
8. **Errors** are thrown as `AppError` via the helpers in `lib/errors.ts`. Never
   `res.status(500)` by hand, never leak a stack trace or SQL error to the client.
9. **Modules do not import other modules.** Shared behaviour lives in `apps/api/src/lib`.
   Reading/writing another module's *table* inside your own transaction is allowed
   when the contract says so.
10. **Tests are integration tests** against real Postgres through HTTP (supertest),
    using the factories in `apps/api/src/test/helpers.ts`. Every module tests: the
    happy path, validation, permissions per role, **cross-tenant access (404)**, and
    every illegal state transition it owns.

## Style

- TypeScript strict; no `any`, no non-null `!` outside tests, no `as` casts to silence errors.
- Comments explain **why**, not what. Write them for a junior engineer reading the file cold.
- Reference implementation to copy the shape of: `apps/api/src/modules/organizations/`
  (routes + service + tests) and `apps/api/src/modules/auth/`.
- No new dependencies without asking. No `console.log` (use `logger`).

## Working as a delegated agent

- You own only the files listed in your brief. If you need a change outside them,
  **do not make it** — describe it in your final report.
- Do not run `npm install`, do not commit, do not start dev servers.
- Run only your own test files, against the test database named in your brief.
- Report: files written, exact commands run, pass/fail counts, and anything in the
  contract you found ambiguous or had to interpret.
