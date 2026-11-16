import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  type DocumentDto,
  type UploadDocumentInput,
} from '@meridian/shared';
import { Download, FileText, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { downloadDocument, useUploadDocument, useWorkerDocuments } from '../../api/portal';
import {
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  Loading,
  StatusBadge,
  useToast,
} from '../../components/ui';
import { fileToBase64 } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';

function isAllowedMime(type: string): type is UploadDocumentInput['mimeType'] {
  return ALLOWED_DOCUMENT_MIME_TYPES.some((allowed) => allowed === type);
}

const STATUS_HELP: Record<DocumentDto['status'], string> = {
  requested: 'Please upload this document.',
  submitted: 'Uploaded — waiting for review.',
  verified: 'Verified. No further action needed.',
  rejected: 'Not accepted. Please upload a new file.',
};

/** The worker's requested documents, with upload / replace / download. */
export function DocumentsCard({ workerId }: { workerId: string }) {
  const documents = useWorkerDocuments(workerId);

  return (
    <Card padded={false}>
      <div id="documents" className="scroll-mt-6 px-5 pt-5 sm:px-6 sm:pt-6">
        <CardHeader
          title="Your documents"
          description="PDF, PNG or JPEG, up to 5 MB each. Your employer and Meridian review each upload."
        />
      </div>
      {documents.isLoading ? (
        <Loading label="Loading documents…" />
      ) : documents.isError || !documents.data ? (
        <div className="px-5 sm:px-6">
          <ErrorState error={documents.error} onRetry={() => void documents.refetch()} />
        </div>
      ) : documents.data.items.length === 0 ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" aria-hidden />}
          title="No documents requested"
          description="If your employer needs a document from you, it will appear here."
        />
      ) : (
        <ul className="divide-y divide-ink-100 border-t border-ink-200">
          {documents.data.items.map((doc) => (
            <DocumentRow key={doc.id} doc={doc} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function DocumentRow({ doc }: { doc: DocumentDto }) {
  const toast = useToast();
  const upload = useUploadDocument();
  const input = useRef<HTMLInputElement>(null);
  const [downloading, setDownloading] = useState(false);
  const canUpload = doc.status !== 'verified'; // verified files are locked (409 document_locked)

  async function onFile(file: File | undefined) {
    if (!file) return;
    // Checked here for instant feedback; the server checks size AND the file's real bytes.
    if (!isAllowedMime(file.type)) {
      toast.error('Please choose a PDF, PNG or JPEG file.');
      return;
    }
    if (file.size > MAX_DOCUMENT_BYTES) {
      toast.error(
        `That file is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_DOCUMENT_BYTES)}.`,
      );
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      await upload.mutateAsync({
        id: doc.id,
        input: { fileName: file.name, mimeType: file.type, dataBase64 },
      });
      toast.success(`${doc.title} uploaded`);
    } catch (err) {
      toast.error(err);
    }
  }

  async function onDownload() {
    setDownloading(true);
    try {
      await downloadDocument(doc);
    } catch (err) {
      toast.error(err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-ink-900">{doc.title}</p>
          <StatusBadge status={doc.status} />
        </div>
        <p className="mt-1 text-sm text-ink-500">{STATUS_HELP[doc.status]}</p>
        {doc.fileName && (
          <p className="mt-1 break-all text-xs text-ink-500">
            {doc.fileName} · {formatBytes(doc.sizeBytes)} · uploaded {formatDate(doc.uploadedAt)}
          </p>
        )}
        {doc.status === 'rejected' && doc.reviewNote && (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
            <span className="font-medium">Reviewer note:</span> {doc.reviewNote}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {doc.fileName && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Download className="h-4 w-4" aria-hidden />}
            loading={downloading}
            onClick={() => void onDownload()}
            aria-label={`Download ${doc.title}`}
          >
            Download
          </Button>
        )}
        {canUpload && (
          <>
            <input
              ref={input}
              type="file"
              hidden
              accept={ALLOWED_DOCUMENT_MIME_TYPES.join(',')}
              aria-label={`Choose a file for ${doc.title}`}
              onChange={(event) => {
                void onFile(event.target.files?.[0]);
                event.target.value = ''; // allow choosing the same file again after a failure
              }}
            />
            <Button
              size="sm"
              variant={doc.fileName ? 'secondary' : 'primary'}
              icon={<Upload className="h-4 w-4" aria-hidden />}
              loading={upload.isPending}
              onClick={() => input.current?.click()}
              aria-label={`${doc.fileName ? 'Replace' : 'Upload'} ${doc.title}`}
            >
              {doc.fileName ? 'Replace' : 'Upload'}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
