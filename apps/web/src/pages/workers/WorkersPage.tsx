import {
  WORKER_STATUSES,
  WORKER_TYPES,
  type ListWorkersQuery,
  type WorkerDto,
  type WorkerStatus,
  type WorkerType,
} from '@meridian/shared';
import { Search, UserPlus, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useCountries } from '../../api/countries';
import { useWorkers } from '../../api/workers';
import {
  Button,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  type Column,
} from '../../components/ui';
import { formatDate, fullName, humanize } from '../../lib/format';
import { formatSalary } from './worker-ui';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

const isOneOf = <T extends string>(values: readonly T[], value: string | null): value is T =>
  value !== null && (values as readonly string[]).includes(value);

/**
 * Filters live in the URL (?search=&status=&type=&country=&offset=) so a filtered
 * list can be bookmarked and survives the back button. Anything unrecognised in
 * the URL is ignored rather than sent to the API (which would answer 400).
 */
function readFilters(params: URLSearchParams) {
  const status = params.get('status');
  const type = params.get('type');
  const country = params.get('country');
  const offset = Number(params.get('offset') ?? '0');
  return {
    search: params.get('search')?.trim() ?? '',
    status: isOneOf<WorkerStatus>(WORKER_STATUSES, status) ? status : undefined,
    type: isOneOf<WorkerType>(WORKER_TYPES, type) ? type : undefined,
    countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : undefined,
    offset: Number.isInteger(offset) && offset > 0 ? offset : 0,
  };
}

const columns: Column<WorkerDto>[] = [
  {
    key: 'name',
    header: 'Name',
    cell: (w) => (
      <div className="min-w-0">
        <p className="font-medium text-ink-900">{fullName(w)}</p>
        <p className="text-xs text-ink-500">{w.email}</p>
      </div>
    ),
  },
  { key: 'jobTitle', header: 'Job title', cell: (w) => w.jobTitle },
  { key: 'country', header: 'Country', cell: (w) => w.countryName },
  { key: 'type', header: 'Type', cell: (w) => <StatusBadge status={w.type} /> },
  { key: 'status', header: 'Status', cell: (w) => <StatusBadge status={w.status} /> },
  {
    key: 'startDate',
    header: 'Start date',
    cell: (w) => formatDate(w.startDate),
    className: 'whitespace-nowrap',
  },
  {
    key: 'salary',
    header: 'Salary',
    align: 'right',
    cell: (w) => formatSalary(w),
    className: 'whitespace-nowrap',
  },
];

export default function WorkersPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);
  const countries = useCountries();

  /** Change some URL params; any filter change sends you back to the first page. */
  const updateParams = (
    changes: Record<string, string | undefined>,
    options?: { replace?: boolean },
  ) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(changes)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        if (!('offset' in changes)) next.delete('offset');
        return next;
      },
      { replace: options?.replace },
    );
  };

  // The search box is local UI state so typing is instant; it is copied to the URL
  // (and so to the API) once the user pauses for SEARCH_DEBOUNCE_MS.
  const [searchText, setSearchText] = useState(filters.search);
  // When the URL changes from outside (back button, a link), the box follows it.
  // This is React's "adjust state when a prop changes" pattern, not an effect.
  const [urlSearch, setUrlSearch] = useState(filters.search);
  if (urlSearch !== filters.search) {
    setUrlSearch(filters.search);
    setSearchText(filters.search);
  }

  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === filters.search) return;
    const timer = window.setTimeout(() => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (trimmed) next.set('search', trimmed);
          else next.delete('search');
          next.delete('offset');
          return next;
        },
        // One history entry per search, not one per keystroke.
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText, filters.search, setSearchParams]);

  const query: ListWorkersQuery = {
    limit: PAGE_SIZE,
    offset: filters.offset,
    search: filters.search || undefined,
    status: filters.status,
    type: filters.type,
    countryCode: filters.countryCode,
  };
  const workers = useWorkers(query);

  const hasFilters = Boolean(
    filters.search || filters.status || filters.type || filters.countryCode,
  );
  const clearFilters = () => {
    setSearchText('');
    setSearchParams(new URLSearchParams());
  };

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone you employ or contract through Meridian."
        actions={
          <ButtonLink to="/people/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>
            Hire someone
          </ButtonLink>
        }
      />

      <Card padded={false}>
        <div className="grid grid-cols-1 gap-3 border-b border-ink-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="relative">
            <Input
              label="Search"
              type="search"
              placeholder="Name, email or job title"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              className="pl-9"
            />
            <Search
              className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 text-ink-400"
              aria-hidden
            />
          </div>
          <Select
            label="Status"
            value={filters.status ?? ''}
            onChange={(event) => updateParams({ status: event.target.value || undefined })}
          >
            <option value="">All statuses</option>
            {WORKER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </Select>
          <Select
            label="Type"
            value={filters.type ?? ''}
            onChange={(event) => updateParams({ type: event.target.value || undefined })}
          >
            <option value="">Employees and contractors</option>
            {WORKER_TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}s
              </option>
            ))}
          </Select>
          <Select
            label="Country"
            value={filters.countryCode ?? ''}
            onChange={(event) => updateParams({ country: event.target.value || undefined })}
            hint={countries.isError ? 'Could not load countries.' : undefined}
          >
            <option value="">All countries</option>
            {countries.data?.items.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
            {/* A country code from a bookmarked URL stays selectable even before the list loads. */}
            {filters.countryCode &&
              !countries.data?.items.some((c) => c.code === filters.countryCode) && (
                <option value={filters.countryCode}>{filters.countryCode}</option>
              )}
          </Select>
        </div>

        {workers.isPending ? (
          <Loading />
        ) : workers.isError ? (
          <div className="px-4">
            <ErrorState error={workers.error} onRetry={() => void workers.refetch()} />
          </div>
        ) : workers.data.items.length === 0 ? (
          hasFilters ? (
            <EmptyState
              icon={<Search className="h-6 w-6" aria-hidden />}
              title="No one matches these filters"
              description="Try a different search, or clear the filters to see everyone."
              action={
                <Button variant="secondary" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden />}
              title="No people yet"
              description="Hire an employee through Meridian's local entities, or engage a contractor anywhere."
              action={
                <ButtonLink to="/people/new" icon={<UserPlus className="h-4 w-4" aria-hidden />}>
                  Hire someone
                </ButtonLink>
              }
            />
          )
        ) : (
          <>
            <Table
              caption="People"
              columns={columns}
              rows={workers.data.items}
              rowKey={(w) => w.id}
              onRowClick={(w) => navigate(`/people/${w.id}`)}
            />
            <Pagination
              total={workers.data.total}
              limit={workers.data.limit}
              offset={workers.data.offset}
              onChange={(offset) =>
                updateParams({ offset: offset > 0 ? String(offset) : undefined })
              }
            />
          </>
        )}
      </Card>
    </>
  );
}
