# Stories 1–5 — junior: web and API basics

Not implemented. See the [index](README.md) for how to use these and for the warning
about line numbers.

---

## US-01 — The browser tab shows which page you are on

**Level:** junior · **Area:** web · **Size:** ~1 hour

> As anyone using Meridian with several tabs open, I want each tab's title to say which
> page it is, so that I can find the payroll tab without clicking through all of them.

**Why it matters.** Every tab currently reads "Meridian — Global employment". Page titles
are also what a screen reader announces on navigation and what appears in browser
history.

### Acceptance criteria

- On `/people` the tab reads `People · Meridian`; on `/payroll`, `Payroll · Meridian`.
- Leaving a page restores the default title.
- A page whose header title is not plain text (for example a worker's name inside a
  component) can pass an explicit title.
- No page file needs to change for the common case.

### Files

- `apps/web/src/components/ui/layout.tsx` (change)
- `apps/web/src/components/ui/layout.test.tsx` (new)

### Steps

**1. Import `useEffect`.** At the top of `layout.tsx`, line 3:

```ts
// anchor:
import type { ReactNode } from 'react';
// change to:
import { useEffect, type ReactNode } from 'react';
```

**2. Add an optional prop to `PageHeader`.** Find `export function PageHeader({` (line
48). It destructures `title, description, actions, back` and then declares their types.
Add `documentTitle` to both:

```tsx
export function PageHeader({
  title,
  description,
  actions,
  back,
  documentTitle,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Optional "back to list" link shown above the title. */
  back?: { to: string; label: string };
  /** Browser-tab title. Defaults to `title` when that is a plain string. */
  documentTitle?: string;
}) {
```

**3. Set the title in an effect.** Immediately inside the function body, before the
`return (`:

```tsx
  // The tab title is a side effect outside React's tree, so it belongs in an effect.
  const tabTitle = documentTitle ?? (typeof title === 'string' ? title : undefined);
  useEffect(() => {
    if (!tabTitle) return;
    const previous = document.title;
    document.title = `${tabTitle} · Meridian`;
    // Cleanup runs when the page unmounts or the title changes.
    return () => {
      document.title = previous;
    };
  }, [tabTitle]);
```

Why compute `tabTitle` outside the effect? So the dependency array holds a string. If you
put `title` (a `ReactNode`) in the dependency array, a page passing JSX would create a new
object every render and the effect would run every render.

### Tests

Create `apps/web/src/components/ui/layout.test.tsx`:

```tsx
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { PageHeader } from './layout';

describe('PageHeader', () => {
  it('puts a string title in the browser tab and restores it on unmount', () => {
    document.title = 'Before';
    const { unmount } = render(
      <MemoryRouter>
        <PageHeader title="People" />
      </MemoryRouter>,
    );
    expect(document.title).toBe('People · Meridian');
    unmount();
    expect(document.title).toBe('Before');
  });

  it('uses documentTitle when the visible title is not plain text', () => {
    render(
      <MemoryRouter>
        <PageHeader title={<span>Lena Fischer</span>} documentTitle="Lena Fischer" />
      </MemoryRouter>,
    );
    expect(document.title).toBe('Lena Fischer · Meridian');
  });

  it('leaves the tab alone when there is nothing to show', () => {
    document.title = 'Untouched';
    render(
      <MemoryRouter>
        <PageHeader title={<span>JSX only</span>} />
      </MemoryRouter>,
    );
    expect(document.title).toBe('Untouched');
  });
});
```

(`MemoryRouter` is needed because `PageHeader` can render a `<Link>`.)

### Verify

`cd apps/web && npx vitest run src/components/ui` then `npm run dev`, open two pages in
two tabs.

### Pitfalls

- In development React's StrictMode mounts, unmounts and re-mounts every component once.
  Your cleanup must restore the title correctly or you will see it flicker — the code
  above does.
- Do not set `document.title` during render. Render must be free of side effects.

