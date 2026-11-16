import { registerSchema } from '@meridian/shared';
import { Link, useNavigate } from 'react-router';
import { Alert, Button, Input, Select } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { AuthLayout } from './AuthLayout';

/**
 * The countries list endpoint needs a session, and nobody has one yet on this
 * page — so signup offers a short fixed list for "where is your company based".
 * It can be changed later under Settings.
 */
const HQ_COUNTRIES: [code: string, name: string][] = [
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['CA', 'Canada'],
  ['DE', 'Germany'],
  ['FR', 'France'],
  ['NL', 'Netherlands'],
  ['ES', 'Spain'],
  ['AU', 'Australia'],
  ['SG', 'Singapore'],
  ['JP', 'Japan'],
  ['IN', 'India'],
  ['BR', 'Brazil'],
  ['MX', 'Mexico'],
  ['PH', 'Philippines'],
];

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const form = useZodForm(registerSchema, {
    organizationName: '',
    countryCode: 'US',
    fullName: '',
    email: '',
    password: '',
  });

  const onSubmit = form.handleSubmit(async (data) => {
    await register(data);
    navigate('/', { replace: true });
  });

  return (
    <AuthLayout
      title="Create your company account"
      subtitle="Start hiring in 14 countries without opening a single entity."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Input label="Company name" autoFocus required {...form.field('organizationName')} />
        <Select label="Company headquarters" required {...form.field('countryCode')}>
          {HQ_COUNTRIES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </Select>
        <Input label="Your full name" autoComplete="name" required {...form.field('fullName')} />
        <Input
          label="Work email"
          type="email"
          autoComplete="email"
          required
          {...form.field('email')}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters."
          required
          {...form.field('password')}
        />
        <Button type="submit" className="w-full" loading={form.submitting}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}
