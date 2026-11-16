import {
  CONTRACT_STATUSES,
  createContractSchema,
  type ContractDto,
  type ContractStatus,
} from '@meridian/shared';
import { FileSignature, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useContracts, useCreateContract } from '../../api/contracts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Table,
  type Column,
} from '../../components/ui';
import { isWorkerRole, useUser } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { formatDate, humanize } from '../../lib/format';
import { topLevelError } from './form-helpers';
import { WorkerPicker } from './WorkerPicker';

const PAGE_SIZE = 25;

/** Workers never see drafts or void contracts (the API hides them), so neither does the filter. */
const WORKER_VISIBLE_STATUSES = CONTRACT_STATUSES.filter((s) => s !== 'draft' && s !== 'void');

export default function ContractsPage() {
  const user = useUser();
  const isWorker = isWorkerRole(user);
  const navigate = useNavigate();
  const [status, setStatus] = useState<ContractStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);

  const contracts = useContracts({ status: status || undefined, limit: PAGE_SIZE, offset });

  const columns: Column<ContractDto>[] = [
    ...(isWorker
      ? []
      : [{ key: 'worker', header: 'Worker', cell: (c: ContractDto) => c.workerName }]),
    {
      key: 'title',
      header: 'Title',
      cell: (c) => <span className="font-medium text-ink-900">{c.title}</span>,
    },
    { key: 'status', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
    { key: 'sent', header: 'Sent', cell: (c) => formatDate(c.sentAt) },
    { key: 'signed', header: 'Signed', cell: (c) => formatDate(c.signedAt) },
  ];

  const statusOptions = isWorker ? WORKER_VISIBLE_STATUSES : CONTRACT_STATUSES;

  return (
    <>
      <PageHeader
        title={isWorker ? 'My agreement' : 'Contracts'}
        description={
          isWorker
            ? 'Your employment or contractor agreement.'
            : 'Generate, send and countersign employment and contractor agreements.'
        }
        actions={
          !isWorker && (
            <Button
              icon={<Plus className="h-4 w-4" aria-hidden />}
              onClick={() => setCreating(true)}
            >
              New contract
            </Button>
          )
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-ink-200 p-4">
          <div className="w-full sm:w-56">
            <Select
              label="Status"
              value={status}
              onChange={(event) => {
                const next = statusOptions.find((s) => s === event.target.value);
                setStatus(next ?? '');
                setOffset(0);
              }}
            >
              <option value="">All statuses</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {contracts.isLoading ? (
          <Loading />
        ) : contracts.isError ? (
          <div className="px-4">
            <ErrorState error={contracts.error} onRetry={() => void contracts.refetch()} />
          </div>
        ) : contracts.data ? (
          <>
            <Table
              caption={isWorker ? 'Your agreements' : 'Contracts'}
              columns={columns}
              rows={contracts.data.items}
              rowKey={(c) => c.id}
              onRowClick={(c) => navigate(`/contracts/${c.id}`)}
              empty={
                status ? (
                  <EmptyState
                    title="No contracts with this status"
                    description="Try another status filter."
                    action={
                      <Button variant="secondary" onClick={() => setStatus('')}>
                        Show all
                      </Button>
                    }
                  />
                ) : isWorker ? (
                  <EmptyState
                    icon={<FileSignature className="h-6 w-6" aria-hidden />}
                    title="No agreement yet"
                    description="Your employer has not sent you an agreement yet. It will appear here as soon as they do, ready for you to review and sign."
                  />
                ) : (
                  <EmptyState
                    icon={<FileSignature className="h-6 w-6" aria-hidden />}
                    title="No contracts yet"
                    description="Generate an agreement for a worker from their country's template, then send it for signature."
                    action={<Button onClick={() => setCreating(true)}>New contract</Button>}
                  />
                )
              }
            />
            <Pagination
              total={contracts.data.total}
              limit={contracts.data.limit}
              offset={contracts.data.offset}
              onChange={setOffset}
            />
          </>
        ) : null}
      </Card>

      {!isWorker && creating && (
        <NewContractModal
          onClose={() => setCreating(false)}
          onCreated={(id) => navigate(`/contracts/${id}`)}
        />
      )}
    </>
  );
}

function NewContractModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const create = useCreateContract();
  const form = useZodForm(createContractSchema, { workerId: '' });

  // Errors such as `409 contract_exists` / `worker_not_eligible` arrive without
  // field details, so they surface as the form error with the server's message.
  const onSubmit = form.handleSubmit(async (data) => {
    const contract = await create.mutateAsync(data);
    onCreated(contract.id);
  });

  const alert = topLevelError(form);
  return (
    <Modal
      open
      onClose={onClose}
      title="New contract"
      description="The agreement is generated from the worker's details and their country's rules. You can edit it before sending."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="new-contract-form" loading={form.submitting}>
            Generate contract
          </Button>
        </>
      }
    >
      <form id="new-contract-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {alert && <Alert tone="error">{alert}</Alert>}
        <WorkerPicker
          value={form.values.workerId}
          // Only onboarding/active workers can receive a contract (else 409 worker_not_eligible).
          statuses={['onboarding', 'active']}
          error={form.errors.workerId ? 'Choose a worker' : undefined}
          onChange={(id) => form.setValue('workerId', id)}
        />
      </form>
    </Modal>
  );
}
