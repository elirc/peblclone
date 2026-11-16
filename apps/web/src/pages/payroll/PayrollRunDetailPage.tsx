import {
  canTransition,
  formatPeriod,
  INVOICE_DUE_DAYS,
  PAYROLL_RUN_TRANSITIONS,
  rejectPayrollRunSchema,
  type InvoiceDetailDto,
  type PayrollItemDto,
  type PayrollRunDetailDto,
  type SessionUser,
} from '@meridian/shared';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useInvoice } from '../../api/invoices';
import {
  useApprovePayrollRun,
  useDeletePayrollRun,
  useMarkPayrollRunPaid,
  usePayrollRun,
  useProcessPayrollRun,
  useRecalculatePayrollRun,
  useRejectPayrollRun,
  useSubmitPayrollRun,
} from '../../api/payroll';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Loading,
  Modal,
  PageHeader,
  StatusBadge,
  Table,
  Textarea,
  useToast,
  type Column,
} from '../../components/ui';
import { isApiError } from '../../lib/api';
import { isAdminRole, isPlatformAdminRole, isStaffRole, useUser } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { formatDate, formatMoney } from '../../lib/format';
import { PayItemBreakdown } from './PayItemBreakdown';
import { RunStepper } from './payroll-ui';

export default function PayrollRunDetailPage() {
  const { id = '' } = useParams();
  const run = usePayrollRun(id);

  if (run.isPending) return <Loading label="Loading payroll run…" />;
  if (run.isError) {
    const notFound = isApiError(run.error) && run.error.status === 404;
    return (
      <>
        <PageHeader title="Payroll run" back={{ to: '/payroll', label: 'Payroll' }} />
        {notFound ? (
          <Alert tone="warning" title="Payroll run not found">
            It may have been deleted, or it belongs to a different organization.
          </Alert>
        ) : (
          <ErrorState error={run.error} onRetry={() => void run.refetch()} />
        )}
      </>
    );
  }
  return <RunDetail run={run.data} />;
}

type Dialog = 'approve' | 'reject' | 'delete' | 'process' | 'markPaid' | null;

