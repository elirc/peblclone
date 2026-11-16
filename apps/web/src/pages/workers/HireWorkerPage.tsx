import {
  annualSalaryOf,
  calculateEmploymentCost,
  CONTRACTOR_MONTHLY_FEE_USD_MINOR,
  createWorkerSchema,
  parseMoneyToMinor,
  type CountryDto,
  type PayBasis,
  type WorkerType,
} from '@meridian/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useCountries } from '../../api/countries';
import { useHireWorker } from '../../api/workers';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardHeader,
  Checkbox,
  ErrorState,
  Input,
  Loading,
  PageHeader,
  Select,
  useToast,
} from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { formatBps, formatMoney, fullName } from '../../lib/format';
import { InviteLinkModal, RadioGroup } from './worker-ui';

/** What the user typed, in major units ("60,000"), as minor units for the form. 0 = not a number. */
function salaryToMinor(text: string, currency: string): number {
  return parseMoneyToMinor(text, currency) ?? 0;
}

export default function HireWorkerPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const countries = useCountries();
  const hire = useHireWorker();

  const form = useZodForm(createWorkerSchema, {
    type: 'employee',
    firstName: '',
    lastName: '',
    email: '',
    countryCode: '',
    jobTitle: '',
    department: '',
    startDate: '',
    salaryMinor: 0,
    payBasis: 'annual',
    sendInvite: true,
  });
  const { values, setValue } = form;

  // The salary box holds text in major units; the form holds minor units. Both are
  // UI state (what the user typed), recomputed whenever the text or the currency changes.
  const [salaryText, setSalaryText] = useState('');

  const country = countries.data?.items.find((c) => c.code === values.countryCode);
  const currency = country?.currency ?? 'USD';
  const employeeInUnsupportedCountry =
    values.type === 'employee' && country && !country.eorSupported;

  const onSalaryChange = (text: string) => {
    setSalaryText(text);
    setValue('salaryMinor', salaryToMinor(text, currency));
  };
  const onCountryChange = (code: string) => {
    setValue('countryCode', code);
    const next = countries.data?.items.find((c) => c.code === code);
    // JPY has no minor unit, EUR has two: the same typed number is a different minor amount.
    setValue('salaryMinor', salaryToMinor(salaryText, next?.currency ?? 'USD'));
  };

  const onSubmit = form.handleSubmit(async (data) => {
    if (employeeInUnsupportedCountry) {
      form.setFormError(
        `Meridian cannot employ people in ${country.name} yet. Hire them as a contractor instead.`,
      );
      return;
    }
    const result = await hire.mutateAsync({ ...data, department: data.department || undefined });
    toast.success(`${fullName(result.worker)} has been added`);
    // With an invite, the modal (driven by hire.data) shows the link first.
    if (!result.acceptUrl) navigate(`/people/${result.worker.id}`);
  });

  // A typed-but-unparseable salary reaches the schema as 0 ("Must be > 0"); say what is wrong instead.
  const salaryError = form.errors.salaryMinor
    ? salaryText.trim() && parseMoneyToMinor(salaryText, currency) === null
      ? 'Enter an amount using digits only, e.g. 60000'
      : salaryText.trim()
        ? form.errors.salaryMinor
        : 'Enter a salary'
    : undefined;

  const header = (
    <PageHeader
      title="Hire someone"
      description="Add an employee (employed by Meridian on your behalf) or a contractor."
      back={{ to: '/people', label: 'People' }}
    />
  );

  if (countries.isPending) {
    return (
      <>
        {header}
        <Loading />
      </>
    );
  }
  if (countries.isError) {
    return (
      <>
        {header}
        <ErrorState error={countries.error} onRetry={() => void countries.refetch()} />
      </>
    );
  }

  const created = hire.data;

  return (
    <>
      {header}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form onSubmit={onSubmit} className="space-y-6" noValidate>
          {form.formError && <Alert tone="error">{form.formError}</Alert>}

          <Card>
            <CardHeader title="Who" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input label="First name" autoComplete="off" required {...form.field('firstName')} />
              <Input label="Last name" autoComplete="off" required {...form.field('lastName')} />
              <div className="sm:col-span-2">
                <Input
                  label="Email"
                  type="email"
                  autoComplete="off"
                  required
                  {...form.field('email')}
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Role" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Input label="Job title" required {...form.field('jobTitle')} />
              <Input label="Department" hint="Optional." {...form.field('department')} />
            </div>
          </Card>

          <Card>
            <CardHeader title="Where and what kind" />
            <div className="space-y-4">
              <RadioGroup<WorkerType>
                legend="Worker type"
                value={values.type}
                onChange={(type) => setValue('type', type)}
                error={form.errors.type}
                options={[
                  {
                    value: 'employee',
                    label: 'Employee',
                    description: 'Employed by Meridian locally, with statutory benefits.',
                  },
                  {
                    value: 'contractor',
                    label: 'Contractor',
                    description: 'Self-employed, paid gross against invoices.',
                  },
                ]}
              />
              <Select
                label="Country"
                required
                value={values.countryCode}
                onChange={(event) => onCountryChange(event.target.value)}
                error={
                  form.errors.countryCode
                    ? 'Choose a country'
                    : employeeInUnsupportedCountry
                      ? `Meridian cannot employ people in ${country.name} yet. Choose contractor, or another country.`
                      : undefined
                }
                hint={country ? `Paid in ${country.currency}.` : undefined}
              >
                <option value="">Choose a country…</option>
                {countries.data.items.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                    {c.eorSupported ? '' : ' (contractors only)'}
                  </option>
                ))}
              </Select>
            </div>
          </Card>

          <Card>
            <CardHeader title="Pay and start date" />
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label={`Salary (${currency})`}
                  inputMode="decimal"
                  placeholder={values.payBasis === 'annual' ? 'e.g. 60000' : 'e.g. 5000'}
                  required
                  name="salary"
                  value={salaryText}
                  onChange={(event) => onSalaryChange(event.target.value)}
                  error={salaryError}
                  hint={country ? undefined : 'Choose a country to set the currency.'}
                />
                <Input label="Start date" type="date" required {...form.field('startDate')} />
              </div>
              <RadioGroup<PayBasis>
                legend="Salary is"
                value={values.payBasis}
                onChange={(payBasis) => setValue('payBasis', payBasis)}
                error={form.errors.payBasis}
                options={[
                  { value: 'annual', label: 'Per year' },
                  { value: 'monthly', label: 'Per month' },
                ]}
              />
            </div>
          </Card>

          <Card>
            <Checkbox
              label="Create a worker portal invite link now (you will be shown the link to send them)"
              checked={values.sendInvite ?? true}
              onChange={(event) => setValue('sendInvite', event.target.checked)}
            />
          </Card>

          <div className="flex flex-wrap justify-end gap-2">
            <ButtonLink to="/people" variant="secondary">
              Cancel
            </ButtonLink>
            <Button type="submit" loading={form.submitting}>
              Hire
            </Button>
          </div>
        </form>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <CostPreview
            type={values.type}
            country={country}
            salaryMinor={values.salaryMinor}
            payBasis={values.payBasis}
          />
        </aside>
      </div>

      {created?.acceptUrl && (
        <InviteLinkModal
          open
          acceptUrl={created.acceptUrl}
          workerName={fullName(created.worker)}
          closeLabel="Continue to worker"
          onClose={() => navigate(`/people/${created.worker.id}`)}
        />
      )}
    </>
  );
}

