import type { PayrollRunDto } from '@meridian/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import PayrollRunsPage from './PayrollRunsPage';
import { makeRun, makeUser, polyfillDialog, renderPage, route, signedInAs } from './test-fixtures';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

const { items: _items, ...runSummary } = makeRun({ status: 'pending_approval' });
const run: PayrollRunDto = runSummary;

const countries = route('GET', '/countries', () =>
  jsonResponse({
    items: [
      { code: 'DE', name: 'Germany', currency: 'EUR' },
      { code: 'PT', name: 'Portugal', currency: 'EUR' },
    ],
  }),
);
const runs = (items: PayrollRunDto[]) =>
  route('GET', '/payroll/runs', () =>
    jsonResponse({ items, total: items.length, limit: 25, offset: 0 }),
  );

describe('PayrollRunsPage', () => {
  it('lists runs with period, formatted total and status', async () => {
    mockFetch(signedInAs(makeUser('client_manager')), countries, runs([run]));
    renderPage(<PayrollRunsPage />, { path: '/payroll', pattern: '/payroll' });

    const table = await screen.findByRole('table', { name: 'Payroll runs' });
    expect(within(table).getByText('March 2026')).toBeInTheDocument();
    expect(within(table).getByText('€6,250.00')).toBeInTheDocument();
    expect(within(table).getByText('Pending approval')).toBeInTheDocument();
    // Managers cannot create runs.
    expect(screen.queryByRole('button', { name: 'New payroll run' })).not.toBeInTheDocument();
  });

  it('sends the status filter to the API', async () => {
    const { calls } = mockFetch(signedInAs(makeUser('client_manager')), countries, runs([run]));
    renderPage(<PayrollRunsPage />, { path: '/payroll', pattern: '/payroll' });

    await screen.findByRole('table', { name: 'Payroll runs' });
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'paid');
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.startsWith('/api/v1/payroll/runs?') && c.url.includes('status=paid'),
        ),
      ).toBe(true),
    );
  });

  it('shows the API reason when a run for that period already exists', async () => {
    const { calls } = mockFetch(
      signedInAs(makeUser('client_admin')),
      countries,
      runs([]),
      route('POST', '/payroll/runs', () =>
        jsonResponse(
          {
            error: {
              code: 'run_exists',
              message: 'A payroll run for this country and month already exists',
            },
          },
          409,
        ),
      ),
    );
    renderPage(<PayrollRunsPage />, { path: '/payroll', pattern: '/payroll' });

    expect(await screen.findByText('No payroll runs yet')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'New payroll run' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'New payroll run' });

    // No country chosen -> blocked in the browser.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create run' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await within(dialog).findByRole('option', { name: 'Germany (EUR)' });
    await userEvent.selectOptions(within(dialog).getByLabelText(/country/i), 'DE');
    await userEvent.selectOptions(within(dialog).getByLabelText(/month/i), '2');
    const year = new Date().getFullYear();
    await userEvent.selectOptions(within(dialog).getByLabelText(/year/i), String(year));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create run' }));

    expect(
      await within(dialog).findByText('A payroll run for this country and month already exists'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      countryCode: 'DE',
      periodYear: year,
      periodMonth: 2,
    });
  });
});
