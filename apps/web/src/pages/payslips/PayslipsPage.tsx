import { formatPeriod, type PayslipDto } from '@meridian/shared';
import { Wallet } from 'lucide-react';
import { useState } from 'react';
import { usePayslips, useWorkerOptions } from '../../api/payroll';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Table,
  type Column,
} from '../../components/ui';
import { isStaffRole, useUser } from '../../lib/auth';
import { formatDate, formatMoney, fullName } from '../../lib/format';
import { PayItemBreakdown } from '../payroll/PayItemBreakdown';

const PAGE_SIZE = 25;

/**
 * Payslips = the items of PAID payroll runs. Workers see only their own (the
 * API enforces it); staff see everyone's and can narrow to one worker.
 */
export default function PayslipsPage() {
  const user = useUser();
  const isStaff = isStaffRole(user);
  const [workerId, setWorkerId] = useState('');
  const [offset, setOffset] = useState(0);
  // Which payslip's modal is open (an id: the payslip itself stays in the query cache).
  const [openId, setOpenId] = useState<string | null>(null);

  const payslips = usePayslips({ workerId: (isStaff && workerId) || undefined, limit: PAGE_SIZE, offset });
  const workers = useWorkerOptions(isStaff);
  const open = payslips.data?.items.find((slip) => slip.id === openId);

  const columns: Column<PayslipDto>[] = [
    {
      key: 'period',
      header: 'Period',
      cell: (slip) => (
        <span className="font-medium text-ink-900">{formatPeriod(slip.periodYear, slip.periodMonth)}</span>
      ),
    },
    ...(isStaff ? [{ key: 'worker', header: 'Worker', cell: (slip: PayslipDto) => slip.workerName }] : []),
    { key: 'gross', header: 'Gross', align: 'right', cell: (slip) => formatMoney(slip.grossMinor, slip.currency) },
    {
      key: 'deductions',
      header: 'Deductions',
      align: 'right',
      cell: (slip) => formatMoney(slip.deductionsMinor, slip.currency),
    },
    {
      key: 'net',
      header: 'Net pay',
      align: 'right',
      cell: (slip) => <span className="font-medium text-ink-900">{formatMoney(slip.netMinor, slip.currency)}</span>,
    },
    { key: 'paid', header: 'Paid', cell: (slip) => formatDate(slip.paidAt) },
  ];

  return (
    <>
      <PageHeader
        title="Payslips"
        description={
          isStaff
            ? 'A payslip is published for every worker when their payroll run is marked paid.'
            : 'Your pay for each month, published when payroll is paid. Select one to see every line.'
        }
      />
      <Card padded={false}>
        {isStaff && (
          <div className="border-b border-ink-200 p-4 sm:max-w-xs">
            <Select
              label="Worker"
              value={workerId}
              disabled={workers.isLoading}
              hint={workers.isError ? 'Could not load the worker list.' : undefined}
              onChange={(event) => {
                setWorkerId(event.target.value);
                setOffset(0);
              }}
            >
              <option value="">All workers</option>
              {workers.data?.items.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {fullName(worker)}
                </option>
              ))}
            </Select>
          </div>
        )}

        {payslips.isPending ? (
          <Loading label="Loading payslips…" />
        ) : payslips.isError ? (
          <div className="px-4">
            <ErrorState error={payslips.error} onRetry={() => void payslips.refetch()} />
          </div>
        ) : (
          <>
            <Table
              caption="Payslips"
              columns={columns}
              rows={payslips.data.items}
              rowKey={(slip) => slip.id}
              onRowClick={(slip) => setOpenId(slip.id)}
              empty={
                workerId ? (
                  <EmptyState
                    icon={<Wallet className="h-6 w-6" aria-hidden />}
                    title="No payslips for this worker yet"
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setWorkerId('');
                          setOffset(0);
                        }}
                      >
                        Show all workers
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<Wallet className="h-6 w-6" aria-hidden />}
                    title="No payslips yet"
                    description={
                      isStaff
                        ? 'Payslips appear here once a payroll run has been paid.'
                        : 'Your first payslip appears here after your first payroll is paid.'
                    }
                  />
                )
              }
            />
            <Pagination
              total={payslips.data.total}
              limit={payslips.data.limit}
              offset={payslips.data.offset}
              onChange={setOffset}
            />
          </>
        )}
      </Card>

      <Modal
        open={open !== undefined}
        onClose={() => setOpenId(null)}
        title={open ? `Payslip · ${formatPeriod(open.periodYear, open.periodMonth)}` : 'Payslip'}
        description={open ? `${open.workerName} · paid ${formatDate(open.paidAt)} · ${open.currency}` : undefined}
      >
        {open && <PayItemBreakdown item={open} currency={open.currency} showEmployerCosts={isStaff} />}
      </Modal>
    </>
  );
}
