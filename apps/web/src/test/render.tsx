import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { ToastProvider } from '../components/ui';
import { AuthProvider } from '../lib/auth';

/**
 * Render a component inside the same providers the real app uses.
 * Each call gets a fresh QueryClient so cached data never leaks between tests.
 */
export function renderApp(ui: ReactElement, { route = '/' }: { route?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <ToastProvider>{ui}</ToastProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Build a fetch Response carrying JSON. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = (request: { method: string; url: string; body: unknown }) => Response | undefined;

/**
 * Replace global fetch with a tiny router for one test. Handlers are tried in
 * order; an unhandled request FAILS the test loudly instead of hanging.
 */
export function mockFetch(...handlers: Handler[]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    calls.push(request);
    for (const handler of handlers) {
      const response = handler(request);
      if (response) return response;
    }
    throw new Error(`Unhandled request in test: ${request.method} ${request.url}`);
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

/** Handler: the user is not signed in. */
export const signedOut: Handler = ({ url }) =>
  url.endsWith('/auth/me')
    ? jsonResponse({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    : undefined;
