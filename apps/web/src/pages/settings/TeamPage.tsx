import { INVITABLE_TEAM_ROLES, type InviteDto, type TeamMemberDto } from '@meridian/shared';
import { MailPlus, Users } from 'lucide-react';
import { useState } from 'react';
import {
  useRevokeTeamInvite,
  useTeam,
  useTeamInvites,
  useUpdateTeamMember,
} from '../../api/organization';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  useToast,
  type Column,
} from '../../components/ui';
import { isAdminRole, useUser } from '../../lib/auth';
import { formatDate, humanize } from '../../lib/format';
import { InviteTeammateModal } from './InviteTeammateModal';

/** A role the team page can hand out (the API refuses anything else). */
const isInvitableRole = (role: string) => INVITABLE_TEAM_ROLES.some((r) => r === role);

export default function TeamPage() {
  const user = useUser();
  const isAdmin = isAdminRole(user);
  const [inviting, setInviting] = useState(false);

  return (
    <>
      <PageHeader
        title="Team"
        description="The people at your company who use Meridian. Workers are managed under People."
        actions={
          isAdmin && (
            <Button
              icon={<MailPlus className="h-4 w-4" aria-hidden />}
              onClick={() => setInviting(true)}
            >
              Invite teammate
            </Button>
          )
        }
      />
      <div className="space-y-6">
        <MembersCard currentUserId={user.id} isAdmin={isAdmin} onInvite={() => setInviting(true)} />
        {isAdmin && <InvitesCard />}
      </div>
      {isAdmin && <InviteTeammateModal open={inviting} onClose={() => setInviting(false)} />}
    </>
  );
}

function MembersCard({
  currentUserId,
  isAdmin,
  onInvite,
}: {
  currentUserId: string;
  isAdmin: boolean;
  onInvite: () => void;
}) {
  const toast = useToast();
  const team = useTeam();
  const update = useUpdateTeamMember();
  // Which member's activation change awaits confirmation (an id, not a copy of the row).
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirming = team.data?.items.find((m) => m.id === confirmId);

  async function changeRole(member: TeamMemberDto, role: string) {
    const next = INVITABLE_TEAM_ROLES.find((r) => r === role);
    if (!next || next === member.role) return;
    try {
      await update.mutateAsync({ id: member.id, input: { role: next } });
      toast.success(`${member.fullName} is now ${humanize(next).toLowerCase()}`);
    } catch (err) {
      toast.error(err);
    }
  }

  async function toggleActive(member: TeamMemberDto) {
    try {
      await update.mutateAsync({ id: member.id, input: { isActive: !member.isActive } });
      toast.success(
        member.isActive ? `${member.fullName} deactivated` : `${member.fullName} reactivated`,
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setConfirmId(null);
    }
  }

  // You can't change your own role or deactivate yourself (the API answers
  // `400 cannot_modify_self`), so your own row never shows the controls.
  const manageable = (member: TeamMemberDto) =>
    isAdmin && member.id !== currentUserId && isInvitableRole(member.role);

  const columns: Column<TeamMemberDto>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (member) => (
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink-900">{member.fullName}</span>
          {member.id === currentUserId && <Badge tone="blue">You</Badge>}
        </span>
      ),
    },
    { key: 'email', header: 'Email', cell: (member) => member.email },
    {
      key: 'role',
      header: 'Role',
      cell: (member) =>
        manageable(member) ? (
          <Select
            aria-label={`Role for ${member.fullName}`}
            value={member.role}
            disabled={update.isPending}
            onChange={(event) => void changeRole(member, event.target.value)}
            className="h-8 min-w-36"
          >
            {INVITABLE_TEAM_ROLES.map((role) => (
              <option key={role} value={role}>
                {humanize(role)}
              </option>
            ))}
          </Select>
        ) : (
          humanize(member.role)
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (member) =>
        member.isActive ? (
          <StatusBadge status="active" />
        ) : (
          <Badge tone="neutral">Deactivated</Badge>
        ),
    },
    { key: 'since', header: 'Member since', cell: (member) => formatDate(member.createdAt) },
  ];
  if (isAdmin) {
    columns.push({
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (member) =>
        manageable(member) ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={update.isPending}
            aria-label={`${member.isActive ? 'Deactivate' : 'Reactivate'} ${member.fullName}`}
            onClick={() => setConfirmId(member.id)}
          >
            {member.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        ) : null,
    });
  }

  return (
    <Card padded={false}>
      <div className="px-5 pt-5 sm:px-6">
        <CardHeader title="Members" />
      </div>
      {team.isPending ? (
        <Loading label="Loading team…" />
      ) : team.isError ? (
        <div className="px-4">
          <ErrorState error={team.error} onRetry={() => void team.refetch()} />
        </div>
      ) : (
        <Table
          caption="Team members"
          columns={columns}
          rows={team.data.items}
          rowKey={(member) => member.id}
          empty={
            <EmptyState
              icon={<Users className="h-6 w-6" aria-hidden />}
              title="No teammates yet"
              action={isAdmin && <Button onClick={onInvite}>Invite teammate</Button>}
            />
          }
        />
      )}

      <ConfirmDialog
        open={confirming !== undefined}
        onClose={() => setConfirmId(null)}
        title={
          confirming?.isActive
            ? `Deactivate ${confirming.fullName}?`
            : `Reactivate ${confirming?.fullName ?? ''}?`
        }
        confirmLabel={confirming?.isActive ? 'Deactivate' : 'Reactivate'}
        danger={confirming?.isActive}
        loading={update.isPending}
        onConfirm={() => {
          if (confirming) void toggleActive(confirming);
        }}
      >
        {confirming?.isActive
          ? 'They lose access to Meridian. Their history (approvals, audit entries) is kept, and you can reactivate them later.'
          : 'They will be able to sign in again with their existing password.'}
      </ConfirmDialog>
    </Card>
  );
}

