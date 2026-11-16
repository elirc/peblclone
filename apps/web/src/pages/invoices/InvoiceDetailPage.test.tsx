import type { InvoiceDetailDto, SessionUser } from '@meridian/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import {
  INVOICE_ID,
  makeInvoice,
  makeUser,
  polyfillDialog,
  renderPage,
  route,
  RUN_ID,
  signedInAs,
} from '../payroll/test-fixtures';
import InvoiceDetailPage from './InvoiceDetailPage';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

const invoicePath = `/invoices/${INVOICE_ID}`;

function setup(user: SessionUser, invoice: InvoiceDetailDto, ...extra: Parameters<typeof mockFetch>) {
  const fetchMock = mockFetch(
    signedInAs(user),
    route('GET', invoicePath, () => jsonResponse(invoice)),
    ...extra,
  );
  renderPage(<InvoiceDetailPage />, { path: invoicePath, pattern: '/invoices/:id' });
  return fetchMock;
}

describe('InvoiceDetailPage', () => {
  it('renders bill-to, lines, totals, the FX note and the payroll link', async () => {
    setup(makeUser('client_manager'), makeInvoice());

    expect(await screen.findByRole('heading', { name: 'Invoice INV-2026-000042' })).toBeInTheDocument();
    expect(screen.getByText('Acme GmbH')).toBeInTheDocument();

    const lines = screen.getByRole('table', { name: 'Invoice lines' });
    expect(within(lines).getByText('Gross pay — Germany, March 2026')).toBeInTheDocument();
    expect(within(lines).getByText('$5,434.78')).toBeInTheDocument();
    expect(within(lines).getByText('Meridian EOR fee — 1 employee')).toBeInTheDocument();

    expect(screen.getByText('$6,800.00')).toBeInTheDocument(); // subtotal
    expect(screen.getByText('$7,399.00')).toBeInTheDocument(); // total
    expect(screen.getByText('1 USD = 0.92 EUR')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payroll run this invoice covers/i })).toHaveAttribute(
      'href',
      `/payroll/${RUN_ID}`,
    );
  });

  it('omits the FX note for a USD payroll', async () => {
    setup(makeUser('client_manager'), makeInvoice({ localCurrency: 'USD', fxRate: '1' }));

    await screen.findByRole('heading', { name: 'Invoice INV-2026-000042' });
    expect(screen.queryByText(/1 USD =/)).not.toBeInTheDocument();
  });

  it('offers Pay to an admin on an issued invoice', async () => {
    setup(makeUser('client_admin'), makeInvoice({ status: 'issued' }));
    expect(await screen.findByRole('button', { name: 'Pay invoice' })).toBeInTheDocument();
  });

  it('does not offer Pay to a manager', async () => {
    setup(makeUser('client_manager'), makeInvoice({ status: 'issued' }));
    await screen.findByRole('heading', { name: 'Invoice INV-2026-000042' });
    expect(screen.queryByRole('button', { name: 'Pay invoice' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print' })).toBeInTheDocument();
  });

  it('does not offer Pay on a paid invoice', async () => {
    setup(makeUser('client_admin'), makeInvoice({ status: 'paid', paidAt: '2026-04-01T08:00:00.000Z' }));
    await screen.findByRole('heading', { name: 'Invoice INV-2026-000042' });
    expect(screen.queryByRole('button', { name: 'Pay invoice' })).not.toBeInTheDocument();
  });

  it('does not offer Pay on a void invoice', async () => {
    setup(makeUser('platform_admin'), makeInvoice({ status: 'void' }));
    await screen.findByRole('heading', { name: 'Invoice INV-2026-000042' });
    expect(screen.queryByRole('button', { name: 'Pay invoice' })).not.toBeInTheDocument();
  });

  it('posts to /invoices/:id/pay only after confirming the simulated payment', async () => {
    const { calls } = setup(
      makeUser('client_admin'),
      makeInvoice({ status: 'issued' }),
      route('POST', `${invoicePath}/pay`, () =>
        jsonResponse(makeInvoice({ status: 'paid', paidAt: '2026-04-01T08:00:00.000Z' })),
      ),
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Pay invoice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pay $7,399.00?' });
    expect(within(dialog).getByText(/simulated payment/i)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await userEvent.click(within(dialog).getByRole('button', { name: 'Pay invoice' }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
        `/api/v1${invoicePath}/pay`,
      ]),
    );
    expect(await screen.findByText('Invoice INV-2026-000042 paid')).toBeInTheDocument();
    // The paid response replaced the cached invoice: no more Pay button on the page.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Pay invoice' })).not.toBeInTheDocument());
  });
});
