# Stories 33–38 — security

Not implemented. See the [part 2 index](README.md) for how to use these.

The theme of this group: **assume one of your defences will fail, and ask what happens
then.** Each story adds a layer, limits what a mistake can reach, or makes an intrusion
visible. Read the build journal's chapter 8 (sessions, passwords, the Actor) before
starting — every story here builds on it.

---

## US-33 — A second lock on tenant data

> As the engineer responsible for tenant isolation, I want the database itself to refuse
> to return another tenant's rows, so that a single forgotten `WHERE` clause cannot leak
> a customer's payroll.

### Acceptance criteria

- With row-level security enabled, a query on a tenant table that has **no** tenant
  filter returns only the current tenant's rows.
- With no tenant set, tenant tables return **nothing** (never everything).
- Platform-admin cross-tenant endpoints still work, through an explicit, audited path.
- The whole existing test suite passes.
- There is a test that proves the database layer works *with the application filter
  removed*.

### The concept: defence in depth, and where the tenant boundary lives

ADR 0002 chose "tenant id on every table, enforced by convention plus tests". The
independent review found the convention followed in every query (build journal, chapter
17.6). So isolation is currently exactly as strong as the least careful query anyone will
ever write.

**Row-level security (RLS)** moves the rule into Postgres. You attach a *policy* to a
table — "a row is visible only if its `organization_id` equals the current tenant
setting" — and the database applies it to every statement, as though the `WHERE` clause
were added for you.

```sql
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workers
  USING (organization_id = current_setting('app.organization_id', true)::uuid);
```

Now there are two independent locks. The application filter can be forgotten; the policy
still holds. The policy can be misconfigured; the application filter still holds. An
attacker — or a bug — needs both to fail at once.

### The design decision

The policy is easy. **Telling Postgres who the current tenant is** is the entire
difficulty, because of connection pooling.

The API holds a pool of ten connections (`apps/api/src/db/client.ts`). A request borrows
one, runs queries, returns it. The "current tenant" is a *session setting* on a
connection. If request A sets it and returns the connection without clearing it, request
B — a different tenant — inherits A's setting. That is not a leak RLS prevents; it is a
leak RLS *causes*.

| Approach | How | Risk |
| --- | --- | --- |
| `SET` on the connection | Set at request start, reset at the end | A missed reset poisons the pool. **Do not.** |
| `SET LOCAL` in a transaction | The setting dies with the transaction, automatically | Every tenant query must run inside a transaction |
| A connection per tenant | Separate pools | Does not scale past a handful of tenants |

Recommendation: **`SET LOCAL` inside a transaction** (via `set_config(name, value,
true)`, which can be parameterised). Its lifetime is tied to the transaction by the
database, so there is nothing to forget.

That has a real consequence for this codebase: many reads run directly on `db`, outside
any transaction. They would all need to be inside one. That is the size of this story,
and why ADR 0002 deferred it.

**The other trap: the table owner bypasses RLS.** By default, policies do not apply to
the role that owns the table, and never to superusers. The application currently connects
as `postgres` — a superuser. RLS would do *nothing*. You need:

- a separate, non-superuser **application role** for the API;
- the migrations run as the owner;
- and `ALTER TABLE … FORCE ROW LEVEL SECURITY` if the app role is also the owner.

### Where it touches this codebase

- `apps/api/src/db/client.ts` — connection handling; a helper that opens a transaction
  and sets the tenant.
- `apps/api/src/middleware/auth.ts` — where the tenant is resolved.
- Every service that queries on `db` directly.
- `apps/api/drizzle/` — a migration enabling RLS and creating policies on the sixteen
  tenant tables (the list is in `apps/api/src/test/cleanup.ts`).
- `.env`, `apps/api/src/config.ts` — a second connection string for migrations.
- `apps/api/src/test/` — factories insert directly, across tenants; they need a
  privileged connection.

### Hints

1. Prove the concept on **one table** in `psql` before touching the application: create
   a role, enable RLS on `workers`, `SET LOCAL`, select. Then select *as the superuser*
   and watch the policy be ignored. Until you have seen that with your own eyes you will
   not believe the bypass rule.
2. `current_setting('app.organization_id', true)` — the `true` means "return NULL if
   unset, do not error". `organization_id = NULL` is never true, so an unset tenant sees
   nothing. That is the fail-closed behaviour you want; do not "fix" it.
