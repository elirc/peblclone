import type { InvoiceDetailDto, InvoiceDto, ListInvoicesQuery, Paginated } from '@meridian/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/** Invoices (contract section "Invoices"). Always billed in USD. */

const invoiceKey = (id: string) => [...keys.invoices, 'detail', id] as const;

export function useInvoices(query: Partial<ListInvoicesQuery>) {
  return useQuery({
    queryKey: [...keys.invoices, 'list', query],
    queryFn: () => api.get<Paginated<InvoiceDto>>('/invoices', query),
    placeholderData: keepPreviousData,
  });
}

/** Pass `null` to skip (e.g. a payroll run that has no invoice yet). */
export function useInvoice(id: string | null) {
  return useQuery({
    queryKey: invoiceKey(id ?? 'none'),
    queryFn: () => api.get<InvoiceDetailDto>(`/invoices/${id ?? ''}`),
    enabled: Boolean(id),
  });
}

export function usePayInvoice(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<InvoiceDetailDto>(`/invoices/${id}/pay`),
    onSuccess: (invoice) => {
      queryClient.setQueryData(invoiceKey(id), invoice);
      // Paying unblocks the payroll run ("process" requires a paid invoice) and
      // changes the dashboard's unpaid-invoices counter.
      return invalidate(keys.invoices, keys.payroll, keys.dashboard, keys.audit);
    },
  });
}
