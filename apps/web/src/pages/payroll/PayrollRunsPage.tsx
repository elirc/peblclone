import {
  formatPeriod,
  PAYROLL_RUN_STATUSES,
  type PayrollRunDto,
  type PayrollRunStatus,
} from '@meridian/shared';
import { Banknote, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useCountryOptions, usePayrollRuns } from '../../api/payroll';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  type Column,
} from '../../components/ui';
import { isAdminRole, useUser } from '../../lib/auth';
import { formatMoney, humanize } from '../../lib/format';
import { NewPayrollRunModal } from './NewPayrollRunModal';

const PAGE_SIZE = 25;

const columns: Column<PayrollRunDto>[] = [
  {
    key: 'period',
    header: 'Period',
    cell: (run) => (
      <span className="font-medium text-ink-900">
        {formatPeriod(run.periodYear, run.periodMonth)}
      </span>
    ),
  },
  { key: 'country', header: 'Country', cell: (run) => run.countryName },
  { key: 'workers', header: 'Workers', align: 'right', cell: (run) => run.workerCount },
  {
    key: 'total',
    header: 'Total cost',
    align: 'right',
    cell: (run) => formatMoney(run.totalCostMinor, run.currency),
  },
  { key: 'status', header: 'Status', cell: (run) => <StatusBadge status={run.status} /> },
];

export default function PayrollRunsPage() {
  const user = useUser();
  const navigate = useNavigate();
  const isAdmin = isAdminRole(user);

  // Filters and paging are UI state; the runs themselves come from the query.
  const [status, setStatus] = useState<PayrollRunStatus | ''>('');
  const [countryCode, setCountryCode] = useState('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);

  const runs = usePayrollRuns({
    status: status || undefined,
    countryCode: countryCode || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  const countries = useCountryOptions();
  const filtered = Boolean(status || countryCode);

  return (
    <>
      <PageHeader
        title="Payroll"
        description="One run per country per month. Runs are reviewed, approved, invoiced and then paid by Meridian."
        actions={
          isAdmin && (
            <Button
              icon={<Plus className="h-4 w-4" aria-hidden />}
              onClick={() => setCreating(true)}
            >
              New payroll run
            </Button>
          )
        }
      />

      <Card padded={false}>
        <div className="grid gap-3 border-b border-ink-200 p-4 sm:grid-cols-2 lg:max-w-xl">
          <Select
            label="Status"
            value={status}
            onChange={(event) => {
              setStatus(PAYROLL_RUN_STATUSES.find((s) => s === event.target.value) ?? '');
              setOffset(0);
            }}
          >
            <option value="">All statuses</option>
            {PAYROLL_RUN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select
            label="Country"
            value={countryCode}
            onChange={(event) => {
              setCountryCode(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All countries</option>
            {countries.data?.items.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </Select>
        </div>

        {runs.isPending ? (
          <Loading label="Loading payroll runs…" />
        ) : runs.isError ? (
          <div className="px-4">
            <ErrorState error={runs.error} onRetry={() => void runs.refetch()} />
          </div>
        ) : (
          <>
            <Table
              caption="Payroll runs"
              columns={columns}
              rows={runs.data.items}
              rowKey={(run) => run.id}
              onRowClick={(run) => navigate(`/payroll/${run.id}`)}
              empty={
                filtered ? (
                  <EmptyState
                    icon={<Banknote className="h-6 w-6" aria-hidden />}
                    title="No runs match these filters"
                    action={
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setStatus('');
                          setCountryCode('');
                          setOffset(0);
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={<Banknote className="h-6 w-6" aria-hidden />}
                    title="No payroll runs yet"
                    description={
                      isAdmin
                        ? 'Create a run for a country and month to calculate pay for your team there.'
                        : 'An admin creates payroll runs. They will appear here for review.'
                    }
                    action={
                      isAdmin && <Button onClick={() => setCreating(true)}>New payroll run</Button>
                    }
                  />
                )
              }
            />
            <Pagination
              total={runs.data.total}
              limit={runs.data.limit}
              offset={runs.data.offset}
              onChange={setOffset}
            />
          </>
        )}
      </Card>

      {isAdmin && <NewPayrollRunModal open={creating} onClose={() => setCreating(false)} />}
    </>
  );
}