3. A policy with only `USING` governs reads. Writes need `WITH CHECK`, or a tenant could
   *insert* a row belonging to another tenant.
4. Tables without an `organization_id` column cannot have this policy. `invoice_lines`
   reaches its tenant through `invoices`. Either add the column (the ADR's rule says
   every tenant table has one — check whether this table breaks its own rule) or write a
   policy with a subquery.
5. Platform admins: do **not** add "or the user is an admin" to the policy. Give
   cross-tenant endpoints an explicit privileged path — a different role or a function —
   so that every cross-tenant read is a deliberate, findable line of code.
6. Do this incrementally. Introduce a `withTenant(orgId, fn)` helper; move modules over
   one at a time; enable the policy on a table only when every query touching it goes
   through the helper.

### How to test it

- The decisive test: through the application's own connection, with the tenant set to A,
  run a **raw `SELECT * FROM workers`** with no `WHERE`. Only A's rows come back.
- With no tenant set: zero rows.
- Insert a row for tenant B while the tenant is A → refused.
- Hammer the pool: 50 concurrent requests alternating between two tenants; no response
  ever contains the other tenant's data. This is the pool-poisoning test.
- All 385 existing tests.

### What goes wrong

- Connecting as a superuser and believing RLS is on.
- `SET` instead of `SET LOCAL`.
- Forgetting `WITH CHECK`.
- Performance: the policy is evaluated per row. Confirm with `EXPLAIN` that the planner
  still uses the `organization_id` indexes.

### Questions to be able to answer

- Why does connection pooling make `SET` dangerous and `SET LOCAL` safe?
- Which role runs migrations, which runs the app, and why must they differ?
- If the application filter and the policy disagree, which wins, and is that the
  behaviour you want?

---

## US-34 — Two-factor sign-in

> As a client admin who approves payroll, I want to protect my account with an
> authenticator app, so that a stolen password is not enough to move money.

### Acceptance criteria

- A user can enrol an authenticator app (TOTP) by scanning a QR code and confirming with
  a code.
- After enrolment, login requires the password **and** a current code.
- The user receives one-time recovery codes at enrolment.
- A user can disable two-factor only by proving both factors again.
- An organization can require two-factor for all its admins.
- Codes cannot be brute-forced, and a code cannot be used twice.

### The concept: what a second factor actually defends against

Authentication factors come in kinds: something you **know** (password), something you
**have** (a phone, a hardware key), something you **are** (a fingerprint). A password
alone fails to phishing, reuse across sites, and database leaks elsewhere. A second
factor of a *different kind* means the attacker needs two independent things.

**TOTP** (time-based one-time password) works like this:

1. At enrolment the server generates a random **shared secret** and shows it as a QR
   code. The authenticator app stores it.
2. Both sides compute `HMAC(secret, current 30-second time step)` and truncate it to six
   digits.
3. At login the user types the six digits; the server computes the same and compares.

No network is involved, and the code is useless after about a minute. What TOTP does
**not** stop is real-time phishing: a fake login page can relay a code within its 30
seconds. Hardware keys (WebAuthn) do stop that, by binding the response to the site's
origin. Know the limit of what you are building.

### The design decision

| Question | Recommendation |
| --- | --- |
| Library or hand-rolled | TOTP is a short, published algorithm (RFC 6238) on top of HMAC, which Node has built in. Either is defensible; if you write it, test against the RFC's published vectors |
| Storing the secret | It must be **recoverable** — the server needs the actual secret to compute codes, so it cannot be hashed. Encrypt it at rest with a key held outside the database |
| Clock drift | Accept the previous and next time step as well as the current one |
| Replay | Record the last accepted time step per user; refuse a code for that step or earlier |
| Brute force | Six digits is a million possibilities. Rate-limit attempts per user (part 1, US-20) |
| Recovery codes | Ten random codes, stored **hashed**, each usable once |
| Login flow | Two steps: password → a short-lived, single-purpose "pending" token → code → real session |

**The login flow is the design problem.** Today `POST /auth/login` returns a session.
With two-factor, a correct password must *not* yield a session. But the server has to
remember "this person passed step one" between the two requests.

- Do **not** issue the real session cookie and mark it "half authenticated" — every
  endpoint would have to remember to check the flag, and one that forgets is a bypass.
- **Do** issue a separate, short-lived (five-minute) token that is accepted by exactly
  one endpoint, `POST /auth/login/verify`, and by nothing else.

