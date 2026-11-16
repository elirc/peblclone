import { PAYROLL_RUN_STATUSES, type PayrollRunStatus } from '@meridian/shared';
import clsx from 'clsx';
import { Check } from 'lucide-react';

/** January…December as select options (value = month number 1–12). */
export const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => ({
  value: index + 1,
  label: new Date(Date.UTC(2000, index, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
}));

const STEP_LABELS: Record<PayrollRunStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Pending approval',
  approved: 'Approved',
  processing: 'Processing',
  paid: 'Paid',
};

/**
 * Draft → Pending approval → Approved → Processing → Paid.
 *
 * The order comes from PAYROLL_RUN_STATUSES (the happy path, in order). The
 * current step is marked with `aria-current="step"` and the word "current", and
 * finished steps get a tick, so the state is never conveyed by colour alone.
 */
export function RunStepper({ status }: { status: PayrollRunStatus }) {
  const currentIndex = PAYROLL_RUN_STATUSES.indexOf(status);
  return (
    <nav aria-label="Payroll run progress">
      <ol className="flex items-start">
        {PAYROLL_RUN_STATUSES.map((step, index) => {
          const done = index < currentIndex || status === 'paid';
          const current = index === currentIndex;
          return (
            <li
              key={step}
              aria-current={current ? 'step' : undefined}
              className="relative flex flex-1 flex-col items-center text-center"
            >
              {/* connector to the previous step */}
              {index > 0 && (
                <span
                  aria-hidden
                  className={clsx(
                    'absolute top-4 right-1/2 h-0.5 w-full -translate-y-1/2',
                    index <= currentIndex ? 'bg-brand-600' : 'bg-ink-200',
                  )}
                />
              )}
              <span
                className={clsx(
                  'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-semibold',
                  done && 'border-brand-600 bg-brand-600 text-white',
                  current && !done && 'border-brand-700 bg-white text-brand-800 ring-4 ring-brand-100',
                  !done && !current && 'border-ink-300 bg-white text-ink-400',
                )}
              >
                {done ? <Check className="h-4 w-4" aria-hidden /> : index + 1}
              </span>
              <span
                className={clsx(
                  'mt-2 px-1 text-xs leading-tight',
                  current ? 'font-semibold text-ink-900' : 'text-ink-500',
                )}
              >
                {STEP_LABELS[step]}
                {current && <span className="sr-only"> (current step)</span>}
                {done && !current && <span className="sr-only"> (done)</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * Basis points as a percentage: 2000 -> "20%", 2150 -> "21.5%", 925 -> "9.25%".
 *
 * Local on purpose: `formatBps` in lib/format.ts strips a trailing zero from
 * whole percentages too (2000 -> "2%"), which would misstate a tax rate.
 * Reported to the lead; switch back once the shell helper is fixed.
 */
export function formatRateBps(bps: number): string {
  const fixed = (bps / 100).toFixed(2);
  return `${fixed.replace(/0+$/, '').replace(/\.$/, '')}%`;
}
