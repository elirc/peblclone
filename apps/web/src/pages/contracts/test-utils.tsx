import type { SessionUser, UserRole } from '@meridian/shared';
import type { ReactNode } from 'react';
import { useAuth } from '../../lib/auth';
import { jsonResponse, type mockFetch } from '../../test/render';

/**
 * Test helpers for the contracts / time-off / expenses / portal pages.
 * (Not a test file itself — vitest only collects `*.test.tsx`.)
 */

type Handler = Parameters<typeof mockFetch>[0];

export function sessionUser(role: UserRole, overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: `user-${role}`,
    email: `${role}@example.com`,
    fullName: role === 'worker' ? 'Ada Lovelace' : 'Grace Hopper',
    role,
    organizationId: 'org-1',
    organizationName: 'Acme Ltd',
    workerId: role === 'worker' ? 'worker-1' : null,
    ...overrides,
  };
}

/** Handler: `GET /auth/me` answers with this user. */
export const signedInAs =
  (user: SessionUser): Handler =>
  ({ url }) =>
    url.endsWith('/auth/me') ? jsonResponse({ user }) : undefined;

/**
 * Handler for one endpoint. `path` is relative to `/api/v1` and matched without
 * the query string; use `calls` from `mockFetch` to assert on query params.
 */
export const on =
  (method: string, path: string, body: unknown, status = 200): Handler =>
  (request) =>
    request.method === method && request.url.split('?')[0] === `/api/v1${path}`
      ? jsonResponse(body, status)
      : undefined;

/**
 * Pages call `useUser()`, which (by design) throws while signed out. In the app,
 * <RequireAuth> waits for `/auth/me`; in tests this does the same job.
 */
export function WhenSignedIn({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : null;
}

/** jsdom has no `HTMLDialogElement.showModal/close`; the kit's <Modal> needs both. */
export function polyfillDialog(): void {
  const proto = HTMLDialogElement.prototype;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  }
}