The session table and cookie stay exactly as they are: a session row means "fully
authenticated", always. That keeps a single meaning for the most security-critical thing
in the system.

### Where it touches this codebase

- `apps/api/src/modules/auth/service.ts` — `login` is where the fork happens.
- `apps/api/src/lib/crypto.ts` — token generation and hashing; add encryption for the
  secret.
- `apps/api/src/config.ts` — an encryption key from the environment (validated at
  startup, never committed).
- `apps/api/src/db/schema.ts` — per-user two-factor state, recovery codes, pending login
  tokens.
- `apps/web/src/pages/auth/LoginPage.tsx`, `apps/web/src/lib/auth.tsx` — a second step.

### Hints

1. Enrolment is two requests on purpose: *begin* (generate a secret, return it; **not
   yet active**) and *confirm* (the user submits a code; only now turn it on). If you
   activate at "begin" and the user never scans the code, they are locked out.
2. Keep the rule from the build journal's chapter 8.4: one error message. "Wrong
   password" and "wrong code" must not let an attacker confirm a password is correct —
   though reaching step two already reveals that the password was right. Think about
   what an attacker learns at each step and whether you can avoid it.
3. Recovery codes are passwords. Hash them. Show them once.
4. Disabling two-factor must require **both** factors. Otherwise a stolen session — the
   very thing the second factor was for — can simply switch it off.
5. The organization-wide requirement is enforced **at login**, not in the UI: an admin
   without two-factor is forced to enrol before getting a session.
6. Constant-time comparison for the code (`timingSafeEqual`), as with password hashes.
7. Encryption: authenticated encryption (AES-256-GCM in Node's `crypto`), a random nonce
   per value stored beside the ciphertext. Never invent a scheme.

### How to test it

- The RFC 6238 test vectors, with a fixed clock.
- Enrol → login without a code fails to produce a session → with the code succeeds.
- The same code twice → the second is refused.
- A code from one step ago is accepted; from five steps ago is not.
- A recovery code works once.
- The pending token is rejected by an ordinary endpoint such as `GET /auth/me`.
- Ten wrong codes → rate-limited.

### What goes wrong

- A "half-authenticated" session.
- The secret stored in plaintext, so a database leak defeats the second factor.
- No replay protection.
- Activating before confirmation.

### Questions to be able to answer

- What attack does TOTP stop, and which does it not?
- Why can the secret not be hashed while recovery codes must be?
- Why is a separate pending token safer than a flag on the session?

---

## US-35 — Forgotten password

> As a user who has forgotten my password, I want to reset it using a link sent to my
> email, so that I can get back into my account.

There is no email service in this project (it is on the out-of-scope list). Build the
flow completely, and replace "send email" with one function that logs the link in
development. That function is the seam where a real mailer would go.

### Acceptance criteria

- `POST /auth/forgot-password { email }` always answers `204`, whether or not the email
  exists.
- If the account exists, a single-use reset link is produced, valid for 30 minutes.
- `POST /auth/reset-password { token, newPassword }` sets the password and ends **all**
  the user's sessions.
- A token works once. Requesting a new link invalidates earlier ones.
- Requests are rate-limited per email and per IP.

### The concept: a reset link is a password

Whoever holds the link can take over the account. So a reset token deserves the same care
as a credential:

- **Unguessable** — 256 bits from a cryptographic generator (`generateToken`).
- **Stored hashed** — a database leak must not yield working links.
- **Short-lived** and **single-use**.
- **Bound to one account** — the token identifies the user; the request carries no
  user id that could be swapped.

The second idea is **account enumeration**. If "forgot password" says "no account with
that email", an attacker can test a list of addresses and learn who your customers are.
The build journal's login handler already defends against this (chapter 8.4: same
message, same timing). The reset endpoint must do the same — and it is harder here,
because the *existing-account* path does more work (generate, hash, store, send) and is
therefore measurably slower unless you deliberately even it out.

### The design decision

You have already built almost exactly this. Compare with **invitations**
(`apps/api/src/lib/invites.ts`, `auth/service.ts` → `acceptInvite`):

| | Invitation | Password reset |
| --- | --- | --- |
| Token | random, stored hashed | same |
| Expiry | 7 days | 30 minutes |
| Single use | conditional `UPDATE … WHERE accepted_at IS NULL` | same technique |
| Result | creates a user | changes a password |

