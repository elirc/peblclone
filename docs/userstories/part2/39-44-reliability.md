# Stories 39–44 — reliability and operations

Not implemented. See the [part 2 index](README.md) for how to use these.

The theme of this group: **what happens when things do not go to plan** — a server
restarts mid-task, a dependency stops answering, two workers grab the same job, nobody
knows why the system is slow. A feature that works when everything works is half a
feature.

---

## US-39 — Payroll processing in the background

> As a platform admin, I want "process payroll" to return immediately and do the work in
> the background, so that a run with thousands of workers does not time out — and so that
> a server restart in the middle does not lose or duplicate payments.

### Acceptance criteria

- `POST /payroll/runs/:id/process` moves the run to `processing`, enqueues a job and
  returns at once.
- A worker process picks the job up, does the work (simulated: a short delay per
  payslip), and marks the run `paid`.
- If the worker crashes mid-job, the job is retried and the run still ends up paid
  **exactly once**.
- Two workers never process the same job at the same time.
- A job that keeps failing is retried with backoff, then parked as `failed` for a human.
- Job status is visible.

### The concept: a queue, and why "at least once" changes how you write the work

A web request should answer in milliseconds. Anything slow, or anything that calls
another system, belongs in a **background job**: the request records "this needs doing"
and returns; a separate **worker** does it later.

That raises three questions a request handler never had to answer:

1. **What if the worker dies halfway?** The job must not vanish. So a job is only
   *removed* when it is finished — which means that after a crash it runs **again**.
2. **So jobs run at least once, never exactly once.** Whatever the job does must be safe
   to do twice. That property is **idempotence** (US-27), and it is not optional for
   background work.
3. **What if two workers take the same job?** They must not. Claiming a job has to be
   atomic.

### The design decision: do you need a queue product?

The usual answer is "add Redis and a queue library". You may not need to. **Postgres can
be a perfectly good job queue** for a system this size, and using it has one enormous
advantage: the job is enqueued **in the same transaction** as the state change. There is
no dual-write problem (US-31) — "the run became `processing`" and "a job exists to
process it" are one atomic fact.

The piece of Postgres that makes it work:

```sql
SELECT id FROM jobs
WHERE status = 'queued' AND run_at <= now()
ORDER BY run_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE` locks the row a worker selects. `SKIP LOCKED` tells every *other* worker to
ignore locked rows rather than wait for them. Ten workers running this at the same
instant each get a different job, with no coordination and no waiting.

| Question | Recommendation |
| --- | --- |
| Queue technology | A `jobs` table in Postgres. Revisit if throughput reaches thousands of jobs per second |
| Claiming | `FOR UPDATE SKIP LOCKED` |
| Crash detection | The claim sets `locked_until = now() + 5 minutes`. A job whose lease has expired is claimable again. A long job extends its lease as it works |
| Retries | `attempts` counter; exponential backoff by setting `run_at`; after N attempts → `failed` |
| Where the worker runs | Same codebase, separate process (`npm run worker`). In development it may run inside the API process |
| Idempotence of the work | Each step checks state before acting (below) |

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — a `jobs` table. Is it tenant-owned? It carries an
  `organization_id` for filtering and cleanup, but workers process all tenants. Add it to
  `TENANT_TABLES` in `test/cleanup.ts` so tests reset it.
- `apps/api/src/modules/payroll/service.ts` — `processRun` and the mark-paid transition
  each have hooks that run inside the transaction; `processRun`'s `after` is where the
  job is enqueued.
- `apps/api/src/server.ts` — already runs a periodic sweeper; a worker loop is the same
  idea done properly.
- `apps/api/package.json` — a `worker` script.

### Hints

1. Write `enqueue(tx, …)` so that it **requires** a transaction (`Tx`, not `DbOrTx`). A
   job enqueued outside the transaction that changed state brings the dual write back.
2. Claim and work in **separate** transactions. Claiming is short: select-and-lock, set
   `status = 'running'` and the lease, commit. Then do the work. If you held the claim
   transaction open for the whole job you would pin a connection and a row lock for
   minutes.
