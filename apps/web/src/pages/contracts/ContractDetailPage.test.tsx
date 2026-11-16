import type { ContractDetailDto, ContractStatus } from '@meridian/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, renderApp } from '../../test/render';
import ContractDetailPage from './ContractDetailPage';
import { WhenSignedIn, on, polyfillDialog, sessionUser, signedInAs } from './test-utils';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

function contract(
  status: ContractStatus,
  overrides: Partial<ContractDetailDto> = {},
): ContractDetailDto {
  return {
    id: 'c1',
    workerId: 'worker-1',
    workerName: 'Ada Lovelace',
    status,
    title: 'Employment agreement — Ada Lovelace',
    terms: {
      workerName: 'Ada Lovelace',
      workerType: 'employee',
      jobTitle: 'Engineer',
      countryCode: 'DE',
      countryName: 'Germany',
      startDate: '2026-12-01',
      salaryMinor: 7_200_000,
      payBasis: 'annual',
      currency: 'EUR',
      annualLeaveDays: 25,
      noticePeriodDays: 30,
      probationDays: 180,
    },
    sentAt: status === 'draft' ? null : '2026-11-10T09:00:00.000Z',
    signedAt: null,
    signedByName: null,
    activatedAt: null,
    terminatedAt: null,
    createdAt: '2026-11-09T09:00:00.000Z',
    body: 'THIS AGREEMENT is made between Acme Ltd and Ada Lovelace.\n\n1. Duties…',
    ...overrides,
  };
}

function renderDetail() {
  return renderApp(
    <WhenSignedIn>
      <Routes>
        <Route path="/contracts/:id" element={<ContractDetailPage />} />
      </Routes>
    </WhenSignedIn>,
    { route: '/contracts/c1' },
  );
}

const STAFF_ACTIONS = [
  /^edit$/i,
  /send to worker/i,
  /^recall$/i,
  /^activate$/i,
  /^void$/i,
  /^terminate$/i,
];

describe('ContractDetailPage', () => {
  it('shows a worker the signing card for a sent contract, and no staff actions', async () => {
    mockFetch(signedInAs(sessionUser('worker')), on('GET', '/contracts/c1', contract('sent')));
    renderDetail();

    expect(await screen.findByRole('heading', { name: /review and sign/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/full legal name/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign agreement/i })).toBeInTheDocument();
    // Terms and body render.
    expect(screen.getByText('€72,000.00 per year')).toBeInTheDocument();
    expect(screen.getByText(/THIS AGREEMENT is made between/)).toBeInTheDocument();
    for (const name of STAFF_ACTIONS) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('shows staff Edit / Send on a draft, and no signing card', async () => {
    mockFetch(
      signedInAs(sessionUser('client_admin')),
      on('GET', '/contracts/c1', contract('draft')),
    );
    renderDetail();

    expect(await screen.findByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send to worker/i })).toBeInTheDocument();
    // An admin may void a draft…
    expect(screen.getByRole('button', { name: /^void$/i })).toBeInTheDocument();
    // …but nothing the draft status does not allow.
    expect(screen.queryByRole('button', { name: /^recall$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^activate$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /review and sign/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/full legal name/i)).not.toBeInTheDocument();
  });

  it('hides admin-only actions from a client manager', async () => {
    mockFetch(
      signedInAs(sessionUser('client_manager')),
      on('GET', '/contracts/c1', contract('sent')),
    );
    renderDetail();

    expect(await screen.findByRole('button', { name: /^recall$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^void$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /review and sign/i })).not.toBeInTheDocument();
  });

  it('signing posts { signedByName, agree: true } and then shows the signed state', async () => {
    const signed = contract('signed', {
      signedAt: '2026-11-15T10:00:00.000Z',
      signedByName: 'Ada Lovelace',
    });
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('POST', '/contracts/c1/sign', signed),
      on('GET', '/contracts/c1', contract('sent')),
    );
    renderDetail();

    await userEvent.type(await screen.findByLabelText(/full legal name/i), '  Ada Lovelace ');
    await userEvent.click(screen.getByLabelText(/i have read and agree/i));
    await userEvent.click(screen.getByRole('button', { name: /sign agreement/i }));

    expect(await screen.findByText(/you signed this agreement/i)).toBeInTheDocument();
    const sign = calls.find((c) => c.method === 'POST');
    expect(sign?.url).toBe('/api/v1/contracts/c1/sign');
    // The shared nameSchema trims the typed name before it is sent.
    expect(sign?.body).toEqual({ signedByName: 'Ada Lovelace', agree: true });
    expect(screen.queryByRole('button', { name: /sign agreement/i })).not.toBeInTheDocument();
  });

  it('does not sign until the agreement box is ticked', async () => {
    const { calls } = mockFetch(
      signedInAs(sessionUser('worker')),
      on('GET', '/contracts/c1', contract('sent')),
    );
    renderDetail();

    await userEvent.type(await screen.findByLabelText(/full legal name/i), 'Ada Lovelace');
    await userEvent.click(screen.getByRole('button', { name: /sign agreement/i }));

    expect(await screen.findByText(/please confirm you have read and agree/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('shows a signature mismatch on the name field', async () => {
    mockFetch(
      signedInAs(sessionUser('worker')),
      ({ method, url }) =>
        method === 'POST' && url.endsWith('/contracts/c1/sign')
          ? jsonResponse(
              {
                error: {
                  code: 'signature_mismatch',
                  message: 'The name does not match the worker',
                },
              },
              400,
            )
          : undefined,
      on('GET', '/contracts/c1', contract('sent')),
    );
    renderDetail();

    const name = await screen.findByLabelText(/full legal name/i);
    await userEvent.type(name, 'Someone Else');
    await userEvent.click(screen.getByLabelText(/i have read and agree/i));
    await userEvent.click(screen.getByRole('button', { name: /sign agreement/i }));

    expect(await screen.findByText('The name does not match the worker')).toBeInTheDocument();
    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    // Shown once, under the field — not repeated as a banner.
    expect(screen.getAllByText('The name does not match the worker')).toHaveLength(1);
  });
});