So: a new `password_resets` table or reuse `invitations` with a `kind`? Recommendation:
**a new table.** They share mechanics, not meaning, and their rules will diverge
(US-22 made the same argument about adjustments and expenses).

| Question | Recommendation |
| --- | --- |
| Response when the email is unknown | `204`, identical to success |
| Timing | Do the same amount of work either way, or respond immediately and do the work after the response |
| Sessions after reset | Delete **all** of them — the person resetting may be locked out *because* someone else is in |
| Auto-login after reset | No. Send them to the login page. A reset link should not also be a login link |
| Two-factor (US-34) | A reset must **not** disable or bypass it |
| Deactivated users | Behave as if the account did not exist |

### Where it touches this codebase

- `apps/api/src/modules/auth/` — two endpoints, service functions.
- `apps/api/src/lib/` — a `mailer.ts` with one function, `sendPasswordReset(email, url)`,
  that logs in development and test.
- `apps/api/src/lib/sessions.ts` — `deleteUserSessions` already exists.
- `packages/shared/src/schemas.ts` — reuse `passwordSchema` for the new password.
- `apps/web/src/pages/auth/` — two pages; `AcceptInvitePage.tsx` is nearly the same UI.

### Hints

1. Claim the token the way `acceptInvite` does: a conditional update that only one
   request can win, inside the transaction that changes the password.
2. "A new link invalidates earlier ones": delete the user's existing unused rows when
   creating a new one.
3. The mailer in test mode should **record** what it would have sent, so a test can read
   the link. Do not return the link in the HTTP response "for convenience in dev" — that
   convenience ships.
4. Rate-limit by email *and* by IP. By email alone, an attacker can spam a victim's
   inbox from many addresses; by IP alone, they can enumerate from one.
5. Audit `user.password_reset_requested` and `user.password_reset`. Never the token.
6. The reset URL is built from `config.webOrigin`, like `buildAcceptUrl`. Never from the
   request's `Host` header — a forged header would put an attacker's domain in the email.

### How to test it

- Unknown email and known email return the same status and body.
- The full flow: request → read the link from the test mailer → reset → old password
  fails, new one works.
- The token cannot be reused; an older token stops working when a newer one is issued;
  an expired one fails.
- Every session of the user is gone after a reset.
- Rate limiting.

### What goes wrong

- "No account found for that address."
- Tokens stored in plaintext.
- Building the link from the `Host` header.
- Leaving sessions alive after a reset.
- Logging the token or the full URL in production.

### Questions to be able to answer

- What can an attacker learn from your forgot-password endpoint, and how did you check?
- Why delete *all* sessions rather than keep the current one (as change-password does)?
- Where exactly would a real email provider plug in, and what would not need to change?

---

## US-36 — Custom roles

> As a client admin of a larger company, I want to create a "Payroll clerk" role that can
> prepare and submit payroll but not approve it or see the audit log, so that people get
> exactly the access their job needs.

### Acceptance criteria

- The system has a defined list of **permissions** (for example `payroll.submit`,
  `payroll.approve`, `workers.read`).
- The four built-in roles are expressed as sets of permissions and behave exactly as
  today.
- A client admin can create a custom role from that list and assign it to a teammate.
- Every endpoint checks a permission, not a role name.
- The web app shows or hides actions from the same permission list.
- Nobody can grant a permission they do not hold.

### The concept: roles are bundles; permissions are the unit

Today, endpoints ask *"is this user a `client_admin`?"* That is **role-based** checking,
and it has one flaw: the role name is hard-coded into the code. A new kind of job needs a
new role, which means editing every guard that should include it.

Turn it around. Endpoints ask *"may this user do `payroll.approve`?"* A **permission**
names an action. A **role** is just a named set of permissions. Now:

- code refers only to permissions, which change rarely;
- roles are *data*, and adding one touches no code.

This is the same move the build journal made repeatedly — statutory rules as data, state
machines as data. Things that vary per customer should be rows, not `if` statements.

### The design decision

| Question | Recommendation |
| --- | --- |
| Where is the permission list defined? | In `packages/shared`, as a const tuple like the other enums. Both the API and the web app need it, and a typo should be a compile error |
| Granularity | Action-level (`payroll.approve`), not endpoint-level. Around 25–35 for this app. Too coarse and you rebuilt roles; too fine and nobody can reason about them |
| Built-in roles | Keep them, defined as constant permission sets in code. They are also the migration path: existing users change nothing |
| Custom roles | A `roles` table per organization with a permission array |
| When are permissions resolved? | Once per request, in `authenticate`, onto the `Actor` |
| The worker role | Stays special. "Only your own record" is not a permission; it is a **scoping rule** (see below) |
| Platform admin | Stays a separate concept above tenants, not a role inside one |

