import { updateOrganizationSchema, type OrganizationDto } from '@meridian/shared';
import { useCountryOptions } from '../../api/payroll';
import { useOrganization, useUpdateOrganization } from '../../api/organization';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ErrorState,
  Input,
  Loading,
  PageHeader,
  Select,
  useToast,
} from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { formatDate } from '../../lib/format';

export default function OrganizationSettingsPage() {
  const organization = useOrganization();

  return (
    <>
      <PageHeader
        title="Organization settings"
        description="Your company's details as they appear on invoices."
      />
      {organization.isPending ? (
        <Loading label="Loading organization…" />
      ) : organization.isError ? (
        <ErrorState error={organization.error} onRetry={() => void organization.refetch()} />
      ) : (
        // Keyed by id so switching tenant (platform admins) starts a fresh form.
        <OrganizationForm key={organization.data.id} organization={organization.data} />
      )}
    </>
  );
}

const toFormValues = (org: OrganizationDto) => ({
  name: org.name,
  legalName: org.legalName,
  billingEmail: org.billingEmail,
  countryCode: org.countryCode,
});

/**
 * The form's starting values come from the server once; after that the inputs
 * are the user's draft (UI state). On save the form is reset to what the server
 * returned, because the server normalises (e.g. lower-cases the billing email).
 */
function OrganizationForm({ organization }: { organization: OrganizationDto }) {
  const toast = useToast();
  const update = useUpdateOrganization();
  const countries = useCountryOptions();
  const form = useZodForm(updateOrganizationSchema, toFormValues(organization));

  const onSubmit = form.handleSubmit(async (data) => {
    const saved = await update.mutateAsync(data);
    form.reset(toFormValues(saved));
    toast.success('Organization details saved');
  });

  const countryKnown =
    countries.data?.items.some((c) => c.code === form.values.countryCode) ?? false;

  return (
    <Card className="max-w-2xl">
      <CardHeader
        title="Company details"
        description={`Customer since ${formatDate(organization.createdAt)}`}
      />
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Input label="Display name" required autoComplete="organization" {...form.field('name')} />
        <Input
          label="Legal name"
          required
          hint="The registered company name printed on invoices."
          {...form.field('legalName')}
        />
        <Input
          label="Billing email"
          type="email"
          required
          autoComplete="email"
          hint="The contact for invoices and billing questions."
          {...form.field('billingEmail')}
        />
        <Select
          label="Headquarters country"
          required
          disabled={countries.isLoading}
          hint={countries.isError ? 'Could not load the country list.' : undefined}
          {...form.field('countryCode')}
        >
          {/* Keep the current value selectable even before / without the country list. */}
          {!countryKnown && form.values.countryCode && (
            <option value={form.values.countryCode}>{form.values.countryCode}</option>
          )}
          {countries.data?.items.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </Select>
        <div className="flex justify-end">
          <Button type="submit" loading={form.submitting}>
            Save changes
          </Button>
        </div>
      </form>
    </Card>
  );
}
