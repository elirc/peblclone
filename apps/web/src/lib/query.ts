import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './api';

/**
 * TanStack Query owns all SERVER state: fetching, caching, refetching, loading
 * and error flags. Components never keep a copy of server data in useState.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Retrying a 4xx is pointless: the answer will not change. Retry network/5xx once.
      retry: (failureCount, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return failureCount < 1;
      },
    },
  },
});

/**
 * Query keys, in one place. After a mutation, invalidate the TOP-LEVEL key of
 * everything it could have changed, e.g. approving payroll invalidates
 * `keys.payroll`, `keys.invoices` and `keys.dashboard`.
 */
export const keys = {
  me: ['me'] as const,
  organization: ['organization'] as const,
  organizations: ['organizations'] as const,
  team: ['team'] as const,
  countries: ['countries'] as const,
  quotes: ['quotes'] as const,
  workers: ['workers'] as const,
  documents: ['documents'] as const,
  contracts: ['contracts'] as const,
  timeOff: ['time-off'] as const,
  expenses: ['expenses'] as const,
  payroll: ['payroll'] as const,
  payslips: ['payslips'] as const,
  invoices: ['invoices'] as const,
  audit: ['audit'] as const,
  dashboard: ['dashboard'] as const,
};

/** Invalidate several top-level keys at once. */
export function invalidate(...topLevelKeys: (readonly string[])[]): Promise<void[]> {
  return Promise.all(topLevelKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