3. Making "pay this run" idempotent: the handler's first action is to load the run. If it
   is already `paid`, succeed and stop. The final step uses the existing transition,
   whose conditional `UPDATE … WHERE status = 'processing'` already guarantees it happens
   once. The state machine *is* your idempotence — the same observation as in US-27.
4. For per-payslip progress, mark each `payroll_items` row as paid individually, so a
   retry skips the ones already done. Then a crash at payslip 4,000 of 5,000 resumes at
   4,001 rather than starting over.
5. Polling interval: a worker with nothing to do should sleep (a second or so), not spin.
   Postgres `LISTEN`/`NOTIFY` can wake it instantly — a good stretch.
6. Graceful shutdown: on `SIGTERM`, stop claiming, finish the current job, exit.
   `server.ts` shows the pattern for the HTTP server.
7. The API contract changes meaning: `process` no longer means "done", it means
   "accepted". Consider `202 Accepted`. The UI must show progress — see US-44.

### How to test it

- Enqueue + state change are atomic: make the transition fail and assert no job row
  exists.
- Run the handler twice for the same job → one `payroll_run.paid` audit row.
- Two workers claiming concurrently (`Promise.all`) → each job claimed once.
- A handler that throws → `attempts` increases, `run_at` moves into the future; after the
  limit → `failed`.
- Simulated crash: claim a job, do not finish, set `locked_until` into the past; another
  claim picks it up.

### What goes wrong

- Doing the work inside the claim transaction.
- A job handler that is not idempotent — the first retry double-pays.
- No lease, so a crashed worker's job is stuck `running` forever.
- An unbounded retry loop on a job that can never succeed (a "poison" job).

### Questions to be able to answer

- Why "at least once" and not "exactly once"? What must be true of the job as a result?
- What does `SKIP LOCKED` do that plain `FOR UPDATE` does not?
- When would you replace this with a dedicated queue?

---

## US-40 — Reminders for overdue invoices

> As a client admin, I want to be reminded when an invoice is three days overdue and
> again after seven, so that payroll is not delayed because a payment was forgotten.

There is no email service. Build an **in-app notification** — a row the user sees in the
web app — with "send" behind one function, as US-35 does for password resets.

### Acceptance criteria

- A scheduled task runs daily and creates a reminder for each invoice that is 3 or 7
  days overdue.
- Each reminder is created **once**, even if the task runs twice in a day, runs late, or
  runs on two servers.
- Paying the invoice stops further reminders.
- Admins see unread notifications in the app and can mark them read.
- If the task did not run for two days, the missed reminders are still created.

### The concept: scheduled work is harder than it looks

`setInterval(sendReminders, 24 * 60 * 60 * 1000)` is where everyone starts. Now consider:

- **Two servers** each run the timer → every reminder is sent twice.
- **A deploy at 02:59** restarts the process → the timer resets and the 03:00 run never
  happens.
- **The task runs twice** (a retry, a restart) → duplicates.
- **The server was down on day 3** → on day 4 the invoice is "4 days overdue", which
  matches neither 3 nor 7. The reminder is silently never sent.

The lesson generalises far beyond reminders: **a scheduled task must be safe to run any
number of times, at any time, on any number of machines.** You get there by making the
task *declarative*:

- not "it is day 3, send a reminder"
- but "**ensure** that every invoice at least 3 days overdue has a day-3 reminder."

The first describes an event that happens at a moment. The second describes a state that
should hold. Run it once or fifty times, on time or a week late: the result is the same.
This is called **reconciliation**, and it is how reliable scheduled systems are built.

### The design decision

| Question | Recommendation |
| --- | --- |
| Preventing duplicates | A **unique constraint** on `(invoice_id, kind)` in the notifications table, and `INSERT … ON CONFLICT DO NOTHING`. The database guarantees "once", not the scheduler |
| Missed days | The query is "overdue by **at least** 3 days and no day-3 reminder exists" — not "exactly 3 days". Catch-up is automatic |
| Who triggers the task | With US-39 done: a recurring job. Without it: a timer plus a Postgres advisory lock so only one instance runs it |
| What "today" means | The database's date, in UTC. One clock (the same reasoning as part 1's US-20) |
| Recipients | Every active client admin of the invoice's organization — resolved when the notification is *read*, or one row per user? One row per user makes "mark as read" simple |
| Stopping on payment | The query only considers `issued` invoices. Nothing to cancel |