**Permission versus scope.** "May approve payroll" is a *permission*. "May see only their
own payslips" is a *scope* — a restriction on *which rows*. They are different questions
and trying to express scopes as permissions is how these systems get tangled. Keep
`resolveWorkerId` / `assertCanAccessWorker` exactly as they are.

**Privilege escalation is the whole risk.** If a user with `team.manage` can create a
role containing `payroll.approve` and assign it to themselves, the permission system has
a hole in the middle. The rule: **you can only grant permissions you hold.**

### Where it touches this codebase

- `packages/shared/src/enums.ts` — `USER_ROLES`; add the permission list and the built-in
  role → permission map.
- `apps/api/src/lib/actor.ts` — add `permissions: ReadonlySet<Permission>` to `Actor`;
  `assertRole` becomes `assertCan`.
- `apps/api/src/middleware/auth.ts` — `requireRole`, `requireStaff`, `requireAdmin`,
  `requirePlatformAdmin` are used on roughly sixty routes. This is the bulk of the work.
- `docs/api-contract.md` — the "Who" column of every table.
- `apps/web/src/lib/auth.tsx` — `isAdminRole` and friends; `SessionUser` should carry
  permissions.
- `apps/web/src/components/layout/AppShell.tsx` — `navFor`.

### Hints

1. **Refactor before you extend.** First change: introduce permissions, map the four
   existing roles onto them, replace every `requireRole(...)` with `requirePermission(...)`
   — with **no behaviour change**. The existing 385 tests are your proof: they contain a
   role-permission test for nearly every endpoint. If they all pass, the mapping is
   right. Only then add custom roles.
2. Build the mapping from the contract: go through `docs/api-contract.md` table by table
   and derive the permissions from the "Who" column. Where two endpoints always share
   the same "Who", they may share a permission.
3. `users.role` is a Postgres enum. A custom role cannot be an enum value. Add a nullable
   `custom_role_id`; when set, it replaces the built-in role's permission set. Keep the
   enum for the built-ins.
4. Enforce escalation in the service: `requested ⊆ actor.permissions`, for both creating
   a role and assigning one.
5. Changing a role's permissions should take effect on the next request — it does, for
   free, because `authenticate` re-reads the user every request (build journal, chapter
   8.5). Do not cache permissions in the session.
6. Send the permission list to the web app in `SessionUser`. The UI check
   (`can('payroll.approve')`) and the server check then use the same strings.
7. Deleting a role that people hold: refuse, or reassign. Decide.

### How to test it

- All existing tests pass after the refactor, unchanged.
- A custom "payroll clerk" can submit but gets 403 on approve and on the audit log.
- A user cannot create or assign a role containing a permission they lack.
- Changing a role's permissions affects the holder's very next request.
- A role from tenant A cannot be assigned in tenant B.

### What goes wrong

- Checking permissions in the UI and roles on the server.
- Privilege escalation through role editing.
- Modelling "own records only" as a permission.
- Caching permissions in a token or session, so a revoked permission keeps working.

### Questions to be able to answer

- What is the difference between a permission and a scope? Give an example of each from
  this system.
- How do you know your refactor did not change who can do what?
- What stops a team manager from making themselves an approver?

---

## US-37 — See and end my sessions

> As a user, I want to see where I am signed in and sign out a specific device, so that
> I can deal with a lost laptop without signing out everywhere.

Part 1's US-07 ended *all* sessions. This story is the fine-grained version, plus two
policies that security teams ask for.

### Acceptance criteria

- `GET /auth/sessions` lists the caller's sessions: device description, created, last
  active, and which one is current.
- `DELETE /auth/sessions/:id` ends one — only if it belongs to the caller.
- Sessions expire after 30 days in total **and** after 7 days of inactivity.
- The session token is rotated at login-sensitive moments.
- The session list never exposes a token or its hash.

### The concept: a session has a lifecycle

A session is a server-side record that says "the holder of this token is user X". Three
separate questions govern how long it stays valid:

- **Absolute timeout** — the longest any session may live, however active. Limits how
  long a stolen token is useful. (Today: `SESSION_TTL_HOURS`, seven days, the only rule.)
