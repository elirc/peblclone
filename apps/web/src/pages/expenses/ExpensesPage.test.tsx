import type { ExpenseDto, Paginated, WorkerDetailDto } from '@meridian/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { todayLocal } from '../../lib/format';
import { mockFetch, renderApp } from '../../test/render';
import { WhenSignedIn, on, polyfillDialog, sessionUser, signedInAs } from '../contracts/test-utils';
import ExpensesPage from './ExpensesPage';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

const page = <T,>(items: T[]): Paginated<T> => ({
  items,
  total: items.length,
  limit: 25,
  offset: 0,
});

const taxi: ExpenseDto = {
  id: 'e1',
  workerId: 'worker-1',
  workerName: 'Ada Lovelace',
  category: 'travel',
  description: 'Taxi to client site',
  amountMinor: 4_250,
  currency: 'EUR',
  incurredOn: '2026-11-10',
  status: 'submitted',
  decisionNote: null,
  decidedAt: null,
  payrollRunId: null,
  createdAt: '2026-11-10T12:00:00.000Z',
};

function me(overrides: Partial<WorkerDetailDto> = {}): WorkerDetailDto {
  return {
    id: 'worker-1',
    type: 'employee',
    status: 'active',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    countryCode: 'DE',
    countryName: 'Germany',
    jobTitle: 'Engineer',
    department: null,
    startDate: '2026-01-01',
    endDate: null,
    salaryMinor: 7_200_000,
    payBasis: 'annual',
    currency: 'EUR',
    hasPortalAccess: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    tasks: [],
    ...overrides,
  };
}

const renderPage = () =>
  renderApp(
    <WhenSignedIn>
      <ExpensesPage />
    </WhenSignedIn>,
    { route: '/expenses' },
  );

describe('ExpensesPage (staff)', () => {
  it('shows the review queue with amounts in the expense currency', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('client_admin')),
      on('GET', '/expenses', page([taxi])),
    );
    renderPage();

    expect(await screen.findByText('Taxi to client site')).toBeInTheDocument();
    expect(screen.getByText('€42.50')).toBeInTheDocument();
    // "To review" asks the API for submitted expenses only.
    expect(calls.find((c) => c.url.startsWith('/api/v1/expenses'))?.url).toContain(
      'status=submitted',
    );
  });

  it('will not reject without a note, and sends the note once given', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('client_manager')),
      on('POST', '/expenses/e1/decision', {
        ...taxi,
        status: 'rejected',
        decisionNote: 'No receipt',
      }),
      on('GET', '/expenses', page([taxi])),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /reject ada lovelace's expense/i }),
    );
    const dialog = screen.getByRole('dialog', { name: /reject expense/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /reject expense/i }));

    expect(
      await within(dialog).findByText(/add a note so the worker knows why/i),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    // Whitespace alone is not a note either.
    await userEvent.type(within(dialog).getByLabelText(/reason for rejecting/i), '   ');
    await userEvent.click(within(dialog).getByRole('button', { name: /reject expense/i }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await userEvent.type(within(dialog).getByLabelText(/reason for rejecting/i), 'No receipt');
    await userEvent.click(within(dialog).getByRole('button', { name: /reject expense/i }));

    expect(await screen.findByText('Expense rejected')).toBeInTheDocument();
    const decision = calls.find((c) => c.method === 'POST');
    expect(decision?.url).toBe('/api/v1/expenses/e1/decision');
    expect(decision?.body).toEqual({ decision: 'rejected', note: 'No receipt' });
  });
});

describe('ExpensesPage (worker)', () => {
  async function openSubmitDialog() {
    const [first] = await screen.findAllByRole('button', { name: /submit expense/i });
    if (!first) throw new Error('no submit button');
    await userEvent.click(first);
    return screen.getByRole('dialog', { name: /submit expense/i });
  }

  it('converts the amount typed in major units to minor units', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', me()),
      on('GET', '/expenses', page([])),
      on('POST', '/expenses', { ...taxi, id: 'e2', amountMinor: 123_450 }, 201),
    );
    renderPage();

    const dialog = await openSubmitDialog();
    // The amount is labelled with the worker's own currency.
    const amount = within(dialog).getByLabelText(/amount \(eur\)/i);
    await userEvent.selectOptions(within(dialog).getByLabelText(/category/i), 'equipment');
    await userEvent.type(within(dialog).getByLabelText(/description/i), 'Monitor');
    await userEvent.type(amount, '1,234.50');
    await userEvent.click(within(dialog).getByRole('button', { name: /submit expense/i }));

    expect(await screen.findByText(/expense submitted for review/i)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/v1/expenses');
    expect(post?.body).toEqual({
      category: 'equipment',
      description: 'Monitor',
      amountMinor: 123_450,
      incurredOn: todayLocal(),
    });
  });

  it('respects zero-decimal currencies', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', me({ currency: 'JPY', countryCode: 'JP', countryName: 'Japan' })),
      on('GET', '/expenses', page([])),
      on('POST', '/expenses', { ...taxi, currency: 'JPY', amountMinor: 1500 }, 201),
    );
    renderPage();

    const dialog = await openSubmitDialog();
    await userEvent.type(within(dialog).getByLabelText(/description/i), 'Lunch');
    await userEvent.type(within(dialog).getByLabelText(/amount \(jpy\)/i), '1500');
    await userEvent.click(within(dialog).getByRole('button', { name: /submit expense/i }));

    await screen.findByText(/expense submitted for review/i);
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ amountMinor: 1500 });
  });

  it('rejects a non-numeric amount without calling the API', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', me()),
      on('GET', '/expenses', page([])),
    );
    renderPage();

    const dialog = await openSubmitDialog();
    await userEvent.type(within(dialog).getByLabelText(/description/i), 'Monitor');
    await userEvent.type(within(dialog).getByLabelText(/amount/i), 'twelve');
    await userEvent.click(within(dialog).getByRole('button', { name: /submit expense/i }));

    expect(
      await within(dialog).findByText(/enter an amount greater than zero/i),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('lets a worker delete only submitted expenses and never shows approval actions', async () => {
    const reimbursed: ExpenseDto = {
      ...taxi,
      id: 'e3',
      description: 'Old hotel',
      status: 'reimbursed',
    };
    mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', me()),
      on('GET', '/expenses', page([taxi, reimbursed])),
    );
    renderPage();

    expect(
      await screen.findByRole('button', { name: /delete expense: taxi/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /delete expense: old hotel/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/paid through payroll/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^reject/i })).not.toBeInTheDocument();
  });
});
