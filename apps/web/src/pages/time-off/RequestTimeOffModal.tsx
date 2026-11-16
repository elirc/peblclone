import {
  TIME_OFF_TYPES,
  countBusinessDays,
  createTimeOffRequestSchema,
  isIsoDate,
} from '@meridian/shared';
import { useMemo } from 'react';
import { useCreateTimeOffRequest, useTimeOffBalance } from '../../api/time-off';
import { Alert, Button, Input, Modal, Select, Textarea, useToast } from '../../components/ui';
import { useZodForm } from '../../lib/form';
import { humanize } from '../../lib/format';
import { rethrowOnField, topLevelError } from '../contracts/form-helpers';
import { WorkerPicker } from '../contracts/WorkerPicker';

/**
 * Staff must say WHO the request is for (the API resolves a worker's own id from
 * the session, but a client user has none). Workers never see the picker.
 */
const staffSchema = createTimeOffRequestSchema.superRefine((value, ctx) => {
  if (!value.workerId)
    ctx.addIssue({ code: 'custom', path: ['workerId'], message: 'Choose a worker' });
});

/** Rule errors that belong to one field rather than the whole form. */
const FIELD_BY_CODE = {
  before_start_date: 'startDate',
  spans_years: 'endDate',
  no_working_days: 'endDate',
};

export function RequestTimeOffModal({
  mode,
  onClose,
}: {
  mode: 'worker' | 'staff';
  onClose: () => void;
}) {
  const toast = useToast();
  const create = useCreateTimeOffRequest();
  const schema = mode === 'staff' ? staffSchema : createTimeOffRequestSchema;
  const form = useZodForm(schema, {
    workerId: undefined,
    type: 'vacation',
    startDate: '',
    endDate: '',
    reason: '',
  });
  const { values } = form;

  // Live working-day count, using the same function the server uses to store `days`.
  const days = useMemo(() => {
    if (!isIsoDate(values.startDate) || !isIsoDate(values.endDate)) return null;
    if (values.startDate > values.endDate) return null;
    return countBusinessDays(values.startDate, values.endDate);
  }, [values.startDate, values.endDate]);

  // A worker sees their remaining balance next to the count; staff see the chosen worker's.
  const balance = useTimeOffBalance(
    { workerId: mode === 'staff' ? values.workerId : undefined },
    mode === 'worker' || Boolean(values.workerId),
  );
  const remaining = values.type === 'vacation' ? balance.data?.remainingDays : undefined;

  const onSubmit = form.handleSubmit(async (data) => {
    try {
      await create.mutateAsync({ ...data, reason: data.reason || undefined });
    } catch (err) {
      // overlapping_request, insufficient_balance, worker_not_active… stay as the
      // form error with the server's own message.
      rethrowOnField(err, FIELD_BY_CODE);
    }
    toast.success('Time-off request submitted');
    onClose();
  });

  let daysHint: string | undefined;
  if (days !== null) {
    daysHint = `${days} working day${days === 1 ? '' : 's'} (Monday–Friday)`;
    if (remaining !== undefined) daysHint += ` · ${remaining} remaining`;
  }

  const alert = topLevelError(form);
  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'staff' ? 'Request time off on behalf' : 'Request time off'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="time-off-form" loading={form.submitting}>
            Submit request
          </Button>
        </>
      }
    >
      <form id="time-off-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        {mode === 'staff' && (
          <WorkerPicker
            value={values.workerId ?? ''}
            // Only active employees can take time off (contractors: 409 not_applicable_to_contractors).
            query={{ status: 'active', type: 'employee' }}
            error={form.errors.workerId}
            onChange={(id) => form.setValue('workerId', id || undefined)}
          />
        )}
        <Select label="Type" required {...form.field('type')}>
          {TIME_OFF_TYPES.map((type) => (
            <option key={type} value={type}>
              {humanize(type)}
            </option>
          ))}
        </Select>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="First day" type="date" required {...form.field('startDate')} />
          <Input
            label="Last day"
            type="date"
            required
            min={values.startDate || undefined}
            {...form.field('endDate')}
          />
        </div>
        <p aria-live="polite" className="text-sm text-ink-600">
          {daysHint ?? 'Pick the first and last day to see how many working days this uses.'}
        </p>
        {days === 0 && (
          <Alert tone="warning">
            That range has no working days, so there is nothing to request.
          </Alert>
        )}
        <Textarea label="Reason (optional)" rows={3} {...form.field('reason')} />
      </form>
    </Modal>
  );
}
