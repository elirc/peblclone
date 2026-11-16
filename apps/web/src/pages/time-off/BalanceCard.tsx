import { useTimeOffBalance } from '../../api/time-off';
import { Card, CardHeader, ErrorState, Loading } from '../../components/ui';

const plural = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** The signed-in worker's vacation balance for the current year. */
export function BalanceCard() {
  const balance = useTimeOffBalance({});

  return (
    <Card>
      <CardHeader
        title="Vacation balance"
        description={balance.data ? `Calendar year ${balance.data.year}` : undefined}
      />
      {balance.isLoading ? (
        <Loading label="Loading balance…" />
      ) : balance.isError || !balance.data ? (
        <ErrorState error={balance.error} onRetry={() => void balance.refetch()} />
      ) : (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            { label: 'Entitlement', value: balance.data.entitlementDays },
            { label: 'Used', value: balance.data.usedDays },
            { label: 'Pending approval', value: balance.data.pendingDays },
            { label: 'Remaining', value: balance.data.remainingDays },
          ].map((item) => (
            <div key={item.label} className="rounded-lg bg-ink-50 px-4 py-3">
              <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {item.label}
              </dt>
              <dd className="tabular mt-1 text-xl font-semibold text-ink-900">
                {plural(item.value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
