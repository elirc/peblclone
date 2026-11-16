import type { OnboardingTaskDto, UserRole, WorkerDetailDto } from '@meridian/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import { polyfillDialog, renderPage, signedInAs, worker } from './test-helpers';
import WorkerDetailPage from './WorkerDetailPage';

beforeAll(() => polyfillDialog());
afterEach(() => vi.unstubAllGlobals());

const ID = '00000000-0000-4000-8000-000000000001';

const task = (overrides: Partial<OnboardingTaskDto>): OnboardingTaskDto => ({
  id: `task-${overrides.key ?? 'x'}`,
  workerId: ID,
  key: 'bank_details',
  title: 'Bank details',
  description: 'Add bank details in the portal.',
  assignee: 'worker',
  status: 'pending',
  automatic: false,
  completedAt: null,
  ...overrides,
});

const detail = (overrides: Partial<WorkerDetailDto> = {}): WorkerDetailDto => ({
  ...worker(),
  tasks: [],
  ...overrides,
});

function mockWorker(role: UserRole, body: WorkerDetailDto) {
  return mockFetch(signedInAs(role), ({ url, method }) => {
    if (method === 'GET' && url === `/api/v1/workers/${ID}`) return jsonResponse(body);
    if (method === 'GET' && url === `/api/v1/workers/${ID}/documents`)
      return jsonResponse({ items: [] });
    return undefined;
  });
}

describe('WorkerDetailPage', () => {
  it('shows a clear "not found" state for a 404', async () => {
    mockFetch(signedInAs(), ({ url }) =>
      url.includes('/workers/')
        ? jsonResponse({ error: { code: 'not_found', message: 'Worker not found' } }, 404)
        : undefined,
    );
    renderPage(<WorkerDetailPage />, { route: `/people/${ID}`, path: '/people/:id' });

    expect(await screen.findByText("We couldn't find this worker")).toBeInTheDocument();
  });

  it('offers admins only the status moves the transition table allows', async () => {
    mockWorker('client_admin', detail({ status: 'active' }));
    renderPage(<WorkerDetailPage />, { route: `/people/${ID}`, path: '/people/:id' });

    expect(await screen.findByRole('button', { name: 'Start offboarding' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark terminated' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel onboarding' })).not.toBeInTheDocument();
  });

  it('hides status actions from managers', async () => {
    mockWorker('client_manager', detail({ status: 'active' }));
    renderPage(<WorkerDetailPage />, { route: `/people/${ID}`, path: '/people/:id' });

    await screen.findByText('Details');
    expect(screen.queryByRole('button', { name: 'Start offboarding' })).not.toBeInTheDocument();
  });

  it('requires an end date before starting offboarding', async () => {
    const { calls } = mockWorker('client_admin', detail({ status: 'active' }));
    renderPage(<WorkerDetailPage />, { route: `/people/${ID}`, path: '/people/:id' });

    await userEvent.click(await screen.findByRole('button', { name: 'Start offboarding' }));
    const dialogSubmit = screen.getAllByRole('button', { name: 'Start offboarding' }).at(-1);
    if (!dialogSubmit) throw new Error('dialog submit button missing');
    await userEvent.click(dialogSubmit);

    expect(await screen.findByText('Choose the last working day')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows the checklist with progress, explaining automatic tasks instead of a button', async () => {
    mockWorker(
      'client_admin',
      detail({
        status: 'onboarding',
        tasks: [
          task({ key: 'bank_details', title: 'Bank details', assignee: 'worker' }),
          task({
            key: 'contract_signed',
            title: 'Contract signed',
            assignee: 'worker',
            automatic: true,
          }),
          task({ key: 'client_confirm_start', title: 'Confirm start date', assignee: 'client' }),
          task({
            key: 'documents_verified',
            title: 'Documents verified',
            assignee: 'platform',
            automatic: true,
            status: 'completed',
            completedAt: '2026-01-02T10:00:00.000Z',
          }),
        ],
      }),
    );
    renderPage(<WorkerDetailPage />, {
      route: `/people/${ID}?tab=onboarding`,
      path: '/people/:id',
    });

    const progress = await screen.findByRole('progressbar', { name: 'Onboarding progress' });
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(progress).toHaveAttribute('aria-valuemax', '4');
    expect(screen.getByText(/when Grace signs their contract/i)).toBeInTheDocument();
    // A client admin may complete the client task only; the worker's task waits on the worker.
    expect(
      screen.getByRole('button', { name: 'Mark "Confirm start date" complete' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark "Bank details" complete' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/waiting on Grace/i)).toBeInTheDocument();
  });
});