### Stretch

Find pages whose `title` is JSX (search for `<PageHeader` with `title={`) and give them a
`documentTitle`. The worker detail page and contract detail page are good candidates.

---

## US-02 — Show / hide password

**Level:** junior · **Area:** web · **Size:** ~2 hours

> As someone signing in on a phone, I want to reveal the password I typed, so that I can
> fix a typo instead of retyping it blind.

### Acceptance criteria

- Password fields on login, sign-up and accept-invite have a toggle button.
- The button is keyboard-reachable, has an accessible name that changes with its state,
  and exposes `aria-pressed`.
- Toggling does not submit the form or move focus away from the field.
- Existing tests still pass.

### Files

- `apps/web/src/components/ui/form-controls.tsx` (add a component)
- `apps/web/src/pages/auth/LoginPage.tsx`, `RegisterPage.tsx`, `AcceptInvitePage.tsx` (use it)
- `apps/web/src/pages/auth/LoginPage.test.tsx` (adjust + add)

### Steps

**1. Add the component.** In `form-controls.tsx`, update the imports at the top:

```ts
import clsx from 'clsx';
import { Eye, EyeOff } from 'lucide-react';
import {
  useId,
  useState,
  type InputHTMLAttributes,
  // …the rest unchanged
```

Then add this **after** the `Input` function (which starts at line 63) and before
`Select`. It reuses `FieldShell`, `controlClass`, `describedBy` and `CommonProps`, which
are private to this file — that is why the new component lives here:

```tsx
/** A password field with a "show" toggle. Same props as Input, minus `type`. */
export function PasswordInput({
  label,
  hint,
  error,
  className,
  id: idProp,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & CommonProps) {
  const generated = useId();
  const id = idProp ?? generated;
  const [visible, setVisible] = useState(false);
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={rest.required}>
      <div className="relative">
        <input
          id={id}
          type={visible ? 'text' : 'password'}
          className={controlClass(Boolean(error), clsx('h-10 pr-10', className))}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          {...rest}
        />
        <button
          // type="button" is essential: the default inside a <form> is "submit".
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-500 hover:text-ink-800"
        >
          {visible ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    </FieldShell>
  );
}
```

`components/ui/index.ts` already re-exports everything from `./form-controls`, so the new
component is available without touching the index.

**2. Use it on the three pages.** In each file, add `PasswordInput` to the existing
import from `'../../components/ui'`, then replace the password `Input`.

`LoginPage.tsx` — anchor:

```tsx
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          {...form.field('password')}
        />
```

becomes (remove the `type` line; the component owns it):

```tsx
        <PasswordInput
          label="Password"
          autoComplete="current-password"
          required
          {...form.field('password')}
        />
```

Do the same in `RegisterPage.tsx` (label `"Password"`, `autoComplete="new-password"`) and
`AcceptInvitePage.tsx` (label `"Choose a password"`).

### Tests

**This change breaks an existing test — on purpose, understand why.** `LoginPage.test.tsx`
finds the field with `screen.getByLabelText(/password/i)`. Your new button has
`aria-label="Show password"`, which *also* matches `/password/i`. `getByLabelText` throws
when more than one element matches.

Fix the three occurrences in `LoginPage.test.tsx` by anchoring the pattern to the start:

```ts
screen.getByLabelText(/^password/i)
```

The label text is `Password*` (with the required asterisk), which starts with "password";
the button's name starts with "Show", so it no longer matches.

Then add a test:

```tsx
  it('reveals and hides the password without submitting the form', async () => {
    const { calls } = mockFetch(signedOut);
    renderApp(<LoginPage />);
    const field = screen.getByLabelText(/^password/i);
    await userEvent.type(field, 'secret-value');
    expect(field).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(field).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');

    // Toggling is not a submit: no POST was sent.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
```

### Verify

