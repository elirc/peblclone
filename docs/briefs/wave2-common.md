# Wave 2 — web pages: instructions common to every builder

You are one of three engineers building the pages of the **Meridian** web app in parallel,
in the same working tree (`C:\Users\Owner\Desktop\peblclone`). The app shell is built,
tested and committed: routing, auth, API client, form hook, UI kit. Every page already
exists as a stub that the router lazy-loads. Your job is to replace the stubs named in
your own brief with real pages.

## Read these first, in this order

1. `CLAUDE.md` — project rules.
2. `docs/api-contract.md` — the sections for your pages. This is the API you call. It is
   implemented; you do not need to read backend code, and you must not change it.
3. `packages/shared/src/dto.ts` and `schemas.ts` — the response and request types. Import
   them; never re-declare a shape that exists there.
4. The shell — read all of it, it is small:
   - `apps/web/src/lib/api.ts` (`api.get/post/patch/delete/blob`, `ApiError`, `errorMessage`)
   - `apps/web/src/lib/query.ts` (`keys`, `invalidate`)
   - `apps/web/src/lib/auth.tsx` (`useUser`, `useAuth`, role helpers)
   - `apps/web/src/lib/form.ts` (`useZodForm`)
   - `apps/web/src/lib/format.ts`
   - `apps/web/src/components/ui/*` (the UI kit — use it; do not restyle from scratch)
   - `apps/web/src/routes.tsx` (which path renders which page, and the role guards)
5. The reference pages — copy their shape:
   `apps/web/src/pages/auth/LoginPage.tsx`, `AcceptInvitePage.tsx`, and the test
   `LoginPage.test.tsx` with `apps/web/src/test/render.tsx`.

## How a page is built here

- **Data access lives in `apps/web/src/api/<area>.ts`** (you create the files listed in your
  brief): one exported hook per endpoint, built on TanStack Query.
  ```ts
  export function useWorkers(query: ListWorkersQuery) {
    return useQuery({
      queryKey: [...keys.workers, 'list', query],
      queryFn: () => api.get<Paginated<WorkerDto>>('/workers', query),
    });
  }
  export function useHireWorker() {
    return useMutation({
      mutationFn: (input: CreateWorkerInput) => api.post<WorkerCreatedDto>('/workers', input),
      onSuccess: () => invalidate(keys.workers, keys.dashboard),
    });
  }
  ```
  Query keys always start with a top-level key from `keys`. After a mutation, invalidate
  every top-level key whose data it could have changed — think about other pages too.
- **Server data is never copied into `useState`.** Read it from the query. Local state is
  for UI only (which modal is open, form input, filters).
- **Every page handles four states**: loading (`<Loading />`), error (`<ErrorState error
  onRetry />`), empty (`<EmptyState />` with a next action), and data.
- **Forms** use `useZodForm` with the shared schema, show field errors, disable the submit
  button while pending (`loading` prop), and surface `form.formError`.
- **Mutations outside forms**: `try { await m.mutateAsync(...); toast.success('…') } catch
  (e) { toast.error(e) }`. Consequential actions (approve payroll, terminate, void, delete)
  go through `<ConfirmDialog>`.
- **Role-aware UI**: show an action only to roles the contract allows. This is courtesy;
  the server still enforces it. Use the helpers in `lib/auth.tsx`.
- **Status-dependent actions**: use `canTransition(<MAP>, status, next)` from shared to
  decide which buttons to show, so the UI can never offer a move the server would refuse.
- **Money** is always rendered with `formatMoney(minor, currency)`; inputs take major units
  and convert with `parseMoneyToMinor`. Dates with `formatDate` / `formatDateTime`.
  Right-align numeric table columns (`align: 'right'`).
- **Accessibility**: every input has a label (the kit does this), buttons have text or an
  `aria-label`, tables have a `caption`, nothing is conveyed by colour alone.
- Layout: `PageHeader` at the top, content in `Card`s, lists in `Table` with `Pagination`.
  Keep it clean and consistent with the auth pages. Must work at 375 px wide.
- Pages are **default exports** (the router lazy-loads them). Keep the file names.

## Ground rules

- **Stay inside your file list.** Do not edit the shell (`lib/`, `components/`,
  `routes.tsx`, `main.tsx`, `index.css`), `packages/shared`, `apps/api`, `package.json`,
  or another builder's pages / api files. If the shell is missing something you need,
  build it locally inside your own folder and **report it**.
- You may add small components next to your pages (e.g. `pages/workers/WorkerForm.tsx`).
- No `npm install`, no new dependencies, no git commands that change state, no dev
  servers, no browsers.

## Verifying your work

- Typecheck: `npx tsc -p apps/web` from the repo root. Other builders' half-written files
  may produce errors — only errors in **your** files are yours to fix.
- Tests: write component tests for your most logic-heavy pages (at least 2 test files,
  see your brief) in the style of `LoginPage.test.tsx`, mocking `fetch` with `mockFetch`.
  Run only your own: from `apps/web`, `npx vitest run src/pages/<your-folder>`.
  Run them twice.
- You cannot see the UI, so be careful instead: re-read each page against the contract,
  check every endpoint path, method, body shape and response type by hand.

## Final report

1. Files created/changed.
2. Exact commands run and pass/fail counts.
3. For each page: which endpoints it calls.
4. Anything in the contract or shell that was ambiguous, missing or awkward.
5. Known gaps, honestly.