/**
 * Live employer-cost estimate, computed in the browser with the same pure function
 * the API uses for quotes and payroll — so there is no network call per keystroke
 * and the numbers cannot disagree with the server's.
 */
function CostPreview({
  type,
  country,
  salaryMinor,
  payBasis,
}: {
  type: WorkerType;
  country: CountryDto | undefined;
  salaryMinor: number;
  payBasis: PayBasis;
}) {
  if (type === 'contractor') {
    return (
      <Card>
        <CardHeader title="Cost preview" />
        <p className="text-sm text-ink-600">
          Contractors are paid gross: no employer contributions or statutory deductions.
        </p>
        <dl className="mt-4 flex justify-between gap-3 border-t border-ink-200 pt-3 text-sm">
          <dt className="text-ink-600">Meridian fee</dt>
          <dd className="tabular font-medium text-ink-900">
            {formatMoney(CONTRACTOR_MONTHLY_FEE_USD_MINOR, 'USD')}/mo
          </dd>
        </dl>
      </Card>
    );
  }

  if (!country || salaryMinor <= 0) {
    return (
      <Card>
        <CardHeader title="Cost preview" />
        <p className="text-sm text-ink-500">
          Choose a country and enter a salary to see the monthly employer cost.
        </p>
      </Card>
    );
  }

  if (!country.eorSupported) {
    return (
      <Card>
        <CardHeader title="Cost preview" />
        <p className="text-sm text-ink-500">Employment is not available in {country.name}.</p>
      </Card>
    );
  }

  const cost = calculateEmploymentCost({
    countryCode: country.code,
    currency: country.currency,
    annualSalaryMinor: annualSalaryOf(salaryMinor, payBasis),
    employerContributions: country.employerContributions,
    employeeDeductions: country.employeeDeductions,
    monthlyFeeUsdMinor: country.monthlyFeeUsdMinor,
  });
  const money = (minor: number) => formatMoney(minor, cost.currency);

  return (
    <Card>
      <CardHeader title="Cost preview" description={`Monthly, in ${country.name}`} />
      <dl className="space-y-2 text-sm" aria-label="Cost preview">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-600">Monthly salary</dt>
          <dd className="tabular text-ink-900">{money(cost.monthlySalaryMinor)}</dd>
        </div>
        {cost.employerContributions.map((line) => (
          <div key={line.key} className="flex justify-between gap-3">
            <dt className="text-ink-600">
              {line.name} <span className="text-ink-400">({formatBps(line.rateBps)})</span>
            </dt>
            <dd className="tabular text-ink-900">{money(line.monthlyMinor)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-3 border-t border-ink-200 pt-2 font-semibold">
          <dt className="text-ink-900">Total monthly cost</dt>
          <dd className="tabular text-ink-900">{money(cost.monthlyTotalMinor)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-600">Meridian fee</dt>
          <dd className="tabular text-ink-900">{formatMoney(cost.monthlyFeeUsdMinor, 'USD')}/mo</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-ink-500">
        Illustrative estimate with simplified statutory rates. Not tax advice.
      </p>
    </Card>
  );
}
