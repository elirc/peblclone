import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_KINDS,
  MAX_DOCUMENT_BYTES,
  requestDocumentSchema,
  reviewDocumentSchema,
  type DocumentDto,
  type DocumentKind,
  type WorkerDetailDto,
} from '@meridian/shared';
import { Download, FilePlus, FileText, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  downloadDocument,
  useRequestDocument,
  useReviewDocument,
  useUploadDocument,
  useWorkerDocuments,
} from '../../api/workers';
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
  Modal,
  Select,
  StatusBadge,
  Table,
  Textarea,
  useToast,
  type Column,
} from '../../components/ui';
import { fileToBase64 } from '../../lib/api';
import { isPlatformAdminRole, useUser } from '../../lib/auth';
import { useZodForm } from '../../lib/form';
import { formatBytes, formatDate, fullName } from '../../lib/format';

type AllowedMime = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];
const isAllowedMime = (type: string): type is AllowedMime =>
  (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(type);

/** Rejecting requires a note in the UI, so the worker knows what to fix. */
const rejectSchema = reviewDocumentSchema.refine(
  (v) => v.decision !== 'rejected' || Boolean(v.note),
  {
    message: 'Tell the worker what needs fixing',
    path: ['note'],
  },
);

export function DocumentsTab({ worker }: { worker: WorkerDetailDto }) {
  const user = useUser();
  const toast = useToast();
  const documents = useWorkerDocuments(worker.id);
  const review = useReviewDocument();
  const [requesting, setRequesting] = useState(false);
  const [verifying, setVerifying] = useState<DocumentDto | null>(null);
  const [rejecting, setRejecting] = useState<DocumentDto | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const isPlatformAdmin = isPlatformAdminRole(user);

  const download = async (doc: DocumentDto) => {
    setDownloadingId(doc.id);
    try {
      await downloadDocument(doc);
    } catch (err) {
      toast.error(err);
    } finally {
      setDownloadingId(null);
    }
  };

  const verify = async (doc: DocumentDto) => {
    try {
      await review.mutateAsync({ documentId: doc.id, decision: 'verified' });
      toast.success(`${doc.title} verified`);
      setVerifying(null);
    } catch (err) {
      toast.error(err);
    }
  };

  const columns: Column<DocumentDto>[] = [
    {
      key: 'document',
      header: 'Document',
      cell: (d) => (
        <div className="min-w-0">
          <p className="font-medium text-ink-900">{d.title}</p>
          <p className="text-xs text-ink-500">{DOCUMENT_KIND_LABELS[d.kind]}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
    {
      key: 'file',
      header: 'File',
      cell: (d) =>
        d.fileName ? (
          <div className="min-w-0">
            <p className="max-w-[14rem] truncate text-ink-800" title={d.fileName}>
              {d.fileName}
            </p>
            <p className="text-xs text-ink-500">
              {formatBytes(d.sizeBytes)} · uploaded {formatDate(d.uploadedAt)}
            </p>
          </div>
        ) : (
          <span className="text-ink-500">Not uploaded</span>
        ),
    },
    {
      key: 'note',
      header: 'Review note',
      cell: (d) => (d.reviewNote ? <span className="text-ink-700">{d.reviewNote}</span> : '—'),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (d) => (
        <div className="flex flex-wrap justify-end gap-2">
          {d.status !== 'verified' && <UploadButton document={d} />}
          {d.fileName && (
            <Button
              size="sm"
              variant="ghost"
              icon={<Download className="h-4 w-4" aria-hidden />}
              loading={downloadingId === d.id}
              onClick={() => void download(d)}
              aria-label={`Download ${d.title}`}
            >
              Download
            </Button>
          )}
          {isPlatformAdmin && d.status === 'submitted' && (
            <>
              <Button size="sm" onClick={() => setVerifying(d)} aria-label={`Verify ${d.title}`}>
                Verify
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => setRejecting(d)}
                aria-label={`Reject ${d.title}`}
              >
                Reject
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card padded={false}>
      <div className="p-5 pb-0 sm:p-6 sm:pb-0">
        <CardHeader
          title="Documents"
          description="PDF, PNG or JPEG, up to 5 MB each. Meridian verifies every document."
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={<FilePlus className="h-4 w-4" aria-hidden />}
              onClick={() => setRequesting(true)}
            >
              Request a document
            </Button>
          }
        />
      </div>

      {documents.isPending ? (
        <Loading />
      ) : documents.isError ? (
        <div className="px-5">
          <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
        </div>
      ) : documents.data.items.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" aria-hidden />}
          title="No documents requested"
          description={`Request a document from ${worker.firstName}, such as a passport or tax form.`}
          action={
            <Button variant="secondary" onClick={() => setRequesting(true)}>
              Request a document
            </Button>
          }
        />
      ) : (
        <Table
          caption={`Documents for ${fullName(worker)}`}
          columns={columns}
          rows={documents.data.items}
          rowKey={(d) => d.id}
        />
      )}

      {requesting && <RequestDocumentModal worker={worker} onClose={() => setRequesting(false)} />}
      {rejecting && <RejectDocumentModal document={rejecting} onClose={() => setRejecting(null)} />}
      <ConfirmDialog
        open={verifying !== null}
        onClose={() => setVerifying(null)}
        onConfirm={() => verifying && void verify(verifying)}
        title={`Verify ${verifying?.title ?? 'document'}?`}
        confirmLabel="Verify"
        loading={review.isPending}
      >
        Confirm that you have checked the file and it is valid. A verified document can no longer be
        replaced.
      </ConfirmDialog>
    </Card>
  );
}

/** A button that opens the file picker, checks the file in the browser, then uploads it. */
function UploadButton({ document }: { document: DocumentDto }) {
  const toast = useToast();
  const upload = useUploadDocument();
  const inputRef = useRef<HTMLInputElement>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    // The server enforces both rules too; checking here saves a slow upload that would fail.
    if (!isAllowedMime(file.type)) {
      toast.error('Upload a PDF, PNG or JPEG file.');
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      toast.error(
        `"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_DOCUMENT_BYTES)}.`,
      );
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      await upload.mutateAsync({
        documentId: document.id,
        fileName: file.name,
        mimeType: file.type,
        dataBase64,
      });
      toast.success(`${document.title} uploaded`);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_DOCUMENT_MIME_TYPES.join(',')}
        className="sr-only"
        tabIndex={-1}
        aria-label={`File for ${document.title}`}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so choosing the same file again still fires a change event.
          event.target.value = '';
          void onFile(file);
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        icon={<Upload className="h-4 w-4" aria-hidden />}
        loading={upload.isPending}
        onClick={() => inputRef.current?.click()}
        aria-label={`${document.fileName ? 'Replace file for' : 'Upload'} ${document.title}`}
      >
        {document.fileName ? 'Replace' : 'Upload'}
      </Button>
    </>
  );
}

function RequestDocumentModal({
  worker,
  onClose,
}: {
  worker: WorkerDetailDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const request = useRequestDocument(worker.id);
  const form = useZodForm(requestDocumentSchema, {
    kind: 'passport',
    title: DOCUMENT_KIND_LABELS.passport,
  });

  const onKindChange = (kind: DocumentKind) => {
    // Keep the title in step with the kind until the user writes their own title.
    const titleIsDefault = (Object.values(DOCUMENT_KIND_LABELS) as string[]).includes(
      form.values.title,
    );
    form.setValue('kind', kind);
    if (titleIsDefault || form.values.title.trim() === '')
      form.setValue('title', DOCUMENT_KIND_LABELS[kind]);
  };

  const onSubmit = form.handleSubmit(async (data) => {
    await request.mutateAsync(data);
    toast.success(`${data.title} requested from ${worker.firstName}`);
    onClose();
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Request a document"
      description={
        worker.status === 'onboarding'
          ? `${worker.firstName}'s "documents verified" onboarding task re-opens until this one is verified.`
          : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button type="submit" form="request-document-form" loading={form.submitting}>
            Request
          </Button>
        </>
      }
    >
      <form id="request-document-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Select
          label="Kind"
          value={form.values.kind}
          onChange={(event) => {
            const kind = DOCUMENT_KINDS.find((k) => k === event.target.value);
            if (kind) onKindChange(kind);
          }}
          error={form.errors.kind}
        >
          {DOCUMENT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {DOCUMENT_KIND_LABELS[kind]}
            </option>
          ))}
        </Select>
        <Input label="Title" required {...form.field('title')} />
      </form>
    </Modal>
  );
}

function RejectDocumentModal({
  document,
  onClose,
}: {
  document: DocumentDto;
  onClose: () => void;
}) {
  const toast = useToast();
  const review = useReviewDocument();
  const form = useZodForm(rejectSchema, { decision: 'rejected', note: '' });

  const onSubmit = form.handleSubmit(async (data) => {
    await review.mutateAsync({ documentId: document.id, decision: 'rejected', note: data.note });
    toast.success(`${document.title} rejected`);
    onClose();
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Reject ${document.title}?`}
      description="The worker sees your note and can upload a new file."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={form.submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            form="reject-document-form"
            loading={form.submitting}
          >
            Reject document
          </Button>
        </>
      }
    >
      <form id="reject-document-form" onSubmit={onSubmit} className="space-y-4" noValidate>
        {form.formError && <Alert tone="error">{form.formError}</Alert>}
        <Textarea label="What needs fixing?" required rows={3} {...form.field('note')} />
      </form>
    </Modal>
  );
}
