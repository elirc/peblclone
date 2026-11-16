# Stories 6–10 — junior: across the stack

Not implemented. See the [index](README.md) for how to use these and for the warning
about line numbers.

---

## US-06 — A request id on every response

**Level:** junior · **Area:** api · **Size:** ~2 hours

> As a support engineer, I want every API response to carry a request id that also
> appears in the server logs, so that when a customer reports "it failed at 14:02" I can
> find the exact log lines.

### Acceptance criteria

- Every response has an `X-Request-Id` header.
- If the caller sends a well-formed `X-Request-Id`, it is reused; otherwise the server
  generates one.
- A malformed incoming id is ignored (never written to logs or echoed back).
- A `500` response body includes the id, so a user can quote it.
- The same id is on the request's log lines.

### Files

- `apps/api/src/middleware/request-id.ts` (new)
- `apps/api/src/app.ts` (change)
- `apps/api/src/middleware/error-handler.ts` (change)
- `packages/shared/src/dto.ts` (change)
- `apps/api/src/test/request-id.test.ts` (new)

### Steps

**1. Create `apps/api/src/middleware/request-id.ts`:**

```ts
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Letters, digits, dash, underscore; 8–64 characters. Anything else is discarded. */
const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Give every request an id and echo it in the response.
 *
 * An upstream proxy may already have assigned one, in which case we keep it so
 * the whole chain shares a single id. But the header is caller-controlled text
 * that ends up in our LOGS — so it is validated first. An attacker must not be
 * able to forge log lines by sending a header with newlines in it.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get('x-request-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.id = id; // pino-http reads req.id for its `reqId` field
  res.setHeader('X-Request-Id', id);
  next();
}
```

`req.id` exists as a type because `pino-http` (already a dependency) declares it on the
request. If TypeScript says the property does not exist, add
`import 'pino-http';` at the top of the file to bring that declaration in.

**2. Register it — first.** In `app.ts`, add the import:

```ts
import { requestId } from './middleware/request-id';
```

and place it immediately after `app.use(helmet());` (line 26), **before** the `pinoHttp`
block, so the logger sees the id:

```ts
  app.use(helmet());
  app.use(requestId);
  if (!config.isTest) {
```

Update the comment block above `createApp` that lists the pipeline order — it should now
read `security headers -> request id -> logging -> …`. Comments that describe order must
change when the order does.

**3. Put the id in the 500 response and its log line.** In `error-handler.ts`, find
(line 41):

```ts
  logger.error({ err, method: req.method, path: req.path }, 'Unhandled error');
  const body: ApiErrorBody = {
    error: { code: 'internal_error', message: 'Something went wrong on our side' },
  };
```

Change to:

```ts
  const requestId = typeof req.id === 'string' ? req.id : undefined;
  logger.error({ err, method: req.method, path: req.path, requestId }, 'Unhandled error');
  const body: ApiErrorBody = {
    error: {
      code: 'internal_error',
      message: 'Something went wrong on our side',
      ...(requestId && { requestId }),
    },
  };
```

**4. Allow the field in the shared type.** In `packages/shared/src/dto.ts`, find
`export interface ApiErrorBody` and add one optional field inside `error`:

```ts
    /** Field-level problems for validation errors: { "email": ["Invalid email"] } */
    details?: Record<string, string[]>;
    /** Present on 500s. Quote it to support so they can find the server logs. */
    requestId?: string;
```

### Tests

`apps/api/src/test/request-id.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { anonymous, client } from './helpers';

describe('X-Request-Id', () => {
  it('is generated when the caller sends none', async () => {
    const res = await anonymous().get('/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is different for every request', async () => {
    const a = await anonymous().get('/health');
    const b = await anonymous().get('/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('reuses a well-formed id from the caller', async () => {
    const res = await client(undefined, { 'X-Request-Id': 'trace-abc-12345' }).get('/health');
    expect(res.headers['x-request-id']).toBe('trace-abc-12345');
  });

  it('discards a malformed id instead of echoing it', async () => {
    const res = await client(undefined, { 'X-Request-Id': 'bad id with spaces' }).get('/health');
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is present on error responses too', async () => {
    const res = await anonymous().get('/auth/me'); // 401
    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});
```

