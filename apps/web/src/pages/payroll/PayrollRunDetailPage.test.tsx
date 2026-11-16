import type { PayrollRunDetailDto, SessionUser } from '@meridian/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import PayrollRunDetailPage from './PayrollRunDetailPage';
import {
  INVOICE_ID,
  makeInvoice,
  makeItem,
  makeRun,
  makeUser,
  polyfillDialog,
  renderPage,
  route,
  RUN_ID,
  signedInAs,
} from './test-fixtures';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

const runPath = `/payroll/runs/${RUN_ID}`;

function setup(user: SessionUser, run: PayrollRunDetailDto, ...extra: Parameters<typeof mockFetch>) {
  const fetchMock = mockFetch(
    signedInAs(user),
    route('GET', runPath, () => jsonResponse(run)),
    route('GET', `/invoices/${INVOICE_ID}`, () => jsonResponse(makeInvoice())),
    ...extra,
  );
  renderPage(<PayrollRunDetailPage />, { path: `/payroll/${RUN_ID}`, pattern: '/payroll/:id' });
  return fetchMock;
}

/** The action bar lives inside the "What happens next" callout. */
async function actionNames(): Promise<string[]> {
  const callout = (await screen.findByTestId('next-step')).parentElement;
  if (!callout) throw new Error('callout not found');
  return within(callout)
    .queryAllByRole('button')
    .map((button) => button.textContent ?? '');
}

