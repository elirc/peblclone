import type { DashboardDto } from '@meridian/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';

export function useDashboard() {
  return useQuery({
    queryKey: [...keys.dashboard],
    queryFn: () => api.get<DashboardDto>('/dashboard'),
  });
}
