import clsx from 'clsx';
import { AlertCircle, CheckCircle2, Info, Loader2, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { errorMessage } from '../../lib/api';
import { humanize } from '../../lib/format';
import { Button } from './Button';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('h-5 w-5 animate-spin text-ink-400', className)} aria-hidden />;
}

/** Centered spinner for a whole page or panel that is loading. */
export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-16 text-sm text-ink-500">
      <Spinner />
      {label}
    </div>
  );
}

type Tone = 'info' | 'success' | 'warning' | 'error';

const alertTones: Record<Tone, { box: string; icon: ReactNode }> = {
  info: { box: 'border-sky-200 bg-sky-50 text-sky-900', icon: <Info className="h-4 w-4" /> },
  success: {
    box: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    icon: <CheckCircle2 className="h-4 w-4" />,
  },
  warning: {
    box: 'border-amber-200 bg-amber-50 text-amber-900',
    icon: <TriangleAlert className="h-4 w-4" />,
  },
  error: { box: 'border-red-200 bg-red-50 text-red-900', icon: <AlertCircle className="h-4 w-4" /> },
};

export function Alert({
  tone = 'info',
  title,
  children,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const t = alertTones[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={clsx('flex gap-3 rounded-lg border px-4 py-3 text-sm', t.box, className)}
    >
      <span className="mt-0.5 shrink-0">{t.icon}</span>
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={clsx(title && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  );
}

/** Standard "the query failed" panel with a retry button. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="py-10">
      <Alert tone="error" title="Could not load this">
        <p>{errorMessage(error)}</p>
        {onRetry && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Alert>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-ink-100 text-ink-500">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-ink-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

type BadgeTone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

const badgeTones: Record<BadgeTone, string> = {
  neutral: 'bg-ink-100 text-ink-700',
  green: 'bg-emerald-100 text-emerald-800',
  amber: 'bg-amber-100 text-amber-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-sky-100 text-sky-800',
  purple: 'bg-violet-100 text-violet-800',
};

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        badgeTones[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * Every status in the system mapped to a colour ONCE, so "approved" is the same
 * green on the payroll page, the expenses page and the dashboard.
 */
const STATUS_TONES: Record<string, BadgeTone> = {
  // good / finished
  active: 'green',
  approved: 'green',
  paid: 'green',
  verified: 'green',
  completed: 'green',
  reimbursed: 'green',
  signed: 'green',
  // waiting on someone
  pending: 'amber',
  pending_approval: 'amber',
  submitted: 'amber',
  sent: 'amber',
  onboarding: 'amber',
  requested: 'amber',
  issued: 'amber',
  offboarding: 'amber',
  // in motion
  processing: 'blue',
  draft: 'neutral',
  // stopped
  rejected: 'red',
  terminated: 'red',
  void: 'red',
  cancelled: 'neutral',
  // types
  employee: 'blue',
  contractor: 'purple',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <Badge tone={STATUS_TONES[status] ?? 'neutral'}>{label ?? humanize(status)}</Badge>;
}
