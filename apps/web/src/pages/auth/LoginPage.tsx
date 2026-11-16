import { loginSchema } from '@meridian/shared';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Input } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const form = useZodForm(loginSchema, { email: '', password: '' });

  // Where the user was heading before being asked to log in. Only ever an
  // in-app path — never navigate to a URL taken from the query string.
  const from = (location.state as { from?: string } | null)?.from;
  const destination = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';

  const onSubmit = form.handleSubmit(async (data) => {
    await login(data);
    navigate(destination, { replace: true });
  });

  return (
    <AuthLayout
      title="Sign in to Meridian"
      subtitle="Hire, pay and manage your global team."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-medium text-brand-700 hover:underline">
            Create a company account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Input
          label="Work email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          {...form.field('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          {...form.field('password')}
        />
        <Button type="submit" className="w-full" loading={form.submitting}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