### Verify

```bash
cd apps/api && npx vitest run src/test/request-id.test.ts
npm run dev:api
curl -i http://localhost:4000/api/v1/health | grep -i x-request-id
```

In the dev server's log output, each request line should now show the same id as the
header. If it shows a small counter instead (`1`, `2`, `3`), pino-http is not picking up
`req.id` — pass it explicitly: `pinoHttp({ logger, genReqId: (req) => req.id, … })`.

### Pitfalls

- Order. Register the middleware after `pinoHttp` and the log lines will not have the id.
- Do not skip the validation "because it is only a header". Log injection is a real
  attack: text an attacker controls, written to a file that people trust.

### Stretch

Show the id in the web app's `ErrorState` component when the error is a 500, so a user
can copy it into a support ticket. `ApiError` in `apps/web/src/lib/api.ts` would need to
carry it.

---

## US-07 — Log out of all devices

**Level:** junior · **Area:** api + web · **Size:** ~3 hours

> As a user who signed in on a shared computer and forgot to log out, I want to end all
> my sessions from where I am now, so that nobody else can use my account.

**Why it is cheap here.** Sessions are rows in a table (ADR 0004), and
`deleteUserSessions` already exists in `apps/api/src/lib/sessions.ts` (line 64). This is
exactly what server-side sessions were chosen for.

### Acceptance criteria

- `POST /api/v1/auth/logout-all` deletes every session of the caller, clears the cookie,
  writes an audit record, and answers `204`.
- Afterwards a *second* browser logged in as the same user gets `401` on its next request.
- The web app offers the action behind a confirmation dialog and lands on the login page.

### Files

- `apps/api/src/modules/auth/service.ts`, `routes.ts` (change)
- `apps/api/src/modules/auth/auth.test.ts` (add tests)
- `apps/web/src/lib/auth.tsx`, `apps/web/src/components/layout/AppShell.tsx` (change)
- `docs/api-contract.md` (add a row)

### Steps — API

**1. Service function.** In `auth/service.ts`, extend the sessions import:

```ts
// anchor:
import { createSession } from '../../lib/sessions';
// change to:
import { createSession, deleteUserSessions } from '../../lib/sessions';
```

Add an import for the actor type near the other `lib` imports:

```ts
import type { Actor } from '../../lib/actor';
```

Then add at the end of the file:

```ts
/** End every session this user has, on every device, including the current one. */
export async function logoutEverywhere(actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteUserSessions(tx, actor.userId);
    await recordAudit(tx, actor, {
      action: 'user.logged_out_everywhere',
      entityType: 'user',
      entityId: actor.userId,
    });
  });
}
```

`db` and `recordAudit` are already imported in that file. The delete and the audit record
share a transaction (`CLAUDE.md`, rule 7).

**2. Route.** In `auth/routes.ts`, directly after the existing `/auth/logout` handler
(lines 44–48):

```ts
authRouter.post('/auth/logout-all', authenticate, async (req, res) => {
  await service.logoutEverywhere(getActor(req));
  clearSessionCookie(res);
  res.status(204).end();
});
```

`getActor` and `clearSessionCookie` are already imported there.

**3. Contract.** In `docs/api-contract.md`, in the Auth table, add after the logout row:

```
| POST | `/auth/logout-all` | any | → 204 (ends every session of the caller) |
```

### Tests — API

In `auth.test.ts`, inside `describe('sessions', …)`:

```ts
  it('logout-all ends every session of the user, on every device', async () => {
    const { adminUser } = await createTenant();
    const laptop = await loginAs(adminUser);
    const phone = await loginAs(adminUser);
    expect((await phone.get('/auth/me')).status).toBe(200);

    expect((await laptop.post('/auth/logout-all')).status).toBe(204);

    expect((await laptop.get('/auth/me')).status).toBe(401);
    expect((await phone.get('/auth/me')).status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('logout-all does not touch other users', async () => {
    const { org, admin } = await createTenant();
    const other = await loginAs(await createUser('client_manager', org.id));

    await admin.post('/auth/logout-all');

    expect((await other.get('/auth/me')).status).toBe(200);
  });
```

