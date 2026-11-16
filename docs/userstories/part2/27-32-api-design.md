# Stories 27–32 — API design

Not implemented. See the [part 2 index](README.md) for how to use these.

The theme of this group: **an API is a promise to callers you cannot see or control.**
They retry, they page through data while it changes, they keep using a field you want to
rename, and they send you a thousand rows at once. Good API design is mostly about
behaving sensibly when callers do those things.

---

## US-27 — Safe retries for payments

> As an integrator, I want to retry "pay invoice" after a network timeout without any
> risk of paying twice, so that my automation can be reliable.

### Acceptance criteria

- Mutating endpoints accept an `Idempotency-Key` header.
- Repeating a request with the same key returns the **original response** — same status,
  same body — without performing the action again.
- The same key with a *different* request body is refused (`422 idempotency_key_reused`).
- Two identical requests arriving at the same moment perform the action once.
- Keys expire after 24 hours.

### The concept: you cannot tell "failed" from "succeeded but I did not hear"

A client sends `POST /invoices/123/pay`. The connection drops. Did the payment happen?

The client **cannot know**. The request may have been lost on the way there (nothing
happened) or the response lost on the way back (it happened). The only safe thing a
client can do is retry — and if the first one did succeed, the retry pays twice.

Some operations are naturally safe to repeat — **idempotent**: `GET`, `PUT` ("set the
name to X"), `DELETE`. Doing them twice leaves the same state as once. `POST` generally
is not: "create a payment" twice creates two.

An **idempotency key** makes an unsafe operation safe. The client generates a unique id
for the *intent* ("this particular payment") and sends it with every attempt. The server
remembers what it did for each key and replays the result instead of repeating the work.

### The design decision

Notice first that this codebase already has **natural idempotency** in places, and that
is usually the better tool:

- paying an already-paid invoice → `409 invalid_transition` (the state machine);
- creating a second payroll run for the same period → `409 run_exists` (a unique index);
- completing an already-completed task → returns it unchanged.

The state machine and the constraints already prevent double *effects*. What they do not
do is give the retrying client the *same answer*: the retry gets a `409` and the client
has to work out that "conflict" means "your first attempt worked". Idempotency keys make
the retry indistinguishable from the first success.

| Question | Options | Recommendation |
| --- | --- | --- |
| Where to store keys | Postgres table; Redis | **Postgres**, in the same transaction as the action — otherwise the action can commit and the key record be lost |
| What to store | just "seen"; the full response | Status + body, so the retry can replay it |
| Scope of a key | global; per user; per (user, endpoint) | Per **(user, method, path)** — a key is one caller's intent for one operation |
| Detecting misuse | ignore; hash the request body | Store a hash of the body; a mismatch means the client reused a key for something else → `422` |
| In-flight duplicates | let both run; lock | Insert the key row *first*; the second insert conflicts → wait or `409` |
| Required? | always; opt-in | Opt-in per endpoint, required only where a duplicate costs money |

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — an `idempotency_keys` table (tenant-owned: add it to
  `TENANT_TABLES` in `test/cleanup.ts`).
- `apps/api/src/middleware/` — this is cross-cutting, so it is a middleware or a helper
  wrapped around a handler, not code in each service.
- `apps/api/src/modules/invoices/routes.ts` — `POST /invoices/:id/pay` is the first
  customer; then payroll approve.
- `apps/web/src/lib/api.ts` — the client could send a key for mutations automatically.

### Hints

1. The order of operations is the whole design. Inside **one transaction**:
   insert the key row (unique on user + method + path + key) → run the action → store
   the response on that row → commit. If the action throws, the transaction rolls back
   and the key row vanishes with it, so the client may retry. That is correct: a failed
   attempt should be retryable.
2. The existing services open their own transactions (`db.transaction` inside
   `payInvoice`). To share one, the service must be able to *join* a transaction. Look at
   how `issueInvoiceForRun(tx, …)` accepts a `tx` — that is the pattern. This refactor is
   the real work of the story.
3. On a duplicate key: load the stored row. Body hash differs → `422`. Response stored →
   replay it. Response not stored yet → the first request is still running: return
   `409 request_in_progress` and let the client retry shortly.
4. Decide which responses are worth storing. A `400 validation_error` is deterministic —
   replaying it is harmless. A `500` should not be stored; the client should be able to
   try again.
5. Expiry: a sweeper like `deleteExpiredSessions` in `server.ts`.
6. Do not store secrets in the saved response body. Check what your endpoints return.

### How to test it

- Same key twice, sequentially: one invoice paid, two identical 200 responses, **one**
  `invoice.paid` audit row.
- Same key twice with `Promise.all`: still one audit row.
- Same key, different body → 422.
- An action that fails validation, then succeeds on retry with the same key and a fixed
  body… decide what should happen, and test your decision.
- Different users with the same key do not collide.

### What goes wrong

- Writing the key in a **separate** transaction from the action. A crash between the two
  leaves either a paid invoice with no key (retry pays again) or a key with no payment
  (retry is refused forever).
- Caching `500`s.
- Treating the key as authentication. It is not a secret and proves nothing.

### Questions to be able to answer

- Why must the key and the action commit together?
- When is a unique constraint enough, and when do you need idempotency keys as well?
- Who generates the key, and why not the server?

---

## US-28 — Cursor pagination for the audit log

> As an auditor scrolling back through a year of events, I want paging to stay fast and
> never skip or repeat an entry, even while new events are being recorded.

### Acceptance criteria

- `GET /audit-logs` supports `?after=<cursor>&limit=`; the response includes
  `nextCursor` (null on the last page).
- Paging through the whole log visits every entry exactly once, even if entries are
  added during paging.
- Page 1,000 is as fast as page 1.
- The cursor is opaque to clients.
- Existing `offset` paging keeps working (or is removed deliberately — see US-29).

### The concept: why OFFSET is both slow and wrong

`LIMIT 25 OFFSET 10000` tells the database: produce 10,025 rows in order, throw away
10,000, return 25. The cost grows with the page number. That is the *slow* part.

The *wrong* part is subtler. The audit log is newest-first and new rows keep arriving.
You load page 1 (rows 1–25). Three events are recorded. You load page 2 — "skip 25, take
25" — but everything has shifted down by three, so you see three rows from page 1
*again*. With deletes it goes the other way and rows are **skipped**. For an audit log,
silently skipping entries is not a cosmetic problem.

**Keyset pagination** (also called cursor or seek pagination) replaces "skip N" with
"continue after *this row*":

```sql
-- page 1
SELECT … ORDER BY created_at DESC, id DESC LIMIT 25;
-- next page: everything strictly after the last row you saw
SELECT … WHERE (created_at, id) < ($lastCreatedAt, $lastId)
         ORDER BY created_at DESC, id DESC LIMIT 25;
```

The database jumps straight to that position using the index. Cost no longer depends on
depth, and rows added at the top cannot shift what comes after your position.

### The design decision

| Question | Answer |
| --- | --- |
| What is the sort key? | It must be **unique and stable**. `created_at` alone is neither — rows written in one transaction share a timestamp (the audit service even has a comment saying so). Hence `(created_at, id)` |
| What is in the cursor? | The sort key of the last row: `{ createdAt, id }`, base64url-encoded JSON |
| Is the cursor trusted? | **No.** It comes from the client. Parse and validate it like any input; a malformed cursor is a `400`. It never contains or replaces the tenant filter |
| Total count? | Keyset paging cannot cheaply give "page 7 of 312". Either drop `total` or compute it separately and accept the cost. Infinite scroll / "Load more" does not need it |
| Jump to page N? | Not possible with a cursor. That is the trade: you give up random access to get speed and correctness |
| Response shape | `Paginated<T>` has `total`/`offset`. Add a second shape, e.g. `CursorPage<T> = { items, nextCursor }`, rather than overloading the first |

### Where it touches this codebase

- `apps/api/src/modules/audit/service.ts` — already orders by
  `desc(createdAt), desc(id)`; the tie-break you need is there.
- `apps/api/src/db/schema.ts` — `audit_logs_org_created_idx` is on
  `(organization_id, created_at)`. Does it serve `(organization_id, created_at, id)`
  ordering? Check with `EXPLAIN` (see part 1, US-18).
- `packages/shared/src/schemas.ts`, `dto.ts` — the query schema and a new page type.
- `apps/web/src/pages/audit/AuditLogPage.tsx` + `components/ui/Table.tsx`'s `Pagination`
  — a "Load more" button, and TanStack Query's `useInfiniteQuery`.

### Hints

1. **Row-value comparison**: Postgres supports `(a, b) < (x, y)` directly, and it means
   exactly "a < x, or a = x and b < y". It also lets the planner use a composite index.
   In Drizzle you will likely need a `sql` template for it.
2. Fetch `limit + 1` rows. If you get the extra one, there is a next page — return
   `limit` rows and build `nextCursor` from the last one you *return*. This avoids a
   separate "is there more?" query.
3. Timestamp precision is a trap. Postgres stores microseconds; a JavaScript `Date` has
   milliseconds. Round-trip `created_at` through a `Date` in your cursor and the
   comparison can skip or repeat rows that share a millisecond. Carry the timestamp in
   the cursor as the **text Postgres gave you**, not as a `Date`.
4. Filters and cursors: a cursor is only valid for the filter set it was issued with.
   Simplest robust approach: the client resets the cursor whenever a filter changes
   (US-12 added filters).
5. Opaque does not mean encrypted. Base64 is enough to signal "do not build these
   yourself". Never put anything in a cursor you would mind the client reading.

### How to test it

- Insert 60 rows; page with limit 25; collect ids; assert 60 unique ids in the right
  order and `nextCursor === null` at the end.
- Insert rows **between** page fetches; assert no id appears twice and none of the
  original 60 is missing.
- Several rows with an identical `created_at` (insert them in one transaction): none
  skipped. This is the test that fails without the `id` tie-break.
- A garbage cursor → 400, not 500.
- A cursor from tenant A used by tenant B returns only B's rows.

### What goes wrong

- Sorting by a non-unique key.
- Losing microseconds (hint 3) — a bug that appears only under load.
- Believing the cursor: if it carried `organizationId`, a client could page another
  tenant.

### Questions to be able to answer

- Why can offset paging skip rows, in one sentence?
- What did you give up by moving to cursors, and why is that acceptable for *this* list
  but perhaps not for the People list?

---

## US-29 — Rename a field without breaking clients

> As the API's maintainer, I want to rename `salaryMinor` to `compensationMinor` on the
> worker resource, so that the name is accurate for contractors — without breaking the
> web app or any integration for even one deploy.

### Acceptance criteria

- At every point during the change, old clients and new clients both work.
- The change ships as a sequence of small, individually safe deploys.
- There is a written deprecation: what is changing, by when, and how clients are told.
- At the end, the old name is gone from the code, the contract and the database.

### The concept: expand, migrate, contract

You cannot change a server and all its clients at the same instant. During a deploy, old
and new servers run side by side; browsers hold JavaScript loaded an hour ago; an
integration partner upgrades next quarter. So **any change that requires both sides to
switch together is a breaking change**, no matter how small.

The technique that avoids it has three phases, each safe on its own:

```
1. EXPAND    add the new thing alongside the old.   Server speaks both.
2. MIGRATE   move every client to the new thing.    Old still works.
3. CONTRACT  remove the old thing.                  Only when nobody uses it.
```

For a response field: return **both** names → switch readers → stop returning the old.
For a request field: **accept** both → switch writers → stop accepting the old.
For a database column: add new → write both → backfill → read new → drop old.

It feels slow. It is the only way to change a live system without downtime, and it turns
one scary change into several boring ones. (The .NET journal's migration chapter uses the
same idea at the scale of a whole backend.)

### The design decision

| Question | Recommendation |
| --- | --- |
| Rename the database column too? | It is a separate decision. An API name and a column name are different promises (that is what the DTO mapper is for). Do the API first; do the column only if the confusion is worth another three-phase change |
| How do clients learn about it? | A `Deprecation` response header on affected endpoints, an entry in the contract, and a date |
| How do you know nobody uses the old name? | **Measure.** Log or count requests that send the old field. "Probably nobody" is not evidence |
| Both names sent with different values? | Refuse with `400` — do not guess which one the client meant |
| Do you need `/api/v2`? | No. A new version is for changes that cannot be made compatibly. Adding a field and later removing a deprecated one can |

### Where it touches this codebase

- `packages/shared/src/dto.ts` (`WorkerDto`), `schemas.ts` (`createWorkerSchema`,
  `updateWorkerSchema`).
- `apps/api/src/modules/workers/service.ts` — `toWorkerDto`, `createWorker`,
  `updateWorker`.
- Every reader in `apps/web` — find them with the compiler, not with search.
- `apps/api/src/db/seed.ts` and the journey test also send `salaryMinor`.
- `docs/api-contract.md`.

### Hints

1. **Phase 1 commit.** DTO gains `compensationMinor` next to `salaryMinor`, both filled
   from the same column. Request schemas accept either (zod: make both optional and add a
   `refine` requiring exactly one, then a `transform` to a single internal name). Mark
   the old one `/** @deprecated use compensationMinor */` — editors will strike it
   through at every use.
2. **Phase 2 commits.** Move the web app, seed and tests to the new name. Because the old
   property is marked deprecated, `tsc` plus an ESLint rule — or simply temporarily
   deleting the old field from the type — lists every remaining use.
3. **Phase 3 commit.** Remove the old name from the DTO and stop accepting it. In this
   repository all clients live in one place, so phases can follow each other quickly. In
   real life phase 3 waits until your measurement says usage is zero.
4. Each phase must leave `npm test` green *on its own*. If phase 1 needs phase 2 to pass,
   it was not really an expand.
5. Write the deprecation note as if for a partner who has never met you: what, why, what
   to change, by when.

### How to test it

- After phase 1: a request with the old name works; with the new name works; with both
  and different values → 400. Responses contain both.
- After phase 3: the old name in a request is rejected (or ignored — decide, and say why;
  note that these schemas currently strip unknown keys rather than rejecting them).
- The journey test passes after every phase.

### What goes wrong

- Doing it in one commit "because it is just a rename".
- Removing the old field while a cached browser bundle still reads it — the page shows
  `NaN` for every salary.
- Silently ignoring an unknown field: a client sending the old name after phase 3 gets a
  `200` and nothing changes. Think hard about whether that is acceptable.

### Questions to be able to answer

- Why is a rename a breaking change even though "nothing changed"?
- What is your evidence that it is safe to contract?
- Which changes are *always* safe to make to a JSON API, and which never are?

---

## US-30 — Bulk hire from a spreadsheet

> As an HR manager opening a new office, I want to upload a spreadsheet of forty new
> hires and have them all created, so that I do not fill in the hire form forty times.

### Acceptance criteria

- An endpoint accepts up to 200 hires in one request.
- Every row is validated; the response reports **all** problems, by row and field, not
  just the first.
- Either every row is created or none is.
- A "dry run" mode validates without creating anything.
- Each created worker gets the same treatment as a single hire: checklist, requested
  documents, audit record, optional invite.

### The concept: batch semantics

A single hire either works or fails. A batch has a third outcome — *some* work — and you
must decide, up front, what that means.

| Semantics | Behaviour | Good for |
| --- | --- | --- |
| **All-or-nothing** | One bad row rejects the whole batch | Data that must be consistent; simple to reason about |
| **Partial success** | Good rows go in; bad rows are reported | Huge imports where re-uploading everything for one typo is unreasonable |

Partial success sounds friendlier and creates a hard follow-up problem: the user fixes
row 17 and uploads the file again — and now 39 workers exist twice (or 39 rows fail on
the duplicate-email rule and the report is a wall of red). All-or-nothing with a **good
error report** is nearly always the better start: nothing happened, here is exactly what
to fix, upload again.

The second idea is **validate everything, then act**. Stopping at the first error makes
the user fix forty problems across forty uploads.

### The design decision

| Question | Options | Recommendation |
| --- | --- | --- |
| Input format | JSON array; CSV upload | **JSON array** to the API; parse the spreadsheet in the browser. The API stays simple and strictly validated; CSV dialect problems stay on the client |
| Validation layers | schema only; schema + database | Three passes: (1) each row against `createWorkerSchema`; (2) rules *within the file* — duplicate emails; (3) rules against the database — email already a worker, unknown country |
| Transaction | one for all; one per row | **One for all.** That is what all-or-nothing means |
| Size limit | none; fixed | Fixed (200). An unbounded batch is a way to hold a transaction open for minutes |
| Error shape | first error; all errors | All, keyed by row index: `{ "3": { "email": ["…"] }, "17": { … } }` |
| Synchronous? | yes; background job | Yes at this size. Past a few thousand rows it becomes a job (US-39) |

### Where it touches this codebase

- `apps/api/src/modules/workers/service.ts` — `createWorker` opens its own transaction
  and does the whole hire. A bulk version needs the body of that function to run
  **inside a transaction it is given**. Splitting it into "hire one worker within `tx`"
  plus a thin wrapper is the core refactor (the same one US-27 needs).
- `packages/shared/src/schemas.ts` — `z.array(createWorkerSchema).min(1).max(200)`.
- `apps/api/src/lib/errors.ts` — `validationError` takes `Record<string, string[]>`;
  decide how to key row-level errors (e.g. `"3.email"`), which `parseBody`'s existing
  path-joining already produces for arrays.
- `apps/api/src/app.ts` — the JSON body limit is 8 MB; 200 rows is nowhere near it.

### Hints

1. Refactor first, with no behaviour change: extract `hireWithin(tx, actor, input,
   country)` from `createWorker`, make `createWorker` call it, run the existing worker
   tests. Only then add the bulk endpoint. Two small steps you can verify beat one large
   one you cannot.
2. Load reference data once. Forty hires in four countries need four country lookups,
   not forty. Collect the distinct codes and fetch them in one query.
3. Check database-level duplicates in one query too (`WHERE email IN (…)`), so you can
   report them all. The unique index remains the real guard — a row that slips past your
   pre-check because of a concurrent request still fails safely, rolling back the batch.
4. Translating a constraint error to a row number is hard after the fact. That is the
   reason to pre-check: the pre-check gives good messages; the constraint gives safety.
5. Dry run: do everything, then roll back. The cleanest way is to run the real code path
   inside the transaction and throw a sentinel to abort it. That guarantees the dry run
   tests exactly what the real run will do.
6. Invites: forty accept-URLs in one response. Return them as an array aligned with the
   input rows.

### How to test it

- 3 valid rows → 3 workers, 3 checklists, 3 audit rows.
- 3 rows, the middle one invalid → **zero** workers; the error names row 1 (zero-based)
  and the field.
- Duplicate email within the file → both rows reported.
- Email that is already a worker → reported with its row.
- Dry run with valid data → 200 and nothing in the database.
- 201 rows → 400.

### What goes wrong

- A loop of `await createWorker(...)` — forty transactions, so a failure at row 20 leaves
  19 workers behind.
- Reporting only the first error.
- No size limit.
- Forgetting that a hire also seeds tasks and documents, so the bulk path creates
  half-hired workers.

### Questions to be able to answer

- Why all-or-nothing rather than partial success?
- Why pre-check for duplicates when the unique index would catch them anyway?
- At what size does this stop being a synchronous request, and what replaces it?

---

## US-31 — Notify other systems when payroll is paid

> As a client's finance system, I want to be told when a payroll run is paid, so that I
> can post the journal entries automatically.

### Acceptance criteria

- A client admin can register a webhook URL.
- When a payroll run is marked paid, an event is delivered to that URL as an HTTP POST.
- The event is **never lost** — not if the API crashes right after the database commit —
  and never sent for a change that was rolled back.
- Failed deliveries are retried with backoff and eventually marked failed.
- Each delivery is signed so the receiver can verify it came from Meridian.

### The concept: the dual-write problem and the transactional outbox

The naive implementation:

```ts
await db.transaction(async (tx) => { /* mark run paid */ });
await fetch(webhookUrl, { … });          // tell the world
```

Two systems are being changed — the database and the outside world — and nothing makes
them agree.

- Crash between the two lines → the run is paid and **nobody is ever told**.
- Swap the order → the world is told, then the transaction fails → you announced
  something that never happened.

There is no ordering of two independent writes that is safe. This is the **dual-write
problem**, and it is one of the most important things to recognise in distributed
systems.

The **transactional outbox** removes the second write. Inside the *same transaction* that
marks the run paid, insert a row into an `outbox` table describing the event. Now there
is one write, to one system; the database guarantees both happen or neither does. A
separate *relay* process later reads undelivered rows and does the HTTP call, marking
each row done.

```
   transaction                     relay (separate, repeating)
 ┌──────────────────────┐        ┌──────────────────────────────┐
 │ UPDATE payroll_runs  │        │ SELECT undelivered events    │
 │ INSERT INTO outbox   │  ───▶  │ POST to webhook              │
 └──────────────────────┘        │ mark delivered / schedule retry │
        (atomic)                 └──────────────────────────────┘
```

Notice that this codebase already does exactly this for one consumer: **the audit log**.
`recordAudit(tx, …)` writes a row in the same transaction as the change (build journal,
chapter 8.6). An outbox is the audit log's sibling — same guarantee, but the rows are
*work to do* rather than *history to keep*.

### The design decision

| Question | Recommendation |
| --- | --- |
| Delivery guarantee | **At-least-once.** The relay can crash after the POST but before marking the row delivered, so it will send again. Exactly-once delivery over a network is not achievable; receivers must de-duplicate |
| How do receivers de-duplicate? | Every event has a unique `id`, sent in the payload and a header |
| Ordering | Not guaranteed across retries. Include a timestamp and the run's status so receivers can ignore stale events |
| Retry policy | Exponential backoff with a cap (e.g. 1m, 5m, 30m, 2h, 12h), then `failed` |
| What counts as success | A `2xx` within a short timeout. Anything else is a failure |
| Signing | HMAC-SHA256 of the raw body with a per-endpoint secret, in a header; include a timestamp to limit replay |
| Payload | Thin: event type, ids, timestamp. The receiver calls the API for details. Avoids leaking data and avoids stale payloads |

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — `webhook_endpoints`, `outbox_events` (both tenant-owned).
- `apps/api/src/modules/payroll/service.ts` — the mark-paid transition has an `after`
  hook that runs inside the transaction; that is where the event row is inserted.
- `apps/api/src/lib/` — an `emitEvent(tx, …)` helper beside `recordAudit`.
- `apps/api/src/server.ts` — the relay loop (see US-39 for doing this properly).
- `apps/api/src/lib/crypto.ts` — `generateToken` for the signing secret.

### Hints

1. Make `emitEvent` require a `Tx`, not `DbOrTx`. The type signature then makes it
   impossible to emit an event outside a transaction — the mistake this whole pattern
   exists to prevent.
2. **SSRF.** You are about to make HTTP requests to URLs supplied by users. A client
   could register `http://localhost:5443` or `http://169.254.169.254/` (a cloud metadata
   address) and use your server to reach things it should not. Require `https`, resolve
   the hostname, and refuse private, loopback and link-local addresses. This is not
   optional and is the most commonly forgotten part of every webhook feature.
3. Sign the **exact bytes** you send. If you sign an object and then serialise it again,
   key order or whitespace may differ and the receiver's check fails.
4. The relay must not be run by two instances on the same rows at once — or it must be
   safe if it is. `SELECT … FOR UPDATE SKIP LOCKED` is the standard tool (US-39).
5. Store the secret so it can be shown once at creation, like invite links. Unlike a
   password it must be recoverable by the server to compute signatures, so it cannot be
   hashed — which is why it must be a random value used for nothing else.
6. Set a timeout on the outgoing request (US-42). A receiver that never answers must not
   stall the relay.

### How to test it

- Mark a run paid → exactly one outbox row, in the same transaction (make the transition
  fail on purpose and assert there is **no** row).
- Relay against a local test HTTP server: success marks delivered; a 500 schedules a
  retry with a later `next_attempt_at`; after N failures the row is `failed`.
- The signature verifies against the body the test server received.
- A webhook URL pointing at `127.0.0.1` is refused at registration.
- Tenant A's events never go to tenant B's endpoint.

### What goes wrong

- Calling `fetch` inside the transaction: slow, and it holds a database connection and
  row locks while waiting on someone else's server.
- Calling `fetch` after the transaction with no outbox: the dual write.
- No SSRF protection.
- Infinite retries to a dead endpoint.

### Questions to be able to answer

- Why can no ordering of "commit" and "send" be made safe without an outbox?
- Why at-least-once rather than exactly-once, and what does that require of receivers?
- What does your server do if a client registers a URL that resolves to an internal
  address?

---

## US-32 — API keys for integrations

> As a client's developer, I want an API key for my payroll script, so that it can call
> the Meridian API without a person logging in through a browser.

### Acceptance criteria

- A client admin can create, list and revoke API keys.
- A key is shown **once**, at creation.
- A key carries scopes (for example `workers:read`, `payroll:read`) and can do nothing
  outside them.
- Requests authenticate with `Authorization: Bearer <key>`.
- Each key shows when it was last used.
- A revoked key stops working immediately.

### The concept: machine credentials are not user sessions

A browser session represents *a person, right now*: it is created by typing a password,
lives in a cookie, and expires in days. A script has no person and no browser. It needs a
**long-lived secret** that identifies *an integration*.

That difference changes the security model:

- **Long-lived** → it will leak eventually (a log, a repository, a screenshot). So it
  must be revocable instantly and should be able to do as little as possible.
- **No person present** → no password prompt, no second factor. The key *is* the whole
  credential.
- **Not a cookie** → the browser never attaches it automatically, so **CSRF does not
  apply**. That is why APIs use the `Authorization` header: a malicious page cannot make
  a visitor's browser send it.

The principle that follows is **least privilege**: a key should be scoped to what the
script needs. A read-only reporting script has no business holding a credential that can
approve payroll.

### The design decision

| Question | Recommendation |
| --- | --- |
| Storage | Store a **SHA-256 hash**, never the key — exactly like session and invite tokens (`lib/crypto.ts`, `hashToken`). A fast hash is right because the key is high-entropy |
| Format | A recognisable prefix plus random bytes: `mrd_live_<43 chars>`. The prefix lets secret-scanners (and humans) recognise a leaked key |
| Identifying a key in the UI | Store and show the first few characters after the prefix. Never the whole key |
| Who is the actor? | A key belongs to an organization and acts as a **service identity**, not as the admin who created it — or it stops working when that person leaves |
| Scopes | A list of strings on the key, checked per endpoint. Design the names as `resource:action` |
| Expiry | Optional `expires_at`; recommend one |
| Rate limiting | Per key (part 1's US-20 gives you the machinery) |

**The hard part is the Actor.** Everything in this API is built on
`Actor { userId, role, organizationId, workerId }`, and authorization is by role. An API
key has no user and no role. Options:

- **A.** Give a key a role (`client_manager`) and synthesise an Actor. Quick; scopes then
  need a second, separate check.
- **B.** Extend `Actor` with a `kind: 'user' | 'api_key'` and a `scopes` list, and move
  authorization from "has role" to "has permission". This is the right model and is
  exactly what US-36 introduces.

Recommendation: do US-36 first, then this story is small. If you do this one first,
choose A and write down the debt.

### Where it touches this codebase

- `apps/api/src/middleware/auth.ts` — `authenticate` reads the session cookie. It needs a
  second path for the `Authorization` header that produces the same `req.actor`.
- `apps/api/src/lib/actor.ts` — the `Actor` type.
- `apps/api/src/lib/audit.ts` — `actorUserId` is a foreign key to `users`. An API key is
  not a user: the audit row needs to say *which key* acted.
- `apps/api/src/middleware/security.ts` — the origin check; confirm it does not block
  header-authenticated calls (they carry no `Origin`).
- `apps/api/src/db/schema.ts` — `api_keys` (tenant-owned).

### Hints

1. One middleware, two credentials, **never both**: if a request has an `Authorization`
   header, use it and ignore the cookie. Mixing them invites confusion about who is
   acting.
2. Look the key up by its hash with a unique index — the same single indexed lookup as a
   session.
3. `last_used_at`: updating a row on every request is a write per read. Update at most
   once a minute per key (compare in the `WHERE` clause so it is one conditional
   statement).
4. Audit: add a nullable `actor_api_key_id` to `audit_logs`, and a check constraint that
   at most one of the two actor columns is set. `actorName` in `AuditLogDto` can then
   show the key's name.
5. Do not let an API key create or revoke API keys. Otherwise one leaked key can mint
   replacements for itself.
6. Constant-time comparison is not needed when you look up by hash — you never compare
   the secret to anything in application code. Understand why.

### How to test it

- Create → the plaintext appears once; the database holds only a hash; listing shows a
  prefix, never the key.
- A valid key reads workers; without the scope → 403; revoked → 401 immediately.
- A key from tenant A cannot see tenant B (the usual 404).
- A request with both a cookie and a header uses the header.
- An audit entry written through a key names the key.
- A key cannot manage keys.

### What goes wrong

- Storing keys in plaintext "so we can show them again".
- Acting as the creating user — the integration breaks when they are deactivated, and
  the audit log blames a person for what a script did.
- Scopes checked in the UI only.
- Keys in query strings (they end up in logs). Header only.

### Questions to be able to answer

- Why is CSRF not a concern for header-based authentication?
- Why is a fast hash acceptable for API keys but not for passwords?
- If a key leaks, what is the blast radius, and what limits it?