`cd apps/web && npx vitest run src/pages/auth`, then try it in the browser with the
keyboard only (Tab to the toggle, press Space).

### Pitfalls

- Forgetting `type="button"` makes the toggle submit the form. The test above catches it.
- Search the other builders' tests for `getByLabelText(/password/i)` before you finish:
  `grep -rn "password/i" apps/web/src`.

### Stretch

Password managers sometimes misbehave when a field's `type` changes. Read about
`autocomplete` values and confirm the browser still offers to save the password after a
toggle.

---

## US-03 — A helpful "page not found"

**Level:** junior · **Area:** web · **Size:** ~1 hour

> As a user who followed an old link, I want the "not found" page to tell me where I can
> go, so that I am not stuck on a dead end.

**Today** the catch-all route renders a bare `EmptyState` with no way forward
(`apps/web/src/routes.tsx`, line 139).

### Acceptance criteria

- An unknown path shows a heading, the path that was not found, and a button to go home.
- The tab title is "Page not found · Meridian" (if you have done US-01).
- It renders inside the app frame (sidebar still visible).

### Files

- `apps/web/src/pages/NotFoundPage.tsx` (new)
- `apps/web/src/routes.tsx` (change)
- `apps/web/src/pages/NotFoundPage.test.tsx` (new)

### Steps

**1. Create `apps/web/src/pages/NotFoundPage.tsx`:**

```tsx
import { Compass } from 'lucide-react';
import { useLocation } from 'react-router';
import { ButtonLink, EmptyState } from '../components/ui';

/** Shown for any signed-in path that matches no route. */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <EmptyState
      icon={<Compass className="h-6 w-6" aria-hidden />}
      title="Page not found"
      description={
        <>
          There is nothing at <code className="rounded bg-ink-100 px-1">{pathname}</code>. The link
          may be old, or the page may have moved.
        </>
      }
      action={<ButtonLink to="/">Go to the home page</ButtonLink>}
    />
  );
}
```

React escapes `{pathname}` when it renders it as text, so a path containing `<script>` is
displayed, not executed. Never use `dangerouslySetInnerHTML` for something that came from
the URL.

**2. Wire it in.** In `routes.tsx`, add an import next to the other page imports (around
line 9):

```ts
import { NotFoundPage } from './pages/NotFoundPage';
```

Then replace the catch-all (anchor, lines 138–143):

```tsx
          <Route
            path="*"
            element={
              <EmptyState title="Page not found" description="That address does not exist." />
            }
          />
```

with:

```tsx
          <Route path="*" element={<NotFoundPage />} />
```

`EmptyState` is still used elsewhere in `routes.tsx` (inside `RequireRole`), so keep its
import.

### Tests

`apps/web/src/pages/NotFoundPage.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NotFoundPage } from './NotFoundPage';

describe('NotFoundPage', () => {
  it('names the missing path and offers a way home', () => {
    render(
      <MemoryRouter initialEntries={['/no/such/page']}>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByText('/no/such/page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /home page/i })).toHaveAttribute('href', '/');
  });
});
```

### Pitfalls

- The catch-all sits *inside* `<Route element={<RequireAuth />}>`. A signed-out visitor to
  an unknown path is sent to the login page first. That is intended — check it by hand.

### Stretch

`RequireRole` in `routes.tsx` shows a similar dead-end ("You don't have access to this
page"). Give it a "Go to the home page" action too.

---

## US-04 — Tests for the sign-up page

**Level:** junior · **Area:** web tests · **Size:** ~2 hours

> As the team, we want the sign-up page covered by tests, so that a change to the shared
> validation rules cannot silently break the first thing a new customer sees.

**Why it matters.** `RegisterPage.tsx` has no tests. The login bug described in the build
journal (chapter 18.6) existed partly because only *failure* paths were tested. This
story is a pure test-writing task — no production code changes.

### Acceptance criteria

A new `RegisterPage.test.tsx` with at least these four tests, all passing:

1. invalid input shows errors and sends nothing;
2. valid input posts the right body, with the email normalised;
3. a server `409 email_taken` is shown to the user;
4. a server validation error is shown on the right field.

### Files

- `apps/web/src/pages/auth/RegisterPage.test.tsx` (new)
- read first: `LoginPage.test.tsx`, `apps/web/src/test/render.tsx`, `RegisterPage.tsx`,
  and `registerSchema` in `packages/shared/src/schemas.ts` (line 50)

### Steps

**1. Start from this skeleton:**

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, renderApp, signedOut } from '../../test/render';
import { RegisterPage } from './RegisterPage';

