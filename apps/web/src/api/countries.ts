import type {
  CalculateQuoteInput,
  CostBreakdown,
  CountryDto,
  Paginated,
  QuoteDto,
  SaveQuoteInput,
  UpdateCountryInput,
} from '@meridian/shared';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

// ---------- countries ----------

export function useCountries() {
  return useQuery({
    queryKey: [...keys.countries, 'list'],
    queryFn: () => api.get<{ items: CountryDto[] }>('/countries'),
    // Reference data: it changes only when a platform admin edits it.
    staleTime: 5 * 60_000,
  });
}

export function useUpdateCountry() {
  return useMutation({
    mutationFn: ({ code, ...input }: UpdateCountryInput & { code: string }) =>
      api.patch<CountryDto>(`/countries/${code}`, input),
    // Audited with organizationId = null, so no tenant's audit log or dashboard changes.
    // Saved quotes are snapshots and deliberately keep their old rates.
    onSuccess: () => invalidate(keys.countries),
  });
}

// ---------- quotes ----------

/** A calculation saves nothing, so it is a mutation with no invalidation. */
export function useCalculateQuote() {
  return useMutation({
    mutationFn: (input: CalculateQuoteInput) => api.post<CostBreakdown>('/quotes/calculate', input),
  });
}

export function useQuotes(page: { limit: number; offset: number }) {
  return useQuery({
    queryKey: [...keys.quotes, 'list', page],
    queryFn: () => api.get<Paginated<QuoteDto>>('/quotes', page),
    placeholderData: keepPreviousData,
  });
}

export function useSaveQuote() {
  return useMutation({
    mutationFn: (input: SaveQuoteInput) => api.post<QuoteDto>('/quotes', input),
    onSuccess: () => invalidate(keys.quotes, keys.dashboard, keys.audit),
  });
}

export function useDeleteQuote() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/quotes/${id}`),
    onSuccess: () => invalidate(keys.quotes, keys.dashboard, keys.audit),
  });
}
