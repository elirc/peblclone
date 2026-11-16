# ADR 0001 — Monorepo with a shared contract package

**Status:** accepted

## Context
The API and the web app must agree on request shapes, response shapes, enums and money
maths. In separate repositories that agreement is maintained by hand and drifts.

## Decision
One repository using npm workspaces: `packages/shared`, `apps/api`, `apps/web`.
`packages/shared` exports TypeScript **source** (`"main": "./src/index.ts"`), with no build
step. The API runs it through `tsx`; the web app through Vite.

## Consequences
- A contract change that breaks a consumer fails that consumer's typecheck in the same commit.
- No "rebuild shared, then restart" loop during development.
- The API cannot be run with plain `node` — it needs `tsx` (or a bundling step for
  production). Accepted for now; noted as a deployment task.
- Everything shares one lockfile, so one dependency version across the repo.