- **Idle timeout** — how long since it was last used. A session nobody is using is all
  risk and no benefit.
- **Revocation** — ended explicitly: logout, "end this session", password change,
  deactivation.

Server-side sessions make all three trivial (ADR 0004); they are precisely what a
self-contained token cannot do without extra machinery.

**Rotation** is the fourth idea. If the token never changes, anything that ever captured
it stays valid for the session's whole life. Issuing a new token at moments when
privilege changes — and invalidating the old one — shrinks that window. It also defeats
**session fixation**, where an attacker plants a known token in a victim's browser before
they log in.

### The design decision

| Question | Recommendation |
| --- | --- |
| Tracking "last active" | A `last_seen_at` column. But updating it on every request turns every read into a write. Update only if it is older than a few minutes — one conditional `UPDATE` |
| Idle timeout check | In `findSession`: reject when `last_seen_at` is too old. Do it in SQL, in the same query |
| Device description | Parse the stored `user_agent` into "Chrome on Windows" for display. Never trust it for security — the client sends whatever it likes |
| IP / location | Store the IP at creation. Geolocation is out of scope; "IP address 203.0.113.7" is honest |
| When to rotate | After login (already a new session), after password change, after enabling two-factor |
| Ending the current session via this endpoint | Allow it; it is equivalent to logout. Clear the cookie in that case |

### Where it touches this codebase

- `apps/api/src/lib/sessions.ts` — `createSession`, `findSession`,
  `deleteExpiredSessions`.
- `apps/api/src/db/schema.ts` — `sessions` has `userAgent`, `expiresAt`, `createdAt`;
  add `last_seen_at`, `ip`.
- `apps/api/src/middleware/auth.ts` — sets `req.sessionId`; the place a "touch" happens.
- `apps/api/src/modules/auth/routes.ts` — new endpoints.
- A new web page, linked from the user menu in `AppShell.tsx`.

### Hints

1. The delete must be scoped: `WHERE id = $1 AND user_id = $actor`. Someone else's
   session id returns 404 — the same rule as tenant isolation, applied to users. Write
   this test first; it is an IDOR waiting to happen.
2. The "touch": `UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at
   < now() - interval '5 minutes'`. Most requests match zero rows and cost almost
   nothing.
3. Do not await the touch before answering if you can avoid it — but then handle its
   failure (log it; never let it crash the process).
4. The DTO for a session is an explicit list of fields: id, description, created, last
   seen, `current: boolean`. Not `tokenHash`. The build journal's rule about never
   returning a row matters most on exactly this table.
5. Compute `current` by comparing each row's id with `req.sessionId`.
6. Rotation = create a new session row, delete the old one, set the new cookie, in one
   transaction. Test that the old token is dead.

### How to test it

- Two sessions listed; exactly one marked current.
- Ending the other one makes its client get 401; the current one still works.
- Another user's session id → 404, and that session still works.
- Set `last_seen_at` to eight days ago in the test → the session is rejected.
- The list response contains no hash (assert on the raw JSON text).

### What goes wrong

- Deleting by id without checking the owner.
- Writing `last_seen_at` on every request.
- Returning the row.
- Trusting the user-agent string for anything but display.

### Questions to be able to answer

- Why have both an absolute and an idle timeout?
- What attack does rotating the token after login prevent?
- What is the cost of "last active" tracking, and how did you bound it?

---

## US-38 — An audit log that shows tampering

> As an auditor, I want to be able to prove that the audit log has not been altered, so
> that I can rely on it as evidence.

### Acceptance criteria

- Each audit entry is cryptographically linked to the one before it.
- A verification endpoint reports whether a tenant's chain is intact, and if not, where
  it breaks.
- Altering, deleting or inserting an entry in the middle is detected.
- The application's database role cannot `UPDATE` or `DELETE` audit rows.
- Normal operation is not noticeably slower.

### The concept: tamper-evident, not tamper-proof

The audit log's header says entries "cannot be edited or deleted" — but that is only
true of the *application*. Anyone with database access can run an `UPDATE`. Nothing would
show it.

You cannot make a log impossible to alter while someone has write access to the storage.
What you *can* do is make alteration **detectable**. That is the difference between
tamper-*proof* (not achievable here) and tamper-*evident* (achievable, and what auditors
actually ask for).

The tool is a **hash chain**. Each entry stores a hash computed from its own content
*and the previous entry's hash*:

