# ADR 0002 — Shared schema multi-tenancy with `organization_id` on every tenant table

**Status:** accepted

## Context
Many client organizations share one database. Leaking one tenant's data to another is the
most damaging class of bug this product can have.

Options considered:
1. Database per tenant — strongest isolation; heavy to operate, migrate and query across.
2. Shared schema, tenant id only on root tables — fewer columns; child tables need joins
   to be filtered, so the rule has exceptions.
3. Shared schema, tenant id on **every** tenant-owned table.
4. Option 3 plus Postgres row-level security (RLS).

## Decision
Option 3. Every tenant-owned table has `organization_id NOT NULL`, and every query filters
on it using the id from the server-side `Actor`. A record in another tenant answers `404`.

## Consequences
- The rule is uniform: "filter by `organization_id`", no exceptions to remember.
- Some redundancy (a child row repeats its parent's tenant id). Accepted.
- Enforcement is by convention plus tests: every module must have a cross-tenant test.
- RLS (option 4) would add a second, database-level guarantee and is the natural next
  hardening step. It was deferred because it complicates connection handling (the tenant
  must be set per transaction) beyond what this teaching codebase should carry on day one.
