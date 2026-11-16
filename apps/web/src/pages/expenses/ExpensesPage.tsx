import {
  EXPENSE_TRANSITIONS,
  canTransition,
  type ExpenseDto,
  type WorkerDetailDto,
} from '@meridian/shared';
import { Plus, Receipt } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useDecideExpense, useDeleteExpense, useExpenses } from '../../api/expenses';
import { useMyWorker } from '../../api/portal';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  StatusBadge,
  Table,
  Tabs,
  Textarea,
  useToast,
  type Column,
} from '../../components/ui';
import { isWorkerRole, useUser } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { formatDate, formatMoney, humanize } from '../../lib/format';
import { topLevelError } from '../contracts/form-helpers';
import { SubmitExpenseModal } from './SubmitExpenseModal';

const PAGE_SIZE = 25;

type StaffTab = 'review' | 'all';

export default function ExpensesPage() {
  const user = useUser();
  return isWorkerRole(user) ? <WorkerExpenses /> : <StaffExpenses />;
}

// ---------------------------------------------------------------------------
// Worker view
// ---------------------------------------------------------------------------

/** Mirrors the API rule: only active or offboarding workers can submit (409 worker_not_active). */
function submitBlocker(worker: WorkerDetailDto): string | null {
  if (worker.status === 'onboarding') {
    return 'You can submit expenses once your onboarding is complete and your employment is active.';
  }
  if (worker.status !== 'active' && worker.status !== 'offboarding') {
    return 'Expense submissions are closed for your account.';
  }
  return null;
}

