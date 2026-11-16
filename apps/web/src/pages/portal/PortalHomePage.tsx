import type { ContractDto, OnboardingTaskDto, WorkerDetailDto } from '@meridian/shared';
import {
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileSignature,
  Receipt,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';
import { useContracts } from '../../api/contracts';
import { useCompleteOnboardingTask, useMyWorker } from '../../api/portal';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  DescriptionList,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useToast,
} from '../../components/ui';
import { useUser } from '../../lib/auth';
import { formatDate, formatMoney, humanize } from '../../lib/format';
import { DocumentsCard } from './DocumentsCard';

export default function PortalHomePage() {
  const me = useMyWorker();

  if (me.isLoading) return <Loading />;
  if (me.isError || !me.data) {
    return (
      <>
        <PageHeader title="Welcome" />
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      </>
    );
  }
  return <Portal worker={me.data} />;
}

function Portal({ worker }: { worker: WorkerDetailDto }) {
  const user = useUser();
  const employer = user.organizationName;

  return (
    <>
      <PageHeader
        title={`Welcome, ${worker.firstName}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>
              {worker.jobTitle}
              {employer ? ` at ${employer}` : ''}
            </span>
            <StatusBadge status={worker.status} />
          </span>
        }
      />

      <div className="space-y-6">
        {worker.status === 'onboarding' && <OnboardingChecklist worker={worker} />}
        {worker.status === 'active' && <QuickLinks />}
        {worker.status === 'offboarding' && (
          <Alert tone="warning" title="Your employment is ending">
            Your last working day is {formatDate(worker.endDate)}. You can still submit expenses and
            see your payslips until then.
          </Alert>
        )}
        {(worker.status === 'terminated' || worker.status === 'cancelled') && (
          <Alert tone="info" title="Your employment has ended">
            You can still view your agreement and past payslips.
          </Alert>
        )}

        {worker.status !== 'onboarding' && <EmploymentSummary worker={worker} />}
        <DocumentsCard workerId={worker.id} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Onboarding checklist
// ---------------------------------------------------------------------------

function OnboardingChecklist({ worker }: { worker: WorkerDetailDto }) {
  const done = worker.tasks.filter((t) => t.status === 'completed').length;
  const total = worker.tasks.length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const contractPending = worker.tasks.some(
    (t) => t.key === 'contract_signed' && t.status === 'pending',
  );
  // Newest first; a worker only ever sees sent/signed/active/terminated ones.
  const contracts = useContracts({ limit: 1 }, contractPending);

  return (
    <Card>
      <CardHeader
        title="Getting started"
        description="Finish these steps and your employment becomes active automatically."
      />
      <div className="mb-5">
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="font-medium text-ink-800">
            {done} of {total} steps complete
          </span>
          <span className="tabular text-ink-500">{percent}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Onboarding progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-2 overflow-hidden rounded-full bg-ink-100"
        >
          <div className="h-full rounded-full bg-brand-700" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <ul className="divide-y divide-ink-100">
        {worker.tasks.map((task) => (
          <li
            key={task.id}
            className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex min-w-0 gap-3">
              {task.status === 'completed' ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-ink-300" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="font-medium text-ink-900">
                  {task.title}
                  <span className="sr-only">
                    {task.status === 'completed' ? ' (done)' : ' (to do)'}
                  </span>
                </p>
                <p className="text-sm text-ink-500">{task.description}</p>
              </div>
            </div>
            <div className="shrink-0 pl-8 text-sm sm:pl-0 sm:text-right">
              <TaskAction
                task={task}
                contract={contracts.data?.items[0]}
                contractLoading={contracts.isLoading}
              />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The right call to action for one task. */
function TaskAction({
  task,
  contract,
  contractLoading,
}: {
  task: OnboardingTaskDto;
  contract: ContractDto | undefined;
  contractLoading: boolean;
}) {
  const toast = useToast();
  const complete = useCompleteOnboardingTask();

  if (task.status === 'completed') {
    return <span className="text-ink-500">Done {formatDate(task.completedAt)}</span>;
  }

  if (task.key === 'contract_signed') {
    if (contractLoading) return <span className="text-ink-500">Checking your agreement…</span>;
    if (!contract) {
      return <span className="text-ink-500">Your employer has not sent your agreement yet</span>;
    }
    return (
      <ButtonLink
        to={`/contracts/${contract.id}`}
        size="sm"
        icon={<FileSignature className="h-4 w-4" aria-hidden />}
      >
        {contract.status === 'sent' ? 'Review and sign' : 'View agreement'}
      </ButtonLink>
    );
  }

  if (task.key === 'documents_verified') {
    return (
      <a href="#documents" className="font-medium text-brand-700 hover:underline">
        See your documents below
      </a>
    );
  }

  if (task.assignee === 'client')
    return <span className="text-ink-500">Waiting on your employer</span>;
  if (task.assignee === 'platform')
    return <span className="text-ink-500">Waiting on Meridian</span>;
  if (task.automatic) return <span className="text-ink-500">Completes automatically</span>;

  // A manual task assigned to the worker, e.g. bank_details.
  async function markComplete() {
    try {
      const result = await complete.mutateAsync(task.id);
      toast.success(
        result.workerStatus === 'active'
          ? 'All done — your employment is now active'
          : `"${task.title}" marked complete`,
      );
    } catch (err) {
      toast.error(err);
    }
  }
  return (
    <Button size="sm" loading={complete.isPending} onClick={() => void markComplete()}>
      Mark complete
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Active workers
// ---------------------------------------------------------------------------

const LINKS: { to: string; label: string; description: string; icon: LucideIcon }[] = [
  {
    to: '/time-off',
    label: 'Time off',
    description: 'Check your balance and request leave',
    icon: CalendarDays,
  },
  { to: '/expenses', label: 'Expenses', description: 'Claim work expenses', icon: Receipt },
  { to: '/payslips', label: 'Payslips', description: 'See what you were paid', icon: Wallet },
  {
    to: '/contracts',
    label: 'My agreement',
    description: 'Read your signed agreement',
    icon: FileSignature,
  },
];

function QuickLinks() {
  return (
    <nav aria-label="Quick links" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className="group flex items-center gap-3 rounded-xl border border-ink-200 bg-white p-4 shadow-sm hover:border-brand-300 hover:bg-brand-50"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
            <link.icon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-ink-900">{link.label}</p>
            <p className="text-sm text-ink-500">{link.description}</p>
          </div>
          <ChevronRight
            className="h-4 w-4 shrink-0 text-ink-400 group-hover:text-brand-700"
            aria-hidden
          />
        </Link>
      ))}
    </nav>
  );
}

function EmploymentSummary({ worker }: { worker: WorkerDetailDto }) {
  return (
    <Card>
      <CardHeader title="Your employment" />
      <DescriptionList
        items={[
          { label: 'Role', value: worker.jobTitle },
          { label: 'Department', value: worker.department ?? '—' },
          { label: 'Type', value: humanize(worker.type) },
          { label: 'Country', value: worker.countryName },
          { label: 'Start date', value: formatDate(worker.startDate) },
          ...(worker.endDate ? [{ label: 'End date', value: formatDate(worker.endDate) }] : []),
          {
            label: 'Salary',
            value: `${formatMoney(worker.salaryMinor, worker.currency)} per ${
              worker.payBasis === 'annual' ? 'year' : 'month'
            }`,
          },
          { label: 'Work email', value: worker.email },
        ]}
      />
    </Card>
  );
}
