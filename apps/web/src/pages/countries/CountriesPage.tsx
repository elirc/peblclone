import {
  DOCUMENT_KIND_LABELS,
  parseMoneyToMinor,
  updateCountrySchema,
  type ContributionRule,
  type CountryDto,
  type UpdateCountryInput,
} from '@meridian/shared';
import { Globe } from 'lucide-react';
import { useState } from 'react';
import { useCountries, useUpdateCountry } from '../../api/countries';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  Modal,
  PageHeader,
  Table,
  useToast,
  type Column,
} from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { formatBps, formatMoney } from '../../lib/format';

const columns: Column<CountryDto>[] = [
  {
    key: 'name',
    header: 'Country',
    cell: (c) => (
      <div>
        <p className="font-medium text-ink-900">{c.name}</p>
        <p className="text-xs text-ink-500">
          {c.code} · {c.region}
        </p>
      </div>
    ),
  },
  { key: 'currency', header: 'Currency', cell: (c) => c.currency },
  { key: 'leave', header: 'Leave days', align: 'right', cell: (c) => c.annualLeaveDays },
  { key: 'notice', header: 'Notice (days)', align: 'right', cell: (c) => c.noticePeriodDays },
  {
    key: 'fee',
    header: 'Fee / mo',
    align: 'right',
    cell: (c) => formatMoney(c.monthlyFeeUsdMinor, 'USD'),
  },
  {
    key: 'eor',
    header: 'Employment (EOR)',
    // Text, not just colour, says whether it is supported.
    cell: (c) =>
      c.eorSupported ? <Badge tone="green">Supported</Badge> : <Badge>Contractors only</Badge>,
  },
];

export default function CountriesPage() {
  const countries = useCountries();
  const [editingCode, setEditingCode] = useState<string | null>(null);
  // Look the country up from the query on every render, so the modal never shows a stale copy.
  const editing = countries.data?.items.find((c) => c.code === editingCode);

  return (
    <>
      <PageHeader
        title="Countries"
        description="Commercial and statutory settings for every country Meridian operates in. Changes apply to new calculations; saved quotes keep their rates."
      />
      <Card padded={false}>
        {countries.isPending ? (
          <Loading />
        ) : countries.isError ? (
          <div className="px-5">
            <ErrorState error={countries.error} onRetry={() => void countries.refetch()} />
          </div>
        ) : countries.data.items.length === 0 ? (
          <EmptyState
            icon={<Globe className="h-6 w-6" aria-hidden />}
            title="No countries configured"
            description="Countries come from the reference data seed. Run the database seed to load them."
          />
        ) : (
          <Table
            caption="Countries"
            columns={columns}
            rows={countries.data.items}
            rowKey={(c) => c.code}
            onRowClick={(c) => setEditingCode(c.code)}
          />
        )}
      </Card>
      {editing && <EditCountryModal country={editing} onClose={() => setEditingCode(null)} />}
    </>
  );
}

/** Whole numbers only; anything else becomes NaN so the schema reports it. */
const toInt = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);

type IntField = 'annualLeaveDays' | 'noticePeriodDays' | 'probationDays';

