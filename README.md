# Meridian

A global-employment (Employer of Record) platform — hire, onboard, pay and manage
employees and contractors in other countries — built as a **teaching codebase**.

The real product of this repository is **[docs/JOURNAL.md](docs/JOURNAL.md)**: a detailed
engineering journal of how a senior engineer directed AI agents to build it, written for a
junior engineer to follow along. Start there.

## Stack

TypeScript everywhere · Node 22 + Express 5 · Postgres 18 + Drizzle ORM · zod ·
React 19 + Vite + React Router + TanStack Query + Tailwind 4 · Vitest.

```
packages/shared   request schemas, response DTOs, enums, state machines, pure payroll maths
apps/api          REST API   (src/modules/<name>/{routes,service}.ts)
apps/web          single-page app
docs/             JOURNAL.md · api-contract.md · adr/ · briefs/
```

## Run it

Prerequisites: Node 22+, a Postgres 16+ server.

```bash
cp .env.example .env            # adjust DATABASE_URL / TEST_DATABASE_URL if needed
createdb meridian_dev && createdb meridian_test
npm install
npm run db:migrate
npm run db:seed                 # demo company, workers, payroll history
npm run dev                     # API on :4000, web on :5173
```

Demo logins (password for all: `meridian-demo-1`):

| Role                            | Email                     |
| ------------------------------- | ------------------------- |
| Client admin                    | `admin@acme.test`         |
| Client manager                  | `manager@acme.test`       |
| Worker (active)                 | `lena.fischer@acme.test`  |
| Worker (onboarding)             | `diego.ramirez@acme.test` |
| Platform admin (Meridian staff) | `ops@meridian.test`       |

## Verify it

```bash
npm run typecheck
npm test                        # shared unit + API integration (real Postgres) + web component tests
npm run build
```

## Documents

- [docs/JOURNAL.md](docs/JOURNAL.md) — the build, step by step, with the reasoning.
- [docs/dotnet-rewrite/](docs/dotnet-rewrite) — a second journal: how this would have been designed and built on
  C# and .NET, what would change and what would not. A proposal only; nothing there is built.
- [docs/userstories/](docs/userstories) — twenty practice tasks for a junior or mid-level engineer, each with
  step-by-step implementation instructions. Not implemented: they are for you to do.
- [docs/api-contract.md](docs/api-contract.md) — every endpoint and business rule.
- [docs/adr/](docs/adr) — architecture decision records.
- [docs/briefs/](docs/briefs) — the briefs given to each builder agent, verbatim.
- [CLAUDE.md](CLAUDE.md) — standing instructions for AI agents working in this repo.

## Scope and honesty

Statutory rates are **illustrative teaching data, not tax advice**. Payments are simulated
("mark paid" is a button, not a bank transfer). No emails are sent — invitation links are
shown on screen. The journal's known-gaps list says what a production system would still need.