describe('PayrollRunDetailPage', () => {
  it('offers a client admin Approve and Reject (not Process) on a pending run', async () => {
    setup(makeUser('client_admin'), makeRun({ status: 'pending_approval' }));

    expect(await screen.findByRole('heading', { name: 'Waiting for your approval' })).toBeInTheDocument();
    const names = await actionNames();
    expect(names).toEqual(expect.arrayContaining(['Approve', 'Reject']));
    expect(names).not.toContain('Process');
    expect(names).not.toContain('Submit for approval');
    expect(names).not.toContain('Delete');
  });

  it('offers a platform admin Process on an approved run whose invoice is paid', async () => {
    const run = makeRun({ status: 'approved', invoiceId: INVOICE_ID });
    const { calls } = mockFetch(
      signedInAs(makeUser('platform_admin')),
      route('GET', runPath, () => jsonResponse(run)),
      route('GET', `/invoices/${INVOICE_ID}`, () =>
        jsonResponse(makeInvoice({ status: 'paid', paidAt: '2026-04-01T08:00:00.000Z' })),
      ),
    );
    renderPage(<PayrollRunDetailPage />, { path: `/payroll/${RUN_ID}`, pattern: '/payroll/:id' });

    expect(await screen.findByRole('heading', { name: /INV-2026-000042 is paid/ })).toBeInTheDocument();
    const names = await actionNames();
    expect(names).toEqual(['Process']);
    expect(calls.some((c) => c.url === `/api/v1/invoices/${INVOICE_ID}`)).toBe(true);
  });

  it('does not offer Process to a client admin on an approved run', async () => {
    setup(makeUser('client_admin'), makeRun({ status: 'approved', invoiceId: INVOICE_ID }));

    // Invoice still issued -> the callout says what we are waiting for and links to it.
    expect(
      await screen.findByRole('heading', { name: 'Waiting for invoice INV-2026-000042 to be paid' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View invoice INV-2026-000042' })).toHaveAttribute(
      'href',
      `/invoices/${INVOICE_ID}`,
    );
    expect(await actionNames()).toEqual([]);
  });

  it('offers a manager Submit but not Delete or Recalculate on a draft', async () => {
    setup(makeUser('client_manager'), makeRun({ status: 'draft' }));

    const names = await actionNames();
    expect(names).toContain('Submit for approval');
    expect(names).not.toContain('Delete');
    expect(names).not.toContain('Recalculate');
    expect(names).not.toContain('Approve');
  });

  it('gives a client admin Recalculate and Delete on a draft', async () => {
    setup(makeUser('client_admin'), makeRun({ status: 'draft' }));

    const names = await actionNames();
    expect(names).toEqual(expect.arrayContaining(['Submit for approval', 'Recalculate', 'Delete']));
  });

  it('renders totals as formatted money and flags prorated workers', async () => {
    setup(
      makeUser('client_admin'),
      makeRun({
        workerCount: 2,
        items: [
          makeItem(),
          makeItem({
            id: 'item-2',
            workerId: 'w2',
            workerName: 'Ben Okafor',
            workerType: 'contractor',
            daysWorked: 10,
            daysInPeriod: 31,
          }),
        ],
      }),
    );

    expect(await screen.findByText('€6,250.00')).toBeInTheDocument(); // total cost
    expect(screen.getByText('€4,200.00', { selector: 'dd' })).toBeInTheDocument(); // net to workers
    expect(screen.getByText('−€1,000.00')).toBeInTheDocument(); // deductions
    expect(screen.getAllByText('€1,050.00').length).toBeGreaterThan(0); // employer costs
    expect(screen.getByText('Prorated')).toBeInTheDocument();
    expect(screen.getByText('10 / 31')).toBeInTheDocument();
  });

  it('shows the rejection reason prominently on a returned draft', async () => {
    setup(makeUser('client_manager'), makeRun({ status: 'draft', rejectionReason: 'Ana’s raise is missing' }));

    expect(await screen.findByText('This run was rejected and returned to draft')).toBeInTheDocument();
    expect(screen.getByText(/Ana’s raise is missing/)).toBeInTheDocument();
  });

  it('approves only after confirmation, explaining the invoice', async () => {
    const approved = makeRun({ status: 'approved', invoiceId: INVOICE_ID });
    const { calls } = setup(
      makeUser('client_admin'),
      makeRun({ status: 'pending_approval' }),
      route('POST', `${runPath}/approve`, () => jsonResponse(approved)),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve this payroll run?' });
    expect(within(dialog).getByText(/issues an invoice/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Approve and issue invoice' }));

    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === `/api/v1${runPath}/approve`)).toBe(true),
    );
    // The response is written into the cache, so the page moves on to the next step.
    expect(
      await screen.findByRole('heading', { name: 'Waiting for invoice INV-2026-000042 to be paid' }),
    ).toBeInTheDocument();
  });

  it('requires a reason to reject and sends it', async () => {
    const { calls } = setup(
      makeUser('client_admin'),
      makeRun({ status: 'pending_approval' }),
      route('POST', `${runPath}/reject`, () =>
        jsonResponse(makeRun({ status: 'draft', rejectionReason: 'Wrong month' })),
      ),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject this payroll run?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject run' }));
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // empty reason blocked in the browser

    await userEvent.type(within(dialog).getByLabelText(/reason/i), 'Wrong month');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reject run' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ reason: 'Wrong month' }),
    );
  });

  it('shows the API message when processing is refused because the invoice is unpaid', async () => {
    setup(
      makeUser('platform_admin'),
      makeRun({ status: 'approved', invoiceId: INVOICE_ID }),
      route('POST', `${runPath}/process`, () =>
        jsonResponse(
          { error: { code: 'invoice_unpaid', message: 'The invoice for this run has not been paid yet' } },
          409,
        ),
      ),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Process' }));
    const dialog = await screen.findByRole('dialog', { name: 'Start paying workers?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Process run' }));

    expect(await screen.findByText('The invoice for this run has not been paid yet')).toBeInTheDocument();
  });

  it('opens a breakdown with each deduction and employer cost and its rate', async () => {
    setup(makeUser('client_admin'), makeRun());

    await userEvent.click(await screen.findByRole('button', { name: 'View pay breakdown for Ana Schmidt' }));
    const dialog = await screen.findByRole('dialog', { name: /Ana Schmidt/ });
    expect(within(dialog).getByText('Income tax')).toBeInTheDocument();
    expect(within(dialog).getByText('20%')).toBeInTheDocument();
    expect(within(dialog).getByText('Pension')).toBeInTheDocument();
    expect(within(dialog).getByText('21%')).toBeInTheDocument();
    expect(within(dialog).getByTestId('net-pay')).toHaveTextContent('€4,200.00');
  });

  it('says so when the run does not exist', async () => {
    mockFetch(
      signedInAs(makeUser('client_admin')),
      route('GET', runPath, () => jsonResponse({ error: { code: 'not_found', message: 'Not found' } }, 404)),
    );
    renderPage(<PayrollRunDetailPage />, { path: `/payroll/${RUN_ID}`, pattern: '/payroll/:id' });

    expect(await screen.findByText('Payroll run not found')).toBeInTheDocument();
  });
});
