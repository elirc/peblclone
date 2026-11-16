import { acceptInviteSchema, type InvitePreviewDto } from '@meridian/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Input, Loading } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { humanize } from '../../lib/format';
import { AuthLayout } from './AuthLayout';

export function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { acceptInvite } = useAuth();
  const navigate = useNavigate();

  const preview = useQuery({
    queryKey: ['invite-preview', token],
    queryFn: () => api.get<InvitePreviewDto>('/auth/invite', { token }),
    enabled: token.length > 0,
    retry: false,
  });

  const form = useZodForm(acceptInviteSchema, { token, fullName: '', password: '' });
  const { setValue } = form;

  // Pre-fill the name for worker invites (the client already typed it when hiring).
  useEffect(() => {
    if (preview.data?.suggestedName) setValue('fullName', preview.data.suggestedName);
  }, [preview.data?.suggestedName, setValue]);

  const onSubmit = form.handleSubmit(async (data) => {
    await acceptInvite(data);
    navigate('/', { replace: true });
  });

  if (!token || preview.isError) {
    return (
      <AuthLayout title="This invitation is not valid">
        <Alert tone="error">
          The link has expired, was already used, or was replaced by a newer invitation. Ask the
          person who invited you to send a new one.
        </Alert>
        <Link to="/login" className="mt-4 block text-center text-sm font-medium text-brand-700">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (preview.isLoading || !preview.data) {
    return (
      <AuthLayout title="Checking your invitation…">
        <Loading />
      </AuthLayout>
    );
  }

  const invite = preview.data;
  return (
    <AuthLayout
      title={`Join ${invite.organizationName}`}
      subtitle={
        invite.role === 'worker'
          ? 'Set a password to access your worker portal.'
          : `You have been invited as ${humanize(invite.role).toLowerCase()}.`
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Input label="Email" value={invite.email} disabled readOnly />
        <Input label="Full name" autoComplete="name" required {...form.field('fullName')} />
        <Input
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          required
          {...form.field('password')}
        />
        <Button type="submit" className="w-full" loading={form.submitting}>
          Accept invitation
        </Button>
      </form>
    </AuthLayout>
  );
}