function WorkerExpenses() {
  const me = useMyWorker();
  const [offset, setOffset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const expenses = useExpenses({ limit: PAGE_SIZE, offset });

  if (me.isLoading) return <Loading />;
  if (me.isError || !me.data) {
    return (
      <>
        <PageHeader title="Expenses" />
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </>
    );
  }
  const worker = me.data;
  const blocker = submitBlocker(worker);

  return (
    <>
      <PageHeader
        title="Expenses"
        description={`Claim work expenses in ${worker.currency}. Approved claims are paid with your next payroll.`}
        actions={
          !blocker && (
            <Button
              icon={<Plus className="h-4 w-4" aria-hidden />}
              onClick={() => setSubmitting(true)}
            >
              Submit expense
            </Button>
          )
        }
      />
      {blocker && (
        <Alert tone="info" className="mb-6">
          {blocker}
        </Alert>
      )}
      <Card padded={false}>
        <ExpensesTable
          isWorker
          query={expenses}
          onPage={setOffset}
          empty={
            <EmptyState
              icon={<Receipt className="h-6 w-6" aria-hidden />}
              title="No expenses yet"
              description="Submit a receipt-backed expense and your employer will review it."
              action={
                !blocker && <Button onClick={() => setSubmitting(true)}>Submit expense</Button>
              }
            />
          }
        />
      </Card>
      {submitting && (
        <SubmitExpenseModal
          mode="worker"
          currency={worker.currency}
          onClose={() => setSubmitting(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Staff view
// ---------------------------------------------------------------------------

function StaffExpenses() {
  const [tab, setTab] = useState<StaffTab>('review');
  const [offset, setOffset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const expenses = useExpenses({
    status: tab === 'review' ? 'submitted' : undefined,
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <>
      <PageHeader
        title="Expenses"
        description="Review expense claims. Approved expenses are reimbursed through payroll."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => setSubmitting(true)}
          >
            Submit on behalf
          </Button>
        }
      />
      <Tabs<StaffTab>
        tabs={[
          {
            id: 'review',
            label: 'To review',
            count: tab === 'review' ? expenses.data?.total : undefined,
          },
          { id: 'all', label: 'All' },
        ]}
        active={tab}
        onChange={(next) => {
          setTab(next);
          setOffset(0);
        }}
      />
      <Card padded={false}>
        <ExpensesTable
          isWorker={false}
          query={expenses}
          onPage={setOffset}
          empty={
            tab === 'review' ? (
              <EmptyState
                icon={<Receipt className="h-6 w-6" aria-hidden />}
                title="Nothing to review"
                description="There are no submitted expenses waiting for a decision."
                action={
                  <Button variant="secondary" onClick={() => setTab('all')}>
                    View all expenses
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Receipt className="h-6 w-6" aria-hidden />}
                title="No expenses yet"
                description="Expenses your workers submit appear here. You can also submit one on a worker's behalf."
                action={<Button onClick={() => setSubmitting(true)}>Submit on behalf</Button>}
              />
            )
          }
        />
      </Card>
      {submitting && <SubmitExpenseModal mode="staff" onClose={() => setSubmitting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared table
// ---------------------------------------------------------------------------

function ExpensesTable({
  isWorker,
  query,
  onPage,
  empty,
}: {
  isWorker: boolean;
  query: ReturnType<typeof useExpenses>;
  onPage: (offset: number) => void;
  empty: ReactNode;
}) {
  const toast = useToast();
  const decide = useDecideExpense();
  const remove = useDeleteExpense();
  const [rejecting, setRejecting] = useState<ExpenseDto | null>(null);
  const [deleting, setDeleting] = useState<ExpenseDto | null>(null);

  async function approve(expense: ExpenseDto) {
    try {
      await decide.mutateAsync({ id: expense.id, input: { decision: 'approved' } });
      toast.success(
        `Approved ${formatMoney(expense.amountMinor, expense.currency)} for ${expense.workerName}`,
      );
    } catch (err) {
      toast.error(err);
    }
  }

  async function confirmDelete() {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success('Expense deleted');
      setDeleting(null);
    } catch (err) {
      toast.error(err);
    }
  }

  if (query.isLoading) return <Loading />;
  if (query.isError || !query.data) {
    return (
      <div className="px-4">
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const approving = (e: ExpenseDto) => decide.isPending && decide.variables?.id === e.id;

  const columns: Column<ExpenseDto>[] = [
    ...(isWorker
      ? []
      : [
          {
            key: 'worker',
            header: 'Worker',
            cell: (e: ExpenseDto) => (
              <span className="font-medium text-ink-900">{e.workerName}</span>
            ),
          },
        ]),
    { key: 'category', header: 'Category', cell: (e) => humanize(e.category) },
    {
      key: 'description',
      header: 'Description',
      cell: (e) => <span className="line-clamp-2 max-w-xs">{e.description}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      cell: (e) => <span className="whitespace-nowrap">{formatDate(e.incurredOn)}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (e) => (
        <span className="whitespace-nowrap">{formatMoney(e.amountMinor, e.currency)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (e) => (
        <div>
          <StatusBadge status={e.status} />
          {e.status === 'reimbursed' && (
            <p className="mt-1 text-xs text-ink-500">Paid through payroll</p>
          )}
          {e.status === 'approved' && (
            <p className="mt-1 text-xs text-ink-500">Will be paid with the next payroll</p>
          )}
          {e.decisionNote && (
            <p className="mt-1 max-w-xs text-xs text-ink-500">Note: {e.decisionNote}</p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (e) => {
        const decidable = !isWorker && e.status === 'submitted';
        // A worker may withdraw their own claim while it is still `submitted`
        // (the API answers 409 otherwise). Staff reject instead of deleting.
        const deletable = isWorker && e.status === 'submitted';
        if (!decidable && !deletable) return null;
        return (
          <div className="flex justify-end gap-2">
            {decidable && canTransition(EXPENSE_TRANSITIONS, e.status, 'approved') && (
              <Button
                size="sm"
                loading={approving(e)}
                onClick={() => void approve(e)}
                aria-label={`Approve ${e.workerName}'s expense: ${e.description}`}
              >
                Approve
              </Button>
            )}
            {decidable && canTransition(EXPENSE_TRANSITIONS, e.status, 'rejected') && (
              <Button
                size="sm"
                variant="secondary"
                disabled={approving(e)}
                onClick={() => setRejecting(e)}
                aria-label={`Reject ${e.workerName}'s expense: ${e.description}`}
              >
                Reject
              </Button>
            )}
            {deletable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDeleting(e)}
                aria-label={`Delete expense: ${e.description}`}
              >
                Delete
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <Table
        caption="Expenses"
        columns={columns}
        rows={query.data.items}
        rowKey={(e) => e.id}
        empty={empty}
      />
      <Pagination
        total={query.data.total}
        limit={query.data.limit}
        offset={query.data.offset}
        onChange={onPage}
      />
      {rejecting && <RejectExpenseModal expense={rejecting} onClose={() => setRejecting(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete this expense?"
        confirmLabel="Delete expense"
        danger
        loading={remove.isPending}
      >
        {deleting &&
          `"${deleting.description}" (${formatMoney(deleting.amountMinor, deleting.currency)}) will be removed. This cannot be undone.`}
      </ConfirmDialog>
    </>
  );
}

/** The API refuses a rejection without a note (400 note_required); the form refuses first. */
const rejectSchema = z.object({
  note: z.string().trim().min(1, 'Add a note so the worker knows why').max(500),
});

function RejectExpenseModal({ expense, onClose }: { expense: ExpenseDto; onClose: () => void }) {
  const toast = useToast();
  const decide = useDecideExpense();
  const form = useZodForm(rejectSchema, { note: '' });

  const onSubmit = form.handleSubmit(async ({ note }) => {
    await decide.mutateAsync({ id: expense.id, input: { decision: 'rejected', note } });
    toast.success('Expense rejected');
    onClose();
  });

  const alert = topLevelError(form);
  return (
    <Modal
      open
      onClose={onClose}
      title="Reject expense"
      description={`${expense.workerName} · ${expense.description} · ${formatMoney(
        expense.amountMinor,
        expense.currency,
      )}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Back
          </Button>
          <Button
            type="submit"
            form="reject-expense-form"
            variant="danger"
            loading={form.submitting}
          >
            Reject expense
          </Button>
        </>
      }
    >
      <form id="reject-expense-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        <Textarea label="Reason for rejecting" required {...form.field('note')} />
      </form>
    </Modal>
  );
}