All the helpers used are already imported in that file. The second test is the important
one: a bug that deleted *all* sessions would pass the first test.

### Steps — web

**4. Auth context.** In `apps/web/src/lib/auth.tsx`, add to the `AuthContextValue`
interface, under `logout(): Promise<void>;`:

```ts
  /** End every session on every device, then drop to the login screen. */
  logoutEverywhere(): Promise<void>;
```

Inside `useMemo`, the existing `logout` looks like this:

```ts
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } finally {
          setActingOrgId(null);
          setActingOrgState(null);
          dropCachedData();
          queryClient.setQueryData(keys.me, null);
        }
      },
```

Both actions end the same way, so pull the shared part into a local function just above
the `return {` inside `useMemo`, and use it twice:

```ts
    const endSession = async (path: string) => {
      try {
        await api.post(path);
      } finally {
        setActingOrgId(null);
        setActingOrgState(null);
        dropCachedData();
        queryClient.setQueryData(keys.me, null);
      }
    };
```

```ts
      logout: () => endSession('/auth/logout'),
      logoutEverywhere: () => endSession('/auth/logout-all'),
```

**5. The button.** In `AppShell.tsx`, `UserMenu` starts at line 156. Add `useState` is
already imported at the top; add `ConfirmDialog` to the import from `'../ui'`:

```ts
import { Badge, ConfirmDialog } from '../ui';
```

and an icon to the `lucide-react` import list (for example `ShieldOff` — check it exists
in the installed version; any icon will do).

Change the first lines of `UserMenu`:

```tsx
function UserMenu() {
  const user = useUser();
  const { logout, logoutEverywhere } = useAuth();
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
```

Add a second button immediately **before** the existing "Log out" `<button>`:

```tsx
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 hover:text-ink-900"
        aria-label="Log out of all devices"
        title="Log out of all devices"
      >
        <ShieldOff className="h-4 w-4" />
      </button>
```

and the dialog just before the closing `</div>` of the component:

```tsx
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Log out of all devices?"
        confirmLabel="Log out everywhere"
        danger
        loading={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            await logoutEverywhere();
            navigate('/login');
          } finally {
            setBusy(false);
          }
        }}
      >
        This ends your session here and on every other browser and device where you are
        signed in. You will need to sign in again.
      </ConfirmDialog>
```

### Verify

`cd apps/api && npx vitest run src/modules/auth`, `npx tsc -p apps/web`, then by hand:
sign in as `admin@acme.test` in two different browsers, use the new button in one, and
click anything in the other.

### Pitfalls

- Clearing the cookie is a courtesy to *this* browser. What actually ends the other
  sessions is deleting the rows. The second test proves the server side.
- In the `finally` block the local state is cleared even if the request fails — a user
  who clicks "log out" must never be left looking logged in.

### Stretch

Add a test in `apps/web/src/lib/auth.test.tsx` for `logoutEverywhere`, modelled on the
existing "forgets you immediately after logout" test.

---

## US-08 — Refuse start dates more than a year away

**Level:** junior · **Area:** api · **Size:** ~1 hour

> As a client admin, I want to be stopped when I mistype a start date as 2062 instead of
> 2026, so that I do not create a worker who never appears in payroll.

### Acceptance criteria

- Hiring with a `startDate` more than 365 days after today answers
  `400 validation_error` with the message on the `startDate` field.
- Exactly 365 days ahead is accepted.
- Past start dates are still accepted (people are onboarded retroactively).
- Nothing is created when the request is refused.

### Files

- `apps/api/src/modules/workers/service.ts` (change)
- `apps/api/src/modules/workers/workers.test.ts` (add tests)
- `packages/shared/src/constants.ts` (add a constant)
- `docs/api-contract.md` (add a rule)