function EditCountryModal({ country, onClose }: { country: CountryDto; onClose: () => void }) {
  const toast = useToast();
  const update = useUpdateCountry();
  const form = useZodForm(updateCountrySchema, {
    monthlyFeeUsdMinor: country.monthlyFeeUsdMinor,
    annualLeaveDays: country.annualLeaveDays,
    noticePeriodDays: country.noticePeriodDays,
    probationDays: country.probationDays,
    eorSupported: country.eorSupported,
  });
  // Number inputs hold what the user typed; the form holds the parsed numbers.
  const [text, setText] = useState<Record<IntField | 'fee', string>>({
    fee: (country.monthlyFeeUsdMinor / 100).toFixed(2),
    annualLeaveDays: String(country.annualLeaveDays),
    noticePeriodDays: String(country.noticePeriodDays),
    probationDays: String(country.probationDays),
  });

  const intInput = (name: IntField, label: string, hint?: string) => (
    <Input
      label={label}
      inputMode="numeric"
      required
      name={name}
      value={text[name]}
      hint={hint}
      onChange={(event) => {
        setText((prev) => ({ ...prev, [name]: event.target.value }));
        form.setValue(name, toInt(event.target.value));
      }}
      error={
        form.errors[name]
          ? Number.isNaN(toInt(text[name]))
            ? 'Enter a whole number'
            : form.errors[name]
          : undefined
      }
    />
  );

  const onSubmit = form.handleSubmit(async (data) => {
    // PATCH only what changed, so the audit record names exactly what an admin edited.
    const changes: UpdateCountryInput = {};
    if (
      data.monthlyFeeUsdMinor !== undefined &&
      data.monthlyFeeUsdMinor !== country.monthlyFeeUsdMinor
    )
      changes.monthlyFeeUsdMinor = data.monthlyFeeUsdMinor;
    if (data.annualLeaveDays !== undefined && data.annualLeaveDays !== country.annualLeaveDays)
      changes.annualLeaveDays = data.annualLeaveDays;
    if (data.noticePeriodDays !== undefined && data.noticePeriodDays !== country.noticePeriodDays)
      changes.noticePeriodDays = data.noticePeriodDays;
    if (data.probationDays !== undefined && data.probationDays !== country.probationDays)
      changes.probationDays = data.probationDays;
    if (data.eorSupported !== undefined && data.eorSupported !== country.eorSupported)
      changes.eorSupported = data.eorSupported;

    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    await update.mutateAsync({ code: country.code, ...changes });
    toast.success(`${country.name} updated`);
    onClose();
  });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${country.name} (${country.code})`}
      description={`Local currency ${country.currency} · ${country.region}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="edit-country-form" loading={form.submitting}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-country-form" onSubmit={onSubmit} className="space-y-6" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Meridian fee per employee (USD / month)"
            inputMode="decimal"
            required
            name="monthlyFeeUsd"
            value={text.fee}
            onChange={(event) => {
              setText((prev) => ({ ...prev, fee: event.target.value }));
              form.setValue(
                'monthlyFeeUsdMinor',
                parseMoneyToMinor(event.target.value, 'USD') ?? Number.NaN,
              );
            }}
            error={
              form.errors.monthlyFeeUsdMinor
                ? parseMoneyToMinor(text.fee, 'USD') === null
                  ? 'Enter an amount in USD, e.g. 599.00'
                  : form.errors.monthlyFeeUsdMinor
                : undefined
            }
          />
          {intInput('annualLeaveDays', 'Annual leave days', '0–60.')}
          {intInput('noticePeriodDays', 'Notice period (days)', '0–365.')}
          {intInput('probationDays', 'Probation (days)', '0–365.')}
        </div>
        <Checkbox
          label="Meridian can employ people here (EOR supported). When off, only contractors can be hired."
          checked={form.values.eorSupported ?? false}
          onChange={(event) => form.setValue('eorSupported', event.target.checked)}
        />

        <div className="space-y-4 border-t border-ink-200 pt-4">
          <p className="text-xs text-ink-500">
            Statutory rules are shown read-only here; they are maintained in the reference data.
          </p>
          <RulesTable
            title="Employer contributions"
            rules={country.employerContributions}
            currency={country.currency}
          />
          <RulesTable
            title="Employee deductions"
            rules={country.employeeDeductions}
            currency={country.currency}
          />
          <div>
            <h3 className="mb-1 text-sm font-semibold text-ink-900">Required documents</h3>
            <p className="text-sm text-ink-700">
              {country.requiredDocuments.length === 0
                ? 'None'
                : country.requiredDocuments.map((kind) => DOCUMENT_KIND_LABELS[kind]).join(', ')}
            </p>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function RulesTable({
  title,
  rules,
  currency,
}: {
  title: string;
  rules: ContributionRule[];
  currency: string;
}) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold text-ink-900">{title}</h3>
      {rules.length === 0 ? (
        <p className="text-sm text-ink-500">None.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
                <th scope="col" className="py-2 pr-4 text-left font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Rate
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Annual cap
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {rules.map((rule) => (
                <tr key={rule.key}>
                  <td className="py-2 pr-4 text-ink-800">{rule.name}</td>
                  <td className="tabular py-2 pr-4 text-right">{formatBps(rule.rateBps)}</td>
                  <td className="tabular py-2 text-right">
                    {rule.annualCapMinor != null
                      ? formatMoney(rule.annualCapMinor, currency)
                      : 'No cap'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
