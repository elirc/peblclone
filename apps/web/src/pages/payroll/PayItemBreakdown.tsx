import type { PayrollItemDto, PayslipLine } from '@meridian/shared';
import { formatMoney } from '../../lib/format';
import { formatRateBps } from './payroll-ui';

/**
 * One worker's pay for one period, line by line: the same view is used for a
 * payroll-run item (staff) and for a payslip (worker or staff), so a worker and
 * their employer always see identical numbers laid out identically.
 *
 * Employer costs are the client's cost, not the worker's pay — they are shown
 * only to staff, and visually separated from the payslip proper.
 */
export function PayItemBreakdown({
  item,
  currency,
  showEmployerCosts,
}: {
  item: PayrollItemDto;
  currency: string;
  showEmployerCosts: boolean;
}) {
  const money = (minor: number) => formatMoney(minor, currency);
  const prorated = item.daysWorked < item.daysInPeriod;

  return (
    <div className="space-y-6">
      <LineTable
        caption="Earnings"
        rows={[
          {
            key: 'gross',
            label: 'Gross pay',
            detail: prorated
              ? `Prorated: ${item.daysWorked} of ${item.daysInPeriod} days worked`
              : `${item.daysWorked} of ${item.daysInPeriod} days`,
            amount: money(item.grossMinor),
          },
        ]}
      />

      <LineTable
        caption="Deductions"
        rows={item.deductions.map((line) => contributionRow(line, money, '−'))}
        emptyText="No deductions apply."
        total={{ label: 'Total deductions', amount: `−${money(item.deductionsMinor)}` }}
      />

      <LineTable
        caption="Reimbursements"
        rows={[
          {
            key: 'reimbursements',
            label: 'Approved expenses',
            detail: 'Paid back on top of salary, not taxed.',
            amount: money(item.reimbursementsMinor),
          },
        ]}
      />

      <div className="flex items-baseline justify-between rounded-lg bg-brand-50 px-4 py-3">
        <span className="text-sm font-semibold text-ink-900">Net pay</span>
        <span className="tabular text-lg font-semibold text-ink-900" data-testid="net-pay">
          {money(item.netMinor)}
        </span>
      </div>

      {showEmployerCosts && (
        <div className="border-t border-dashed border-ink-200 pt-5">
          <p className="mb-2 text-xs text-ink-500">
            Employer costs are paid by your organization on top of gross pay. They do not appear on
            the worker's payslip.
          </p>
          <LineTable
            caption="Employer costs"
            rows={item.employerCosts.map((line) => contributionRow(line, money, ''))}
            emptyText="No employer contributions apply."
            total={{ label: 'Total employer cost', amount: money(item.employerCostMinor) }}
          />
        </div>
      )}
    </div>
  );
}

interface Row {
  key: string;
  label: string;
  detail?: string;
  amount: string;
}

function contributionRow(line: PayslipLine, money: (minor: number) => string, sign: string): Row {
  return {
    key: line.key,
    label: line.name,
    detail: formatRateBps(line.rateBps),
    amount: `${sign}${money(line.amountMinor)}`,
  };
}

function LineTable({
  caption,
  rows,
  total,
  emptyText,
}: {
  caption: string;
  rows: Row[];
  total?: { label: string; amount: string };
  emptyText?: string;
}) {
  return (
    <table className="w-full text-sm">
      <caption className="mb-2 text-left text-xs font-semibold uppercase tracking-wide text-ink-500">
        {caption}
      </caption>
      <tbody className="divide-y divide-ink-100">
        {rows.length === 0 && emptyText && (
          <tr>
            <td colSpan={2} className="py-2 text-ink-500">
              {emptyText}
            </td>
          </tr>
        )}
        {rows.map((row) => (
          <tr key={row.key}>
            <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
              {row.label}
              {row.detail && <span className="ml-2 text-xs text-ink-500">{row.detail}</span>}
            </th>
            <td className="tabular py-2 text-right text-ink-900">{row.amount}</td>
          </tr>
        ))}
        {total && (
          <tr className="border-t border-ink-200">
            <th scope="row" className="py-2 pr-4 text-left font-medium text-ink-900">
              {total.label}
            </th>
            <td className="tabular py-2 text-right font-medium text-ink-900">{total.amount}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
