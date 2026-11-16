import {
  addDays,
  type Paginated,
  type TimeOffRequestDto,
  type WorkerDetailDto,
} from '@meridian/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { todayLocal } from '../../lib/format';
import { jsonResponse, mockFetch, renderApp } from '../../test/render';
import { WhenSignedIn, on, polyfillDialog, sessionUser, signedInAs } from '../contracts/test-utils';
import TimeOffPage from './TimeOffPage';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

const page = <T,>(items: T[]): Paginated<T> => ({
  items,
  total: items.length,
  limit: 25,
  offset: 0,
});
const today = todayLocal();

function request(overrides: Partial<TimeOffRequestDto>): TimeOffRequestDto {
  return {
    id: 'r1',
    workerId: 'worker-1',
    workerName: 'Ada Lovelace',
    type: 'vacation',
    status: 'pending',
    startDate: addDays(today, 10),
    endDate: addDays(today, 11),
    days: 2,
    reason: 'Family visit',
    decisionNote: null,
    decidedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

const me: WorkerDetailDto = {
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
};

const balance = {
  workerId: 'worker-1',
  year: 2026,
  entitlementDays: 25,
  usedDays: 5,
  pendingDays: 2,
  remainingDays: 18,
};

const renderPage = () =>
  renderApp(
    <WhenSignedIn>
      <TimeOffPage />
    </WhenSignedIn>,
    { route: '/time-off' },
  );

describe('TimeOffPage (worker)', () => {
  it('shows the balance and offers Cancel only where the worker is allowed to', async () => {
    mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', me),
      on('GET', '/time-off/balance', balance),
      on(
        'GET',
        '/time-off/requests',
        page([
          request({ id: 'pending', reason: 'Pending one' }),
          request({ id: 'future', status: 'approved', reason: 'Future approved' }),
          request({
            id: 'started',
            status: 'approved',
            startDate: today,
            endDate: addDays(today, 1),
            reason: 'Already started',
          }),
          request({ id: 'rejected', status: 'rejected', reason: 'Rejected one' }),
        ]),
      ),
    );
    renderPage();

    expect(await screen.findByText('18 days')).toBeInTheDocument(); // remaining
    expect(await screen.findByText('Pending one')).toBeInTheDocument();

    const rowOf = (text: string) => {
      const row = screen.getByText(text).closest('tr');
      if (!row) throw new Error(`no row for ${text}`);
      return within(row);
    };
    expect(
      rowOf('Pending one').getByRole('button', { name: /cancel request/i }),
    ).toBeInTheDocument();
    expect(
      rowOf('Future approved').getByRole('button', { name: /cancel request/i }),
    ).toBeInTheDocument();
    expect(
      rowOf('Already started').queryByRole('button', { name: /cancel/i }),
    ).not.toBeInTheDocument();
    expect(
      rowOf('Rejected one').queryByRole('button', { name: /cancel/i }),
    ).not.toBeInTheDocument();
    // Workers never get approval actions or a worker picker.
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('counts working days live and shows the server refusal as a form error', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', me),
      on('GET', '/time-off/balance', balance),
      on('GET', '/time-off/requests', page([])),
      ({ method, url }) =>
        method === 'POST' && url.endsWith('/time-off/requests')
          ? jsonResponse(
              { error: { code: 'insufficient_balance', message: 'Only 18 vacation days remain' } },
              409,
            )
          : undefined,
    );
    renderPage();

    const [open] = await screen.findAllByRole('button', { name: /request time off/i });
    if (!open) throw new Error('no button');
    await userEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: /request time off/i });
    expect(within(dialog).queryByLabelText(/worker/i)).not.toBeInTheDocument();

    // Mon 2027-01-04 … Fri 2027-01-15 = 10 working days.
    await userEvent.type(within(dialog).getByLabelText(/first day/i), '2027-01-04');
    await userEvent.type(within(dialog).getByLabelText(/last day/i), '2027-01-15');
    expect(within(dialog).getByText(/10 working days/i)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: /submit request/i }));
    expect(await within(dialog).findByText('Only 18 vacation days remain')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      type: 'vacation',
      startDate: '2027-01-04',
      endDate: '2027-01-15',
    });
  });

  it('explains that contractors do not track time off', async () => {
    mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', { ...me, type: 'contractor' }),
      on('GET', '/time-off/requests', page([])),
    );
    renderPage();

    expect((await screen.findAllByText(/not tracked for contractors/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /request time off/i })).not.toBeInTheDocument();
  });
});

describe('TimeOffPage (staff)', () => {
  it('approves a pending request and rejects with an optional note', async () => {
    const pending = request({});
    const { calls } = mockFetch(
      signedInAs(sessionUser('client_manager')),
      on('POST', '/time-off/requests/r1/decision', { ...pending, status: 'approved' }),
      on('GET', '/time-off/requests', page([pending])),
    );
    renderPage();

    await userEvent.click(
      await screen.findByRole('button', { name: /approve ada lovelace's request/i }),
    );
    expect(
      await screen.findByText(/approved ada lovelace's vacation request/i),
    ).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ decision: 'approved' });

    await userEvent.click(screen.getByRole('button', { name: /reject ada lovelace's request/i }));
    const dialog = screen.getByRole('dialog', { name: /reject time-off request/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /reject request/i }));
    expect(await screen.findByText('Request rejected')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST').at(-1)?.body).toEqual({ decision: 'rejected' });
    expect(calls.find((c) => c.url.startsWith('/api/v1/time-off/requests?'))?.url).toContain(
      'status=pending',
    );
  });
});
