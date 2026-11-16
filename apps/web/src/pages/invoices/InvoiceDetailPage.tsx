import {
  canTransition,
  INVOICE_TRANSITIONS,
  type InvoiceDetailDto,
  type InvoiceLineDto,
} from '@meridian/shared';
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useInvoice, usePayInvoice } from '../../api/invoices';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  ErrorState,
  Loading,
  PageHeader,
  useToast,
} from '../../components/ui';
import { isApiError } from '../../lib/api';
import { isAdminRole, useUser } from '../../lib/auth';
import { formatDate, formatMoney } from '../../lib/format';
import { formatRate, InvoiceStatusBadge, isOverdue } from './invoice-ui';

export default function InvoiceDetailPage() {
  const { id = '' } = useParams();
  const invoice = useInvoice(id);

  if (invoice.isPending) return <Loading label="Loading invoice…" />;
  if (invoice.isError) {
    const notFound = isApiError(invoice.error) && invoice.error.status === 404;
    return (
      <>
        <PageHeader title="Invoice" back={{ to: '/invoices', label: 'Invoices' }} />
        {notFound ? (
          <Alert tone="warning" title="Invoice not found">
            It may belong to a different organization.
          </Alert>
        ) : (
          <ErrorState error={invoice.error} onRetry={() => void invoice.refetch()} />
        )}
      </>
    );
  }
  return <InvoiceView invoice={invoice.data} />;
}

function InvoiceView({ invoice }: { invoice: InvoiceDetailDto }) {
  const user = useUser();
  const toast = useToast();
  const pay = usePayInvoice(invoice.id);
  const [confirming, setConfirming] = useState(false);

  const money = (minor: number) => formatMoney(minor, invoice.currency);
  const canPay = isAdminRole(user) && canTransition(INVOICE_TRANSITIONS, invoice.status, 'paid');

  async function onPay() {
    try {
      await pay.mutateAsync();
      toast.success(`Invoice ${invoice.number} paid`);
    } catch (err) {
      toast.error(err);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <div className="print:hidden">
        <PageHeader
          back={{ to: '/invoices', label: 'Invoices' }}
          title={`Invoice ${invoice.number}`}
          actions={
            <>
              <Button
                variant="secondary"
                icon={<Printer className="h-4 w-4" aria-hidden />}
                onClick={() => window.print()}
              >
                Print
              </Button>
              {canPay && <Button onClick={() => setConfirming(true)}>Pay invoice</Button>}
            </>
          }
        />
      </div>

      {invoice.status === 'issued' && (
        <Alert
          tone={isOverdue(invoice) ? 'error' : 'warning'}
          title={isOverdue(invoice) ? 'This invoice is overdue' : 'Awaiting payment'}
          className="mb-6 print:hidden"
        >
          Payroll for this period is paid to workers only after Meridian receives this payment.
        </Alert>
      )}

      <Card className="mx-auto max-w-3xl">
        <article aria-label={`Invoice ${invoice.number}`}>
          <header className="flex flex-col gap-6 border-b border-ink-200 pb-6 sm:flex-row sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Invoice</p>
              <p className="mt-1 text-2xl font-semibold text-ink-900">{invoice.number}</p>
              <div className="mt-2">
                <InvoiceStatusBadge invoice={invoice} />
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:text-right">
              <div>
                <dt className="text-xs text-ink-500">Issued</dt>
                <dd className="text-ink-900">{formatDate(invoice.issuedAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-500">Due</dt>
                <dd className="text-ink-900">{formatDate(invoice.dueDate)}</dd>
              </div>
              {invoice.paidAt && (
                <div>
                  <dt className="text-xs text-ink-500">Paid</dt>
                  <dd className="text-ink-900">{formatDate(invoice.paidAt)}</dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-ink-500">Currency</dt>
                <dd className="text-ink-900">{invoice.currency}</dd>
              </div>
            </dl>
          </header>

          <div className="grid gap-6 border-b border-ink-200 py-6 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Bill to</p>
              <p className="mt-1 font-medium text-ink-900">{invoice.organizationName}</p>
            </div>
            <div className="sm:text-right">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">From</p>
              <p className="mt-1 font-medium text-ink-900">Meridian</p>
              <p className="text-sm text-ink-500">Employer of Record services</p>
            </div>
          </div>

          <LinesTable invoice={invoice} money={money} />

          <dl className="ml-auto mt-4 max-w-xs space-y-2 text-sm">
            <div className="flex justify-between gap-6">
              <dt className="text-ink-600">Subtotal</dt>
              <dd className="tabular text-ink-900">{money(invoice.subtotalMinor)}</dd>
            </div>
            <div className="flex justify-between gap-6">
              <dt className="text-ink-600">Meridian fee</dt>
              <dd className="tabular text-ink-900">{money(invoice.feeMinor)}</dd>
            </div>
            <div className="flex justify-between gap-6 border-t-2 border-ink-200 pt-2">
              <dt className="font-semibold text-ink-900">Total due</dt>
              <dd className="tabular text-lg font-semibold text-ink-900">{money(invoice.totalMinor)}</dd>
            </div>
          </dl>

          <footer className="mt-8 space-y-1 border-t border-ink-200 pt-4 text-xs text-ink-500">
            {invoice.localCurrency !== invoice.currency && (
              <p>
                Payroll amounts were converted at{' '}
                <span className="tabular font-medium text-ink-700">
                  1 {invoice.currency} = {formatRate(invoice.fxRate)} {invoice.localCurrency}
                </span>
                , the rate frozen when this invoice was issued.
              </p>
            )}
            {invoice.payrollRunId && (
              <p className="print:hidden">
                <Link to={`/payroll/${invoice.payrollRunId}`} className="font-medium text-brand-700 hover:underline">
                  View the payroll run this invoice covers
                </Link>
              </p>
            )}
          </footer>
        </article>
      </Card>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Pay ${money(invoice.totalMinor)}?`}
        confirmLabel="Pay invoice"
        loading={pay.isPending}
        onConfirm={() => void onPay()}
      >
        <p>
          <strong>This is a simulated payment</strong> — no money moves and no card or bank account is
          charged. It marks invoice {invoice.number} as paid so the payroll run can be processed.
        </p>
      </ConfirmDialog>
    </>
  );
}

function LinesTable({ invoice, money }: { invoice: InvoiceDetailDto; money: (minor: number) => string }) {
  return (
    <div className="overflow-x-auto pt-6">
      <table className="min-w-full text-sm">
        <caption className="sr-only">Invoice lines</caption>
        <thead>
          <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
            <th scope="col" className="py-2 pr-4 text-left font-medium">
              Description
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {invoice.lines.length === 0 && (
            <tr>
              <td colSpan={2} className="py-3 text-ink-500">
                This invoice has no lines.
              </td>
            </tr>
          )}
          {invoice.lines.map((line: InvoiceLineDto) => (
            <tr key={line.id}>
              <td className="py-3 pr-4 text-ink-800">{line.description}</td>
              <td className="tabular py-3 text-right text-ink-900">{money(line.amountMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
