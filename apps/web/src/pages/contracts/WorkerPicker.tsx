import type { ListWorkersQuery, WorkerDto, WorkerStatus } from '@meridian/shared';
import { useWorkerPicker } from '../../api/contracts';
import { Select } from '../../components/ui';
import { errorMessage } from '../../lib/api';

/**
 * A staff-only `<select>` of workers. Used by "New contract", "Request time off
 * on behalf" and "Submit expense on behalf". Never render it for a worker.
 *
 * `query` narrows the list on the server (e.g. `status: 'active'`); `statuses`
 * narrows it further in the browser when the rule allows several statuses
 * (the API filter takes only one).
 */
export function WorkerPicker({
  value,
  onChange,
  error,
  query = {},
  statuses,
  hint,
}: {
  value: string;
  onChange: (workerId: string, worker: WorkerDto | undefined) => void;
  error?: string;
  query?: Partial<ListWorkersQuery>;
  statuses?: WorkerStatus[];
  hint?: string;
}) {
  const workers = useWorkerPicker(query);
  const options = (workers.data?.items ?? []).filter(
    (worker) => !statuses || statuses.includes(worker.status),
  );
  const loadError = workers.isError ? errorMessage(workers.error) : undefined;
  const noneEligible = workers.isSuccess && options.length === 0;

  return (
    <Select
      label="Worker"
      required
      value={value}
      disabled={workers.isLoading}
      error={error ?? loadError}
      hint={noneEligible ? 'No eligible workers.' : hint}
      onChange={(event) => {
        const id = event.target.value;
        onChange(
          id,
          options.find((worker) => worker.id === id),
        );
      }}
    >
      <option value="">{workers.isLoading ? 'Loading workers…' : 'Choose a worker'}</option>
      {options.map((worker) => (
        <option key={worker.id} value={worker.id}>
          {worker.firstName} {worker.lastName} — {worker.jobTitle} ({worker.countryCode})
        </option>
      ))}
    </Select>
  );
}
