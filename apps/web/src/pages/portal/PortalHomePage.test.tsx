import type {
  ContractDto,
  DocumentDto,
  OnboardingTaskDto,
  Paginated,
  WorkerDetailDto,
} from '@meridian/shared';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { mockFetch, renderApp } from '../../test/render';
import { WhenSignedIn, on, sessionUser, signedInAs } from '../contracts/test-utils';
import PortalHomePage from './PortalHomePage';

afterEach(() => vi.unstubAllGlobals());

const page = <T,>(items: T[]): Paginated<T> => ({
  items,
  total: items.length,
  limit: 25,
  offset: 0,
});

function task(overrides: Partial<OnboardingTaskDto>): OnboardingTaskDto {
  return {
    id: 't',
    workerId: 'worker-1',
    key: 'bank_details',
    title: 'Task',
    description: 'Do the thing',
    assignee: 'worker',
    status: 'pending',
    automatic: false,
    completedAt: null,
    ...overrides,
  };
}

function worker(overrides: Partial<WorkerDetailDto> = {}): WorkerDetailDto {
  return {
    id: 'worker-1',
    type: 'employee',
    status: 'onboarding',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    countryCode: 'DE',
    countryName: 'Germany',
    jobTitle: 'Engineer',
    department: null,
    startDate: '2026-12-01',
    endDate: null,
    salaryMinor: 7_200_000,
    payBasis: 'annual',
    currency: 'EUR',
    hasPortalAccess: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    tasks: [
      task({ id: 't-bank', key: 'bank_details', title: 'Add bank details' }),
      task({
        id: 't-docs',
        key: 'documents_verified',
        title: 'Documents verified',
        automatic: true,
        assignee: 'platform',
      }),
      task({ id: 't-sign', key: 'contract_signed', title: 'Sign your agreement', automatic: true }),
      task({
        id: 't-start',
        key: 'client_confirm_start',
        title: 'Employer confirms start date',
        assignee: 'client',
      }),
    ],
    ...overrides,
  };
}

const passport: DocumentDto = {
  id: 'd1',
  workerId: 'worker-1',
  kind: 'passport',
  title: 'Passport',
  status: 'rejected',
  fileName: 'passport.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  reviewNote: 'The scan is blurry',
  uploadedAt: '2026-11-02T00:00:00.000Z',
  reviewedAt: '2026-11-03T00:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const sentContract = { id: 'c1', status: 'sent' } as const;

const renderPage = () =>
  renderApp(
    <WhenSignedIn>
      <PortalHomePage />
    </WhenSignedIn>,
  );

const rowOf = (title: string) => {
  const row = screen.getByText(title).closest('li');
  if (!row) throw new Error(`no row for ${title}`);
  return within(row);
};

describe('PortalHomePage', () => {
  it('gives each onboarding task the right call to action', async () => {
    const contract: Partial<ContractDto> = sentContract;
    mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', worker()),
      on('GET', '/contracts', page([contract])),
      on('GET', '/workers/worker-1/documents', { items: [passport] }),
    );
    renderPage();

    expect(await screen.findByRole('heading', { name: /welcome, ada/i })).toBeInTheDocument();
    expect(screen.getByText(/0 of 4 steps complete/i)).toBeInTheDocument();
    expect(
      rowOf('Add bank details').getByRole('button', { name: /mark complete/i }),
    ).toBeInTheDocument();
    expect(
      await rowOf('Sign your agreement').findByRole('link', { name: /review and sign/i }),
    ).toHaveAttribute('href', '/contracts/c1');
    expect(
      rowOf('Documents verified').getByRole('link', { name: /documents below/i }),
    ).toBeInTheDocument();
    expect(
      rowOf('Employer confirms start date').getByText(/waiting on your employer/i),
    ).toBeInTheDocument();
    // Documents card: the reviewer's note on a rejected upload, and a way to replace it.
    expect(await screen.findByText('The scan is blurry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace passport/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /download passport/i })).toBeInTheDocument();
  });

  it('says so when no agreement has been sent yet, and completes a manual task', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', worker()),
      on('GET', '/contracts', page([])),
      on('GET', '/workers/worker-1/documents', { items: [] }),
      on('POST', '/onboarding-tasks/t-bank/complete', {
        task: task({ id: 't-bank', status: 'completed', completedAt: '2026-11-15T00:00:00.000Z' }),
        workerStatus: 'onboarding',
      }),
    );
    renderPage();

    expect(
      await screen.findByText(/employer has not sent your agreement yet/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /mark complete/i }));
    expect(await screen.findByText(/"Add bank details" marked complete/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.url).toBe(
      '/api/v1/onboarding-tasks/t-bank/complete',
    );
  });

  it('shows quick links and employment details to an active worker', async () => {
    mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/me/worker', worker({ status: 'active', tasks: [] })),
      on('GET', '/workers/worker-1/documents', { items: [] }),
    );
    renderPage();

    const links = await screen.findByRole('navigation', { name: /quick links/i });
    for (const name of [/time off/i, /expenses/i, /payslips/i]) {
      expect(within(links).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('€72,000.00 per year')).toBeInTheDocument();
    expect(screen.queryByText(/steps complete/i)).not.toBeInTheDocument();
  });
});
