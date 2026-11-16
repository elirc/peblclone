import type { AuditLogDto } from '@meridian/shared';
import { History } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useAuditLogs } from '../../api/audit';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Pagination,
  Select,
  Table,
  type Column,
} from '../../components/ui';
import { formatDateTime, formatMoney, humanize } from '../../lib/format';

const PAGE_SIZE = 50;

/**
 * Entity types the API records for a tenant (see `recordAudit` calls). The
 * filter is a free-text field server-side; offering the known values keeps
 * people from guessing spellings.
 */
const ENTITY_TYPES = [
  'worker',
  'onboarding_task',
  'document',
  'contract',
  'time_off_request',
  'expense',
  'payroll_run',
  'invoice',
  'quote',
  'organization',
  'user',
  'invitation',
] as const;

/** Where an entity lives in the app, when it has a page of its own. */
function entityHref(entry: AuditLogDto): string | null {
  if (!entry.entityId) return null;
  switch (entry.entityType) {
    case 'worker':
      return `/people/${entry.entityId}`;
    case 'contract':
      return `/contracts/${entry.entityId}`;
    case 'payroll_run':
      return `/payroll/${entry.entityId}`;
    case 'invoice':
      return `/invoices/${entry.entityId}`;
    default:
      return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALUE_LENGTH = 60;
const MAX_PAIRS = 6;

const truncate = (text: string, max = MAX_VALUE_LENGTH) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * One metadata value as short text. Nested objects/arrays are stringified and
 * truncated (never dumped whole); ids are shortened; `…Minor` amounts are shown
 * as money when the entry also says which currency they are in.
 */
function formatMetaValue(key: string, value: unknown, metadata: Record<string, unknown>): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number' && key.endsWith('Minor') && typeof metadata.currency === 'string') {
    return formatMoney(value, metadata.currency);
  }
  if (typeof value === 'string') return UUID.test(value) ? `${value.slice(0, 8)}…` : truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number')) {
    return truncate(value.join(', '));
  }
  return truncate(JSON.stringify(value));
}

function MetadataSummary({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return <span className="text-ink-400">—</span>;
  const shown = entries.slice(0, MAX_PAIRS);
  return (
    <dl className="flex max-w-md flex-wrap gap-x-3 gap-y-0.5 text-xs">
      {shown.map(([key, value]) => (
        <div key={key} className="flex min-w-0 gap-1">
          <dt className="text-ink-500">{key}:</dt>
          <dd className="break-all text-ink-800" title={typeof value === 'string' ? value : undefined}>
            {formatMetaValue(key, value, metadata)}
          </dd>
        </div>
      ))}
      {entries.length > shown.length && (
        <div className="text-ink-500">+{entries.length - shown.length} more</div>
      )}
    </dl>
  );
}

const columns: Column<AuditLogDto>[] = [
  {
    key: 'when',
    header: 'When',
    className: 'whitespace-nowrap',
    cell: (entry) => formatDateTime(entry.createdAt),
  },
  {
    key: 'who',
    header: 'Who',
    cell: (entry) => entry.actorName ?? <span className="italic text-ink-500">System</span>,
  },
  {
    key: 'action',
    header: 'Action',
    cell: (entry) => <span className="font-medium text-ink-900">{humanize(entry.action)}</span>,
  },
  {
    key: 'entity',
    header: 'Entity',
    cell: (entry) => {
      const href = entityHref(entry);
      const label = humanize(entry.entityType);
      return (
        <span className="whitespace-nowrap">
          {href ? (
            <Link
              to={href}
              className="font-medium text-brand-700 hover:underline"
              aria-label={`Open ${label.toLowerCase()} ${entry.entityId ?? ''}`}
            >
              {label}
            </Link>
          ) : (
            label
          )}
          {entry.entityId && <span className="ml-1 font-mono text-xs text-ink-500">{entry.entityId.slice(0, 8)}</span>}
        </span>
      );
    },
  },
  { key: 'details', header: 'Details', cell: (entry) => <MetadataSummary metadata={entry.metadata} /> },
];

export default function AuditLogPage() {
  const [entityType, setEntityType] = useState('');
  const [offset, setOffset] = useState(0);
  const logs = useAuditLogs({ entityType: entityType || undefined, limit: PAGE_SIZE, offset });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change made in your organization, newest first. Entries cannot be edited or deleted."
      />
      <Card padded={false}>
        <div className="border-b border-ink-200 p-4 sm:max-w-xs">
          <Select
            label="Entity type"
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">Everything</option>
            {ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </Select>
        </div>

        {logs.isPending ? (
          <Loading label="Loading audit log…" />
        ) : logs.isError ? (
          <div className="px-4">
            <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
          </div>
        ) : (
          <>
            <Table
              caption="Audit log entries"
              columns={columns}
              rows={logs.data.items}
              rowKey={(entry) => entry.id}
              empty={
                <EmptyState
                  icon={<History className="h-6 w-6" aria-hidden />}
                  title={entityType ? `No ${humanize(entityType).toLowerCase()} events` : 'Nothing recorded yet'}
                  description={
                    entityType
                      ? undefined
                      : 'Hiring someone, approving payroll or changing settings will show up here.'
                  }
                  action={
                    entityType && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEntityType('');
                          setOffset(0);
                        }}
                      >
                        Show everything
                      </Button>
                    )
                  }
                />
              }
            />
            <Pagination
              total={logs.data.total}
              limit={logs.data.limit}
              offset={logs.data.offset}
              onChange={setOffset}
            />
          </>
        )}
      </Card>
    </>
  );
}
