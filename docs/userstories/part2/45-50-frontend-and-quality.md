# Stories 45–50 — frontend and quality

Not implemented. See the [part 2 index](README.md) for how to use these.

The theme of this group: **the user's experience of the system is a system too.** State
lives in more places than you think (the server, the cache, the URL, the screen), and
most frontend bugs are two of those places disagreeing. Read the build journal's chapter
12 (the web shell) and chapter 18 (the bugs only a browser found) first.

---

## US-45 — Approvals that feel instant

> As a manager working through twenty expense claims, I want each "Approve" to take
> effect the moment I click, so that I am not waiting on a spinner twenty times.

### Acceptance criteria

- Approving or rejecting an expense updates the list immediately, before the server
  answers.
- If the server refuses, the row returns to its previous state and the user is told why.
- Rapid clicks on several rows all end up correct.
- The dashboard's pending count stays consistent with the list.
- The final state on screen always matches the server.

### The concept: optimistic updates

The normal flow is *pessimistic*: click → wait for the server → update the screen. It is
always correct and always feels slow.

An **optimistic update** assumes success: update the screen at once, send the request in
the background, and **roll back** if it fails. Most requests succeed, so most of the time
the user gets an instant interface for free.

It is the same word as in optimistic concurrency (US-25) and the same bet: conflicts are
rare, so do not make everyone pay for them — but have a correct answer for when one
happens.

The cost is that for a moment the screen shows something that is **not true yet**. Three
things can go wrong in that window:

1. **The server says no.** You must restore exactly what was there.
2. **A refetch lands mid-flight.** An older server response overwrites your optimistic
   change, and the row flickers back.
3. **Two mutations overlap.** The first one's rollback restores a snapshot taken *before*
   the second one's change, erasing it.

### The design decision

Not every action should be optimistic. The question to ask is: **how bad is it if the
screen is briefly wrong?**

| Action | Optimistic? | Why |
| --- | --- | --- |
| Approve / reject an expense | Yes | Cheap to undo; failure is rare; high volume |
| Mark a notification read | Yes | Trivial |
| Approve payroll | **No** | It issues an invoice. A screen that says "approved" for half a second before saying "actually no" is worse than a spinner |
| Pay an invoice | **No** | Money |
| Sign a contract | **No** | A legal act |

The rule of thumb: optimistic for **frequent, reversible, low-stakes** actions; a visible
pending state for anything a user would be upset to see flicker.

TanStack Query supports the pattern directly with three callbacks on a mutation:

```
onMutate   → cancel in-flight fetches; snapshot the cache; write the optimistic value
onError    → restore the snapshot
onSettled  → invalidate, so the server's truth replaces whatever is on screen
```

### Where it touches this codebase

- `apps/web/src/api/expenses.ts` — the decision mutation invalidates on success today.
- `apps/web/src/pages/expenses/ExpensesPage.tsx` — the "To review" tab filters on
  `status=submitted`, which matters (see hint 3).
- `apps/web/src/lib/query.ts` — `keys` and `invalidate`.
- `apps/web/src/lib/auth.tsx` and several builders' reports noted that `invalidate` uses
  a module-level client. Inside a mutation, take the client from `useQueryClient()` so
  your code works in tests.

### Hints

1. In `onMutate`, **cancel outgoing queries for the keys you are about to change** before
   writing. Otherwise a fetch that started before the click can resolve after it and
   overwrite your optimistic value. This is failure 2 above and it is the line people
   leave out.
2. Return the snapshot from `onMutate`; it arrives in `onError` as the context argument.
3. What does "optimistic" mean on a **filtered** list? On the "To review" tab an approved
   expense no longer matches the filter. Do you remove the row at once (fast, but it
   vanishes under the cursor and the next row jumps up — a mis-click hazard), or keep it
   in place, greyed with its new status, until the refetch? Decide for the user's sake,
   not the code's.
4. The list is cached under a key that includes the query parameters, so the same expense
   may live in several cached lists (the "All" tab, the "To review" tab, different
   pages). `setQueriesData` with a key prefix updates all of them in one call.
5. Always invalidate in `onSettled` — success *or* failure. The optimistic value is a
   guess; the refetch is the truth.