```
entry 1:  hash1 = H(content1 + "")
entry 2:  hash2 = H(content2 + hash1)
entry 3:  hash3 = H(content3 + hash2)
```

Change entry 2's content and its hash no longer matches. "Fix" its hash and entry 3's
link is broken — and so on to the end. To alter one entry undetected, an attacker must
recompute every later hash. It is the same structure as git commits and blockchains,
without any of the rest.

Even that is detectable if the **latest hash is stored somewhere the attacker cannot
reach** — printed in a daily report, sent to another system, signed with a key held
elsewhere. That external copy is called an *anchor*. Without one, someone with full
database access can rewrite the entire chain consistently. Be honest about that limit.

### The design decision

| Question | Recommendation |
| --- | --- |
| One chain or one per tenant? | **Per tenant.** A tenant can then verify its own log without seeing others', and tenants do not contend with each other |
| What goes into the hash? | Every field that matters, in a fixed order, in a **canonical** encoding |
| Ordering | A per-tenant sequence number. `created_at` is not unique — entries written in one transaction share a timestamp (the audit service has a comment about exactly this) |
| Concurrency | Two transactions appending to one tenant's chain must not both read the same "previous hash". They must be serialised |
| Verification | Recompute from the start and compare. Linear in the log size — make it a job or paginate it for a large log |
| Database-level protection | Revoke `UPDATE` and `DELETE` on the table from the application role; optionally a trigger that raises on them |

**Canonical encoding is where this goes wrong.** `metadata` is JSON. `{"a":1,"b":2}` and
`{"b":2,"a":1}` are the same object and different bytes — and Postgres `jsonb` does not
preserve key order. If you hash the JSON as your code happens to serialise it today, and
verify with whatever order comes back from the database tomorrow, every entry looks
tampered with. You must define the byte representation exactly: sorted keys, no
whitespace, a fixed timestamp format.

### Where it touches this codebase

- `apps/api/src/lib/audit.ts` — `recordAudit` is the only writer. That single choke
  point is what makes this story feasible.
- `apps/api/src/db/schema.ts` — `audit_logs` gains `sequence`, `prev_hash`, `hash`.
- `apps/api/src/modules/audit/` — a verify endpoint.
- A migration that back-fills hashes for existing rows.
- Depends on the database role work in US-33 for the revoke.

### Hints

1. **Serialising appends.** Inside the caller's transaction, take a lock for this tenant
   before reading the previous hash. Options: `SELECT … FOR UPDATE` on the organization
   row; or a transaction-level advisory lock keyed by the tenant
   (`pg_advisory_xact_lock`). The advisory lock does not block ordinary reads of the
   organization row. Either way it is released automatically at commit.
2. That lock means every audited action in one tenant now queues behind every other.
   Measure it. For this system's write volume it is fine; know at what volume it would
   not be.
3. `recordAudit` is called with `tx` *or* `db`. A chain append **must** be in a
   transaction (read previous, write next, atomically). Calls passing bare `db` need to
   change — find them.
4. Several audit rows in one transaction: each must chain to the previous one written in
   that same transaction. Read the latest *including your own uncommitted rows* — which
   a query inside the transaction does naturally.
5. Timestamp in the hash: use the value you *store*, read back from the database, not a
   JavaScript `Date` you made beforehand — the precisions differ (the same trap as the
   cursor in US-28).
6. Platform-level events have `organization_id` NULL. They need their own chain.
7. Back-filling: existing rows have no natural total order beyond `(created_at, id)`.
   Use that once, document it, and note that the back-filled part of the chain is weaker
   evidence than what follows.

### How to test it

- Write several entries; verify → intact.
- `UPDATE` one row's metadata directly in the test; verify → broken at that sequence.
- `DELETE` a middle row → broken (a gap in the sequence).
- Alter the **last** row and recompute its hash → *not detected*. Write this test too,
  with a comment explaining why: it is the limitation an external anchor exists to cover.
- Twenty concurrent audited actions in one tenant → the chain is intact and the sequence
  has no gaps or duplicates.
- Verifying tenant A does not read tenant B's rows.

### What goes wrong

- Non-canonical JSON.
- Ordering by timestamp.
- No serialisation, producing two entries with the same predecessor — a fork.
- Believing the chain proves more than it does without an anchor.

### Questions to be able to answer

- What exactly can your design detect, and what can it not?
- Why does the hash include the previous hash rather than just the content?
- What is an anchor, and where would you put one for this system?