function InvitesCard() {
  const toast = useToast();
  const invites = useTeamInvites(true);
  const revoke = useRevokeTeamInvite();
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const revoking = invites.data?.items.find((invite) => invite.id === revokeId);
  const now = new Date().toISOString();

  async function onRevoke(invite: InviteDto) {
    try {
      await revoke.mutateAsync(invite.id);
      toast.success(`Invite for ${invite.email} revoked`);
    } catch (err) {
      toast.error(err);
    } finally {
      setRevokeId(null);
    }
  }

  const columns: Column<InviteDto>[] = [
    {
      key: 'email',
      header: 'Email',
      cell: (invite) => <span className="font-medium text-ink-900">{invite.email}</span>,
    },
    { key: 'role', header: 'Role', cell: (invite) => humanize(invite.role) },
    { key: 'sent', header: 'Created', cell: (invite) => formatDate(invite.createdAt) },
    {
      key: 'expires',
      header: 'Expires',
      cell: (invite) => (
        <span className="flex flex-wrap items-center gap-2">
          {formatDate(invite.expiresAt)}
          {invite.expiresAt < now && <Badge tone="red">Expired</Badge>}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (invite) => (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Revoke invite for ${invite.email}`}
          onClick={() => setRevokeId(invite.id)}
        >
          Revoke
        </Button>
      ),
    },
  ];

  // The API lists unaccepted invites; filter defensively so an accepted one never shows as pending.
  const pending = invites.data?.items.filter((invite) => invite.acceptedAt === null) ?? [];

  return (
    <Card padded={false}>
      <div className="px-5 pt-5 sm:px-6">
        <CardHeader
          title="Pending invites"
          description="Invites that have not been accepted yet. Revoking one makes its link stop working."
        />
      </div>
      {invites.isPending ? (
        <Loading label="Loading invites…" />
      ) : invites.isError ? (
        <div className="px-4">
          <ErrorState error={invites.error} onRetry={() => void invites.refetch()} />
        </div>
      ) : (
        <Table
          caption="Pending invites"
          columns={columns}
          rows={pending}
          rowKey={(invite) => invite.id}
          empty={<p className="px-6 pb-6 text-sm text-ink-500">No pending invites.</p>}
        />
      )}

      <ConfirmDialog
        open={revoking !== undefined}
        onClose={() => setRevokeId(null)}
        title="Revoke this invite?"
        confirmLabel="Revoke invite"
        danger
        loading={revoke.isPending}
        onConfirm={() => {
          if (revoking) void onRevoke(revoking);
        }}
      >
        {revoking &&
          `The link sent to ${revoking.email} will stop working. You can invite them again later.`}
      </ConfirmDialog>
    </Card>
  );
}
