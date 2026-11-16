import {
  CONTRACT_TRANSITIONS,
  canTransition,
  signContractSchema,
  updateContractSchema,
  type ContractDetailDto,
} from '@meridian/shared';
import { CheckCircle2, Circle } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { z } from 'zod';
import {
  useActivateContract,
  useContract,
  useRecallContract,
  useSendContract,
  useSignContract,
  useTerminateContract,
  useUpdateContract,
  useVoidContract,
} from '../../api/contracts';
import {
  Alert,
  Button,
  Card,
  CardHeader,
  Checkbox,
  ConfirmDialog,
  DescriptionList,
  ErrorState,
  Input,
  Loading,
  Modal,
  PageHeader,
  StatusBadge,
  Textarea,
  useToast,
} from '../../components/ui';
import { isAdminRole, isStaffRole, isWorkerRole, useUser } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { formatDate, formatDateTime, formatMoney, humanize } from '../../lib/format';
import { rethrowOnField, topLevelError } from './form-helpers';

type ConfirmAction = 'activate' | 'void' | 'terminate';

export default function ContractDetailPage() {
  const { id = '' } = useParams();
  const user = useUser();
  const contract = useContract(id);
  const isWorker = isWorkerRole(user);
  const back = { to: '/contracts', label: isWorker ? 'My agreement' : 'Contracts' };

  if (contract.isLoading) return <Loading />;
  if (contract.isError || !contract.data) {
    return (
      <>
        <PageHeader title="Contract" back={back} />
        <ErrorState error={contract.error} onRetry={() => void contract.refetch()} />
      </>
    );
  }
  return <ContractView contract={contract.data} back={back} />;
}

