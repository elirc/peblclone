import { createTeamInviteSchema, INVITABLE_TEAM_ROLES, type CreateTeamInviteInput } from '@meridian/shared';
import { Copy } from 'lucide-react';
import { useCreateTeamInvite } from '../../api/organization';
import { Alert, Button, Input, Modal, Select, useToast } from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { formatDate, humanize } from '../../lib/format';

const INITIAL: CreateTeamInviteInput = { email: '', role: 'client_manager' };

/**
 * Two steps in one modal: the form, then — because Meridian has no email
 * service — the one-time accept link for the admin to copy and send themselves.
 * The link lives in the mutation's result, not in component state.
 */
export function InviteTeammateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const createInvite = useCreateTeamInvite();
  const form = useZodForm(createTeamInviteSchema, INITIAL);
  const created = createInvite.data;

  const close = () => {
    form.reset();
    createInvite.reset();
    onClose();
  };

  const onSubmit = form.handleSubmit(async (data) => {
    await createInvite.mutateAsync(data);
  });

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy automatically. Select the link and copy it yourself.');
    }
  }

  if (created) {
    return (
      <Modal
        open={open}
        onClose={close}
        title="Invitation created"
        footer={<Button onClick={close}>Done</Button>}
      >
        <div className="space-y-4">
          <Alert tone="info" title="No email is sent">
            Send this link to {created.invite.email} yourself. It works once and expires on{' '}
            {formatDate(created.invite.expiresAt)}.
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <Input
                label="Invite link"
                value={created.acceptUrl}
                readOnly
                onFocus={(event) => event.target.select()}
              />
            </div>
            <Button
              variant="secondary"
              icon={<Copy className="h-4 w-4" aria-hidden />}
              onClick={() => void copyLink(created.acceptUrl)}
            >
              Copy
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Invite a teammate"
      description="Teammates manage your workers, payroll and invoices. Workers get their own portal invite from their profile."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="invite-teammate" loading={form.submitting}>
            Create invite
          </Button>
        </>
      }
    >
      <form id="invite-teammate" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Input label="Work email" type="email" autoComplete="off" required {...form.field('email')} />
        <Select
          label="Role"
          required
          hint="Admins can also approve payroll, pay invoices and manage the team."
          name="role"
          value={form.values.role}
          error={form.errors.role}
          onChange={(event) =>
            form.setValue('role', INVITABLE_TEAM_ROLES.find((r) => r === event.target.value) ?? 'client_manager')
          }
        >
          {INVITABLE_TEAM_ROLES.map((role) => (
            <option key={role} value={role}>
              {humanize(role)}
            </option>
          ))}
        </Select>
      </form>
    </Modal>
  );
}
