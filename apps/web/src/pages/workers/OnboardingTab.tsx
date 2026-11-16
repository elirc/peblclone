import type {
  OnboardingTaskDto,
  SessionUser,
  TaskAssignee,
  WorkerDetailDto,
} from '@meridian/shared';
import { CheckCircle2, Circle, Zap } from 'lucide-react';
import { useCompleteOnboardingTask } from '../../api/workers';
import { Button, Card, CardHeader, EmptyState, StatusBadge, useToast } from '../../components/ui';
import { isPlatformAdminRole, isStaffRole, useUser } from '../../lib/auth';
import { formatDateTime, fullName } from '../../lib/format';

const ASSIGNEE_LABELS: Record<TaskAssignee, string> = {
  worker: 'For the worker',
  client: 'For your team',
  platform: 'For Meridian',
};

/**
 * Who may tick a manual task, mirroring the contract:
 * worker tasks -> that worker or a platform admin; client tasks -> client staff or a
 * platform admin; platform tasks -> platform admins only. (Workers never see this page.)
 */
function canComplete(user: SessionUser, task: OnboardingTaskDto): boolean {
  if (task.automatic || task.status === 'completed') return false;
  if (isPlatformAdminRole(user)) return true;
  return task.assignee === 'client' && isStaffRole(user);
}

/** How an automatic task gets done — shown instead of a button. */
function automaticExplanation(task: OnboardingTaskDto, worker: WorkerDetailDto): string {
  switch (task.key) {
    case 'contract_signed':
      return `Completes automatically when ${worker.firstName} signs their contract.`;
    case 'documents_verified':
      return 'Completes automatically once Meridian has verified every requested document.';
    default:
      return 'Completes automatically.';
  }
}

function waitingOn(task: OnboardingTaskDto, worker: WorkerDetailDto): string {
  if (task.assignee === 'worker') return `Waiting on ${worker.firstName}, in the worker portal.`;
  if (task.assignee === 'platform') return 'Waiting on Meridian.';
  return 'Waiting on your team.';
}

export function OnboardingTab({ worker }: { worker: WorkerDetailDto }) {
  const user = useUser();
  const toast = useToast();
  const complete = useCompleteOnboardingTask();

  const tasks = worker.tasks;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const percent = tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100);

  const markComplete = async (task: OnboardingTaskDto) => {
    try {
      const result = await complete.mutateAsync(task.id);
      toast.success(
        result.workerStatus === 'active' && worker.status === 'onboarding'
          ? `Onboarding complete: ${fullName(worker)} is now active`
          : `"${task.title}" marked complete`,
      );
    } catch (err) {
      toast.error(err);
    }
  };

  if (tasks.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No onboarding checklist"
          description="This worker has no onboarding tasks."
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader
        title="Onboarding checklist"
        description={
          worker.status === 'onboarding'
            ? `${worker.firstName} becomes active automatically when every task is complete.`
            : undefined
        }
      />
      <div className="mb-5">
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="text-ink-700">
            <span className="tabular font-semibold">{done}</span> of{' '}
            <span className="tabular font-semibold">{tasks.length}</span> complete
          </span>
          <span className="tabular text-ink-500">{percent}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Onboarding progress"
          aria-valuemin={0}
          aria-valuemax={tasks.length}
          aria-valuenow={done}
          className="h-2 rounded-full bg-ink-100"
        >
          <div className="h-2 rounded-full bg-brand-600" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <ul className="divide-y divide-ink-100">
        {tasks.map((task) => {
          const isDone = task.status === 'completed';
          const pendingThis = complete.isPending && complete.variables === task.id;
          return (
            <li key={task.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start">
              {isDone ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-ink-300" aria-hidden />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-ink-900">{task.title}</p>
                  <StatusBadge status={task.status} />
                  <span className="text-xs text-ink-500">{ASSIGNEE_LABELS[task.assignee]}</span>
                </div>
                <p className="mt-1 text-sm text-ink-600">{task.description}</p>
                {isDone ? (
                  <p className="mt-1 text-xs text-ink-500">
                    Completed {formatDateTime(task.completedAt)}
                  </p>
                ) : task.automatic ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-ink-500">
                    <Zap className="h-3.5 w-3.5" aria-hidden />
                    {automaticExplanation(task, worker)}
                  </p>
                ) : (
                  !canComplete(user, task) && (
                    <p className="mt-1 text-xs text-ink-500">{waitingOn(task, worker)}</p>
                  )
                )}
              </div>
              {canComplete(user, task) && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={pendingThis}
                  disabled={complete.isPending && !pendingThis}
                  aria-label={`Mark "${task.title}" complete`}
                  onClick={() => void markComplete(task)}
                >
                  Mark complete
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