6. Overlapping mutations (failure 3): snapshots of the whole list are fragile. A more
   robust rollback restores **only the row you changed** to its previous value, leaving
   other rows' optimistic states alone.
7. The dashboard count is derived on the server. Either adjust it optimistically too, or
   accept that it catches up after the refetch — but do not leave it permanently stale;
   make sure the dashboard key is invalidated.

### How to test it

- With a mocked `fetch` that never resolves: click Approve → the row shows "Approved"
  while the request is still pending.
- Then resolve with a `409`: the row is "Submitted" again and an error is shown.
- Two rows approved in quick succession, the first failing: the second stays approved.
- A stale list response that arrives after the click does not undo it.

### What goes wrong

- No cancellation, so refetches fight the optimistic value.
- Rolling back to a stale whole-list snapshot.
- Optimistic UI for irreversible actions.
- Forgetting `onSettled`, leaving a guess on screen forever.

### Questions to be able to answer

- Which actions in this app must never be optimistic, and what is the principle?
- What are the three ways the optimistic window goes wrong, and which line of your code
  handles each?

---

## US-46 — Every list remembers its filters

> As a user, I want a filtered, paged list to survive a reload, the back button and being
> pasted to a colleague, so that "the expenses waiting for me" is a link I can keep.

### Acceptance criteria

- On every list page, filters, the active tab and the page are in the URL.
- Reload, back, forward and "open in new tab" all restore the same view.
- Changing a filter resets paging to the first page.
- Invalid values in the URL are ignored safely, never crash the page, never reach the API.
- Typing in a search box does not flood the browser history.
- The pattern is one reusable hook, not copied into each page.

### The concept: the URL is state

A React app has several places to keep state, and choosing the wrong one is the root of
many bugs:

| Where | Lifetime | Right for |
| --- | --- | --- |
| `useState` | Until the component unmounts | Which modal is open; a form draft |
| The query cache | Until invalidated | Server data |
| **The URL** | Survives reload; shareable; in history | **What the user is looking at** |
| `localStorage` | Until cleared, this browser only | Preferences |

The test for "should this be in the URL?" is simple: *if I sent this link to a colleague,
should they see what I see?* For filters, tabs and paging — yes. That is what a URL is
*for*.