### Why in the service, not the zod schema?

The schema in `packages/shared` is shared with the browser and is a pure description of
shape. "More than a year from **today**" depends on the clock, and a schema that reads
the clock gives different answers at different moments — hard to test, and wrong if the
browser's clock is off. Time-dependent rules belong in the service.

### Steps

**1. The constant.** In `packages/shared/src/constants.ts`, add:

```ts
/** A hire's start date may be at most this many days in the future. */
export const MAX_START_DATE_DAYS_AHEAD = 365;
```

**2. Imports.** In `workers/service.ts`, the first import block (lines 1–18) pulls names
from `@meridian/shared`. Add three, keeping the list alphabetical:

```ts
import {
  addDays,
  canTransition,
  DOCUMENT_KIND_LABELS,
  MAX_START_DATE_DAYS_AHEAD,
  toIsoDate,
  WORKER_TRANSITIONS,
  // …types unchanged
```

**3. The check.** In `createWorker` (line 238), find the EOR check that ends just before
the transaction (anchor, lines 252–256):

```ts
  if (input.type === 'employee' && !country.eorSupported) {
    throw badRequest(`Meridian cannot employ people in ${country.name} yet`, 'eor_not_supported');
  }

  return db.transaction(async (tx) => {
```

Insert between the closing `}` and `return db.transaction`:

```ts
  // Catches typos like 2062 for 2026. ISO dates compare correctly as strings.
  const latestStart = addDays(toIsoDate(new Date()), MAX_START_DATE_DAYS_AHEAD);
  if (input.startDate > latestStart) {
    throw validationError({
      startDate: [`Start date can be at most ${MAX_START_DATE_DAYS_AHEAD} days from today`],
    });
  }
```

`validationError` is already imported. Using it (rather than `badRequest`) means the
response has `details.startDate`, so the web form shows the message **on the field**
with no frontend change — `useZodForm` already maps server details onto inputs.

It goes *before* the transaction on purpose: refuse early, before any row is written.

**4. Contract.** In `docs/api-contract.md`, under **Hire (`POST /workers`)**, add a
bullet:

```
  - `startDate` more than `MAX_START_DATE_DAYS_AHEAD` (365) days after today →
    `400 validation_error` on `startDate`.
```

### Tests

Append inside `describe('review fixes', …)` (line 896) or a new `describe` at the end of
`workers.test.ts`. `hireBody` is defined in that block; add
`import { addDays, toIsoDate } from '@meridian/shared';` at the top of the file if those
names are not already imported.

```ts
  it('refuses a start date more than a year away, on the startDate field', async () => {
    const { org, admin } = await createTenant();
    const tooFar = addDays(toIsoDate(new Date()), 366);

    const res = await admin
      .post('/workers')
      .send({ ...hireBody, email: 'far@example.test', startDate: tooFar, sendInvite: false });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details.startDate).toBeDefined();
    expect(await db.select().from(workers).where(eq(workers.organizationId, org.id))).toHaveLength(0);
  });

  it('accepts a start date exactly 365 days away, and one in the past', async () => {
    const { admin } = await createTenant();
    const edge = addDays(toIsoDate(new Date()), 365);

    const future = await admin
      .post('/workers')
      .send({ ...hireBody, email: 'edge@example.test', startDate: edge, sendInvite: false });
    const past = await admin
      .post('/workers')
      .send({ ...hireBody, email: 'past@example.test', startDate: '2020-01-06', sendInvite: false });

    expect(future.status).toBe(201);
    expect(past.status).toBe(201);
  });
```

The boundary test (exactly 365) is the one that catches `>=` written instead of `>`.

### Verify

`cd apps/api && npx vitest run src/modules/workers`. Also run the journey test and the
seed — both hire people, and the seed hires two with start dates next month:

```bash
npx vitest run src/test/journey.test.ts
npx tsx src/db/seed.ts --reset
```

### Pitfalls