function ContractView({
  contract,
  back,
}: {
  contract: ContractDetailDto;
  back: { to: string; label: string };
}) {
  const user = useUser();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  const send = useSendContract(contract.id);
  const recall = useRecallContract(contract.id);
  const activate = useActivateContract(contract.id);
  const voidContract = useVoidContract(contract.id);
  const terminate = useTerminateContract(contract.id);

  const staff = isStaffRole(user);
  const admin = isAdminRole(user);
  const worker = isWorkerRole(user);
  const { status } = contract;
  const can = (to: typeof status) => canTransition(CONTRACT_TRANSITIONS, status, to);

  // What this person may do right now. Status rules come from the shared transition
  // table so the UI can never offer a move the server would refuse; role rules mirror
  // the contract (the server enforces both regardless).
  const actions = {
    edit: staff && status === 'draft',
    send: staff && status === 'draft' && can('sent'),
    recall: staff && status === 'sent' && can('draft'),
    sign: worker && can('signed'),
    activate: admin && can('active'),
    void: admin && can('void'),
    terminate: admin && can('terminated'),
  };

  async function run(action: { mutateAsync: () => Promise<unknown> }, success: string) {
    try {
      await action.mutateAsync();
      toast.success(success);
      setConfirm(null);
    } catch (err) {
      toast.error(err);
    }
  }

  const confirmConfig: Record<
    ConfirmAction,
    {
      title: string;
      label: string;
      danger: boolean;
      body: string;
      onConfirm: () => void;
      loading: boolean;
    }
  > = {
    activate: {
      title: 'Countersign and activate?',
      label: 'Activate contract',
      danger: false,
      body: `This countersigns the agreement on behalf of the employer and makes it the active contract for ${contract.workerName}.`,
      onConfirm: () => void run(activate, 'Contract activated'),
      loading: activate.isPending,
    },
    void: {
      title: 'Void this contract?',
      label: 'Void contract',
      danger: true,
      body:
        status === 'signed'
          ? 'The signed agreement will be cancelled and cannot be restored. If the worker is still onboarding, they will need to sign a new contract.'
          : 'The agreement will be cancelled and cannot be restored. You can generate a new one afterwards.',
      onConfirm: () => void run(voidContract, 'Contract voided'),
      loading: voidContract.isPending,
    },
    terminate: {
      title: 'Terminate this contract?',
      label: 'Terminate contract',
      danger: true,
      body: `This ends the active agreement with ${contract.workerName}. It cannot be undone.`,
      onConfirm: () => void run(terminate, 'Contract terminated'),
      loading: terminate.isPending,
    },
  };
  const confirming = confirm ? confirmConfig[confirm] : null;

  return (
    <>
      <PageHeader
        back={back}
        title={contract.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={status} />
            <span>{contract.workerName}</span>
          </span>
        }
        actions={
          <>
            {actions.edit && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {actions.send && (
              <Button
                loading={send.isPending}
                onClick={() => void run(send, 'Contract sent to the worker')}
              >
                Send to worker
              </Button>
            )}
            {actions.recall && (
              <Button
                variant="secondary"
                loading={recall.isPending}
                onClick={() => void run(recall, 'Contract recalled to draft')}
              >
                Recall
              </Button>
            )}
            {actions.activate && <Button onClick={() => setConfirm('activate')}>Activate</Button>}
            {actions.terminate && (
              <Button variant="danger" onClick={() => setConfirm('terminate')}>
                Terminate
              </Button>
            )}
            {actions.void && (
              <Button variant="danger" onClick={() => setConfirm('void')}>
                Void
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {actions.sign && <SignContractCard contract={contract} />}
          {worker && (status === 'signed' || status === 'active') && (
            <Alert tone="success" title="You signed this agreement">
              Signed as {contract.signedByName ?? '—'} on {formatDateTime(contract.signedAt)}.{' '}
              {status === 'signed'
                ? 'Your employer will countersign it next.'
                : 'Your employer has countersigned it; it is now in force.'}
            </Alert>
          )}
          {staff && status === 'draft' && (
            <Alert tone="info">This is a draft. The worker cannot see it until you send it.</Alert>
          )}

          <Card>
            <CardHeader title="Agreement" />
            <div className="max-h-[70vh] overflow-y-auto rounded-lg border border-ink-200 bg-ink-50 px-5 py-6 sm:px-8">
              <div className="mx-auto max-w-prose whitespace-pre-wrap break-words font-serif text-sm leading-relaxed text-ink-900">
                {contract.body}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <TermsCard contract={contract} />
          <TimelineCard contract={contract} />
        </div>
      </div>

      {editing && <EditContractModal contract={contract} onClose={() => setEditing(false)} />}

      {confirming && (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          onConfirm={confirming.onConfirm}
          title={confirming.title}
          confirmLabel={confirming.label}
          danger={confirming.danger}
          loading={confirming.loading}
        >
          {confirming.body}
        </ConfirmDialog>
      )}
    </>
  );
}

function TermsCard({ contract }: { contract: ContractDetailDto }) {
  const { terms } = contract;
  const days = (n: number) => (n === 0 ? 'None' : `${n} day${n === 1 ? '' : 's'}`);
  return (
    <Card>
      <CardHeader
        title="Key terms"
        description="Snapshot taken when the agreement was generated."
      />
      <DescriptionList
        items={[
          {
            label: 'Salary',
            value: `${formatMoney(terms.salaryMinor, terms.currency)} per ${
              terms.payBasis === 'annual' ? 'year' : 'month'
            }`,
          },
          { label: 'Start date', value: formatDate(terms.startDate) },
          { label: 'Role', value: terms.jobTitle },
          { label: 'Type', value: humanize(terms.workerType) },
          { label: 'Country', value: terms.countryName },
          { label: 'Annual leave', value: days(terms.annualLeaveDays) },
          { label: 'Notice period', value: days(terms.noticePeriodDays) },
          { label: 'Probation', value: days(terms.probationDays) },
        ]}
      />
    </Card>
  );
}

function TimelineCard({ contract }: { contract: ContractDetailDto }) {
  const steps: { label: string; at: string | null; detail?: string }[] = [
    { label: 'Generated', at: contract.createdAt },
    { label: 'Sent to worker', at: contract.sentAt },
    {
      label: 'Signed by worker',
      at: contract.signedAt,
      detail: contract.signedByName ? `as ${contract.signedByName}` : undefined,
    },
    { label: 'Activated', at: contract.activatedAt },
  ];
  if (contract.terminatedAt || contract.status === 'terminated') {
    steps.push({ label: 'Terminated', at: contract.terminatedAt });
  }
  return (
    <Card>
      <CardHeader title="Timeline" />
      <ol className="space-y-4">
        {steps.map((step) => (
          <li key={step.label} className="flex gap-3">
            {step.at ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
            ) : (
              <Circle className="mt-0.5 h-4 w-4 shrink-0 text-ink-300" aria-hidden />
            )}
            <div className="min-w-0 text-sm">
              <p className={step.at ? 'font-medium text-ink-900' : 'text-ink-500'}>{step.label}</p>
              <p className="text-ink-500">
                {step.at ? formatDateTime(step.at) : 'Not yet'}
                {step.at && step.detail ? ` · ${step.detail}` : ''}
              </p>
            </div>
          </li>
        ))}
        {contract.status === 'void' && (
          <li className="flex gap-3 text-sm">
            <Circle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-hidden />
            <p className="font-medium text-ink-900">Voided — this agreement is no longer valid</p>
          </li>
        )}
      </ol>
    </Card>
  );
}

function EditContractModal({
  contract,
  onClose,
}: {
  contract: ContractDetailDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const update = useUpdateContract(contract.id);
  // The form starts from the current text; it is form INPUT, not a copy of server state.
  const form = useZodForm(updateContractSchema, { title: contract.title, body: contract.body });

  const onSubmit = form.handleSubmit(async (data) => {
    await update.mutateAsync(data);
    toast.success('Contract updated');
    onClose();
  });

  const alert = topLevelError(form);
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title="Edit contract"
      description="Drafts can be edited freely until they are sent."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="edit-contract-form" loading={form.submitting}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-contract-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        <Input label="Title" required {...form.field('title')} />
        <Textarea
          label="Agreement text"
          rows={18}
          className="font-mono"
          required
          {...form.field('body')}
        />
      </form>
    </Modal>
  );
}

/**
 * The API wants `agree: true` (a literal), but a checkbox starts unticked, so the
 * form holds a boolean and refuses to submit until it is true.
 */
const signFormSchema = signContractSchema.extend({
  agree: z.boolean().refine((v) => v, 'Please confirm you have read and agree to the agreement'),
});

function SignContractCard({ contract }: { contract: ContractDetailDto }) {
  const toast = useToast();
  const sign = useSignContract(contract.id);
  const form = useZodForm(signFormSchema, { signedByName: '', agree: false });

  const onSubmit = form.handleSubmit(async (data) => {
    try {
      await sign.mutateAsync({ signedByName: data.signedByName, agree: true });
    } catch (err) {
      rethrowOnField(err, { signature_mismatch: 'signedByName' });
    }
    toast.success('Agreement signed');
  });

  const alert = topLevelError(form);
  return (
    <Card className="border-brand-200">
      <CardHeader
        title="Review and sign"
        description="Read the agreement below. To sign, type your full legal name and confirm."
      />
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        <Input
          label="Full legal name"
          autoComplete="name"
          required
          hint={`Type it exactly as it appears in the agreement: ${contract.terms.workerName}`}
          {...form.field('signedByName')}
        />
        <div>
          <Checkbox
            label="I have read and agree to this agreement"
            checked={form.values.agree}
            onChange={(event) => form.setValue('agree', event.target.checked)}
            aria-invalid={form.errors.agree ? true : undefined}
          />
          {form.errors.agree && (
            <p role="alert" className="mt-1.5 text-sm text-red-600">
              {form.errors.agree}
            </p>
          )}
        </div>
        <Button type="submit" loading={form.submitting}>
          Sign agreement
        </Button>
      </form>
    </Card>
  );
}
