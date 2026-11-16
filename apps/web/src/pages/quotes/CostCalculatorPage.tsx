import {
  calculateQuoteSchema,
  parseMoneyToMinor,
  type CalculateQuoteInput,
  type CostBreakdown,
  type CountryDto,
  type QuoteDto,
} from '@meridian/shared';
import { Calculator, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  useCalculateQuote,
  useCountries,
  useDeleteQuote,
  useQuotes,
  useSaveQuote,
} from '../../api/countries';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Select,
  Table,
  useToast,
  type Column,
} from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { formatBps, formatDateTime, formatMoney } from '../../lib/format';

const QUOTES_PAGE_SIZE = 10;

export default function CostCalculatorPage() {
  const countries = useCountries();

  const header = (
    <PageHeader
      title="Cost calculator"
      description="Estimate what it costs to employ someone in another country through Meridian."
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

  return (
    <>
      {header}
      <div className="space-y-6">
        <Alert tone="warning" title="Illustrative rates, not tax advice">
          Statutory rates are simplified (flat rates with optional caps). Real costs depend on
          individual circumstances; confirm with a local adviser before making an offer.
        </Alert>
        <CalculatorSection countries={countries.data.items} />
        <SavedQuotes countries={countries.data.items} />
      </div>
    </>
  );
}

function CalculatorSection({ countries }: { countries: CountryDto[] }) {
  const toast = useToast();
  const calculate = useCalculateQuote();
  const save = useSaveQuote();
  const form = useZodForm(calculateQuoteSchema, { countryCode: '', annualSalaryMinor: 0 });
  // Typed text (major units) is UI state; the form holds the minor-unit number.
  const [salaryText, setSalaryText] = useState('');
  const [label, setLabel] = useState('');

  const country = countries.find((c) => c.code === form.values.countryCode);
  const currency = country?.currency ?? 'USD';
  const toMinor = (text: string, cur: string) => parseMoneyToMinor(text, cur) ?? 0;

  const onSubmit = form.handleSubmit(async (data) => {
    await calculate.mutateAsync(data);
  });

  // The result belongs to the inputs it was calculated FROM (`variables`), which may
  // differ from what is in the form now if the user has edited it since.
  const result = calculate.data;
  const resultInput: CalculateQuoteInput | undefined = calculate.variables;
  const resultCountry = countries.find((c) => c.code === resultInput?.countryCode);

  const saveQuote = async () => {
    if (!resultInput) return;
    try {
      await save.mutateAsync({ ...resultInput, label: label.trim() || undefined });
      toast.success('Quote saved');
      setLabel('');
    } catch (err) {
      toast.error(err);
    }
  };

  const salaryError = form.errors.annualSalaryMinor
    ? salaryText.trim() === ''
      ? 'Enter an annual salary'
      : parseMoneyToMinor(salaryText, currency) === null
        ? 'Enter an amount using digits only, e.g. 60000'
        : form.errors.annualSalaryMinor
    : undefined;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Card className="lg:self-start">
        <CardHeader title="Calculate" />
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {form.formError && <Alert tone="error">{form.formError}</Alert>}
          <Select
            label="Country"
            required
            value={form.values.countryCode}
            onChange={(event) => {
              const code = event.target.value;
              form.setValue('countryCode', code);
              const next = countries.find((c) => c.code === code);
              form.setValue('annualSalaryMinor', toMinor(salaryText, next?.currency ?? 'USD'));
            }}
            error={form.errors.countryCode ? 'Choose a country' : undefined}
            hint="Countries where Meridian can employ people."
          >
            <option value="">Choose a country…</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code} disabled={!c.eorSupported}>
                {c.name}
                {c.eorSupported ? '' : ' (not available)'}
              </option>
            ))}
          </Select>
          <Input
            label={`Annual salary (${currency})`}
            inputMode="decimal"
            placeholder="e.g. 60000"
            required
            name="annualSalary"
            value={salaryText}
            onChange={(event) => {
              setSalaryText(event.target.value);
              form.setValue('annualSalaryMinor', toMinor(event.target.value, currency));
            }}
            error={salaryError}
          />
          <Button
            type="submit"
            className="w-full"
            loading={form.submitting}
            icon={<Calculator className="h-4 w-4" aria-hidden />}
          >
            Calculate
          </Button>
        </form>
      </Card>

      <Card>
        {result && resultInput ? (
          <>
            <CardHeader
              title={`Employing someone in ${resultCountry?.name ?? result.countryCode}`}
              description={`Annual salary ${formatMoney(result.annualSalaryMinor, result.currency)}`}
            />
            <Breakdown breakdown={result} />
            <div className="mt-6 flex flex-col gap-3 border-t border-ink-200 pt-4 sm:flex-row sm:items-end">
              <div className="flex-1">
                <Input
                  label="Label"
                  hint="Optional, e.g. the role or candidate."
                  maxLength={120}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                loading={save.isPending}
                icon={<Save className="h-4 w-4" aria-hidden />}
                onClick={() => void saveQuote()}
                className="sm:mb-[1.625rem]"
              >
                Save quote
              </Button>
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Calculator className="h-6 w-6" aria-hidden />}
            title="No calculation yet"
            description="Choose a country and an annual salary to see the full employer cost."
          />
        )}
      </Card>
    </div>
  );
}

