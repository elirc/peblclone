import {
  canTransition,
  minorUnitDigits,
  parseMoneyToMinor,
  transitionWorkerSchema,
  updateWorkerSchema,
  WORKER_TRANSITIONS,
  type PayBasis,
  type UpdateWorkerInput,
  type WorkerDetailDto,
  type WorkerStatus,
} from '@meridian/shared';
import { KeyRound, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useCreateWorkerInvite, useTransitionWorker, useUpdateWorker } from '../../api/workers';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DescriptionList,
  Input,
  Modal,
  StatusBadge,
  Textarea,
  useToast,
} from '../../components/ui';
import { isAdminRole, useUser } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { formatDate, fullName, humanize } from '../../lib/format';
import { formatSalary, InviteLinkModal, RadioGroup } from './worker-ui';

/** Statuses in which the API accepts PATCH /workers/:id. */
const EDITABLE: readonly WorkerStatus[] = ['onboarding', 'active'];
/** Statuses in which the API refuses to create a portal invite. */
const NO_INVITE: readonly WorkerStatus[] = ['terminated', 'cancelled'];

export function OverviewTab({ worker }: { worker: WorkerDetailDto }) {
  const user = useUser();
  const [editing, setEditing] = useState(false);
  const canEdit = EDITABLE.includes(worker.status);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Card>
        <CardHeader
          title="Details"
          action={
            canEdit && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Pencil className="h-4 w-4" aria-hidden />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )
          }
        />
        <DescriptionList
          items={[
            { label: 'Email', value: worker.email },
            { label: 'Job title', value: worker.jobTitle },
            { label: 'Department', value: worker.department ?? '—' },
            { label: 'Country', value: worker.countryName },
            { label: 'Type', value: <StatusBadge status={worker.type} /> },
            { label: 'Status', value: <StatusBadge status={worker.status} /> },
            { label: 'Start date', value: formatDate(worker.startDate) },
            { label: 'End date', value: formatDate(worker.endDate) },
            { label: 'Salary', value: <span className="tabular">{formatSalary(worker)}</span> },
            { label: 'Added', value: formatDate(worker.createdAt) },
          ]}
        />
      </Card>

      <div className="space-y-6">
        <PortalAccessCard worker={worker} />
        {isAdminRole(user) && <StatusActionsCard worker={worker} />}
      </div>

      {editing && <EditWorkerModal worker={worker} onClose={() => setEditing(false)} />}
    </div>
  );
}

// ---------- portal access ----------