function RunDetail({ run }: { run: PayrollRunDetailDto }) {
  const user = useUser();
  const toast = useToast();
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  // Which worker's breakdown is open — an id, so the item itself always comes from the query.
  const [breakdownId, setBreakdownId] = useState<string | null>(null);
  const breakdownFor = run.items.find((item) => item.id === breakdownId) ?? null;

  // The invoice only matters once the run is approved: it gates processing.
  const invoice = useInvoice(
    run.status === 'draft' || run.status === 'pending_approval' ? null : run.invoiceId,
  );

  const recalculate = useRecalculatePayrollRun(run.id);
  const submit = useSubmitPayrollRun(run.id);
  const approve = useApprovePayrollRun(run.id);
  const reject = useRejectPayrollRun(run.id);
  const processRun = useProcessPayrollRun(run.id);
  const markPaid = useMarkPayrollRunPaid(run.id);
  const remove = useDeletePayrollRun(run.id);

  const isAdmin = isAdminRole(user);
  const isPlatformAdmin = isPlatformAdminRole(user);
  const isStaff = isStaffRole(user);
  const can = (to: PayrollRunDetailDto['status']) =>
    canTransition(PAYROLL_RUN_TRANSITIONS, run.status, to);

  // Which buttons exist is decided by the transition table + the contract's roles,
  // so the screen can never offer a move the server would refuse.
  const actions = {
    recalculate: isAdmin && run.status === 'draft',
    remove: isAdmin && run.status === 'draft',
    submit: isStaff && can('pending_approval'),
    approve: isAdmin && can('approved'),
    reject: isAdmin && run.status === 'pending_approval' && can('draft'),
    process: isPlatformAdmin && can('processing'),
    markPaid: isPlatformAdmin && can('paid'),
  };

  async function perform(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.success(success);
    } catch (err) {
      // e.g. `409 invoice_unpaid` on Process: the server's message says exactly why.
      toast.error(err);
    } finally {
      setDialog(null);
    }
  }

  const money = (minor: number) => formatMoney(minor, run.currency);
  const period = formatPeriod(run.periodYear, run.periodMonth);

  const actionButtons: ReactNode[] = [];
  if (actions.submit) {
    actionButtons.push(
      <Button
        key="submit"
        loading={submit.isPending}
        onClick={() => void perform(() => submit.mutateAsync(), 'Submitted for approval')}
      >
        Submit for approval
      </Button>,
    );
  }
  if (actions.approve) {
    actionButtons.push(
      <Button key="approve" onClick={() => setDialog('approve')}>
        Approve
      </Button>,
    );
  }
  if (actions.reject) {
    actionButtons.push(
      <Button key="reject" variant="secondary" onClick={() => setDialog('reject')}>
        Reject
      </Button>,
    );
  }
  if (actions.process) {
    actionButtons.push(
      <Button key="process" onClick={() => setDialog('process')}>
        Process
      </Button>,
    );
  }
  if (actions.markPaid) {
    actionButtons.push(
      <Button key="markPaid" onClick={() => setDialog('markPaid')}>
        Mark paid
      </Button>,
    );
  }
  if (actions.recalculate) {
    actionButtons.push(
      <Button
        key="recalculate"
        variant="secondary"
        loading={recalculate.isPending}
        onClick={() => void perform(() => recalculate.mutateAsync(), 'Run recalculated')}
      >
        Recalculate
      </Button>,
    );
  }
  if (actions.remove) {
    actionButtons.push(
      <Button
        key="delete"
        variant="ghost"
        className="text-red-700"
        onClick={() => setDialog('delete')}
      >
        Delete
      </Button>,
    );
  }

  const next = nextStep(run, user, invoice.data);

  const columns: Column<PayrollItemDto>[] = [
    {
      key: 'worker',
      header: 'Worker',
      cell: (item) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink-900">{item.workerName}</span>
          <StatusBadge status={item.workerType} />
        </div>
      ),
    },
    {
      key: 'days',
      header: 'Days',
      cell: (item) => (
        <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
          <span className="tabular">
            {item.daysWorked} / {item.daysInPeriod}
          </span>
          {item.daysWorked < item.daysInPeriod && <Badge tone="amber">Prorated</Badge>}
        </div>
      ),
    },
    { key: 'gross', header: 'Gross', align: 'right', cell: (item) => money(item.grossMinor) },
    {
      key: 'deductions',
      header: 'Deductions',
      align: 'right',
      cell: (item) => money(item.deductionsMinor),
    },
    {
      key: 'employer',
      header: 'Employer cost',
      align: 'right',
      cell: (item) => money(item.employerCostMinor),
    },
    {
      key: 'reimbursements',
      header: 'Reimbursements',
      align: 'right',
      cell: (item) => money(item.reimbursementsMinor),
    },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
      cell: (item) => <span className="font-medium text-ink-900">{money(item.netMinor)}</span>,
    },
    {
      key: 'view',
      header: <span className="sr-only">Breakdown</span>,
      align: 'right',
      cell: (item) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`View pay breakdown for ${item.workerName}`}
          onClick={() => setBreakdownId(item.id)}
        >
          Breakdown
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        back={{ to: '/payroll', label: 'Payroll' }}
        title={`${period} · ${run.countryName}`}
        description={`${run.workerCount} ${run.workerCount === 1 ? 'worker' : 'workers'} · paid in ${run.currency}`}
        actions={<StatusBadge status={run.status} />}
      />

      <div className="space-y-6">
        <Card>
          <RunStepper status={run.status} />
        </Card>

        {run.status === 'draft' && run.rejectionReason && (
          <Alert tone="error" title="This run was rejected and returned to draft">
            <p className="whitespace-pre-line">“{run.rejectionReason}”</p>
            <p className="mt-1">
              Fix what was raised (recalculate if needed), then submit it again.
            </p>
          </Alert>
        )}

        <Card className="border-brand-200 bg-brand-50/40">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0" data-testid="next-step">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-800">
                What happens next
              </p>
              <h2 className="mt-1 text-lg font-semibold text-ink-900">{next.title}</h2>
              <div className="mt-1 text-sm text-ink-600">{next.body}</div>
            </div>
            {actionButtons.length > 0 && (
              <div className="flex shrink-0 flex-wrap gap-2">{actionButtons}</div>
            )}
          </div>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader
              title="Cost to your organization"
              description={`In ${run.currency}, before conversion to the USD invoice.`}
            />
            <TotalsList
              rows={[
                { label: 'Gross pay', value: money(run.grossMinor) },
                { label: 'Employer costs', value: money(run.employerCostMinor) },
                { label: 'Reimbursements', value: money(run.reimbursementsMinor) },
              ]}
              total={{ label: 'Total cost', value: money(run.totalCostMinor) }}
            />
          </Card>
          <Card>
            <CardHeader
              title="Paid to workers"
              description="Gross pay minus deductions, plus reimbursements."
            />
            <TotalsList
              rows={[
                { label: 'Gross pay', value: money(run.grossMinor) },
                { label: 'Deductions', value: `−${money(run.deductionsMinor)}` },
                { label: 'Reimbursements', value: money(run.reimbursementsMinor) },
              ]}
              total={{ label: 'Net to workers', value: money(run.netMinor) }}
            />
          </Card>
        </div>

        <Card padded={false}>
          <div className="px-5 pt-5 sm:px-6">
            <CardHeader
              title="Workers in this run"
              description="Open a breakdown to see each deduction and employer contribution with its rate."
            />
          </div>
          <Table
            caption={`Payroll items for ${period}, ${run.countryName}`}
            columns={columns}
            rows={run.items}
            rowKey={(item) => item.id}
            empty={<p className="px-6 pb-6 text-sm text-ink-500">This run has no workers.</p>}
          />
        </Card>
      </div>

      <Modal
        open={breakdownFor !== null}
        onClose={() => setBreakdownId(null)}
        title={breakdownFor ? `${breakdownFor.workerName} · ${period}` : 'Pay breakdown'}
        description={
          breakdownFor
            ? `${breakdownFor.workerType === 'employee' ? 'Employee' : 'Contractor'} · ${run.currency}`
            : undefined
        }
      >
        {breakdownFor && (
          <PayItemBreakdown item={breakdownFor} currency={run.currency} showEmployerCosts />
        )}
      </Modal>

      <ConfirmDialog
        open={dialog === 'approve'}
        onClose={() => setDialog(null)}
        title="Approve this payroll run?"
        confirmLabel="Approve and issue invoice"
        loading={approve.isPending}
        onConfirm={() =>
          void perform(() => approve.mutateAsync(), 'Payroll approved — invoice issued')
        }
      >
        <p>
          Approving locks these figures and <strong>issues an invoice</strong> to your organization
          for <strong>{money(run.totalCostMinor)}</strong> plus Meridian's fee, converted to USD at
          today's rate.
        </p>
        <p className="mt-2">
          The invoice is due in {INVOICE_DUE_DAYS} days. Meridian pays your team once it has been
          paid.
        </p>
      </ConfirmDialog>

      <RejectDialog
        open={dialog === 'reject'}
        onClose={() => setDialog(null)}
        onReject={async (reason) => {
          await reject.mutateAsync({ reason });
          toast.success('Run rejected and returned to draft');
          setDialog(null);
        }}
      />

      <ConfirmDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title="Delete this draft run?"
        confirmLabel="Delete run"
        danger
        loading={remove.isPending}
        onConfirm={() =>
          void (async () => {
            try {
              await remove.mutateAsync();
              toast.success('Payroll run deleted');
              navigate('/payroll', { replace: true });
            } catch (err) {
              toast.error(err);
              setDialog(null);
            }
          })()
        }
      >
        <p>
          The {period} run for {run.countryName} is removed. Expenses it had claimed are released
          and will be picked up by the next run you create.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'process'}
        onClose={() => setDialog(null)}
        title="Start paying workers?"
        confirmLabel="Process run"
        loading={processRun.isPending}
        onConfirm={() => void perform(() => processRun.mutateAsync(), 'Run is processing')}
      >
        <p>
          This moves the run to processing: transfers of {money(run.netMinor)} net pay to{' '}
          {run.workerCount} {run.workerCount === 1 ? 'worker' : 'workers'} begin. The client's
          invoice must already be paid.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'markPaid'}
        onClose={() => setDialog(null)}
        title="Mark this run as paid?"
        confirmLabel="Mark paid"
        loading={markPaid.isPending}
        onConfirm={() =>
          void perform(() => markPaid.mutateAsync(), 'Run marked paid — payslips published')
        }
      >
        <p>
          Confirm every transfer has landed. Payslips become visible to workers and the claimed
          expenses are marked reimbursed. This cannot be undone.
        </p>
      </ConfirmDialog>
    </>
  );
}

