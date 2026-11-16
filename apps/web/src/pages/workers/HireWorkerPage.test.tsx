import type { WorkerCreatedDto } from '@meridian/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import HireWorkerPage from './HireWorkerPage';
import { country, polyfillDialog, renderPage, signedInAs, worker } from './test-helpers';

beforeAll(() => polyfillDialog());
afterEach(() => vi.unstubAllGlobals());

// A lower-case code proves the shared schema normalises it before it is sent.
const countries = ({ url }: { url: string }) =>
  url.endsWith('/countries')
    ? jsonResponse({
        items: [
          country({ code: 'de' }),
          country({ code: 'BR', name: 'Brazil', currency: 'BRL', eorSupported: false }),
        ],
      })
    : undefined;

const created = (acceptUrl: string | null) => ({
  worker: {
    ...worker({ id: '00000000-0000-4000-8000-0000000000aa', status: 'onboarding' }),
    tasks: [],
  },
  acceptUrl,
});

const hireHandler =
  (acceptUrl: string | null) =>
  ({ url, method }: { url: string; method: string }) =>
    method === 'POST' && url === '/api/v1/workers'
      ? jsonResponse(created(acceptUrl) satisfies WorkerCreatedDto, 201)
      : undefined;

async function fillValidForm() {
  await userEvent.type(screen.getByLabelText(/first name/i), 'Grace');
  await userEvent.type(screen.getByLabelText(/last name/i), 'Hopper');
  await userEvent.type(screen.getByLabelText(/^email/i), 'Grace@Acme.test');
  await userEvent.type(screen.getByLabelText(/job title/i), 'Engineer');
  await userEvent.selectOptions(screen.getByLabelText(/^country/i), 'de');
  await userEvent.type(screen.getByLabelText(/salary \(EUR\)/i), '60000');
  await userEvent.type(screen.getByLabelText(/start date/i), '2026-12-01');
}

describe('HireWorkerPage', () => {
  it('shows validation errors without calling the API', async () => {
    const { calls } = mockFetch(signedInAs(), countries);
    renderPage(<HireWorkerPage />, { route: '/people/new', path: '/people/new' });

    await userEvent.click(await screen.findByRole('button', { name: /^hire$/i }));

    expect(await screen.findByText('Choose a country')).toBeInTheDocument();
    expect(screen.getByText('Enter a salary')).toBeInTheDocument();
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(3);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('previews the employer cost in the browser without a network call', async () => {
    const { calls } = mockFetch(signedInAs(), countries);
    renderPage(<HireWorkerPage />, { route: '/people/new', path: '/people/new' });

    await userEvent.selectOptions(await screen.findByLabelText(/^country/i), 'de');
    await userEvent.type(screen.getByLabelText(/salary \(EUR\)/i), '60000');

    // 60,000/yr = 5,000/mo; pension 9.3% = 465/mo; total 5,465/mo.
    const preview = screen.getByLabelText('Cost preview');
    expect(preview).toHaveTextContent('€5,000.00');
    expect(preview).toHaveTextContent('€465.00');
    expect(preview).toHaveTextContent('€5,465.00');
    expect(preview).toHaveTextContent('$599.00');
    expect(calls.filter((c) => c.url.includes('/quotes'))).toHaveLength(0);
  });

  it('sends minor units and an upper-case country code, then shows the invite link', async () => {
    const acceptUrl = 'http://localhost:5173/accept-invite?token=abcdefghijklmnopqrstuvwxyz';
    const { calls } = mockFetch(signedInAs(), countries, hireHandler(acceptUrl));
    renderPage(<HireWorkerPage />, { route: '/people/new', path: '/people/new' });
    await screen.findByLabelText(/^country/i);

    await fillValidForm();
    await userEvent.click(screen.getByRole('button', { name: /^hire$/i }));

    expect(await screen.findByDisplayValue(acceptUrl)).toBeInTheDocument();
    expect(screen.getByText(/does not send email/i)).toBeInTheDocument();

    const hire = calls.find((c) => c.method === 'POST' && c.url === '/api/v1/workers');
    expect(hire?.body).toEqual({
      type: 'employee',
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@acme.test',
      countryCode: 'DE',
      jobTitle: 'Engineer',
      startDate: '2026-12-01',
      salaryMinor: 6_000_000,
      payBasis: 'annual',
      sendInvite: true,
    });

    await userEvent.click(screen.getByRole('button', { name: /continue to worker/i }));
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/people/00000000-0000-4000-8000-0000000000aa',
    );
  });

  it('goes straight to the worker page when no invite was requested', async () => {
    const { calls } = mockFetch(signedInAs(), countries, hireHandler(null));
    renderPage(<HireWorkerPage />, { route: '/people/new', path: '/people/new' });
    await screen.findByLabelText(/^country/i);

    await fillValidForm();
    await userEvent.click(screen.getByLabelText(/invite link/i));
    await userEvent.click(screen.getByRole('button', { name: /^hire$/i }));

    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/people/00000000-0000-4000-8000-0000000000aa',
    );
    const hire = calls.find((c) => c.method === 'POST');
    expect(hire?.body).toMatchObject({ sendInvite: false });
  });

  it('refuses to hire an employee in a contractors-only country', async () => {
    const { calls } = mockFetch(signedInAs(), countries);
    renderPage(<HireWorkerPage />, { route: '/people/new', path: '/people/new' });

    await userEvent.selectOptions(await screen.findByLabelText(/^country/i), 'BR');

    expect(screen.getByText(/cannot employ people in Brazil/i)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});
