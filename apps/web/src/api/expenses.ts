import type {
  CreateExpenseInput,
  DecisionInput,
  ExpenseDto,
  ListExpensesQuery,
  Paginated,
} from '@meridian/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/**
 * Expenses (contract section "Expenses").
 *
 * Mutations here change the expense lists, the dashboard's "expenses to review"
 * counter and the audit log. Approving does NOT touch payroll directly: an
 * approved expense is only claimed when a payroll run is created/recalculated.
 */

const afterChange = () => invalidate(keys.expenses, keys.dashboard, keys.audit);

export function useExpenses(query: Partial<ListExpensesQuery>) {
  return useQuery({
    queryKey: [...keys.expenses, 'list', query],
    queryFn: () => api.get<Paginated<ExpenseDto>>('/expenses', query),
  });
}

export function useCreateExpense() {
  return useMutation({
    mutationFn: (input: CreateExpenseInput) => api.post<ExpenseDto>('/expenses', input),
    onSuccess: afterChange,
  });
}

export function useDecideExpense() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DecisionInput }) =>
      api.post<ExpenseDto>(`/expenses/${id}/decision`, input),
    onSuccess: afterChange,
  });
}

export function useDeleteExpense() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/expenses/${id}`),
    onSuccess: afterChange,
  });
}
