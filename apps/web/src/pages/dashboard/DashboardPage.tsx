import type { DashboardDto } from '@meridian/shared';
import { Activity, Calculator, Clock, UserPlus, Users } from 'lucide-react';
import { Link } from 'react-router';
import { useDashboard } from '../../api/dashboard';
import {
  ButtonLink,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Stat,
} from '../../components/ui';
import { useUser } from '../../lib/auth';
import { formatDateTime, formatMoney, humanize } from '../../lib/format';

type Pending = DashboardDto['pending'];

/** Each "pending" counter, how to describe it, and where the user goes to deal with it. */
const ATTENTION_ITEMS: { key: keyof Pending; one: string; many: string; to: string }[] = [
  {
    key: 'timeOffRequests',
    one: 'time-off request to review',
    many: 'time-off requests to review',
    to: '/time-off',
  },
  { key: 'expenses', one: 'expense to review', many: 'expenses to review', to: '/expenses' },
  {
    key: 'payrollApprovals',
    one: 'payroll run awaiting approval',
    many: 'payroll runs awaiting approval',
    to: '/payroll',
  },
  { key: 'unpaidInvoices', one: 'unpaid invoice', many: 'unpaid invoices', to: '/invoices' },
  {
    key: 'contractsAwaitingSignature',
    one: 'contract awaiting signature',
    many: 'contracts awaiting signature',
    to: '/contracts',
  },
];

const monthFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthLabel = (year: number, month: number) =>
  monthFormatter.format(new Date(Date.UTC(year, month - 1, 1)));

/** Bar width as a percentage of the largest value; a non-zero value always gets a sliver. */
function barWidth(value: number, max: number): string {
  if (max <= 0 || value <= 0) return '0%';
  return `${Math.max(2, Math.round((value / max) * 100))}%`;
}

export default function DashboardPage() {
  const user = useUser();
  const dashboard = useDashboard();

  const header = (
    <PageHeader
      title="Dashboard"
      description={user.organizationName ? `Overview of ${user.organizationName}` : undefined}
      actions={
        <ButtonLink to="/people/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>
          Hire someone
        </ButtonLink>
      }
    />
  );

  if (dashboard.isPending) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (dashboard.isError) {
    return (
      <>
        {header}
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      </>
    );
  }

  const data = dashboard.data;
  const isNewCompany = data.headcount.total === 0;
  const hasSpend = data.monthlySpend.some((m) => m.totalUsdMinor > 0);
  const attention = ATTENTION_ITEMS.filter((item) => data.pending[item.key] > 0);

  return (
    <>
      {header}
      <div className="space-y-6">
        {isNewCompany ? (
          <Card>
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden />}
              title="Hire your first person"
              description="Meridian employs people for you in countries where you have no entity, or pays contractors anywhere. Start with a cost estimate, or go straight to hiring."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <ButtonLink to="/people/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>
                    Hire someone
                  </ButtonLink>
                  <ButtonLink
                    to="/calculator"
                    variant="secondary"
                    icon={<Calculator className="h-4 w-4" aria-hidden />}
                  >
                    Estimate costs
                  </ButtonLink>
                </div>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Total headcount"
              value={data.headcount.total}
              icon={<Users className="h-5 w-5" aria-hidden />}
            />
            <Stat label="Active" value={data.headcount.active} />
            <Stat label="Onboarding" value={data.headcount.onboarding} />
            <Stat
              label="Employees / contractors"
              value={`${data.headcount.employees} / ${data.headcount.contractors}`}
              hint={`${data.headcount.employees} employees, ${data.headcount.contractors} contractors`}
            />
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {(!isNewCompany || attention.length > 0) && (
            <Card>
              <CardHeader title="Needs your attention" />
              {attention.length === 0 ? (
                <p className="text-sm text-ink-500">Nothing is waiting on you. All caught up.</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {attention.map((item) => {
                    const count = data.pending[item.key];
                    return (
                      <li key={item.key}>
                        <Link
                          to={item.to}
                          className="flex items-center gap-3 py-2.5 text-sm text-ink-800 hover:text-brand-800"
                        >
                          <Clock className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                          <span className="tabular font-semibold">{count}</span>
                          <span>{count === 1 ? item.one : item.many}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          )}

          {!isNewCompany && <HeadcountByCountry byCountry={data.byCountry} />}

          {(!isNewCompany || hasSpend) && <MonthlySpend months={data.monthlySpend} />}

          {(!isNewCompany || data.recentActivity.length > 0) && (
            <RecentActivity entries={data.recentActivity} />
          )}
        </div>
      </div>
    </>
  );
}

function HeadcountByCountry({ byCountry }: { byCountry: DashboardDto['byCountry'] }) {
  const max = Math.max(0, ...byCountry.map((c) => c.count));
  return (
    <Card>
      <CardHeader title="Headcount by country" />
      {byCountry.length === 0 ? (
        <p className="text-sm text-ink-500">No current workers.</p>
      ) : (
        <ul className="space-y-3" aria-label="Headcount by country">
          {byCountry.map((c) => (
            <li key={c.countryCode}>
              <div className="mb-1 flex justify-between gap-3 text-sm">
                <span className="truncate text-ink-800">{c.countryName}</span>
                <span className="tabular font-medium text-ink-900">{c.count}</span>
              </div>
              <div className="h-2 rounded-full bg-ink-100" aria-hidden>
                <div
                  className="h-2 rounded-full bg-brand-600"
                  style={{ width: barWidth(c.count, max) }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MonthlySpend({ months }: { months: DashboardDto['monthlySpend'] }) {
  const max = Math.max(0, ...months.map((m) => m.totalUsdMinor));
  return (
    <Card>
      <CardHeader
        title="Monthly spend"
        description="Invoiced totals for the last 6 months, in USD."
      />
      {/* Horizontal bars: they stay readable at phone width, where six vertical columns of
          dollar amounts would not fit. The amount is always printed, never implied by length. */}
      <ul className="space-y-3" aria-label="Monthly spend">
        {months.map((m) => (
          <li
            key={`${m.year}-${m.month}`}
            className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-3 text-sm"
          >
            <span className="text-ink-600">{monthLabel(m.year, m.month)}</span>
            <div className="h-3 rounded bg-ink-100" aria-hidden>
              <div
                className="h-3 rounded bg-brand-600"
                style={{ width: barWidth(m.totalUsdMinor, max) }}
              />
            </div>
            <span className="tabular text-right font-medium text-ink-900">
              {formatMoney(m.totalUsdMinor, 'USD')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function RecentActivity({ entries }: { entries: DashboardDto['recentActivity'] }) {
  return (
    <Card>
      <CardHeader title="Recent activity" />
      {entries.length === 0 ? (
        <p className="text-sm text-ink-500">No activity yet.</p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 py-2.5 text-sm">
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden />
              <div className="min-w-0">
                <p className="text-ink-900">{humanize(entry.action)}</p>
                <p className="text-xs text-ink-500">
                  {entry.actorName ?? 'System'} · {formatDateTime(entry.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