afterEach(() => vi.unstubAllGlobals());

/** Fill every field with valid values; individual tests then override one. */
async function fillValid() {
  await userEvent.type(screen.getByLabelText(/company name/i), 'Globex');
  await userEvent.type(screen.getByLabelText(/your full name/i), 'Ada Lovelace');
  await userEvent.type(screen.getByLabelText(/work email/i), '  Ada@Globex.TEST ');
  await userEvent.type(screen.getByLabelText(/^password/i), 'a-long-enough-password');
}

const submit = () => userEvent.click(screen.getByRole('button', { name: /create account/i }));
```

**2. Test 1 — client-side validation.**

```tsx
  it('shows validation errors and sends nothing when the form is invalid', async () => {
    const { calls } = mockFetch(signedOut);
    renderApp(<RegisterPage />);

    await userEvent.type(screen.getByLabelText(/work email/i), 'not-an-email');
    await userEvent.type(screen.getByLabelText(/^password/i), 'short');
    await submit();

    expect(await screen.findByText(/at least 10 characters/i, { selector: '[role="alert"]' })).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
```

The `selector` option matters: the hint under the password field *also* says "At least 10
characters". You are asserting on the **error** (which has `role="alert"`), not the hint.
When an error is shown, `FieldShell` renders the error *instead of* the hint — read
`form-controls.tsx` to see why.

**3. Test 2 — the happy path.** Return a user from the mocked `POST /auth/register` and
assert on the request body:

```tsx
  it('posts normalised values and the selected country', async () => {
    const user = {
      id: 'u1', email: 'ada@globex.test', fullName: 'Ada Lovelace', role: 'client_admin',
      organizationId: 'o1', organizationName: 'Globex', workerId: null,
    };
    const { calls } = mockFetch(signedOut, ({ url, method }) =>
      method === 'POST' && url.endsWith('/auth/register') ? jsonResponse({ user }, 201) : undefined,
    );
    renderApp(<RegisterPage />);

    await fillValid();
    await userEvent.selectOptions(screen.getByLabelText(/headquarters/i), 'DE');
    await submit();

    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      organizationName: 'Globex',
      countryCode: 'DE',
      fullName: 'Ada Lovelace',
      email: 'ada@globex.test', // trimmed and lower-cased by the shared schema
      password: 'a-long-enough-password',
    });
  });
```

**4. Test 3 — a conflict from the server.** Mock a 409:

```ts
jsonResponse({ error: { code: 'email_taken', message: 'An account with this email already exists' } }, 409)
```

and assert `await screen.findByText('An account with this email already exists')`.

**5. Test 4 — field-level server errors.** Mock a 400 whose body has `details`:

```ts
jsonResponse({ error: { code: 'validation_error', message: 'Invalid request',
  details: { organizationName: ['That name is reserved'] } } }, 400)
