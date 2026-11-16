import { createPayrollRunSchema } from '@meridian/shared';
import { useNavigate } from 'react-router';
import { useCountryOptions, useCreatePayrollRun } from '../../api/payroll';
import { Alert, Button, Modal, Select, useToast } from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { MONTH_OPTIONS } from './payroll-ui';

/**
 * "New payroll run": pick a country and a period. The API does the maths
 * (payable workers, proration, expense claims), so the form is deliberately tiny.
 * Business refusals — `409 run_exists`, `409 no_payable_workers`,
 * `400 period_too_far` — arrive as API errors and are shown as the form error.
 */
export function NewPayrollRunModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const countries = useCountryOptions();
  const createRun = useCreatePayrollRun();

  const now = new Date();
  const currentYear = now.getFullYear();
  // The API refuses periods later than next month; earlier years are for catching up.
  const yearOptions = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1];

  const form = useZodForm(createPayrollRunSchema, {
    countryCode: '',
    periodYear: currentYear,
    periodMonth: now.getMonth() + 1,
  });

  const close = () => {
    form.reset();
    onClose();
  };

  const onSubmit = form.handleSubmit(async (data) => {
    const run = await createRun.mutateAsync(data);
    toast.success('Payroll run created');
    form.reset();
    onClose();
    navigate(`/payroll/${run.id}`);
  });

  return (
    <Modal
      open={open}
      onClose={close}
      title="New payroll run"
      description="Meridian calculates pay for every payable worker in the country for that month, including approved expenses."
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="new-payroll-run" loading={form.submitting}>
            Create run
          </Button>
        </>
      }
    >
      <form id="new-payroll-run" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        {countries.isError && (
          <Alert tone="error">Could not load the country list. Close this and try again.</Alert>
        )}
        <Select
          label="Country"
          required
          disabled={countries.isLoading}
          {...form.field('countryCode')}
        >
          <option value="">{countries.isLoading ? 'Loading countries…' : 'Choose a country'}</option>
          {countries.data?.items.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name} ({country.currency})
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Month"
            required
            name="periodMonth"
            value={String(form.values.periodMonth)}
            error={form.errors.periodMonth}
            onChange={(event) => form.setValue('periodMonth', Number(event.target.value))}
          >
            {MONTH_OPTIONS.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </Select>
          <Select
            label="Year"
            required
            name="periodYear"
            value={String(form.values.periodYear)}
            error={form.errors.periodYear}
            onChange={(event) => form.setValue('periodYear', Number(event.target.value))}
          >
            {yearOptions.map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        </div>
      </form>
    </Modal>
  );
}