### Where it touches this codebase

- `apps/api/src/db/schema.ts` — `notifications` (tenant-owned; add to the cleanup list).
- `apps/api/src/modules/` — a new `notifications` module: list mine, mark read. It
  follows the reference module exactly.
- `apps/api/src/modules/index.ts` — register the router.
- `apps/api/src/server.ts` — where a scheduler would start.
- Part 1's US-17 defines "overdue"; reuse that definition rather than writing a third.
- `apps/web/src/components/layout/AppShell.tsx` — a bell with an unread count.

### Hints

1. Write the task as **one function that can be called from a test**:
   `ensureOverdueReminders(now)`. Take `now` as a parameter. A scheduled task that reads
   the clock internally cannot be tested without waiting for tomorrow.
2. The whole task can be a single `INSERT … SELECT … ON CONFLICT DO NOTHING`: select
   (invoice, admin, kind) combinations that should have a reminder; let the unique index
   discard the ones that already do. Set-based, idempotent, and correct on any number of
   servers. Try writing it that way before reaching for a loop.
3. Model the thresholds as data: `[{ kind: 'overdue_3', days: 3 }, { kind: 'overdue_7',
   days: 7 }]`. Adding a 14-day reminder is then one entry.
4. An invoice that is 10 days overdue and has no reminders (the task was off for a week)
   would get both at once. Decide: send both, or only the most severe? Write the test for
   your choice.
5. The "send" function receives a notification and, for now, does nothing beyond the row
   existing. Keep the call so a real channel has somewhere to attach.
6. Listing notifications: a user sees only their own. Filter by `user_id` **and**
   `organization_id` — rule 2 still applies.
7. The unread count is polled by the shell. Keep the query cheap (a partial index on
   unread rows) and the polling interval long.

### How to test it

- An invoice 3 days overdue → one reminder per admin.
- Run the task **again** → still one. (The most important test.)
- Run it from two "instances" concurrently (`Promise.all`) → still one.
- Pay the invoice; advance `now` to day 7 → no day-7 reminder.
- First run at day 5 (missed day 3) → the day-3 reminder is created.
- A manager and a worker receive none; another tenant's admin receives none.

### What goes wrong

- "Exactly N days" logic — breaks the first time a run is missed.
- De-duplicating in application code (`if not exists then insert`) — a race across two
  servers.
- A timer with no cross-instance lock.
- Reading the clock inside the function.

### Questions to be able to answer

- What makes your task safe to run twice?
- Describe what happens if the server is down for a week.
- Why is "ensure this state" a better instruction than "do this at 03:00"?

---

## US-41 — Documents in object storage

> As the operations team, we want uploaded documents stored in an object store instead
> of on the API server's disk, so that we can run more than one API instance and so that
> a lost server does not lose passports.

### Acceptance criteria

- Storage is selected by configuration: local disk (development, tests) or an
  S3-compatible object store.
- All existing document behaviour and tests are unchanged.
- With the object store, downloads do not pass through the API: the client is redirected
  to a short-lived signed URL.
- A file is never reachable without passing the API's authorization first.
- Deleting or replacing a document removes the old object.

### The concept: ports and adapters

Right now "where files live" is a detail of one small file. Builder A wrote
`apps/api/src/modules/documents/storage.ts` with four functions — `newStorageKey`,
`saveFile`, `loadFile`, `deleteFile` — and a comment: *"Swapping this for S3 later means
re-implementing these four functions."* The build journal praised it (chapter 13.4).