function PortalAccessCard({ worker }: { worker: WorkerDetailDto }) {
  const toast = useToast();
  const invite = useCreateWorkerInvite(worker.id);

  const createInvite = async () => {
    try {
      await invite.mutateAsync();
      toast.success('Invite link created');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Card>
      <CardHeader title="Portal access" />
      {worker.hasPortalAccess ? (
        <div className="space-y-2 text-sm text-ink-600">
          <Badge tone="green">Has portal access</Badge>
          <p>{worker.firstName} can sign in to see contracts, payslips, time off and expenses.</p>
        </div>
      ) : (
        <div className="space-y-3 text-sm text-ink-600">
          <Badge>No portal access yet</Badge>
          <p>
            {NO_INVITE.includes(worker.status)
              ? `Invites cannot be created for ${worker.status} workers.`
              : `Create an invite link and send it to ${worker.firstName}. A new link replaces any earlier one.`}
          </p>
          {!NO_INVITE.includes(worker.status) && (
            <Button
              variant="secondary"
              size="sm"
              icon={<KeyRound className="h-4 w-4" aria-hidden />}
              loading={invite.isPending}
              onClick={() => void createInvite()}
            >
              Create invite link
            </Button>
          )}
        </div>
      )}
      {invite.data && (
        <InviteLinkModal
          open
          acceptUrl={invite.data.acceptUrl}
          workerName={fullName(worker)}
          onClose={() => invite.reset()}
        />
      )}
    </Card>
  );
}

// ---------- status changes (admins) ----------

type StatusAction = 'offboard' | 'rescind' | 'terminate' | 'cancel';

function StatusActionsCard({ worker }: { worker: WorkerDetailDto }) {
  const toast = useToast();
  const transition = useTransitionWorker(worker.id);
  const [open, setOpen] = useState<StatusAction | null>(null);
  const name = fullName(worker);

  // Derived from the shared transition table, so the UI can only offer moves the
  // server would accept. `onboarding → active` is deliberately absent: activation
  // happens automatically when the onboarding checklist completes.
  const can = (to: WorkerStatus) => canTransition(WORKER_TRANSITIONS, worker.status, to);
  const available: { action: StatusAction; label: string; danger: boolean }[] = [];
  if (worker.status === 'active' && can('offboarding'))
    available.push({ action: 'offboard', label: 'Start offboarding', danger: false });
  if (worker.status === 'offboarding' && can('active'))
    available.push({ action: 'rescind', label: 'Rescind offboarding', danger: false });
  if (can('terminated'))
    available.push({ action: 'terminate', label: 'Mark terminated', danger: true });
  if (can('cancelled'))
    available.push({ action: 'cancel', label: 'Cancel onboarding', danger: true });

  const run = async (to: WorkerStatus, success: string) => {
    try {
      await transition.mutateAsync({ to });
      toast.success(success);
      setOpen(null);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <Card>
      <CardHeader title="Employment status" />
      <p className="mb-3 text-sm text-ink-600">
        Currently{' '}
        <span className="font-medium text-ink-900">{humanize(worker.status).toLowerCase()}</span>
        {worker.status === 'offboarding' && worker.endDate
          ? `, last working day ${formatDate(worker.endDate)}.`
          : '.'}
      </p>
      {available.length === 0 ? (
        <p className="text-sm text-ink-500">
          {worker.status === 'onboarding'
            ? 'No status changes are available.'
            : 'This is a final status; no further changes are possible.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {available.map((a) => (
            <Button
              key={a.action}
              size="sm"
              variant={a.danger ? 'danger' : 'secondary'}
              onClick={() => setOpen(a.action)}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
      {worker.status === 'onboarding' && (
        <p className="mt-3 text-xs text-ink-500">
          {worker.firstName} becomes active automatically once every onboarding task is complete.
        </p>
      )}

      {open === 'offboard' && <OffboardingModal worker={worker} onClose={() => setOpen(null)} />}
      <ConfirmDialog
        open={open === 'rescind'}
        onClose={() => setOpen(null)}
        onConfirm={() => void run('active', `Offboarding rescinded; ${name} is active again`)}
        title="Rescind offboarding?"
        confirmLabel="Rescind offboarding"
        loading={transition.isPending}
      >
        {name} goes back to active and the planned end date is cleared.
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'terminate'}
        onClose={() => setOpen(null)}
        onConfirm={() => void run('terminated', `${name} has been marked terminated`)}
        title={`Mark ${name} terminated?`}
        confirmLabel="Mark terminated"
        danger
        loading={transition.isPending}
      >
        Their active contract is terminated as well. This cannot be undone.
      </ConfirmDialog>
      <ConfirmDialog
        open={open === 'cancel'}
        onClose={() => setOpen(null)}
        onConfirm={() => void run('cancelled', `Onboarding for ${name} was cancelled`)}
        title={`Cancel onboarding for ${name}?`}
        confirmLabel="Cancel onboarding"
        danger
        loading={transition.isPending}
      >
        Any unsigned or signed contract is voided and unused portal invites are deleted. This cannot
        be undone.
      </ConfirmDialog>
    </Card>
  );
}

function OffboardingModal({ worker, onClose }: { worker: WorkerDetailDto; onClose: () => void }) {
  const toast = useToast();
  const transition = useTransitionWorker(worker.id);
  // `endDate` is optional in the schema (other transitions do not need it), but an
  // empty string is not a valid date, so leaving the field blank fails validation.
  const form = useZodForm(transitionWorkerSchema, { to: 'offboarding', endDate: '', reason: '' });

  const onSubmit = form.handleSubmit(async (data) => {
    if (data.endDate && data.endDate < worker.startDate) {
      form.setFormError(
        `The last working day cannot be before the start date (${formatDate(worker.startDate)}).`,
      );
      return;
    }
    await transition.mutateAsync({
      to: 'offboarding',
      endDate: data.endDate,
      reason: data.reason || undefined,
    });
    toast.success(`Offboarding started for ${fullName(worker)}`);
    onClose();
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Start offboarding ${fullName(worker)}`}
      description="They stay on payroll until their last working day; you can rescind until they are terminated."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="offboarding-form" loading={form.submitting}>
            Start offboarding
          </Button>
        </>
      }
    >
      <form id="offboarding-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Input
          label="Last working day"
          type="date"
          required
          min={worker.startDate}
          {...form.field('endDate')}
          error={form.errors.endDate ? 'Choose the last working day' : undefined}
        />
        <Textarea
          label="Reason"
          hint="Optional. Recorded in the audit log."
          rows={3}
          {...form.field('reason')}
        />
      </form>
    </Modal>
  );
}

// ---------- edit ----------

/** Minor units -> the text a person would type, e.g. 6000000 EUR -> "60000.00". */
function toMajorText(minor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  return (minor / 10 ** digits).toFixed(digits);
}

function EditWorkerModal({ worker, onClose }: { worker: WorkerDetailDto; onClose: () => void }) {
  const toast = useToast();
  const update = useUpdateWorker(worker.id);
  const form = useZodForm(updateWorkerSchema, {
    firstName: worker.firstName,
    lastName: worker.lastName,
    jobTitle: worker.jobTitle,
    department: worker.department ?? '',
    startDate: worker.startDate,
    salaryMinor: worker.salaryMinor,
    payBasis: worker.payBasis,
  });
  const [salaryText, setSalaryText] = useState(() =>
    toMajorText(worker.salaryMinor, worker.currency),
  );
  const startDateLocked = worker.status !== 'onboarding';

  const onSubmit = form.handleSubmit(async (data) => {
    // Send only what changed: the audit log records the changed field names, and an
    // unchanged start date must not trip the "locked once active" rule.
    const changes: UpdateWorkerInput = {};
    if (data.firstName !== undefined && data.firstName !== worker.firstName)
      changes.firstName = data.firstName;
    if (data.lastName !== undefined && data.lastName !== worker.lastName)
      changes.lastName = data.lastName;
    if (data.jobTitle !== undefined && data.jobTitle !== worker.jobTitle)
      changes.jobTitle = data.jobTitle;
    const department = data.department ? data.department : null;
    if (department !== worker.department) changes.department = department;
    if (!startDateLocked && data.startDate !== undefined && data.startDate !== worker.startDate)
      changes.startDate = data.startDate;
    if (data.salaryMinor !== undefined && data.salaryMinor !== worker.salaryMinor)
      changes.salaryMinor = data.salaryMinor;
    if (data.payBasis !== undefined && data.payBasis !== worker.payBasis)
      changes.payBasis = data.payBasis;

    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    await update.mutateAsync(changes);
    toast.success('Changes saved');
    onClose();
  });

  const salaryError = form.errors.salaryMinor
    ? parseMoneyToMinor(salaryText, worker.currency) === null
      ? 'Enter an amount using digits only, e.g. 60000'
      : form.errors.salaryMinor
    : undefined;

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Edit ${fullName(worker)}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="edit-worker-form" loading={form.submitting}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-worker-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="First name" required {...form.field('firstName')} />
          <Input label="Last name" required {...form.field('lastName')} />
          <Input label="Job title" required {...form.field('jobTitle')} />
          <Input label="Department" hint="Optional." {...form.field('department')} />
          <Input
            label={`Salary (${worker.currency})`}
            inputMode="decimal"
            required
            name="salary"
            value={salaryText}
            onChange={(event) => {
              setSalaryText(event.target.value);
              form.setValue(
                'salaryMinor',
                parseMoneyToMinor(event.target.value, worker.currency) ?? 0,
              );
            }}
            error={salaryError}
          />
          <Input
            label="Start date"
            type="date"
            disabled={startDateLocked}
            hint={
              startDateLocked ? 'The start date is locked once the worker is active.' : undefined
            }
            {...form.field('startDate')}
          />
        </div>
        <RadioGroup<PayBasis>
          legend="Salary is"
          value={form.values.payBasis ?? worker.payBasis}
          onChange={(payBasis) => form.setValue('payBasis', payBasis)}
          error={form.errors.payBasis}
          options={[
            { value: 'annual', label: 'Per year' },
            { value: 'monthly', label: 'Per month' },
          ]}
        />
      </form>
    </Modal>
  );
}