`WorkersPage.tsx` already does this (the build journal's brief asked for it). The other
list pages keep their filters in `useState` — several builders said so in their reports
("tab and filter state is kept on the page, not in the URL"). So a manager who filters
expenses, opens one, and presses Back loses the filter. This story makes the good pattern
the default.

### The design decision

| Question | Recommendation |
| --- | --- |
| Single source of truth | The URL. Do not mirror it into `useState` — two copies drift |
| Parsing | Through a **zod schema**. The URL is user input: someone can type `?status=banana&limit=99999` |
| Invalid values | Fall back to the default for that field; do not show an error for a mangled link |
| Defaults | Omit them from the URL. `/expenses` and `/expenses?status=submitted&page=1` should not be two addresses for one view |
| History: push or replace? | **Push** for deliberate choices (a tab, a filter) so Back undoes them; **replace** for typing in a search box, or every keystroke becomes a history entry |
| Search input | Local state for the text being typed, debounced into the URL |
| Changing a filter | Reset the page / offset / cursor in the same update |

### Where it touches this codebase

- `apps/web/src/pages/workers/WorkersPage.tsx` — the working example: `useSearchParams`,
  the debounce (`SEARCH_DEBOUNCE_MS`), resetting the offset.
- `apps/web/src/lib/` — a new hook, e.g. `useListParams(schema)`.
- The list pages: expenses, time off, contracts, payroll, invoices, payslips, audit.
- `packages/shared/src/schemas.ts` — the `list…QuerySchema`s already describe each list's
  valid parameters. They are the obvious thing to parse the URL with.
- `apps/web/src/pages/dashboard/DashboardPage.tsx` — builder D noted the attention links
  go to plain `/expenses` because "there is no agreed URL filter convention". After this
  story there is one, and the link can be `/expenses?status=submitted`.

### Hints

1. Extract the hook from `WorkersPage` **first**, change that page to use it, and run its
   tests. Then roll it out page by page. The existing page is the specification for the
   hook.
2. Signature to aim for: give the hook a zod schema; get back the parsed, typed values
   and a `set(partial, { replace? })` function. The schema makes the result typed and
   the parsing safe in one move.
3. The shared query schemas use `z.coerce.number()` and have defaults — convenient,
   because everything in a URL is a string. But a schema that *throws* on one bad field
   would discard every other valid field. Parse field by field, or use `.catch(default)`
   per field, so one bad parameter does not reset the whole view.
4. Write parameters in a **stable order** and drop defaults, so the same view always has
   the same URL.
5. `setSearchParams` accepts a function of the previous params. Use that form: two
   updates in the same tick otherwise overwrite each other.
6. The debounced search: keep the input's text in `useState`; push it to the URL after a
   pause with `replace: true`. And when the URL changes from outside (Back button), the
   input must update too — `WorkersPage` handles this; read how.
7. A tab is just another parameter.
8. If you have done US-28, a cursor in the URL is opaque and only valid for its filter
   set: any filter change must clear it.

### How to test it

- Render with `?status=approved` → the filter control shows it and the request carries
  it.
- Change a filter → the URL updates and the offset parameter is gone.
- `?status=banana&limit=99999` → defaults used, no crash, the request contains neither.
- Type five characters in search → after the debounce, exactly one request and no pile of
  history entries.
- Navigate back → the previous filter is restored in both the URL and the controls.

### What goes wrong

- State in both the URL and `useState`.
- Trusting URL values and passing them straight to the API.
- A history entry per keystroke — the Back button becomes useless.
- Not resetting the page: the user narrows a filter and sees an empty "page 5".

### Questions to be able to answer

- How do you decide whether a piece of state belongs in the URL?
- Why parse the URL with a schema when the API validates anyway?
- When push, when replace?

---

## US-47 — One broken page does not break the app

> As a user, when one page hits a bug, I want to see an error for that page and still be
> able to use the menu to go somewhere else, so that one problem does not lock me out of
> everything.

### Acceptance criteria

- A render error inside a page shows an error panel **inside the app frame**: the sidebar
  and header still work.
- Navigating to another page clears the error.
- A "Try again" button re-renders the page.
- The error is reported with the route, the request id if there is one, and the user's
  role — never the user's data.
- A failure to load a page's code (after a new deploy) offers a reload instead of a blank
  screen.

### The concept: blast radius

There is one `ErrorBoundary` in the app, at the very top (`main.tsx`). When any component
anywhere throws during rendering, React unmounts everything up to the nearest boundary —
which is the whole application. The user sees "Something went wrong" and has lost the
sidebar, the header, everything. A typo in the audit log page takes down payroll.

The engineering idea is **blast radius**: when something fails, how much goes with it?
You limit it with *bulkheads* — the watertight compartments in a ship's hull. A boundary
around each route is a bulkhead: one page floods; the rest stay afloat.

It also matters what an error boundary does **not** catch, because people expect too
much of them:

| Kind of error | Caught by a boundary? | What handles it |
| --- | --- | --- |
| Thrown while rendering | Yes | The boundary |
| Thrown in an event handler (`onClick`) | **No** | `try/catch` in the handler → a toast |
| A rejected promise | **No** | The mutation's error handling |
| A failed data fetch | Not by default | The page's `isError` branch → `<ErrorState>` |

So there are three separate error paths in this app, and each needs to exist: fetch
errors (the `ErrorState` every page already renders), action errors (toasts), and render
errors (boundaries). This story is about the third.

### The design decision

| Question | Recommendation |
| --- | --- |
| Where do boundaries go? | Three levels: the whole app (last resort, exists); **around the routed page, inside the shell** (new — the important one); optionally around an independent widget such as one dashboard card |
| Resetting | The boundary must reset when the route changes, or the error screen follows the user to every page |
| Recovery | "Try again" re-mounts the subtree |
| Reporting | One function, `reportError(error, context)`, that logs now and is the seam for a real service later |
| Chunk-load failures | Detect them and offer "Reload to get the latest version" |

**The stale-deploy problem.** Pages are lazy-loaded (`routes.tsx` uses `lazy()` for every
page). After a deploy, the file names of those chunks change. A user who loaded the app
an hour ago clicks "Payroll"; their browser asks for the *old* chunk file, which no
longer exists; the import rejects. With no handling, that is a blank area or a crash.
This is one of the most common production errors in single-page apps and it is not a bug
in your code at all — it is a deploy happening while people are using the product.

### Where it touches this codebase

- `apps/web/src/components/ErrorBoundary.tsx` — the existing class component.
- `apps/web/src/components/layout/AppShell.tsx` — renders `<Outlet />`; the boundary
  wraps that.
- `apps/web/src/routes.tsx` — `page()` wraps each page in `<Suspense>`; lazy imports.
- `apps/web/src/lib/api.ts` — `ApiError`; if US-06's stretch was done, the request id.

### Hints

1. Error boundaries must still be class components. Extend the existing one rather than
   writing a second.
2. Resetting on navigation: give the boundary a `key` derived from the current path. When
   the key changes, React throws the old instance away and mounts a fresh one. One line,
   and far more reliable than resetting state by hand.
3. Make the fallback a prop, so the top-level boundary can show a full-page message and
   the route-level one an in-frame panel that reuses `EmptyState` or `Alert`.
4. Recognising a chunk-load failure: the error raised by a failed dynamic import has a
   recognisable message, but the exact text differs between browsers and bundlers.
   Check what your build actually throws rather than trusting an example — and keep the
   detection loose.
5. Reload carefully: an automatic `location.reload()` on chunk failure can loop forever
   if the server is genuinely broken. Reload at most once (remember it in
   `sessionStorage`), then show a message.
6. What to report: the route **pattern**, the user's role, the error name and message,
   the component stack. Not form contents, not names, not salaries. Error reports are a
   classic way for personal data to end up in a third-party system.
7. In development React shows its own overlay for errors, on top of your boundary. Test
   the real experience with `npm run build && npm run preview`.

### How to test it

- A test component that throws on render, placed inside the route-level boundary within
  the shell: the navigation is still in the document and the error panel is shown.
- Change the route → the error panel is gone.
- "Try again" re-renders (make the component throw only the first time).
- Suppress the expected `console.error` noise in these tests, and assert your reporting
  function was called with a context containing no user data.
- Simulate a lazy import that rejects.

### What goes wrong

- Believing a boundary catches click-handler and fetch errors.
- An error screen that persists across navigation.
- An infinite reload loop.
- Leaking personal data in error reports.

### Questions to be able to answer

- What is the blast radius of a render error before and after your change?
- Name the three error paths in this app and what handles each.
- Why does a deploy cause errors for users who did nothing wrong, and what did you do
  about it?

---

## US-48 — Usable with a keyboard and a screen reader

> As a user who navigates by keyboard and uses a screen reader, I want the app to tell me
> when the page changes and to put my focus somewhere sensible, so that I can do my job
> as efficiently as anyone else.

### Acceptance criteria

- After navigating to a new page, focus moves to the page's main heading and a screen
  reader announces the new page.
- A "Skip to main content" link is the first focusable element.
- Closing a modal returns focus to the control that opened it.
- Toast messages are announced; errors are announced assertively.
- Every interactive element is reachable and operable by keyboard, with a visible focus
  indicator.
- An automated accessibility check runs in the test suite and passes.

### The concept: what a single-page app takes away

On a traditional website, clicking a link loads a new document. The browser resets focus
to the top, and a screen reader announces the new page's title. Users rely on this
without knowing it exists.

A single-page app **replaces the content without loading a document**. So none of that
happens. A screen-reader user clicks "Payroll" and hears… nothing. Focus is still on the
link they clicked, in the sidebar, while the entire main area has changed silently. They
cannot tell whether the click worked.

By building a single-page app you took over the browser's job of managing navigation,
and with it the responsibility for **focus management** and **announcements**. Nothing
does these for you; you have to build them.

The second concept is **the accessibility tree**. Assistive technology does not see
pixels or CSS; it sees a tree of *roles*, *names* and *states* derived from your HTML: "a
button named Approve", "a checkbox, checked". Native elements populate that tree
correctly for free. A `<div onClick>` is in the tree as nothing at all — not focusable,
not announced as a button, not operable from the keyboard.

> The first rule of accessible markup: use the native element. A `<button>` beats a
> `<div role="button" tabindex="0" onKeyDown=…>` every time.

The build journal's shell made this choice deliberately in one place — the modal is a
native `<dialog>` (chapter 12.5), which gives a focus trap and Escape handling for free.
This story extends that thinking to the rest of the app.

### The design decision

| Question | Recommendation |
| --- | --- |
| Where does focus go on navigation? | The new page's `<h1>`, made programmatically focusable with `tabindex="-1"` |
| How is the page change announced? | Moving focus to the heading makes the screen reader read it. Combined with the tab title from part 1's US-01, that is enough for most cases |
| Skip link | A link that is visually hidden until focused, first in the DOM, targeting the main region |
| Toasts | A polite live region for confirmations (exists); an assertive one for errors |
| Focus return from modals | The native `<dialog>` restores focus when opened with `showModal()` — **verify** it does in your target browsers rather than assuming |
| How to verify | Automated checks catch perhaps a third of problems. Keyboard-only testing by hand, and a few minutes with a real screen reader, catch the rest |

### Where it touches this codebase

- `apps/web/src/components/layout/AppShell.tsx` — the `<main>` element, the skip link,
  the mobile menu.
- `apps/web/src/components/ui/layout.tsx` — `PageHeader` renders the `<h1>`.
- `apps/web/src/components/ui/Table.tsx` — rows are clickable with `tabIndex` and an
  Enter handler. Read it critically (hint 4).
- `apps/web/src/components/ui/Modal.tsx`, `toast.tsx`.
- `apps/web/src/index.css` — the global `:focus-visible` rule.

### Hints

1. Focus on navigation: an effect keyed on the pathname that focuses the heading. Do
   **not** run it on the very first page load — the browser handles that — and do not run
   it when only the query string changes (changing a filter must not steal focus from
   the filter control the user is using).
2. A heading with `tabindex="-1"` shows a focus ring when focused programmatically. The
   ring is correct — it tells a sighted keyboard user where they are. Resist removing it.
3. The mobile drawer in `AppShell` is a hand-built overlay, not a `<dialog>`. Check: does
   focus move into it when it opens? Can you Tab out of it into the page behind? Does
   Escape close it? This is the component most likely to fail, because it is the one
   that did not use a native element.
4. `Table` makes a `<tr>` clickable. A row is not a control: it has no role a screen
   reader would announce as actionable, and Space does not activate it. The robust
   pattern is a real link in the first cell (the name), with the row click as a mouse
   convenience on top. Consider what that changes for the pages that pass `onRowClick`.
5. Icon-only buttons need an accessible name (`aria-label`). Search for buttons whose
   only child is an icon. The decorative icon itself should be `aria-hidden`.
6. Colour is not information by itself: status badges carry text as well as colour —
   good. Check the payroll stepper and the dashboard bars.
7. Automated checking: an accessibility rules engine can run inside your component
   tests. Adding one is a new dev dependency — ask first, and then wire it into the
   existing `renderApp` helper so every page test can assert "no violations".
8. Then put the mouse away for fifteen minutes and complete one whole task: sign in,
   approve an expense, sign out. Every place you get stuck is a bug. No tool finds what
   this does.

### How to test it

- Navigate between two routes in a test; assert `document.activeElement` is the new
  heading.
- The skip link is the first tab stop and moves focus into `<main>`.
- Open and close a modal; focus is back on the trigger.
- The automated check on the login page, the people list and one modal.
- A manual keyboard pass, written up: what you tried, what failed, what you fixed.

### What goes wrong

- Stealing focus on every state change.
- Removing focus outlines because they "look untidy".
- `<div onClick>`.
- Treating a passing automated check as "accessible".

### Questions to be able to answer

- What does a multi-page site do on navigation that a single-page app must do for itself?
- Why is a native `<button>` better than a `div` with a role and a key handler?
- What did your manual keyboard pass find that the automated check did not?

---

## US-49 — A smaller first download

> As a user on a slow connection, I want the app to become usable quickly, so that I am
> not looking at a blank screen while a large file downloads.

The build journal lists this as a known gap (chapter 20.2): *"The main JavaScript bundle
is 670 kB (197 kB gzipped). Pages are code-split, but the shared chunk has grown and
nobody has yet looked at why. It should be measured before anyone guesses."*

### Acceptance criteria

- A written analysis of what is in the main chunk, with sizes.
- The main chunk's gzipped size is reduced by a stated, measured amount.
- No page is broken; every route still loads.
- A size budget is checked automatically, so the bundle cannot quietly grow back.
- The before and after numbers are in the commit message.

### The concept: you pay for JavaScript three times

Every kilobyte of JavaScript costs the user:

1. **Download** — over their network.
2. **Parse and compile** — on their CPU, which on a mid-range phone is several times
   slower than your laptop.
3. **Execute** — before anything appears.

Compression (gzip, brotli) only helps with the first. So "197 kB gzipped" still means the
browser must parse and run the full 670 kB.

Two techniques reduce it:

- **Code splitting** — do not ship code for a page until the user visits it. This app
  already does that per route (`lazy()` in `routes.tsx`), which is why the login screen
  does not include the payroll screen.
- **Tree shaking** — the bundler drops exports nobody imports. It only works when imports
  are precise and modules have no side effects.

Then why is the *shared* chunk large? Because anything imported by the code that runs at
startup — or by enough pages — ends up in it. One page importing a big library via a
shared helper is enough to pull that library into everybody's first load.

This story is the build journal's chapter 14 applied to the frontend: **measure, then
optimise.** You do not know what is in the bundle. Neither does anyone else. Find out
before changing a line.

### The design decision

**Step one is not a decision; it is a measurement.** A bundle visualiser draws the bundle
as a map of rectangles, sized by weight. In about a minute you can see what is heavy.

Likely suspects, in rough order — each one a hypothesis to *check*, not a fact:

| Suspect | Why | How to confirm |
| --- | --- | --- |
| The icon library | Importing icons in a way that defeats tree shaking can pull in the entire set | Look for it in the visualiser; compare its size with the number of icons actually used |
| The validation library | `zod` is in the startup path because the login form and the shared package use it | Its size in the map |
| `packages/shared` as a whole | `index.ts` re-exports everything (`export *`), so importing one enum may drag in every schema and the payroll maths | Whether shared's modules appear in the main chunk when only the login page is loaded |
| Something a builder imported at the top level | One wide import in a shared file | The map |
| React and the router | Unavoidable, but know their size so you know your floor | The map |

| Question | Recommendation |
| --- | --- |
| What to split | Vendor code that changes rarely into its own chunk: it then stays cached across your deploys |
| What *not* to do | Do not split into dozens of tiny chunks — each is a request, and too many is slower |
| How to keep it fixed | A size budget checked in CI. Without it the bundle regrows within a quarter |
| What to measure | Bytes are a proxy. The real measure is time to an interactive login screen on a throttled connection — record that too |

### Where it touches this codebase

- `apps/web/vite.config.ts` — build options, manual chunks.
- `apps/web/src/routes.tsx` — the lazy boundaries, and the three auth pages that are
  imported **eagerly**.
- `packages/shared/src/index.ts` — `export *` from every module.
- `apps/web/src/components/layout/AppShell.tsx` — imports about twenty icons at startup.
- `.github/workflows/ci.yml` — where a budget check would run.

### Hints

1. Run the production build and write down the output table before touching anything.
   That is your baseline; a "before" you did not record cannot be compared with.
2. A visualiser is a development-only dependency — still a new dependency, so say so.
   Some bundlers can emit an analysis without one; check what your build tool offers.
3. Form a hypothesis, change **one** thing, rebuild, compare. If you change five things
   and the bundle shrinks, you do not know which mattered — or whether one of them made
   it worse.
4. Is everything in the shell needed at startup? The login page is shown to signed-out
   users; the app shell, its icons and the query hooks are only needed after sign-in.
   Consider whether the whole signed-in tree could be one lazy boundary.
5. Barrel files (`index.ts` with `export *`) are convenient and can defeat tree shaking
   if any module in the barrel has side effects at import time. Check whether the
   bundler is told the package is side-effect free (`sideEffects` in `package.json`).
6. Splitting vendor code: group by how often things change, not by name. React and the
   router change when you upgrade them — rarely. Your code changes every deploy.
7. A budget can be a ten-line script: read the build output, compare the main chunk's
   size with a number in the repo, fail if it is exceeded. Set the limit a little above
   the new size so normal growth does not fail every build.
8. After each change, run the browser sweep from the build journal's chapter 18 — or at
   least click through every route in a production build. A page that fails to load its
   chunk is a broken page, and no unit test will tell you.

### How to test it

- The numbers: before and after, raw and gzipped, for the main chunk and the total.
- Every route loads in a **production build** (`npm run build && npm run preview`), not
  just in the dev server — code splitting behaves differently in each.
- The budget check fails when you deliberately import something large, and passes when
  you remove it. (Make the safeguard fail on purpose once — the .NET journal's chapter 14
  makes the same point.)
- A throttled-network load of the login page, timed before and after.

### What goes wrong

- Optimising without a baseline.
- Chasing bytes that do not affect what the user waits for.
- Over-splitting.
- Breaking a route's lazy import and not noticing because the dev server does not split.
- No budget, so it all comes back.

### Questions to be able to answer

- What was actually in the main chunk? Which of your guesses were wrong?
- Why does gzip not solve the problem by itself?
- What did each change save, individually?

---

## US-50 — End-to-end tests that run on every change

> As the team, we want the critical user journeys checked in a real browser on every
> change, so that a bug like "login bounces back to the login page" is caught by a
> machine instead of by a customer.

### Acceptance criteria

- A committed end-to-end suite runs with one command against a real API, a real database
  and a real browser.
- It covers at least: sign in and land on the right home page for each role; hire a
  worker; approve payroll and pay the invoice; a worker signing their contract.
- Each test starts from a known state and can run in any order, or alone.
- The suite is reliable: ten consecutive runs, ten passes.
- A failure produces a screenshot and a trace.
- It runs in CI.

### The concept: the test pyramid has a top, and it is narrow

The build journal's chapter 19 lists what each kind of check can and cannot see:

| Layer | Sees | Blind to |
| --- | --- | --- |
| Types | Shape mismatches | Any behaviour |
| Unit tests | Logic in isolation | How pieces fit |
| Integration tests (API) | Real database, real HTTP | The browser |
| Component tests (jsdom) | Rendering and events | Layout; real navigation; real network |
| **End-to-end** | The real thing, as a user meets it | Almost nothing — but slowly and expensively |

Two real bugs in this project lived in the blind spots of everything below the top: the
login bounce (a client-side navigation problem invisible to jsdom) and the phone-width
overflow (a layout problem invisible to anything without a layout engine). Both were
found by a throwaway browser script the lead wrote in chapter 18 — and then *thrown
away*. This story makes that script permanent.

Why not test everything end to end, if it sees the most? Because each such test is
**slow** (seconds, not milliseconds), **expensive to maintain** (it depends on every
layer at once), and prone to **flakiness**. Hence the pyramid: many fast tests at the
bottom, a *few* end-to-end tests at the top, covering journeys rather than details.

**Flakiness is the real enemy.** A test that fails one run in twenty, for no reason
related to the code, is worse than no test: people learn to re-run until it is green, and
from then on a real failure is re-run away too. A flaky suite trains the team to ignore
it. Reliability is not a nice-to-have; it is the whole value.

### The design decision

| Question | Recommendation |
| --- | --- |
| Where does the suite live? | Its own workspace (`apps/e2e`), with its own dependencies. A browser automation library is a significant new dependency — make the case |
| What state does a test start from? | The seed. `npm run db:seed -- --reset` already builds a rich, realistic state through the real API (build journal, chapter 16) |
| Which database? | A dedicated one (`meridian_e2e`), never `meridian_dev` — the suite resets it |
| Isolation between tests | Reseeding takes too long to do per test. Either each test **creates what it changes** (a fresh worker, a fresh run), or tests that mutate shared seed data are grouped and the database is reset per group |
| How do tests log in? | Through the UI **once** per role, saving the browser's storage state; other tests reuse it. Logging in through the form in every test is slow and tests the login page forty times |
| Selectors | By role and accessible name (`getByRole('button', { name: 'Approve' })`). Never CSS classes or DOM structure |
| Waiting | For conditions ("this text is visible"), never for time (`sleep(2000)`) |

**Selectors are a design decision, not a detail.** A test that finds a button by its CSS
class breaks when someone restyles it. A test that finds it by its role and name breaks
only when the *user-facing behaviour* changes — which is exactly when you want it to
break. And as the build journal's chapter 12.6 noted, if a test cannot find an element by
its accessible name, a screen-reader user cannot either. The same query is a regression
test and an accessibility check.

### Where it touches this codebase

- `apps/api/src/db/seed.ts` — the seed, and its demo logins.
- `apps/api/src/config.ts` — `NODE_ENV=test` forces the test database; an end-to-end run
  wants a *running server* on a *third* database. Decide how to select it without
  weakening the "tests can never touch dev data" guard.
- `apps/web/vite.config.ts` — the web port comes from `WEB_ORIGIN`; the API's CSRF check
  only accepts that origin.
- `.github/workflows/ci.yml` — a new job.
- The build journal's chapter 18 describes what the throwaway scripts did; that is your
  specification.

### Hints

1. Start with **one** test — sign in as the client admin, see the dashboard heading — and
   make it run from a clean checkout with one command. All the hard problems (starting
   two servers, waiting for them, choosing a database, the origin check) are in getting
   that first test to pass. The other tests are easy after it.
2. The runner should start the API and the web server itself and wait until they answer,
   and refuse to start if the ports are already in use by something else. The build
   journal's chapter 18.3 is a cautionary tale about a port owned by another project —
   and its lesson about "a green health check answered by the wrong process".
3. Run against a **production build** of the web app, not the dev server. The dev server
   does not code-split the same way, does not minify, and runs React in a mode that
   double-invokes effects. You want to test what users get.
4. Do **not** navigate with a full page load between steps unless a user would. The
   chapter-18 sweep called `page.goto()` after logging in, which reloaded the app and hid
   the login-bounce bug. Click links, the way a person does.
5. Every flaky test has a cause. The usual ones: asserting before the UI has settled
   (wait for the condition); depending on another test's leftovers (create your own
   data); depending on the clock (the seed uses dates relative to today; a test at
   midnight on the last day of a month is a different test); animations and toasts
   covering a button.