```

and assert the message `That name is reserved` appears. This proves the path in
`apps/web/src/lib/form.ts` that maps server `details` onto fields.

### Verify

```bash
cd apps/web && npx vitest run src/pages/auth/RegisterPage.test.tsx
```

Then **break the code on purpose** and confirm a test goes red: in `RegisterPage.tsx`,
change `form.field('email')` to `form.field('fullName')` on the email input. Test 2 should
fail. Put it back.

### Pitfalls

- If you did US-02, the password toggle button also matches `/password/i`; that is why
  the skeleton uses `/^password/i`.
- After a successful registration the page calls `navigate('/')`. In the test there is no
  route at `/`, which is fine — you are asserting on the request, not the destination.
- `mockFetch` throws on any request you did not handle. If you see "Unhandled request in
  test", read which URL it names and add a handler.

### Stretch

Write the same four tests for `AcceptInvitePage`. It needs one extra handler for
`GET /auth/invite?token=…`.

---

## US-05 — Health check that knows about the database

**Level:** junior · **Area:** api · **Size:** ~1 hour

> As the person on call, I want the health endpoint to fail when the database is
> unreachable, so that the load balancer stops sending traffic to an instance that cannot
> serve it.

**Today** `GET /api/v1/health` always answers `{ "status": "ok" }` — even if Postgres is
down (`apps/api/src/app.ts`, line 35).

### Acceptance criteria

- With the database up: `200 { "status": "ok", "database": "up" }`.
- With the database down: `503 { "status": "degraded", "database": "down" }`.
- The endpoint needs no authentication and reveals no error details.
- The check cannot hang: it gives up after two seconds.

### Files

- `apps/api/src/app.ts` (change)
- `apps/api/src/test/health.test.ts` (new)

### Steps

**1. Import the pool.** At the top of `app.ts`, after `import { config } from './config';`:

```ts
import { pool } from './db/client';
```

**2. Replace the handler.** Anchor (lines 35–37):

```ts
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
```

Replace with:

```ts
  // Liveness + readiness in one: the process is up AND can reach its database.
  // No auth (a load balancer calls this) and no detail in the body (anyone can call it).
  app.get('/api/v1/health', async (_req, res) => {
    try {
      await Promise.race([
        pool.query('select 1'),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('health check timed out')), 2000).unref(),
        ),
      ]);
      res.json({ status: 'ok', database: 'up' });
    } catch (err) {
      logger.warn({ err }, 'Health check failed');
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });
```

`logger` is already imported in `app.ts`. The `try/catch` is deliberate here even though
handlers normally let errors propagate (`CLAUDE.md`, rule 8): a failing health check is
not a bug to report as a 500, it is the *answer*.

### Tests

`apps/api/src/test/health.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/client';
import { anonymous } from './helpers';

afterEach(() => vi.restoreAllMocks());

describe('GET /health', () => {
  it('reports ok when the database answers', async () => {
    const res = await anonymous().get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('reports 503 and no details when the database is unreachable', async () => {
    vi.spyOn(pool, 'query').mockRejectedValueOnce(new Error('connection refused: 10.0.0.5') as never);
    const res = await anonymous().get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', database: 'down' });
    // The internal error text must not leak to an unauthenticated caller.
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });
});
```

This is one of the few places a mock is right: you cannot easily take the real database
down inside a test. Note that the project's rule is "no mocks of *our own* code"
(`CLAUDE.md`, rule 10) — here you are simulating an outage of an external system.

### Verify

```bash
cd apps/api && npx vitest run src/test/health.test.ts
npm run dev:api      # in another terminal:
curl -i http://localhost:4000/api/v1/health
```

To see the real 503, stop Postgres (`pg_ctl -D ~/pgdata-peblclone stop`), curl again,
then start it.

### Pitfalls

- The `beforeEach` in `src/test/setup.ts` also uses the pool. If you mock `pool.query`
  with `mockRejectedValue` (not `…Once`) and forget `restoreAllMocks`, the *next* test's
  cleanup fails in a confusing way.
- `.unref()` on the timer stops a pending timeout from keeping the process alive.

### Stretch

Real deployments separate **liveness** ("restart me if this fails") from **readiness**
("do not send me traffic if this fails"). Add `/api/v1/health/live` that never touches
the database, and explain in a comment why a database outage should *not* cause a
restart.