That is a **port**: a small interface describing what the application *needs* ("store
these bytes under this key"), stated in the application's own terms. An implementation of
it for a particular technology is an **adapter**. The documents service depends on the
port and neither knows nor cares which adapter is behind it.

The payoff is the one you are about to collect: a change of infrastructure touches one
file. And tests keep running against the fast local adapter with no cloud account.

The pattern is only as good as the port's shape, and the current one has a flaw you will
discover: `loadFile` returns the whole file as a `Buffer`. That bakes in "the API reads
the file and sends it". The better design for object storage does not do that at all.

### The design decision

**Why the server should not proxy downloads.** If every download streams through the
API, the API's memory and bandwidth carry every file. Object stores can instead issue a
**pre-signed URL**: a link containing a signature and an expiry, valid for a minute, that
lets the browser fetch one specific object directly from storage.

```
browser ── GET /documents/42/file ──▶ API   (checks session, tenant, ownership)
browser ◀── 302 Location: https://storage/…?X-Signature=…&Expires=60s ── API
browser ── GET that URL ──▶ object store (no API involved)
```

Authorization stays in the API; the bytes do not pass through it.

| Question | Recommendation |
| --- | --- |
| Port shape | Replace `loadFile` with something both adapters can satisfy: "give me a way for the client to download this" — either a stream (local) or a redirect URL (object store) |
| Signed URL lifetime | Short — 60 seconds. It is a bearer credential: whoever has the URL has the file |
| Uploads | Keep them going through the API for now. The upload path validates size and file signatures; direct-to-storage uploads would move that check somewhere harder |
| Bucket layout | The existing key (`<organizationId>/<uuid>`) already works as an object key. One private bucket |
| Bucket privacy | **Private.** No public read, ever |
| Encryption | Server-side encryption enabled on the bucket |
| Configuration | `STORAGE_DRIVER=local|s3` plus bucket and credentials, validated in `config.ts` at startup |
| Dependency | An S3 client library is a new dependency — `CLAUDE.md` says to ask first. Make the case in writing |

### Where it touches this codebase

- `apps/api/src/modules/documents/storage.ts` — becomes an interface plus the local
  adapter; a second file holds the object-store adapter.
- `apps/api/src/modules/documents/service.ts` — `uploadDocument` (writes before the
  transaction, deletes the orphan on failure, deletes the replaced file after commit) and
  `downloadDocument`.
- `apps/api/src/modules/documents/routes.ts` — the download route sets headers and sends
  bytes today.
- `apps/api/src/config.ts` — `storageDir`.
- `apps/web/src/lib/api.ts` — `api.blob` uses `fetch`, which follows redirects. Check
  what happens to cookies on a cross-origin redirect (they must **not** be sent to the
  storage host).

### Hints

1. **Refactor first.** Turn the four functions into an interface with a local
   implementation, change nothing else, run `documents.test.ts`. Then add the second
   adapter. This is the same two-step discipline as US-30 and US-36.
2. Define the download result as a tagged union: `{ kind: 'bytes', … } | { kind:
   'redirect', url }`. The route handles both. The service stays ignorant of HTTP.
3. `Content-Disposition` and `Content-Type` were set by the API route. With a signed URL
   the object store serves the response, so those headers must be baked into the signed
   request (object stores support response-header overrides in the signature). Without
   this, a PDF opens in the browser tab instead of downloading — and an HTML file renders
   **as a page on the storage domain**. Force `attachment`.
4. The careful ordering in `uploadDocument` — write the file, then the transaction, clean
   up on failure — is about keeping a database and a file store consistent without a
   shared transaction. Read it again before changing anything; it must survive the move.
5. Orphans will still happen (a crash between the write and the cleanup). A periodic job
   that lists objects with no matching database row is the honest answer; note it as
   follow-up.
6. For local development of the object-store adapter, an S3-compatible server can run on
   your machine. The build journal notes Docker is unreliable on this laptop — check
   whether a native binary exists before assuming a container.
7. Keep the magic-byte check (`matchesMimeType`). It belongs to the service, not to an
   adapter.

### How to test it

- The existing documents suite passes with the local adapter, unchanged.
- A **contract test** — one set of tests run against *each* adapter: save then load
  returns the same bytes; delete then load returns "not found"; a key that is not
  `<uuid>/<uuid>` is rejected.
- With the object-store adapter: the download endpoint answers `302` to a URL that
  expires; another tenant's document is `404` *before* any URL is issued.
- A signed URL stops working after its lifetime.

### What goes wrong

- A public bucket.
- Long-lived signed URLs pasted into chat and working for a week.
- Proxying downloads through the API "to keep it simple".
- Losing `Content-Disposition: attachment`, turning the storage domain into a place where
  uploaded HTML executes.
- Sending the session cookie to the storage host.

### Questions to be able to answer

- What is the difference between the port and an adapter here?
- Why is a signed URL a credential, and how did you limit the damage if one leaks?
- What keeps the database and the object store consistent when a request fails halfway?

---

## US-42 — Nothing hangs forever

> As the person on call, I want every slow operation to give up after a bounded time, so
> that one stuck dependency degrades one feature instead of taking the whole API down.

### Acceptance criteria

- Every database statement has a maximum duration.
- A request whose client has disconnected stops doing work.
- The connection pool cannot be exhausted by a few slow requests: acquiring a connection
  has a timeout, and the caller gets `503` rather than waiting forever.
- Any outbound HTTP call has a timeout.
- The server sets limits on request header, body and total request time.
- Each timeout is a configuration value with a documented default.

### The concept: a hung request is worse than a failed one

A request that **fails** returns an error in milliseconds and frees its resources. A
request that **hangs** holds a database connection, memory and a socket — indefinitely.

The pool has ten connections (`apps/api/src/db/client.ts`). Suppose one query — a report
on a table that lost its index — takes ten minutes. Ten users click that report. All ten
connections are now busy. The eleventh request, a login, waits for a connection that is
not coming. From outside, **the whole API is down**, although nothing has crashed and
almost nothing is broken.

This is **resource exhaustion**, and it is how small problems become outages. The defence
has a simple shape:

> Every wait must have a limit. Decide in advance how long is too long, and when the
> limit is reached, **fail fast and release the resource**.

A related idea is **backpressure**: when the system is saturated, refusing new work
quickly (`503`, "try again shortly") is kinder than accepting it and making everyone
wait. A queue that only grows helps nobody.

### The design decision

There is no single timeout. There is a stack of them, and they must be **ordered** —
inner ones shorter than outer ones — or the outer one fires first and the inner cleanup
never runs.

| Layer | Setting | Sensible start | If it fires |
| --- | --- | --- | --- |
| A single SQL statement | Postgres `statement_timeout` | 5 s | Postgres cancels the query; the driver throws |
| A lock wait | Postgres `lock_timeout` | 2 s | A `FOR UPDATE` that cannot get its lock gives up |
| A forgotten transaction | `idle_in_transaction_session_timeout` | 10 s | Postgres ends it and releases its locks |
| Getting a connection | pool acquire timeout | 3 s | The request fails with `503`, not a hang |
| An outbound HTTP call | abort signal with a timeout | 5 s | The call throws; the caller decides |
| The whole request | server request timeout | 30 s | The connection is closed |

**How should the client see it?** A statement timeout is not the client's fault (`4xx`)
and not exactly a bug (`500`). `503 Service Unavailable` with a `Retry-After` header says
"temporarily unable; try again", which is the truth — and well-behaved clients will back
off.

### Where it touches this codebase

- `apps/api/src/db/client.ts` — the `pg.Pool` options.
- `apps/api/src/config.ts` — new validated settings.
- `apps/api/src/middleware/error-handler.ts` — recognise the timeout errors and map them.
- `apps/api/src/server.ts` — the HTTP server's own limits.
- `apps/api/src/app.ts` — the health check already races a two-second timer (part 1,
  US-05); that is this idea in miniature.
- Anything that calls `fetch` (the webhook relay in US-31).

### Hints

1. Postgres timeouts can be set per connection. The pool can run a statement on each new
   connection, or you can pass options in the connection string. Check the `pg`
   documentation for which pool options exist in the installed version rather than
   guessing their names.
2. Timeouts need different values in different places. A payroll run over 5,000 workers
   legitimately takes longer than a list query. `SET LOCAL statement_timeout` inside a
   transaction raises the limit for that transaction only — the same `SET LOCAL` lesson
   as US-33.
3. Identify the errors by **code**, not message text. Postgres has specific SQLSTATE
   codes for "query cancelled" and "lock not available". `isUniqueViolation` in
   `lib/errors.ts` shows the pattern, including looking at `.cause`.
4. Client disconnects: Node raises an event when the client goes away. For a request
   that is mid-query, the useful response is to cancel that query. This is harder than it
   sounds in Express — find out what your driver offers, and decide whether the
   complexity is worth it compared with simply relying on `statement_timeout`. A written
   "we decided not to, because…" is an acceptable outcome.
5. Lock timeouts interact with the row locks this codebase takes on purpose (onboarding,
   time off). A `lock_timeout` turns "wait for the other request" into an error after two
   seconds. Map it to `409` with "this record is busy, try again" — and re-run the
   concurrency tests, which rely on waiting.
6. `Retry-After` on the `503`.
7. The login rate limiter and scrypt: hashing is CPU work on Node's thread pool, not a
   database wait. No database timeout bounds it. Note it.

### How to test it

- A test that runs `select pg_sleep(10)` through the app's pool and asserts it fails in
  about the configured time with the right mapped error.
- Hold a row lock in one transaction; a second request for the same row fails after the
  lock timeout instead of hanging.
- Exhaust the pool (hold all connections); the next request gets `503` quickly.
- The existing suite still passes — particularly the concurrent tests.

### What goes wrong

- Timeouts in the wrong order.
- One global value that is too short for payroll and too long for everything else.
- Retrying a timed-out **write** blindly: it may have succeeded (see US-27).
- Treating a timeout as a `500` and paging someone for every slow query.

### Questions to be able to answer

- Why is a hang more dangerous than an error?
- Walk through what happens to an unrelated login when ten users run a ten-minute query,
  before and after your change.
- Which of your timeouts is shortest, which is longest, and why that order?

---

## US-43 — Know what the system is doing

> As the engineer on call, I want to see request rates, error rates and latency per
> endpoint, so that I find out about a problem from a graph instead of from a customer.

### Acceptance criteria

- The API exposes a metrics endpoint in a standard text format.
- For every route: request count, error count and a latency histogram.
- Database pool usage and job queue depth (if US-39 is done) are reported.
- Metric labels never contain user data or unbounded values.
- Slow queries are logged with their duration and the request id.
- The metrics endpoint is not reachable by the public.

### The concept: logs, metrics and traces answer different questions

- **Logs** are individual events: "request `abc` failed with this error". Good for
  *"what exactly happened to this request?"* (Part 1's US-06 gave every request an id for
  this.)
- **Metrics** are numbers aggregated over time: "the error rate is 2%". Good for *"is the
  system healthy, and is it getting worse?"* Cheap to keep for years.
- **Traces** follow one request through every component. Good for *"where did the time
  go?"*

You cannot answer a metrics question with logs at scale, or a log question with metrics
at all. A production system needs all three.

For any service, the **four golden signals** tell you most of what matters:

| Signal | Question | Here |
| --- | --- | --- |
| **Traffic** | How much is being asked of us? | requests per second, per route |
| **Errors** | How much of it is failing? | rate of `5xx` |
| **Latency** | How long does it take? | duration distribution |
| **Saturation** | How full are we? | pool connections in use, queue depth |

**Why a histogram and not an average.** Suppose 99 requests take 10 ms and one takes 10
seconds. The average is about 110 ms — which describes *no* request anybody made.
Averages hide exactly the experience you most need to see. **Percentiles** do not: p50
(the typical request), p95, p99 (the unlucky one in a hundred). A histogram — counts of
requests per duration bucket — is what lets a monitoring system compute them.

### The design decision

| Question | Recommendation |
| --- | --- |
| Format | The Prometheus text exposition format: plain text, an open standard, understood by almost every monitoring tool |
| Library or hand-written | The format is simple enough to write by hand for a few counters, and doing so teaches what a metric *is*. A client library is the practical choice — a new dependency, so ask first |
| Route label | The **route pattern** (`/workers/:id`), never the actual path (`/workers/3f2a…`) |
| Who can read `/metrics` | Not the public internet. A separate port bound to localhost, or a shared-secret header |
| What counts as an error | `5xx` only. A `404` or `409` is the system working correctly |

**Cardinality is the trap.** Every distinct combination of label values is a separate
time series that the monitoring system stores forever. Label a metric with the request
*path* and every worker id creates a new series; with a user id, every user does. A
metrics system that received a million series from one misplaced label falls over — this
is one of the most common real-world monitoring outages. The rule: **a label's possible
values must be a small, fixed set.** Route patterns, HTTP methods, status classes — yes.
Ids, emails, tenant ids, error messages — never.

### Where it touches this codebase

- `apps/api/src/app.ts` — a timing middleware, registered early (next to the request-id
  middleware from US-06) and finishing on the response's `finish` event.
- `apps/api/src/db/client.ts` — the pool exposes counts of total, idle and waiting
  connections.
- `apps/api/src/lib/logger.ts` — slow-query logging.
- `apps/api/src/config.ts` — the metrics port or secret.

### Hints

1. Express knows the matched route pattern once routing has happened — it is on the
   request object after the handler runs. Read it in the `finish` handler, not at the
   start of the request, and decide what to record for requests that matched no route
   (one fixed label such as `unmatched`, or you have just made a label from attacker
   input).
2. Choose histogram buckets for **your** latencies: something like 5 ms, 10, 25, 50, 100,
   250, 500 ms, 1 s, 2.5 s, 5 s. Buckets that are all too large tell you nothing about a
   10 ms endpoint.
3. Use a monotonic clock for durations (`process.hrtime.bigint()` or
   `performance.now()`), not `Date.now()`, which jumps when the system clock is adjusted.
4. Counters only ever go up; the monitoring system computes rates. Do not try to store
   "requests per second" yourself.
5. Slow queries: wrap the pool's query function, or use the driver's hooks, to time each
   statement and log those above a threshold — with the request id, and with the SQL
   *text* but never the parameter values (they are user data: names, emails, salaries).
6. Saturation: export the pool gauges at scrape time (read them when `/metrics` is
   requested) rather than on a timer.
7. Do not time the `/metrics` and `/health` endpoints themselves into the request
   metrics; they are noise.

### How to test it

- Make three requests to a route; scrape; the counter for that route pattern shows 3 and
  the path parameter does **not** appear anywhere in the output.
- A request that returns `500` increments the error counter; a `404` does not.
- A request to a nonsense URL does not create a new label value.
- The metrics endpoint is refused without its secret (or is not on the public port).
- A deliberately slow query produces one slow-query log line with a request id and no
  parameter values.

### What goes wrong

- High-cardinality labels.
- Averages.
- A public `/metrics` endpoint — it describes your traffic and internals to anyone.
- Query parameters in logs.
- Alerting on `4xx`.

### Questions to be able to answer

- What can a p99 tell you that an average cannot?
- Why must a label never contain a user id?
- For each golden signal, which metric of yours answers it?

---

## US-44 — Live payroll status

> As a client admin watching a payroll run, I want the page to update by itself when the
> run moves to processing and then to paid, so that I do not have to keep reloading.

### Acceptance criteria

- With the payroll run page open, a status change made elsewhere appears within a couple
  of seconds, without a reload.
- It works with more than one API instance.
- A dropped connection reconnects automatically and catches up on anything missed.
- A user only ever receives events for their own tenant, and only for things they are
  allowed to see.
- With live updates unavailable, the page still works — it falls back to polling.

### The concept: three ways to push, and why the simplest is usually enough

HTTP is request–response: the server cannot speak first. There are three common ways
round that.

| Technique | How | Direction | Good for |
| --- | --- | --- | --- |
| **Polling** | The client asks every N seconds | client → server | Almost everything. Trivial, robust, wasteful when nothing changes |
| **Server-sent events (SSE)** | One long-lived HTTP response that the server keeps writing to | server → client | Notifications, status, feeds |
| **WebSocket** | A separate two-way protocol after an HTTP upgrade | both | Chat, collaborative editing, games |

People reach for WebSockets by default. For "tell the browser something changed", SSE is
simpler in every way: it is plain HTTP (so cookies, proxies and the existing auth all
work), browsers reconnect automatically, and there is a built-in mechanism for resuming.
WebSockets earn their extra complexity only when the *client* also needs to send a stream
of messages.

And notice the smallest design of all: **send a hint, not the data.** The event says "run
42 changed". The browser responds by refetching run 42 through the normal API. Then the
event stream carries no sensitive payload, there is one code path for loading data, and
authorization is enforced by the endpoint that already enforces it.

### The design decision

**The hard part is multiple servers.** The browser's SSE connection is held by API
instance A. The platform admin's "mark paid" request lands on instance B. B must somehow
tell A. Three ways:

| Option | How | Trade-off |
| --- | --- | --- |
| Postgres `LISTEN` / `NOTIFY` | B runs `NOTIFY` in its transaction; every instance holds a `LISTEN` connection | No new infrastructure. Notifications are delivered **on commit** — exactly when you want. Not durable: a disconnected listener misses them |
| Poll a table | Each instance polls an events table every second | Durable and simple; up to a second late; constant query load |
| A message broker | Redis pub/sub or similar | Scales furthest; new infrastructure |

Recommendation: **`LISTEN`/`NOTIFY` to wake listeners, plus an events table to catch
up.** The notification is a fast, lossy doorbell; the table is the durable record. If you
did US-31, the outbox table is that record already.

| Question | Recommendation |
| --- | --- |
| Authorization | Checked when the stream opens (session → actor → tenant), then enforced on **every event** by filtering on the actor's tenant |
| Payload | `{ type, entity, id }` only |
| Catch-up | Each event has an increasing id; the browser sends `Last-Event-ID` on reconnect; the server replays from the table |
| Keep-alive | A comment line every ~20 seconds, or proxies close the idle connection |
| Session ends | Re-check the session periodically and close the stream when it is gone |
| Fallback | TanStack Query `refetchInterval` when the stream is not connected |

### Where it touches this codebase

- `apps/api/src/modules/payroll/service.ts` — every transition goes through one
  `transition` function with an `after` hook inside the transaction: one place to emit.
- `apps/api/src/db/client.ts` — a `LISTEN` connection is **dedicated**: it cannot come
  from the shared pool and be returned to it.
- `apps/api/src/app.ts` — `helmet` and any compression must not buffer the stream.
- `apps/api/src/server.ts` — graceful shutdown must close open streams.
- `apps/web/src/lib/query.ts` — the event handler calls `invalidate(keys.payroll)`.
  The central key list the build journal's chapter 12.2 set up is what makes this a
  one-liner.
- `apps/web/vite.config.ts` — the dev proxy must pass the stream through unbuffered.

### Hints

1. An SSE response sets `Content-Type: text/event-stream`, disables caching, and never
   calls `res.end()` until the client leaves. Each message is a few `field: value` lines
   followed by a blank line. Read the format — it is one page.
2. Clean up on disconnect. Every open stream registers a listener; if you do not remove
   it when the request closes, you leak one per page view. Count your listeners in a test.
3. `NOTIFY` payloads are small (a few thousand bytes at most) and are plain text visible
   to every listener. Send ids, never data — which is what you were going to do anyway.
4. `NOTIFY` issued inside a transaction is delivered only if it commits. That is the
   property that keeps you from announcing a change that was rolled back — the same
   guarantee the outbox gives.
5. In the browser, the built-in `EventSource` reconnects by itself and sends
   `Last-Event-ID`. It also sends cookies for same-origin requests, so the existing
   session authenticates it. It cannot send custom headers — which matters for platform
   admins, who select a tenant with `X-Org-Id`. Decide how they pick a tenant for the
   stream (a query parameter validated exactly like the header is validated today).
6. Connection limits: browsers allow only a handful of concurrent connections per site
   over HTTP/1.1. One stream per **tab**, shared by every component — not one per
   component.
7. Each open stream holds a socket and some memory on the server. Decide a limit per user
   and what happens at the limit.

### How to test it

- Open a stream as tenant A's admin; change a run in tenant A → an event arrives.
- Change a run in tenant **B** → nothing arrives on A's stream. (The test that matters.)
- A worker-role user's stream receives no payroll events.
- Disconnect, change a run, reconnect with `Last-Event-ID` → the missed event is
  replayed.
- Open and close 100 streams → the listener count returns to zero.
- Delete the session → the stream closes.

### What goes wrong

- Broadcasting every event to every connection.
- Putting the run's data in the event.
- Borrowing the `LISTEN` connection from the pool.
- Leaking listeners.
- A proxy buffering the response, so events arrive in a burst minutes later.
- No fallback, so a corporate proxy that blocks streaming breaks the page.

### Questions to be able to answer

- Why SSE rather than WebSockets here?
- How does an event produced on one server reach a browser connected to another?
- What stops tenant A from receiving tenant B's events — at connection time *and* per
  event?
