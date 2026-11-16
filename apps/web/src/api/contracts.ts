import type {
  ContractDetailDto,
  ContractDto,
  CreateContractInput,
  ListContractsQuery,
  ListWorkersQuery,
  Paginated,
  SignContractInput,
  UpdateContractInput,
  WorkerDto,
} from '@meridian/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/**
 * Contracts (contract section "Contracts").
 *
 * Who-invalidates-what:
 *  - every action writes an audit entry and can move the dashboard's
 *    "contracts awaiting signature" counter → `audit`, `dashboard`;
 *  - signing completes the worker's `contract_signed` onboarding task (and may
 *    activate the worker); voiding a signed contract re-opens it; terminating
 *    ends employment → those three also invalidate `workers` (which includes the
 *    worker portal's `GET /me/worker`).
 */

const contractKey = (id: string) => [...keys.contracts, 'detail', id] as const;

export function useContracts(query: Partial<ListContractsQuery>, enabled = true) {
  return useQuery({
    queryKey: [...keys.contracts, 'list', query],
    queryFn: () => api.get<Paginated<ContractDto>>('/contracts', query),
    enabled,
  });
}

export function useContract(id: string) {
  return useQuery({
    queryKey: contractKey(id),
    queryFn: () => api.get<ContractDetailDto>(`/contracts/${id}`),
  });
}

export function useCreateContract() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContractInput) => api.post<ContractDetailDto>('/contracts', input),
    onSuccess: (contract) => {
      queryClient.setQueryData(contractKey(contract.id), contract);
      return invalidate(keys.contracts, keys.dashboard, keys.audit);
    },
  });
}

/**
 * Every action endpoint answers with the updated contract, so the answer goes
 * straight into the detail cache (no flicker, no extra request) before the
 * lists and counters that could also have changed are invalidated.
 */
function useContractAction<TInput = void>(
  id: string,
  request: (input: TInput) => Promise<ContractDetailDto>,
  alsoInvalidate: (readonly string[])[] = [],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (contract) => {
      queryClient.setQueryData(contractKey(id), contract);
      return invalidate(keys.contracts, keys.dashboard, keys.audit, ...alsoInvalidate);
    },
  });
}

export function useUpdateContract(id: string) {
  return useContractAction(id, (input: UpdateContractInput) =>
    api.patch<ContractDetailDto>(`/contracts/${id}`, input),
  );
}

export function useSendContract(id: string) {
  return useContractAction(id, () => api.post<ContractDetailDto>(`/contracts/${id}/send`));
}

export function useRecallContract(id: string) {
  return useContractAction(id, () => api.post<ContractDetailDto>(`/contracts/${id}/recall`));
}

export function useSignContract(id: string) {
  return useContractAction(
    id,
    (input: SignContractInput) => api.post<ContractDetailDto>(`/contracts/${id}/sign`, input),
    [keys.workers],
  );
}

export function useActivateContract(id: string) {
  return useContractAction(id, () => api.post<ContractDetailDto>(`/contracts/${id}/activate`));
}

export function useVoidContract(id: string) {
  return useContractAction(id, () => api.post<ContractDetailDto>(`/contracts/${id}/void`), [
    keys.workers,
  ]);
}

export function useTerminateContract(id: string) {
  return useContractAction(id, () => api.post<ContractDetailDto>(`/contracts/${id}/terminate`), [
    keys.workers,
  ]);
}

// ---------- worker picker (staff only) ----------
// Builder D owns api/workers.ts; this is a deliberately small, local lookup used by
// the "new contract", "request time off on behalf" and "submit expense on behalf"
// pickers. Its own key suffix ('picker') keeps its cache entry from ever colliding
// with another page's differently-shaped worker query.

/** Up to 100 workers matching `query`, for a staff-only `<select>`. */
export function useWorkerPicker(query: Partial<ListWorkersQuery>, enabled = true) {
  const params = { limit: 100, ...query };
  return useQuery({
    queryKey: [...keys.workers, 'picker', params],
    queryFn: () => api.get<Paginated<WorkerDto>>('/workers', params),
    enabled,
  });
}
