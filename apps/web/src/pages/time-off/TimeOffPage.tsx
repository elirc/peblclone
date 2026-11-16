import {
  TIME_OFF_TRANSITIONS,
  canTransition,
  decisionSchema,
  type TimeOffRequestDto,
  type WorkerDetailDto,
} from '@meridian/shared';
import { CalendarDays, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  useCancelTimeOffRequest,
  useDecideTimeOffRequest,
  useTimeOffRequests,
} from '../../api/time-off';
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
import { formatDate, humanize, todayLocal } from '../../lib/format';
import { topLevelError } from '../contracts/form-helpers';
import { BalanceCard } from './BalanceCard';
import { RequestTimeOffModal } from './RequestTimeOffModal';

const PAGE_SIZE = 25;

type StaffTab = 'pending' | 'all';

/**
 * A worker may cancel a pending request, or an approved one that has not started
 * yet (the API answers `409 already_started` otherwise). Staff may cancel any
 * pending/approved request.
 */
function canCancel(request: TimeOffRequestDto, isWorker: boolean, today = todayLocal()) {
  if (!canTransition(TIME_OFF_TRANSITIONS, request.status, 'cancelled')) return false;
  if (isWorker && request.status === 'approved') return request.startDate > today;
  return true;
}

export default function TimeOffPage() {
  const user = useUser();
  return isWorkerRole(user) ? <WorkerTimeOff /> : <StaffTimeOff />;
}

// ---------------------------------------------------------------------------
// Worker view: my balance, my requests, "Request time off".
// ---------------------------------------------------------------------------

function WorkerTimeOff() {
  const me = useMyWorker();
  const [offset, setOffset] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const requests = useTimeOffRequests({ limit: PAGE_SIZE, offset });

  if (me.isLoading) return <Loading />;
  if (me.isError || !me.data) {
    return (
      <>
        <PageHeader title="Time off" />
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </>
    );
  }

  const worker = me.data;
  const blocker = requestBlocker(worker);

  return (
    <>
      <PageHeader
        title="Time off"
        description="Your leave balance and requests."
        actions={
          !blocker && (
            <Button
              icon={<Plus className="h-4 w-4" aria-hidden />}
              onClick={() => setRequesting(true)}
            >
              Request time off
            </Button>
          )
        }
      />

      <div className="space-y-6">
        {blocker ? <Alert tone="info">{blocker}</Alert> : <BalanceCard />}

        <Card padded={false}>
          <RequestsTable
            isWorker
            query={requests}
            onPage={setOffset}
            empty={
              <EmptyState
                icon={<CalendarDays className="h-6 w-6" aria-hidden />}
                title="No time-off requests yet"
                description={
                  blocker ??
                  'When you request time off, it shows up here while your employer reviews it.'
                }
                action={
                  !blocker && <Button onClick={() => setRequesting(true)}>Request time off</Button>
                }
              />
            }
          />
        </Card>
      </div>

      {requesting && <RequestTimeOffModal mode="worker" onClose={() => setRequesting(false)} />}
    </>
  );
}

/** Why this worker cannot file a request right now (mirrors the API's create rules), or null. */
function requestBlocker(worker: WorkerDetailDto): string | null {
  if (worker.type === 'contractor') {
    return 'Time off is not tracked for contractors. Agree any time away directly with your client.';
  }
  if (worker.status === 'onboarding') {
    return 'You can request time off once your onboarding is complete and your employment is active.';
  }
  if (worker.status !== 'active') return 'Time-off requests are closed for your account.';
  return null;
}

// ---------------------------------------------------------------------------
// Staff view: review queue + everything, approve / reject / cancel, file on behalf.
// ---------------------------------------------------------------------------