6. When a test fails intermittently, **do not add a retry and move on**. Run it fifty
   times in a loop, capture a trace of a failure, find the cause. Retries are for
   infrastructure you do not control, not for your own race conditions.
7. Also assert on what must *not* happen: no uncaught page errors, no `5xx` responses,
   no console errors, during every test. The chapter-18 script collected exactly these.
8. Add one phone-width test that asserts the document is not wider than the viewport on
   the main list pages — the overflow bug's regression test.
9. Keep it small. Five to ten journeys. If you find yourself testing validation messages
   end to end, that test belongs lower in the pyramid.

### How to test the tests

- **Mutation check**: reintroduce the login bug (the build journal's chapter 18.6
  describes it: replace the cache-clearing call in `auth.tsx` with `queryClient.clear()`)
  and confirm your suite goes red. Then undo it. A suite that stays green with a known
  bug in place is not testing what you think.
- Do the same for the overflow fix: remove `relative` from the `Table` wrapper.
- Run the whole suite ten times in a row. Ten passes.
- Run a single test file alone, and the files in reverse order. Still green.

### What goes wrong

- Tests that depend on running order.
- `sleep`.
- CSS selectors.
- Running against the dev database and wiping someone's work.
- Tolerating "it is just flaky".
- Growing the suite until it takes twenty minutes and nobody runs it.

### Questions to be able to answer

- Which bugs can only an end-to-end test catch, and why can the layers below not?
- How does each of your tests get its starting state, and what makes it independent of
  the others?
- You have an intermittently failing test. What do you do — in order?
- Why is "find the button by its role and name" both a better test and an accessibility
  check?
