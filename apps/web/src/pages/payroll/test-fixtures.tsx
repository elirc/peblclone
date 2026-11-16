import type {
  InvoiceDetailDto,
  PayrollItemDto,
  PayrollRunDetailDto,
  SessionUser,
  UserRole,
} from '@meridian/shared';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router';
import { useAuth } from '../../lib/auth';
import { jsonResponse, renderApp, type mockFetch } from '../../test/render';

/**
 * Test-only helpers shared by the payroll and invoice page tests.
 * (Not imported by any page, so it never reaches the production bundle.)
 */

type Handler = Parameters<typeof mockFetch>[0];

/**
 * jsdom has <dialog> but not showModal()/close(). The kit's <Modal> relies on
 * them, so give jsdom the minimum: toggling the `open` attribute.
 */
export function polyfillDialog() {
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

export const ORG_ID = '00000000-0000-4000-8000-0000000000aa';

export function makeUser(role: UserRole, overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: `00000000-0000-4000-8000-${role === 'platform_admin' ? '000000000001' : '000000000002'}`,
    email: `${role}@example.com`,
    fullName: role === 'platform_admin' ? 'Pat Platform' : 'Casey Client',
    role,
    organizationId: role === 'platform_admin' ? null : ORG_ID,
    organizationName: role === 'platform_admin' ? null : 'Acme GmbH',
    workerId: null,
    ...overrides,
  };
}

/** Handler: `/auth/me` answers with this user. */
export const signedInAs =
  (user: SessionUser): Handler =>
  ({ url }) =>
    url.endsWith('/auth/me') ? jsonResponse({ user }) : undefined;

/** Handler for one exact method + path (query string ignored). */
export const route =
  (method: string, path: string, respond: (body: unknown) => Response): Handler =>
  (request) =>
    request.method === method && request.url.split('?')[0] === `/api/v1${path}`
      ? respond(request.body)
      : undefined;

/** Pages call useUser(), which needs the session to have loaded — as <RequireAuth> guarantees in the app. */
function AuthGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return user ? children : <p>Signing in…</p>;
}

/** Render `element` at `path`, matched against the router `pattern` (so useParams works). */
export function renderPage(
  element: ReactNode,
  { path, pattern }: { path: string; pattern: string },
) {
  return renderApp(
    <Routes>
      <Route path={pattern} element={<AuthGate>{element}</AuthGate>} />
      <Route path="*" element={<p>Left the page</p>} />
    </Routes>,
    { route: path },
  );
}

export const RUN_ID = '11111111-1111-4111-8111-111111111111';
export const INVOICE_ID = '22222222-2222-4222-8222-222222222222';

export function makeItem(overrides: Partial<PayrollItemDto> = {}): PayrollItemDto {
  return {
    id: '33333333-3333-4333-8333-333333333331',
    payrollRunId: RUN_ID,
    workerId: '44444444-4444-4444-8444-444444444441',
    workerName: 'Ana Schmidt',
    workerType: 'employee',
    daysWorked: 31,
    daysInPeriod: 31,
    grossMinor: 500_000,
    deductionsMinor: 100_000,
    netMinor: 420_000,
    employerCostMinor: 105_000,
    reimbursementsMinor: 20_000,
    deductions: [{ key: 'income_tax', name: 'Income tax', rateBps: 2000, amountMinor: 100_000 }],
    employerCosts: [{ key: 'pension', name: 'Pension', rateBps: 2100, amountMinor: 105_000 }],
    ...overrides,
  };
}

export function makeRun(overrides: Partial<PayrollRunDetailDto> = {}): PayrollRunDetailDto {
  return {
    id: RUN_ID,
    countryCode: 'DE',
    countryName: 'Germany',
    currency: 'EUR',
    periodYear: 2026,
    periodMonth: 3,
    status: 'draft',
    workerCount: 1,
    grossMinor: 500_000,
    deductionsMinor: 100_000,
    netMinor: 420_000,
    employerCostMinor: 105_000,
    reimbursementsMinor: 20_000,
    totalCostMinor: 625_000,
    rejectionReason: null,
    invoiceId: null,
    submittedAt: null,
    approvedAt: null,
    paidAt: null,
    createdAt: '2026-03-28T09:00:00.000Z',
    items: [makeItem()],
    ...overrides,
  };
}

export function makeInvoice(overrides: Partial<InvoiceDetailDto> = {}): InvoiceDetailDto {
  return {
    id: INVOICE_ID,
    number: 'INV-2026-000042',
    status: 'issued',
    currency: 'USD',
    subtotalMinor: 680_000,
    feeMinor: 59_900,
    totalMinor: 739_900,
    payrollRunId: RUN_ID,
    fxRate: '0.920000',
    localCurrency: 'EUR',
    issuedAt: '2026-03-30T10:00:00.000Z',
    dueDate: '2099-04-13',
    paidAt: null,
    organizationName: 'Acme GmbH',
    lines: [
      {
        id: 'l1',
        kind: 'gross_pay',
        description: 'Gross pay — Germany, March 2026',
        amountMinor: 543_478,
      },
      {
        id: 'l2',
        kind: 'employer_cost',
        description: 'Employer contributions',
        amountMinor: 114_130,
      },
      {
        id: 'l3',
        kind: 'reimbursement',
        description: 'Expense reimbursements',
        amountMinor: 22_392,
      },
      {
        id: 'l4',
        kind: 'platform_fee',
        description: 'Meridian EOR fee — 1 employee',
        amountMinor: 59_900,
      },
    ],
    ...overrides,
  };
}
