import type {
  CountryDto,
  CreatePayrollRunInput,
  ListPayrollRunsQuery,
  Paginated,
  PayrollRunDetailDto,
  PayrollRunDto,
  PayslipDto,
  RejectPayrollRunInput,
  WorkerDto,
  listPayslipsQuerySchema,
} from '@meridian/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/**
 * Payroll runs and payslips (contract section "Payroll").
 *
 * Who-invalidates-what, because a payroll run touches a lot of the product:
 *  - creating / recalculating / deleting a run claims or releases approved
 *    expenses, so `expenses` is invalidated as well as `payroll`;
 *  - submitting changes the dashboard's "payroll approvals" counter;
 *  - approving ISSUES AN INVOICE, so `invoices` and `dashboard` are invalidated;
 *  - marking paid creates payslips and marks expenses reimbursed.
 * Every one of them writes an audit entry, hence `audit` everywhere.
 */

export type ListPayslipsQuery = z.infer<typeof listPayslipsQuerySchema>;

const runKey = (id: string) => [...keys.payroll, 'run', id] as const;

export function usePayrollRuns(query: Partial<ListPayrollRunsQuery>) {
  return useQuery({
    queryKey: [...keys.payroll, 'runs', query],
    queryFn: () => api.get<Paginated<PayrollRunDto>>('/payroll/runs', query),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function usePayrollRun(id: string) {
  return useQuery({
    queryKey: runKey(id),
    queryFn: () => api.get<PayrollRunDetailDto>(`/payroll/runs/${id}`),
  });
}

export function useCreatePayrollRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePayrollRunInput) =>
      api.post<PayrollRunDetailDto>('/payroll/runs', input),
    onSuccess: (run) => {
      queryClient.setQueryData(runKey(run.id), run);
      return invalidate(keys.payroll, keys.expenses, keys.dashboard, keys.audit);
    },
  });
}

/**
 * The action endpoints all answer with the updated run, so each hook writes that
 * answer straight into the detail cache (the screen updates without a refetch)
 * and then invalidates everything else the action could have changed.
 */
function useRunAction<TInput = void>(
  id: string,
  request: (input: TInput) => Promise<PayrollRunDetailDto>,
  alsoInvalidate: (readonly string[])[],
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (run) => {
      queryClient.setQueryData(runKey(id), run);
      return invalidate(keys.payroll, keys.audit, ...alsoInvalidate);
    },
  });
}

export function useRecalculatePayrollRun(id: string) {
  return useRunAction(id, () => api.post<PayrollRunDetailDto>(`/payroll/runs/${id}/recalculate`), [
    keys.expenses,
    keys.dashboard,
  ]);
}

export function useSubmitPayrollRun(id: string) {
  return useRunAction(id, () => api.post<PayrollRunDetailDto>(`/payroll/runs/${id}/submit`), [
    keys.dashboard,
  ]);
}

export function useApprovePayrollRun(id: string) {
  return useRunAction(id, () => api.post<PayrollRunDetailDto>(`/payroll/runs/${id}/approve`), [
    keys.invoices,
    keys.dashboard,
  ]);
}

export function useRejectPayrollRun(id: string) {
  return useRunAction(
    id,
    (input: RejectPayrollRunInput) =>
      api.post<PayrollRunDetailDto>(`/payroll/runs/${id}/reject`, input),
    [keys.dashboard],
  );
}

export function useProcessPayrollRun(id: string) {
  return useRunAction(id, () => api.post<PayrollRunDetailDto>(`/payroll/runs/${id}/process`), [
    keys.dashboard,
  ]);
}

export function useMarkPayrollRunPaid(id: string) {
  return useRunAction(id, () => api.post<PayrollRunDetailDto>(`/payroll/runs/${id}/mark-paid`), [
    keys.payslips,
    keys.expenses,
    keys.dashboard,
  ]);
}

export function useDeletePayrollRun(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete(`/payroll/runs/${id}`),
    onSuccess: () => {
      // Drop the detail entry first: refetching a run that no longer exists would
      // flash a 404 on the screen we are about to leave.
      queryClient.removeQueries({ queryKey: runKey(id) });
      return invalidate(keys.payroll, keys.expenses, keys.dashboard, keys.audit);
    },
  });
}

// ---------- payslips ----------

export function usePayslips(query: Partial<ListPayslipsQuery>) {
  return useQuery({
    queryKey: [...keys.payslips, 'list', query],
    queryFn: () => api.get<Paginated<PayslipDto>>('/payslips', query),
    placeholderData: keepPreviousData,
  });
}

export function usePayslip(id: string | null) {
  return useQuery({
    queryKey: [...keys.payslips, 'detail', id],
    queryFn: () => api.get<PayslipDto>(`/payslips/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

// ---------- small pickers used by payroll screens ----------
// Deliberately local to this file (not shared with the countries/workers pages),
// with their own query-key suffix so they can never clash with another page's cache shape.

/** Every country, for the "new payroll run" and organization country pickers. */
export function useCountryOptions() {
  return useQuery({
    queryKey: [...keys.countries, 'options'],
    queryFn: () => api.get<{ items: CountryDto[] }>('/countries'),
    staleTime: 5 * 60_000,
  });
}

/** Up to 100 workers, for the staff-only "filter payslips by worker" picker. */
export function useWorkerOptions(enabled: boolean) {
  return useQuery({
    queryKey: [...keys.workers, 'options'],
    queryFn: () => api.get<Paginated<WorkerDto>>('/workers', { limit: 100 }),
    enabled,
  });
}
