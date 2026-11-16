import type {
  CreateTimeOffRequestInput,
  DecisionInput,
  ListTimeOffQuery,
  Paginated,
  TimeOffBalanceDto,
  TimeOffRequestDto,
} from '@meridian/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/**
 * Time off (contract section "Time off").
 *
 * Every mutation changes the request list AND the balance (pending/used days),
 * both of which live under `keys.timeOff`; the dashboard counts pending requests,
 * and every action is audited.
 */

const afterChange = () => invalidate(keys.timeOff, keys.dashboard, keys.audit);

export function useTimeOffRequests(query: Partial<ListTimeOffQuery>) {
  return useQuery({
    queryKey: [...keys.timeOff, 'requests', query],
    queryFn: () => api.get<Paginated<TimeOffRequestDto>>('/time-off/requests', query),
  });
}

/** Leave balance. A worker omits `workerId` (the API uses their own). */
export function useTimeOffBalance(query: { workerId?: string; year?: number }, enabled = true) {
  return useQuery({
    queryKey: [...keys.timeOff, 'balance', query],
    queryFn: () => api.get<TimeOffBalanceDto>('/time-off/balance', query),
    enabled,
  });
}

export function useCreateTimeOffRequest() {
  return useMutation({
    mutationFn: (input: CreateTimeOffRequestInput) =>
      api.post<TimeOffRequestDto>('/time-off/requests', input),
    onSuccess: afterChange,
  });
}

export function useDecideTimeOffRequest() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DecisionInput }) =>
      api.post<TimeOffRequestDto>(`/time-off/requests/${id}/decision`, input),
    onSuccess: afterChange,
  });
}

export function useCancelTimeOffRequest() {
  return useMutation({
    mutationFn: (id: string) => api.post<TimeOffRequestDto>(`/time-off/requests/${id}/cancel`),
    onSuccess: afterChange,
  });
}
