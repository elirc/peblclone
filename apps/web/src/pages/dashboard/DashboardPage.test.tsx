import type { DashboardDto } from '@meridian/shared';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import { renderPage, signedInAs } from '../workers/test-helpers';
import DashboardPage from './DashboardPage';

afterEach(() => vi.unstubAllGlobals());

const months = (totals: number[]): DashboardDto['monthlySpend'] =>
  totals.map((totalUsdMinor, i) => ({ year: 2026, month: 6 + i, totalUsdMinor }));

const dashboard = (overrides: Partial<DashboardDto> = {}): DashboardDto => ({
  headcount: { total: 5, active: 3, onboarding: 2, employees: 4, contractors: 1 },
  byCountry: [
    { countryCode: 'DE', countryName: 'Germany', count: 3 },
    { countryCode: 'BR', countryName: 'Brazil', count: 2 },
  ],
  pending: {
    timeOffRequests: 2,
    expenses: 0,
    payrollApprovals: 1,
    unpaidInvoices: 0,
    contractsAwaitingSignature: 0,
  },
  monthlySpend: months([0, 0, 0, 0, 1_250_000, 2_500_000]),
  recentActivity: [
    {
      id: 'a1',
      action: 'worker.created',
      entityType: 'worker',
      entityId: null,
      actorName: 'Ada Admin',
      metadata: {},
      createdAt: '2026-11-01T10:00:00.000Z',
    },
  ],
  ...overrides,
});

const serve = (body: DashboardDto) => (r: { url: string }) =>
  r.url.endsWith('/dashboard') ? jsonResponse(body) : undefined;

describe('DashboardPage', () => {
  it('links each non-zero pending count to the page that resolves it', async () => {
    mockFetch(signedInAs(), serve(dashboard()));
    renderPage(<DashboardPage />, { route: '/', path: '/' });

    expect(
      await screen.findByRole('link', { name: /2 time-off requests to review/i }),
    ).toHaveAttribute('href', '/time-off');
    expect(screen.getByRole('link', { name: /1 payroll run awaiting approval/i })).toHaveAttribute(
      'href',
      '/payroll',
    );
    expect(screen.queryByText(/expenses to review/i)).not.toBeInTheDocument();
    expect(screen.getByText('$25,000.00')).toBeInTheDocument();
    expect(screen.getByText('Worker created')).toBeInTheDocument();
  });

  it('says so when nothing needs attention', async () => {
    mockFetch(
      signedInAs(),
      serve(
        dashboard({
          pending: {
            timeOffRequests: 0,
            expenses: 0,
            payrollApprovals: 0,
            unpaidInvoices: 0,
            contractsAwaitingSignature: 0,
          },
        }),
      ),
    );
    renderPage(<DashboardPage />, { route: '/', path: '/' });

    expect(await screen.findByText(/all caught up/i)).toBeInTheDocument();
  });

  it('invites a brand-new company to hire their first person', async () => {
    mockFetch(
      signedInAs(),
      serve(
        dashboard({
          headcount: { total: 0, active: 0, onboarding: 0, employees: 0, contractors: 0 },
          byCountry: [],
          pending: {
            timeOffRequests: 0,
            expenses: 0,
            payrollApprovals: 0,
            unpaidInvoices: 0,
            contractsAwaitingSignature: 0,
          },
          monthlySpend: months([0, 0, 0, 0, 0, 0]),
          recentActivity: [],
        }),
      ),
    );
    renderPage(<DashboardPage />, { route: '/', path: '/' });

    expect(await screen.findByText('Hire your first person')).toBeInTheDocument();
    expect(screen.queryByText('Total headcount')).not.toBeInTheDocument();
  });
});