- "Today" on the server is UTC here (`toIsoDate(new Date())`). A user in Auckland at 8am
  is already on the next calendar day. For a 365-day sanity limit that does not matter;
  for a rule like "not before today" it would.
- A test that runs at midnight UTC can straddle two days. These tests compute both dates
  from the same `new Date()` moments apart; accept the one-in-a-million flake or inject a
  clock (see the .NET journal, chapter 6.6, for what that looks like).

### Stretch

`PATCH /workers/:id` also accepts `startDate` (only while onboarding). Apply the same
limit there. Where should the shared check live so the two call sites cannot drift?

---

## US-09 — Hire in South Korea

**Level:** junior · **Area:** reference data · **Size:** ~2 hours

> As a client, I want to hire employees in South Korea, so that I can build a team in
> Seoul.

**Why this story is more interesting than it looks.** The Korean won, like the yen, has
**no minor unit** — there are no "cents" of a won. The build journal's worst bug (chapter
17) was a currency conversion that was wrong by 100× for exactly this kind of currency.
Adding the *second* zero-decimal country is the test of whether that fix was general.

### Acceptance criteria

- South Korea appears in the country list, the cost calculator and the hire form.
- A Korean worker's salary is stored in whole won (`50000000` means ₩50,000,000).
- A payroll run for Korea produces a USD invoice of the right magnitude.
- The sign-up page no longer says "14 countries".

### Files

- `apps/api/src/db/reference-data.ts` (change)
- `packages/shared/src/primitives.test.ts` (add a test)
- `apps/api/src/test/review-fixes.test.ts` (add a test)
- `apps/web/src/pages/auth/RegisterPage.tsx` (change two lines)

### Steps

**1. Check the currency is already known.** Open `packages/shared/src/money.ts`, line 31:

```ts
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND', 'CLP']);
```

`KRW` is there. If it were not, `formatMoney` would print ₩50,000,000 as ₩500,000.00 and
the conversion would be 100× off. **Always check this list when adding a currency.**

**2. Add the country.** In `reference-data.ts`, `COUNTRY_SEEDS` ends with the Japan block
(lines 299–320) followed by `];` on line 321. Add a new object after Japan's closing
`},`:

```ts
  {
    code: 'KR',
    name: 'South Korea',
    region: 'Asia Pacific',
    currency: 'KRW',
    employer: [
      r('national_pension', 'National pension', 450),
      r('health', 'National health insurance', 355),
      r('employment', 'Employment insurance', 115),
      r('accident', 'Industrial accident insurance', 70),
    ],
    employee: [
      r('income_tax', 'Income tax withholding (est.)', 1000),
      r('national_pension', 'National pension', 450),
      r('health', 'National health insurance', 355),
    ],
    feeUsd: 59_900,
    leave: 15,
    notice: 30,
    probation: 90,
    docs: ['national_id', 'bank_proof', 'tax_form'],
  },
```

These rates are illustrative, like every other country's (see the file's header comment).
Rates are basis points: `450` is 4.5%.

**3. Add the exchange rate.** In `FX_SEEDS` (line 324), after `JPY: '151.00',`:

```ts
  KRW: '1380.00',
```

Skip this and approving a Korean payroll run fails with `409 fx_rate_missing` — which is
the correct, safe behaviour, and worth seeing once: try it before adding the rate.

**4. Sign-up page.** In `RegisterPage.tsx`, add to the `HQ_COUNTRIES` array:

```ts
  ['KR', 'South Korea'],
```

and change the subtitle (line 49) from `14 countries` to `15 countries`.

### Tests

**A. The conversion, in isolation.** In `packages/shared/src/primitives.test.ts`, inside
`describe('money', …)`, next to the yen test:

```ts
  it('converts won, which also has no minor unit', () => {
    const usd = { currency: 'USD', perUsd: '1' };
    const krw = { currency: 'KRW', perUsd: '1380' };
    // ₩1,380,000 is $1,000.00 = 100,000 cents.
    expect(convertMinor(1_380_000, krw, usd)).toBe(100_000);
    expect(formatMoney(50_000_000, 'KRW')).toBe('₩50,000,000');
  });
```

