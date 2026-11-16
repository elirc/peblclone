import type { InvoiceDto } from '@meridian/shared';
import { Badge, StatusBadge } from '../../components/ui';
import { todayLocal } from '../../lib/format';

/** An unpaid invoice past its due date is worth shouting about. */
export function isOverdue(invoice: Pick<InvoiceDto, 'status' | 'dueDate'>, today = todayLocal()): boolean {
  return invoice.status === 'issued' && invoice.dueDate < today;
}

export function InvoiceStatusBadge({ invoice }: { invoice: Pick<InvoiceDto, 'status' | 'dueDate'> }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      <StatusBadge status={invoice.status} />
      {isOverdue(invoice) && <Badge tone="red">Overdue</Badge>}
    </span>
  );
}

/** "0.920000" -> "0.92": the rate is a Postgres numeric string; trim it without float maths. */
export function formatRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/0+$/, '').replace(/\.$/, '') : rate;
}