function TotalsList({
  rows,
  total,
}: {
  rows: { label: string; value: string }[];
  total: { label: string; value: string };
}) {
  return (
    <dl className="divide-y divide-ink-100 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="text-ink-600">{row.label}</dt>
          <dd className="tabular text-ink-900">{row.value}</dd>
        </div>
      ))}
      <div className="flex items-baseline justify-between gap-4 border-t-2 border-ink-200 pt-3">
        <dt className="font-semibold text-ink-900">{total.label}</dt>
        <dd className="tabular text-lg font-semibold text-ink-900">{total.value}</dd>
      </div>
    </dl>
  );
}

function RejectDialog({
  open,
  onClose,
  onReject,
}: {
  open: boolean;
  onClose: () => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const form = useZodForm(rejectPayrollRunSchema, { reason: '' });
  const close = () => {
    form.reset();
    onClose();
  };
  const onSubmit = form.handleSubmit(async (data) => {
    await onReject(data.reason);
    form.reset();
  });

  return (
    <Modal
      open={open}
      onClose={close}
      title="Reject this payroll run?"
      description="It goes back to draft. Whoever fixes it will see your reason at the top of the run."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={form.submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="reject-payroll-run"
            variant="danger"
            loading={form.submitting}
          >
            Reject run
          </Button>
        </>
      }
    >
      <form id="reject-payroll-run" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Textarea
          label="Reason"
          required
          maxLength={500}
          placeholder="e.g. Ana's salary increase from March is missing"
          {...form.field('reason')}
        />
      </form>
    </Modal>
  );
}

/**
 * The "what happens next" sentence. It depends on the run's status, the
 * viewer's role and — once approved — on whether the invoice has been paid,
 * because Meridian only moves money it has received.
 */
function nextStep(
  run: PayrollRunDetailDto,
  user: SessionUser,
  invoice: InvoiceDetailDto | undefined,
): { title: string; body: ReactNode } {
  const isAdmin = isAdminRole(user);
  const isPlatformAdmin = isPlatformAdminRole(user);
  const invoiceLink = run.invoiceId ? (
    <Link to={`/invoices/${run.invoiceId}`} className="font-medium text-brand-700 hover:underline">
      {invoice ? `View invoice ${invoice.number}` : 'View the invoice'}
    </Link>
  ) : null;

  switch (run.status) {
    case 'draft':
      return {
        title: 'Review the figures, then submit for approval',
        body: isAdmin
          ? 'If salaries, start dates or approved expenses changed since this run was created, recalculate it first. Submitting sends it for approval.'
          : 'Check each worker below and submit the run. A client admin then approves it.',
      };
    case 'pending_approval':
      return isAdmin
        ? {
            title: 'Waiting for your approval',
            body: 'Approving locks these figures and issues an invoice in USD. If something is wrong, reject it with a reason and it returns to draft.',
          }
        : {
            title: 'Waiting for an admin to approve',
            body: 'A client admin reviews the run. Once approved, an invoice is issued and appears here.',
          };
    case 'approved': {
      if (!run.invoiceId || invoice?.status === 'void') {
        return {
          title: 'No payable invoice',
          body: 'This run has no open invoice. Contact Meridian support before it can be processed.',
        };
      }
      if (invoice?.status === 'paid') {
        return isPlatformAdmin
          ? {
              title: `Invoice ${invoice.number} is paid — ready to process`,
              body: <>Process the run to start paying workers. {invoiceLink}</>,
            }
          : {
              title: 'Invoice paid — Meridian will start paying your team',
              body: (
                <>We have received your payment and will process this run shortly. {invoiceLink}</>
              ),
            };
      }
      const title = invoice
        ? `Waiting for invoice ${invoice.number} to be paid`
        : 'Waiting for the invoice to be paid';
      let who: string;
      if (isPlatformAdmin) who = 'The client must pay it before the run can be processed.';
      else if (isAdmin)
        who = 'Pay it to release payroll — Meridian pays your team once the funds arrive.';
      else who = 'A client admin needs to pay it. Meridian pays your team once the funds arrive.';
      return {
        title,
        body: (
          <>
            {who} {invoiceLink}
          </>
        ),
      };
    }
    case 'processing':
      return {
        title: 'Meridian is paying your team',
        body: isPlatformAdmin
          ? 'Mark the run paid once every transfer has landed. That publishes the payslips.'
          : 'Transfers are under way. Payslips appear for each worker when the run is marked paid.',
      };
    case 'paid':
      return {
        title: `Paid on ${formatDate(run.paidAt)}`,
        body: <>All done. Payslips are available to workers in their portal. {invoiceLink}</>,
      };
  }
}
