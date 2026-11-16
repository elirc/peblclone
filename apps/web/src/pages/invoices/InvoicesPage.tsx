import { INVOICE_STATUSES, type InvoiceDto, type InvoiceStatus } from '@meridian/shared';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useInvoices } from '../../api/invoices';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
  Select,
  Table,
  type Column,
} from '../../components/ui';
import { formatDate, formatMoney, humanize } from '../../lib/format';
import { InvoiceStatusBadge } from './invoice-ui';

const PAGE_SIZE = 25;

const columns: Column<InvoiceDto>[] = [
  {
    key: 'number',
    header: 'Number',
    cell: (invoice) => <span className="font-medium text-ink-900">{invoice.number}</span>,
  },
  { key: 'issued', header: 'Issued', cell: (invoice) => formatDate(invoice.issuedAt) },
  { key: 'due', header: 'Due', cell: (invoice) => formatDate(invoice.dueDate) },
  {
    key: 'total',
    header: 'Total',
    align: 'right',
    cell: (invoice) => formatMoney(invoice.totalMinor, invoice.currency),
  },
  { key: 'status', header: 'Status', cell: (invoice) => <InvoiceStatusBadge invoice={invoice} /> },
];

export default function InvoicesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<InvoiceStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const invoices = useInvoices({ status: status || undefined, limit: PAGE_SIZE, offset });

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Meridian invoices you in USD when a payroll run is approved. Payroll is paid out once its invoice is paid."
      />
      <Card padded={false}>
        <div className="border-b border-ink-200 p-4 sm:max-w-xs">
          <Select
            label="Status"
            value={status}
            onChange={(event) => {
              setStatus(INVOICE_STATUSES.find((s) => s === event.target.value) ?? '');
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            {INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
        </div>

        {invoices.isPending ? (
          <Loading label="Loading invoices…" />
        ) : invoices.isError ? (
          <div className="px-4">
            <ErrorState error={invoices.error} onRetry={() => void invoices.refetch()} />
          </div>
        ) : (
          <>
            <Table
              caption="Invoices"
              columns={columns}
              rows={invoices.data.items}
              rowKey={(invoice) => invoice.id}
              onRowClick={(invoice) => navigate(`/invoices/${invoice.id}`)}
              empty={
                status ? (
                  <EmptyState
                    icon={<FileText className="h-6 w-6" aria-hidden />}
                    title={`No ${humanize(status).toLowerCase()} invoices`}
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setStatus('');
                          setOffset(0);
                        }}
                      >
                        Show all invoices
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<FileText className="h-6 w-6" aria-hidden />}
                    title="No invoices yet"
                    description="An invoice is issued automatically when a payroll run is approved."
                    action={
                      <ButtonLink to="/payroll" variant="secondary">
                        Go to payroll
                      </ButtonLink>
                    }
                  />
                )
              }
            />
            <Pagination
              total={invoices.data.total}
              limit={invoices.data.limit}
              offset={invoices.data.offset}
              onChange={setOffset}
            />
          </>
        )}
      </Card>
    </>
  );
}
