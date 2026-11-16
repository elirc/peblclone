import type { Paginated, WorkerDto } from '@meridian/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import { country, renderPage, signedInAs, worker } from './test-helpers';
import WorkersPage from './WorkersPage';

afterEach(() => vi.unstubAllGlobals());

const countries = ({ url }: { url: string }) =>
  url.endsWith('/countries') ? jsonResponse({ items: [country()] }) : undefined;

const workersList =
  (items: WorkerDto[]) =>
  ({ url, method }: { url: string; method: string }) =>
    method === 'GET' && url.startsWith('/api/v1/workers?')
      ? jsonResponse({
          items,
          total: items.length,
          limit: 25,
          offset: 0,
        } satisfies Paginated<WorkerDto>)
      : undefined;

const workerRequests = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/v1/workers?'));

describe('WorkersPage', () => {
  it('renders a row per worker with formatted salary and badges', async () => {
    mockFetch(
      signedInAs(),
      countries,
      workersList([
        worker(),
        worker({
          id: '00000000-0000-4000-8000-000000000002',
          firstName: 'Linus',
          lastName: 'Pauling',
          email: 'linus@acme.test',
          type: 'contractor',
          status: 'onboarding',
          salaryMinor: 500_000,
          payBasis: 'monthly',
        }),
      ]),
    );
    renderPage(<WorkersPage />, { route: '/people', path: '/people' });

    expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('grace@acme.test')).toBeInTheDocument();
    expect(screen.getByText('€72,000.00/yr')).toBeInTheDocument();
    expect(screen.getByText('Linus Pauling')).toBeInTheDocument();
    expect(screen.getByText('€5,000.00/mo')).toBeInTheDocument();
    // Status and type are words, not just colours.
    const table = within(screen.getByRole('table', { name: 'People' }));
    expect(table.getByText('Contractor')).toBeInTheDocument();
    expect(table.getByText('Onboarding')).toBeInTheDocument();
  });

  it('shows an empty state with a hire action when there is nobody yet', async () => {
    mockFetch(signedInAs(), countries, workersList([]));
    renderPage(<WorkersPage />, { route: '/people', path: '/people' });

    expect(await screen.findByText('No people yet')).toBeInTheDocument();
    // One "Hire someone" in the header, one in the empty state.
    expect(screen.getAllByRole('link', { name: /hire someone/i })).toHaveLength(2);
  });

  it('sends the search to the API once the user stops typing', async () => {
    const { calls } = mockFetch(signedInAs(), countries, workersList([worker()]));
    renderPage(<WorkersPage />, { route: '/people', path: '/people' });
    await screen.findByText('Grace Hopper');

    await userEvent.type(screen.getByLabelText(/search/i), 'ada');

    await waitFor(() =>
      expect(workerRequests(calls).some((c) => c.url.includes('search=ada'))).toBe(true),
    );
    // Debounced: no request was made for the partial words "a" or "ad".
    const searched = workerRequests(calls).filter((c) => c.url.includes('search='));
    expect(searched.every((c) => c.url.includes('search=ada'))).toBe(true);
  });

  it('reads filters from the URL and ignores values the API would reject', async () => {
    const { calls } = mockFetch(signedInAs(), countries, workersList([]));
    renderPage(<WorkersPage />, {
      route: '/people?status=active&type=nonsense&country=de',
      path: '/people',
    });

    // Filters are applied, so the "no matches" variant of the empty state is shown.
    expect(await screen.findByText('No one matches these filters')).toBeInTheDocument();
    const url = workerRequests(calls)[0]?.url ?? '';
    expect(url).toContain('status=active');
    expect(url).toContain('countryCode=DE');
    expect(url).not.toContain('type=');
  });
});