function StaffTimeOff() {
  const [tab, setTab] = useState<StaffTab>('pending');
  const [offset, setOffset] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const requests = useTimeOffRequests({
    status: tab === 'pending' ? 'pending' : undefined,
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <>
      <PageHeader
        title="Time off"
        description="Review and manage leave requests from your team."
        actions={
          <Button
            icon={<Plus className="h-4 w-4" aria-hidden />}
            onClick={() => setRequesting(true)}
          >
            Request on behalf
          </Button>
        }
      />

      <Tabs<StaffTab>
        tabs={[
          {
            id: 'pending',
            label: 'Pending',
            count: tab === 'pending' ? requests.data?.total : undefined,
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
        <RequestsTable
          isWorker={false}
          query={requests}
          onPage={setOffset}
          empty={
            tab === 'pending' ? (
              <EmptyState
                icon={<CalendarDays className="h-6 w-6" aria-hidden />}
                title="Nothing to review"
                description="There are no pending time-off requests."
                action={
                  <Button variant="secondary" onClick={() => setTab('all')}>
                    View all requests
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<CalendarDays className="h-6 w-6" aria-hidden />}
                title="No time-off requests yet"
                description="Requests your workers file appear here. You can also file one on a worker's behalf."
                action={<Button onClick={() => setRequesting(true)}>Request on behalf</Button>}
              />
            )
          }
        />
      </Card>

      {requesting && <RequestTimeOffModal mode="staff" onClose={() => setRequesting(false)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// The table both audiences share; actions differ by role.
// ---------------------------------------------------------------------------

function RequestsTable({
  isWorker,
  query,
  onPage,
  empty,
}: {
  isWorker: boolean;
  query: ReturnType<typeof useTimeOffRequests>;
  onPage: (offset: number) => void;
  empty: ReactNode;
}) {
  const toast = useToast();
  const decide = useDecideTimeOffRequest();
  const cancel = useCancelTimeOffRequest();
  const [rejecting, setRejecting] = useState<TimeOffRequestDto | null>(null);
  const [cancelling, setCancelling] = useState<TimeOffRequestDto | null>(null);

  async function approve(request: TimeOffRequestDto) {
    try {
      await decide.mutateAsync({ id: request.id, input: { decision: 'approved' } });
      toast.success(
        `Approved ${request.workerName}'s ${humanize(request.type).toLowerCase()} request`,
      );
    } catch (err) {
      toast.error(err);
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    try {
      await cancel.mutateAsync(cancelling.id);
      toast.success('Request cancelled');
      setCancelling(null);
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

  const busy = (request: TimeOffRequestDto) =>
    decide.isPending && decide.variables?.id === request.id;

  const columns: Column<TimeOffRequestDto>[] = [
    ...(isWorker
      ? []
      : [
          {
            key: 'worker',
            header: 'Worker',
            cell: (r: TimeOffRequestDto) => (
              <span className="font-medium text-ink-900">{r.workerName}</span>
            ),
          },
        ]),
    { key: 'type', header: 'Type', cell: (r) => humanize(r.type) },
    {
      key: 'dates',
      header: 'Dates',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {formatDate(r.startDate)}
          {r.endDate !== r.startDate && <> – {formatDate(r.endDate)}</>}
        </span>
      ),
    },
    { key: 'days', header: 'Days', align: 'right', cell: (r) => r.days },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <div>
          <StatusBadge status={r.status} />
          {r.decisionNote && (
            <p className="mt-1 max-w-xs text-xs text-ink-500">Note: {r.decisionNote}</p>
          )}
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Reason',
      cell: (r) => <span className="line-clamp-2 max-w-xs text-ink-600">{r.reason || '—'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (r) => {
        const decidable = !isWorker && r.status === 'pending';
        const cancellable = canCancel(r, isWorker);
        if (!decidable && !cancellable) return null;
        return (
          <div className="flex justify-end gap-2">
            {decidable && canTransition(TIME_OFF_TRANSITIONS, r.status, 'approved') && (
              <Button
                size="sm"
                loading={busy(r) && decide.variables?.input.decision === 'approved'}
                disabled={busy(r)}
                onClick={() => void approve(r)}
                aria-label={`Approve ${r.workerName}'s request`}
              >
                Approve
              </Button>
            )}
            {decidable && canTransition(TIME_OFF_TRANSITIONS, r.status, 'rejected') && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy(r)}
                onClick={() => setRejecting(r)}
                aria-label={`Reject ${r.workerName}'s request`}
              >
                Reject
              </Button>
            )}
            {cancellable && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCancelling(r)}
                aria-label={isWorker ? 'Cancel request' : `Cancel ${r.workerName}'s request`}
              >
                Cancel
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
        caption="Time-off requests"
        columns={columns}
        rows={query.data.items}
        rowKey={(r) => r.id}
        empty={empty}
      />
      <Pagination
        total={query.data.total}
        limit={query.data.limit}
        offset={query.data.offset}
        onChange={onPage}
      />

      {rejecting && <RejectTimeOffModal request={rejecting} onClose={() => setRejecting(null)} />}

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={() => void confirmCancel()}
        title="Cancel this request?"
        confirmLabel="Cancel request"
        danger
        loading={cancel.isPending}
      >
        {cancelling &&
          `${humanize(cancelling.type)} from ${formatDate(cancelling.startDate)} to ${formatDate(
            cancelling.endDate,
          )} (${cancelling.days} day${cancelling.days === 1 ? '' : 's'}) will be cancelled${
            cancelling.status === 'approved' ? ' and the days returned to the balance' : ''
          }.`}
      </ConfirmDialog>
    </>
  );
}

function RejectTimeOffModal({
  request,
  onClose,
}: {
  request: TimeOffRequestDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const decide = useDecideTimeOffRequest();
  const form = useZodForm(decisionSchema, { decision: 'rejected', note: '' });

  const onSubmit = form.handleSubmit(async (data) => {
    await decide.mutateAsync({
      id: request.id,
      input: { decision: 'rejected', note: data.note || undefined },
    });
    toast.success('Request rejected');
    onClose();
  });

  const alert = topLevelError(form);
  return (
    <Modal
      open
      onClose={onClose}
      title="Reject time-off request"
      description={`${request.workerName} · ${humanize(request.type)} · ${formatDate(
        request.startDate,
      )} – ${formatDate(request.endDate)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Back
          </Button>
          <Button
            type="submit"
            form="reject-time-off-form"
            variant="danger"
            loading={form.submitting}
          >
            Reject request
          </Button>
        </>
      }
    >
      <form id="reject-time-off-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        <Textarea
          label="Note to the worker (optional)"
          hint="For example, a reason or a suggestion for other dates."
          {...form.field('note')}
        />
      </form>
    </Modal>
  );
}
