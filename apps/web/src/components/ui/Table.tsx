import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Button } from './Button';

export interface Column<T> {
  /** Unique key for React and for the header cell. */
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes rows clickable (and keyboard-activatable). */
  onRowClick?: (row: T) => void;
  /** Shown instead of the table body when there are no rows. */
  empty?: ReactNode;
  /** Accessible name for the table. */
  caption?: string;
}

/**
 * A plain data table. Columns are described as data, so every list page in the
 * app renders the same way and a page is mostly "which columns?".
 */
export function Table<T>({ columns, rows, rowKey, onRowClick, empty, caption }: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={clsx(
                  'px-4 py-3 font-medium whitespace-nowrap',
                  col.align === 'right' && 'text-right',
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={clsx(onRowClick && 'cursor-pointer hover:bg-ink-50')}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter') onRowClick(row);
                    }
                  : undefined
              }
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={clsx(
                    'px-4 py-3 align-middle text-ink-800',
                    col.align === 'right' && 'tabular text-right',
                    col.className,
                  )}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Offset-based pager matching the API's `Paginated<T>` shape. */
export function Pagination({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between border-t border-ink-200 px-4 py-3 text-sm text-ink-600">
      <span>
        Showing {from}–{to} of {total}
      </span>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={offset === 0}
          onClick={() => onChange(Math.max(0, offset - limit))}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={to >= total}
          onClick={() => onChange(offset + limit)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
