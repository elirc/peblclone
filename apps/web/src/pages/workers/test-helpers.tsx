import type { CountryDto, SessionUser, UserRole, WorkerDto } from '@meridian/shared';
import type { ReactElement, ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { jsonResponse, renderApp } from '../../test/render';

/*
 * Test helpers for Builder D's pages. Kept beside the pages (not in src/test) because
 * the shell is owned by someone else; see the final report.
 */

/** jsdom 25 has no <dialog> methods; the UI kit's Modal calls them. */
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
    };
  }
}

export function sessionUser(role: UserRole = 'client_admin'): SessionUser {
  return {
    id: 'user-1',
    email: 'admin@acme.test',
    fullName: 'Ada Admin',
    role,
    organizationId: 'org-1',
    organizationName: 'Acme',
    workerId: null,
  };
}

/** fetch handler: answers "who am I?" with a signed-in user of the given role. */
export const signedInAs =
  (role: UserRole = 'client_admin') =>
  ({ url }: { url: string }) =>
    url.endsWith('/auth/me') ? jsonResponse({ user: sessionUser(role) }) : undefined;

/** Pages call useUser(), which needs a user; in the app <RequireAuth> guarantees one. */
function WhenSignedIn({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : <Loading label="Signing in…" />;
}

/** Shows where the app navigated to, so tests can assert on redirects. */
function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{location.pathname + location.search}</p>;
}

/**
 * Render a page at `route`, matched by `path` (so useParams works), behind a
 * signed-in user. Any other path renders a probe showing the current location.
 */
export function renderPage(ui: ReactElement, { route, path }: { route: string; path: string }) {
  return renderApp(
    <WhenSignedIn>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </WhenSignedIn>,
    { route },
  );
}

export function country(overrides: Partial<CountryDto> = {}): CountryDto {
  return {
    code: 'DE',
    name: 'Germany',
    region: 'Europe',
    currency: 'EUR',
    employerContributions: [{ key: 'pension', name: 'Pension insurance', rateBps: 930 }],
    employeeDeductions: [{ key: 'pension', name: 'Pension insurance', rateBps: 930 }],
    monthlyFeeUsdMinor: 59_900,
    annualLeaveDays: 25,
    noticePeriodDays: 30,
    probationDays: 180,
    eorSupported: true,
    requiredDocuments: ['passport'],
    ...overrides,
  };
}

export function worker(overrides: Partial<WorkerDto> = {}): WorkerDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'employee',
    status: 'active',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@acme.test',
    countryCode: 'DE',
    countryName: 'Germany',
    jobTitle: 'Engineer',
    department: null,
    startDate: '2026-01-05',
    endDate: null,
    salaryMinor: 7_200_000,
    payBasis: 'annual',
    currency: 'EUR',
    hasPortalAccess: false,
    createdAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}
