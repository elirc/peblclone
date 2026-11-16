import {
  EXPENSE_CATEGORIES,
  EXPENSE_MAX_AGE_DAYS,
  addDays,
  createExpenseSchema,
  parseMoneyToMinor,
  type WorkerDto,
} from '@meridian/shared';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useCreateExpense } from '../../api/expenses';
import { Alert, Button, Input, Modal, Select, useToast } from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { humanize, todayLocal } from '../../lib/format';
import { rethrowOnField, topLevelError } from '../contracts/form-helpers';
import { WorkerPicker } from '../contracts/WorkerPicker';

/**
 * The API takes `amountMinor` (an integer), but people type "12.50" in THEIR
 * currency. So the form holds the typed text, validates that it parses to a
 * positive amount for that currency, and converts with `parseMoneyToMinor` on
 * submit. Everything else is the shared `createExpenseSchema` unchanged.
 */
export function expenseFormSchema(currency: string, requireWorker: boolean) {
  return createExpenseSchema
    .omit({ amountMinor: true })
    .extend({
      amount: z
        .string()
        .trim()
        .min(1, 'Enter an amount')
        .refine(
          (value) => (parseMoneyToMinor(value, currency) ?? 0) > 0,
          'Enter an amount greater than zero, like 42.50',
        ),
    })
    .superRefine((value, ctx) => {
      if (requireWorker && !value.workerId) {
        ctx.addIssue({ code: 'custom', path: ['workerId'], message: 'Choose a worker' });
      }
    });
}

const FIELD_BY_CODE = { future_date: 'incurredOn', too_old: 'incurredOn' };

export function SubmitExpenseModal(
  props:
    | { mode: 'worker'; currency: string; onClose: () => void }
    | { mode: 'staff'; onClose: () => void },
) {
  const { mode, onClose } = props;
  const toast = useToast();
  const create = useCreateExpense();
  // Staff: the currency is the chosen worker's (the API stores `currency` = the worker's).
  const [picked, setPicked] = useState<WorkerDto | undefined>(undefined);
  const currency = props.mode === 'worker' ? props.currency : (picked?.currency ?? '');

  const schema = useMemo(() => expenseFormSchema(currency, mode === 'staff'), [currency, mode]);
  const today = todayLocal();
  const form = useZodForm(schema, {
    workerId: undefined,
    category: 'travel',
    description: '',
    amount: '',
    incurredOn: today,
  });

  const onSubmit = form.handleSubmit(async ({ amount, ...rest }) => {
    // The schema already proved this parses to a positive number.
    const amountMinor = parseMoneyToMinor(amount, currency) ?? 0;
    try {
      await create.mutateAsync({ ...rest, amountMinor });
    } catch (err) {
      rethrowOnField(err, FIELD_BY_CODE);
    }
    toast.success('Expense submitted for review');
    onClose();
  });

  const alert = topLevelError(form);
  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'staff' ? 'Submit expense on behalf' : 'Submit expense'}
      description="Approved expenses are reimbursed with the next payroll."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="expense-form" loading={form.submitting}>
            Submit expense
          </Button>
        </>
      }
    >
      <form id="expense-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        {mode === 'staff' && (
          <WorkerPicker
            value={form.values.workerId ?? ''}
            // Expenses are accepted from active or offboarding workers (else 409 worker_not_active).
            statuses={['active', 'offboarding']}
            error={form.errors.workerId}
            onChange={(id, worker) => {
              setPicked(worker);
              form.setValue('workerId', id || undefined);
            }}
          />
        )}
        <Select label="Category" required {...form.field('category')}>
          {EXPENSE_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {humanize(category)}
            </option>
          ))}
        </Select>
        <Input label="Description" required maxLength={300} {...form.field('description')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={currency ? `Amount (${currency})` : 'Amount'}
            inputMode="decimal"
            placeholder="0.00"
            required
            disabled={mode === 'staff' && !currency}
            hint={mode === 'staff' && !currency ? 'Choose a worker first.' : undefined}
            {...form.field('amount')}
          />
          <Input
            label="Date incurred"
            type="date"
            required
            max={today}
            min={addDays(today, -EXPENSE_MAX_AGE_DAYS)}
            hint={`Within the last ${EXPENSE_MAX_AGE_DAYS} days.`}
            {...form.field('incurredOn')}
          />
        </div>
      </form>
    </Modal>
  );
}