**B. End to end.** In `apps/api/src/test/review-fixes.test.ts`, inside
`describe('review: currencies without a minor unit', …)`, add a test modelled on the
Japanese one directly above it. Work the expected numbers out **by hand first**:

- salary ₩60,000,000 / year → ₩5,000,000 / month (`grossMinor` 5,000,000)
- employer rate 4.5 + 3.55 + 1.15 + 0.7 = 9.9% → ₩495,000
- at 1380 KRW per USD: 5,000,000 / 1380 = $3,623.19 → `362_319` cents
- 495,000 / 1380 = $358.70 → `35_870` cents
- fee `59_900`

```ts
  it('bills a Korean payroll run at the right magnitude', async () => {
    const { org, admin } = await createTenant();
    await createWorker(org.id, { countryCode: 'KR', salaryMinor: 60_000_000 });
    const now = new Date();

    const run = await admin.post('/payroll/runs').send({
      countryCode: 'KR',
      periodYear: now.getUTCFullYear(),
      periodMonth: now.getUTCMonth() + 1,
    });
    expect(run.status).toBe(201);
    expect(run.body.grossMinor).toBe(5_000_000);
    expect(run.body.employerCostMinor).toBe(495_000);

    await admin.post(`/payroll/runs/${run.body.id}/submit`).expect(200);
    const approved = await admin.post(`/payroll/runs/${run.body.id}/approve`).expect(200);
    const invoice = await admin.get(`/invoices/${approved.body.invoiceId}`).expect(200);

    const line = (kind: string) =>
      (invoice.body.lines as { kind: string; amountMinor: number }[]).find((l) => l.kind === kind)
        ?.amountMinor;
    expect(line('gross_pay')).toBe(362_319);
    expect(line('employer_cost')).toBe(35_870);
    expect(line('platform_fee')).toBe(59_900);
  });
```

If your hand calculation and the test disagree, **find out which is wrong before changing
either**. Check the rounding: 5,000,000 / 1380 = 3623.188…, which rounds to 3623.19.

### Verify

```bash
(cd packages/shared && npx vitest run)
(cd apps/api && npx vitest run src/test/review-fixes.test.ts src/modules/countries)
npm run db:seed          # adds the new country to meridian_dev without wiping anything
```

`countries.test.ts` asserts the list length equals `COUNTRY_SEEDS.length`, so it adapts
by itself. Then open the cost calculator and price a ₩60,000,000 salary.

### Pitfalls

- `npm run db:seed` prints "Already seeded" — that is fine. It loads reference data
  *before* that check, and inserts new countries with `onConflictDoNothing`. It will
  **not** update a country that already exists; to change an existing country's rates in
  your dev database you need the platform admin's Countries page or SQL.
- In the hire form, type the salary as `60000000`. For a zero-decimal currency the form
  must not multiply by 100. `parseMoneyToMinor` in `money.ts` handles this — read it.

### Stretch

Add Vietnam (`VN`, `VND`) the same way. Then ask: what would have to change to support a
*three*-decimal currency such as the Kuwaiti dinar? (`minorUnitDigits` returns only 0 or
2.)

---

## US-10 — Show which organization a platform admin is inside

**Level:** junior · **Area:** web · **Size:** ~2 hours

> As a Meridian platform admin, I want the header to name the client organization I am
> working in, so that I never approve the wrong company's payroll.

**Today** the header shows a generic purple badge: "Working inside a client organization"
(`apps/web/src/components/layout/AppShell.tsx`, line 239). Which one? You cannot tell.

### Acceptance criteria

- When a platform admin has selected an organization, the header shows its name.
- While the name is loading, the generic text is shown (no flicker of empty space).
- Non-admin users see no change and make no extra request.

### Files

- `apps/web/src/components/layout/AppShell.tsx` (change)

### Steps

**1. Imports.** At the top of `AppShell.tsx`:

