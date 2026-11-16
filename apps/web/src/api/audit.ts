import type { AuditLogDto, ListAuditLogsQuery, Paginated } from '@meridian/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';

/** Audit log (admins). Read-only: entries are written by the API, never by the client. */
export function useAuditLogs(query: Partial<ListAuditLogsQuery>) {
  return useQuery({
    queryKey: [...keys.audit, 'list', query],
    queryFn: () => api.get<Paginated<AuditLogDto>>('/audit-logs', query),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}
