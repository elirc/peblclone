import type {
  CreateTeamInviteInput,
  InviteCreatedDto,
  InviteDto,
  OrganizationDto,
  OrganizationSummaryDto,
  TeamMemberDto,
  UpdateOrganizationInput,
  UpdateTeamMemberInput,
} from '@meridian/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { invalidate, keys } from '../lib/query';

/** Organization, team, invites and the platform-admin organization list. */

export function useOrganization() {
  return useQuery({
    queryKey: keys.organization,
    queryFn: () => api.get<OrganizationDto>('/organization'),
  });
}

export function useUpdateOrganization() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) => api.patch<OrganizationDto>('/organization', input),
    onSuccess: (organization) => {
      queryClient.setQueryData(keys.organization, organization);
      // The session user carries `organizationName` (shown in the app shell), and the
      // platform-admin organization list shows name/country/billing email.
      return invalidate(keys.organization, keys.me, keys.organizations, keys.audit);
    },
  });
}

/** Platform admins only. */
export function useAdminOrganizations() {
  return useQuery({
    queryKey: keys.organizations,
    queryFn: () => api.get<{ items: OrganizationSummaryDto[] }>('/admin/organizations'),
  });
}

export function useTeam() {
  return useQuery({
    queryKey: [...keys.team, 'members'],
    queryFn: () => api.get<{ items: TeamMemberDto[] }>('/team'),
  });
}

/** Admins only; pass `enabled: false` for managers so no 403 is requested. */
export function useTeamInvites(enabled: boolean) {
  return useQuery({
    queryKey: [...keys.team, 'invites'],
    queryFn: () => api.get<{ items: InviteDto[] }>('/team/invites'),
    enabled,
  });
}

export function useCreateTeamInvite() {
  return useMutation({
    mutationFn: (input: CreateTeamInviteInput) => api.post<InviteCreatedDto>('/team/invites', input),
    onSuccess: () => invalidate(keys.team, keys.audit),
  });
}

export function useRevokeTeamInvite() {
  return useMutation({
    mutationFn: (inviteId: string) => api.delete(`/team/invites/${inviteId}`),
    onSuccess: () => invalidate(keys.team, keys.audit),
  });
}

export function useUpdateTeamMember() {
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTeamMemberInput }) =>
      api.patch<TeamMemberDto>(`/team/${id}`, input),
    onSuccess: () => invalidate(keys.team, keys.audit),
  });
}