```ts
import type { OrganizationDto, SessionUser } from '@meridian/shared';
import { useQuery } from '@tanstack/react-query';
```

(the first line replaces the existing `import type { SessionUser } …`), and:

```ts
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
```

**2. Fetch the organization.** In `AppShell()` (search for `export function AppShell`),
after the line `const navigate = useNavigate();`, add:

```tsx
  // Platform admins choose a tenant; show WHICH one. `enabled` keeps this from
  // running for client users (who already see their own organization's name).
  const isPlatformAdmin = isPlatformAdminRole(user);
  const actingOrg = useQuery({
    queryKey: [...keys.organization, 'acting', actingOrgId],
    queryFn: () => api.get<OrganizationDto>('/organization'),
    enabled: isPlatformAdmin && Boolean(actingOrgId),
    staleTime: 5 * 60_000,
  });
```

Two details worth understanding:

- `actingOrgId` is **in the query key**. Switch organizations and the key changes, so the
  cache can never show the previous organization's name.
- `GET /organization` returns "the organization this request runs against". For a
  platform admin that is decided by the `X-Org-Id` header, which `api.ts` attaches
  automatically from the stored acting organization.

**3. Use the name.** Replace the badge (anchor, line 239):

```tsx
                  <Badge tone="purple">Working inside a client organization</Badge>
```

with:

```tsx
                  <Badge tone="purple">
                    {actingOrg.data
                      ? `Working inside ${actingOrg.data.name}`
                      : 'Working inside a client organization'}
                  </Badge>
```

You can also replace the `isPlatformAdminRole(user) &&` two lines above with the
`isPlatformAdmin` constant you just declared.

### Tests

The shell has no test file yet. Create
`apps/web/src/components/layout/AppShell.test.tsx`. The shape — a platform-admin user
from `/auth/me`, an acting organization in `localStorage`, and a handler for
`/organization`:

```tsx
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { jsonResponse, mockFetch, renderApp } from '../../test/render';
import { useAuth } from '../../lib/auth';
import { AppShell } from './AppShell';

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const platformAdmin = {
  id: 'u1', email: 'ops@meridian.test', fullName: 'Olivia Ops', role: 'platform_admin',
  organizationId: null, organizationName: null, workerId: null,
};

/** AppShell calls useUser(), which throws until /auth/me has answered. */
function WhenSignedIn() {
  const { user } = useAuth();
  return user ? (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="*" element={<p>page</p>} />
      </Route>
    </Routes>
  ) : null;
}

describe('AppShell for a platform admin', () => {
  it('names the organization being worked in', async () => {
    window.localStorage.setItem('meridian.actingOrgId', 'org-1');
    mockFetch(({ url }) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ user: platformAdmin });
      if (url.endsWith('/organization')) return jsonResponse({ id: 'org-1', name: 'Acme Robotics' });
      return undefined;
    });
    renderApp(<WhenSignedIn />);
    expect(await screen.findByText('Working inside Acme Robotics')).toBeInTheDocument();
  });

  it('asks for no organization when none is selected', async () => {
    const { calls } = mockFetch(({ url }) =>
      url.endsWith('/auth/me') ? jsonResponse({ user: platformAdmin }) : undefined,
    );
    renderApp(<WhenSignedIn />);
    expect(await screen.findByText('Platform admin')).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/organization'))).toBe(false);
  });
});
```

The key `'meridian.actingOrgId'` comes from `ACTING_ORG_KEY` in `apps/web/src/lib/api.ts`
— confirm it there rather than trusting this document.

### Verify

`cd apps/web && npx vitest run src/components/layout`, then sign in as
`ops@meridian.test`, open Organizations, choose "Work in this organization".

### Pitfalls

- Without `enabled`, every client user would fire a pointless extra request on every page
  load.
- Without `actingOrgId` in the key, switching from Acme to Globex would briefly (or
  permanently, within `staleTime`) show the wrong name — on a screen where the wrong name
  is the whole risk.

### Stretch

Colour the header bar differently while a platform admin is inside a tenant. A change of
colour is harder to miss than a badge.