/** The full CostBreakdown: employer side first (what the client pays), then the employee side. */
function Breakdown({ breakdown: b }: { breakdown: CostBreakdown }) {
  const money = (minor: number) => formatMoney(minor, b.currency);
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Employer cost</caption>
          <thead>
            <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
              <th scope="col" className="py-2 pr-4 text-left font-medium">
                Employer cost
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Rate
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-medium">
                Monthly
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Annual
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            <tr>
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
                Gross salary
              </th>
              <td className="py-2 pr-4 text-right text-ink-400">—</td>
              <td className="tabular py-2 pr-4 text-right">{money(b.monthlySalaryMinor)}</td>
              <td className="tabular py-2 text-right">{money(b.annualSalaryMinor)}</td>
            </tr>
            {b.employerContributions.map((line) => (
              <tr key={line.key}>
                <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
                  {line.name}
                </th>
                <td className="tabular py-2 pr-4 text-right">{formatBps(line.rateBps)}</td>
                <td className="tabular py-2 pr-4 text-right">{money(line.monthlyMinor)}</td>
                <td className="tabular py-2 text-right">{money(line.annualMinor)}</td>
              </tr>
            ))}
            <tr>
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
                Employer contributions
              </th>
              <td />
              <td className="tabular py-2 pr-4 text-right">{money(b.monthlyEmployerCostMinor)}</td>
              <td className="tabular py-2 text-right">{money(b.annualEmployerCostMinor)}</td>
            </tr>
            <tr className="font-semibold text-ink-900">
              <th scope="row" className="py-2 pr-4 text-left">
                Total employer cost
              </th>
              <td />
              <td className="tabular py-2 pr-4 text-right">{money(b.monthlyTotalMinor)}</td>
              <td className="tabular py-2 text-right">{money(b.annualTotalMinor)}</td>
            </tr>
            <tr>
              <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
                Meridian fee (USD)
              </th>
              <td />
              <td className="tabular py-2 pr-4 text-right">
                {formatMoney(b.monthlyFeeUsdMinor, 'USD')}
              </td>
              <td className="tabular py-2 text-right">
                {formatMoney(b.monthlyFeeUsdMinor * 12, 'USD')}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="mb-1 text-sm font-semibold text-ink-900">Employee side (indicative)</h3>
        <p className="mb-2 text-xs text-ink-500">
          What comes out of the employee's pay, so you can talk about take-home pay.
        </p>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Employee deductions and net pay, monthly</caption>
            <thead>
              <tr className="border-b border-ink-200 text-xs uppercase tracking-wide text-ink-500">
                <th scope="col" className="py-2 pr-4 text-left font-medium">
                  Deduction
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Rate
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Monthly
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {b.employeeDeductions.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-2 text-ink-500">
                    No statutory deductions in this model.
                  </td>
                </tr>
              )}
              {b.employeeDeductions.map((line) => (
                <tr key={line.key}>
                  <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
                    {line.name}
                  </th>
                  <td className="tabular py-2 pr-4 text-right">{formatBps(line.rateBps)}</td>
                  <td className="tabular py-2 text-right">{money(line.monthlyMinor)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="py-2 pr-4 text-left font-normal text-ink-800">
                  Total deductions
                </th>
                <td />
                <td className="tabular py-2 text-right">{money(b.monthlyDeductionsMinor)}</td>
              </tr>
              <tr className="font-semibold text-ink-900">
                <th scope="row" className="py-2 pr-4 text-left">
                  Net monthly pay
                </th>
                <td />
                <td className="tabular py-2 text-right">{money(b.monthlyNetMinor)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SavedQuotes({ countries }: { countries: CountryDto[] }) {
  const toast = useToast();
  const [offset, setOffset] = useState(0);
  const quotes = useQuotes({ limit: QUOTES_PAGE_SIZE, offset });
  const remove = useDeleteQuote();
  const [deleting, setDeleting] = useState<QuoteDto | null>(null);

  const countryName = (code: string) => countries.find((c) => c.code === code)?.name ?? code;

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success('Quote deleted');
      setDeleting(null);
      // Deleting the last row of a page would otherwise leave you on an empty page.
      if (quotes.data && quotes.data.items.length === 1 && offset > 0) {
        setOffset(Math.max(0, offset - QUOTES_PAGE_SIZE));
      }
    } catch (err) {
      toast.error(err);
    }
  };

  const columns: Column<QuoteDto>[] = [
    {
      key: 'label',
      header: 'Quote',
      cell: (q) => (
        <div>
          <p className="font-medium text-ink-900">{q.label ?? 'Untitled quote'}</p>
          <p className="text-xs text-ink-500">{formatDateTime(q.createdAt)}</p>
        </div>
      ),
    },
    { key: 'country', header: 'Country', cell: (q) => countryName(q.countryCode) },
    {
      key: 'salary',
      header: 'Annual salary',
      align: 'right',
      cell: (q) => formatMoney(q.breakdown.annualSalaryMinor, q.breakdown.currency),
    },
    {
      key: 'monthly',
      header: 'Monthly cost',
      align: 'right',
      cell: (q) => formatMoney(q.breakdown.monthlyTotalMinor, q.breakdown.currency),
    },
    {
      key: 'fee',
      header: 'Fee / mo',
      align: 'right',
      cell: (q) => formatMoney(q.breakdown.monthlyFeeUsdMinor, 'USD'),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (q) => (
        <Button
          size="sm"
          variant="ghost"
          icon={<Trash2 className="h-4 w-4" aria-hidden />}
          onClick={() => setDeleting(q)}
          aria-label={`Delete quote ${q.label ?? 'Untitled quote'}`}
        >
          Delete
        </Button>
      ),
    },
  ];

  return (
    <Card padded={false}>
      <div className="p-5 pb-0 sm:p-6 sm:pb-0">
        <CardHeader
          title="Saved quotes"
          description="Each quote keeps the rates it was calculated with, even if rates change later."
        />
      </div>
      {quotes.isPending ? (
        <Loading />
      ) : quotes.isError ? (
        <div className="px-5">
          <ErrorState error={quotes.error} onRetry={() => void quotes.refetch()} />
        </div>
      ) : quotes.data.items.length === 0 ? (
        <EmptyState
          title="No saved quotes yet"
          description="Calculate a cost above and choose “Save quote” to keep it for later."
        />
      ) : (
        <>
          <Table
            caption="Saved quotes"
            columns={columns}
            rows={quotes.data.items}
            rowKey={(q) => q.id}
          />
          <Pagination
            total={quotes.data.total}
            limit={quotes.data.limit}
            offset={quotes.data.offset}
            onChange={setOffset}
          />
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
        title="Delete this quote?"
        confirmLabel="Delete quote"
        danger
        loading={remove.isPending}
      >
        {deleting?.label ?? 'This quote'} will be removed. This cannot be undone.
      </ConfirmDialog>
    </Card>
  );
}
