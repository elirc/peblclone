import {
  MAX_DOCUMENT_BYTES,
  type DocumentDto,
  type RequestDocumentInput,
  type ReviewDocumentInput,
  type UploadDocumentInput,
} from '@meridian/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db, type Tx } from '../../db/client';
import { documents, workers } from '../../db/schema';
import { assertCanAccessWorker, isWorker, requireOrgId, type Actor } from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import { logger } from '../../lib/logger';
import { completeOnboardingTask, reopenOnboardingTask } from '../../lib/onboarding';
import * as storage from './storage';

type DocumentRow = typeof documents.$inferSelect;

/** Row -> DTO. `storageKey` and `reviewedBy` are internal and never leave the server. */
function toDocumentDto(row: DocumentRow): DocumentDto {
  return {
    id: row.id,
    workerId: row.workerId,
    kind: row.kind,
    title: row.title,
    status: row.status,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    reviewNote: row.reviewNote,
    uploadedAt: iso(row.uploadedAt),
    reviewedAt: iso(row.reviewedAt),
    createdAt: iso(row.createdAt),
  };
}

/**
 * Lock the worker row. Document writes for one worker queue up behind it, so
 * "is every document verified now?" is answered from committed data — two
 * admins verifying the last two documents at the same moment cannot both see
 * the other's document as still pending and leave the checklist stuck.
 */
async function lockWorker(tx: Tx, orgId: string, workerId: string) {
  const [row] = await tx
    .select({ id: workers.id, status: workers.status })
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.organizationId, orgId)))
    .for('update');
  if (!row) throw notFound('Worker');
  return row;
}

/**
 * Find a document in the actor's tenant. A worker-role actor only "sees" their
 * own documents; anyone else's is a 404, exactly like a missing id.
 */
async function findDocument(actor: Actor, documentId: string): Promise<DocumentRow> {
  const [row] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, requireOrgId(actor))))
    .limit(1);
  if (!row) throw notFound('Document');
  if (isWorker(actor) && actor.workerId !== row.workerId) throw notFound('Document');
  return row;
}

// ---------- list / request ----------

export async function listDocuments(actor: Actor, workerId: string): Promise<DocumentDto[]> {
  assertCanAccessWorker(actor, workerId);
  const orgId = requireOrgId(actor);
  // Distinguish "no documents" (empty list) from "no such worker here" (404).
  const [worker] = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.id, workerId), eq(workers.organizationId, orgId)))
    .limit(1);
  if (!worker) throw notFound('Worker');

  const rows = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workerId, workerId), eq(documents.organizationId, orgId)))
    .orderBy(asc(documents.createdAt), asc(documents.id));
  return rows.map(toDocumentDto);
}

export async function requestDocument(
  actor: Actor,
  workerId: string,
  input: RequestDocumentInput,
): Promise<DocumentDto> {
  const orgId = requireOrgId(actor);
  return db.transaction(async (tx) => {
    const worker = await lockWorker(tx, orgId, workerId);
    const [row] = await tx
      .insert(documents)
      .values({ organizationId: orgId, workerId, kind: input.kind, title: input.title })
      .returning();
    if (!row) throw new Error('Failed to create document');

    // A new outstanding document means "documents verified" is no longer true.
    // After onboarding the checklist is history and stays as it is.
    if (worker.status === 'onboarding') {
      await reopenOnboardingTask(tx, workerId, 'documents_verified');
    }

    await recordAudit(tx, actor, {
      action: 'document.requested',
      entityType: 'document',
      entityId: row.id,
      metadata: { workerId, kind: row.kind },
    });
    return toDocumentDto(row);
  });
}

// ---------- upload / download ----------

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decode strictly: Buffer.from(…, 'base64') silently skips garbage, which hides bugs. */
function decodeBase64(data: string): Buffer {
  const compact = data.replace(/\s+/g, '');
  // Cheap early reject before allocating: 4 base64 chars carry 3 bytes.
  if (Math.floor((compact.length * 3) / 4) - 2 > MAX_DOCUMENT_BYTES) throw tooLarge();
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) {
    throw badRequest('The file data is not valid base64', 'invalid_file');
  }
  return Buffer.from(compact, 'base64');
}

const tooLarge = () =>
  new AppError(
    413,
    'payload_too_large',
    `Files may be at most ${Math.floor(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`,
  );

export async function uploadDocument(
  actor: Actor,
  documentId: string,
  input: UploadDocumentInput,
): Promise<DocumentDto> {
  const orgId = requireOrgId(actor);
  const existing = await findDocument(actor, documentId);
  if (existing.status === 'verified') {
    throw conflict('A verified document cannot be replaced', 'document_locked');
  }

  const bytes = decodeBase64(input.dataBase64);
  if (bytes.length === 0) throw badRequest('The file is empty', 'invalid_file');
  if (bytes.length > MAX_DOCUMENT_BYTES) throw tooLarge();
  if (!storage.matchesMimeType(bytes, input.mimeType)) {
    throw badRequest(`The file is not a valid ${input.mimeType} file`, 'invalid_file');
  }

  // Write the new file BEFORE the transaction: if the disk write fails, the row
  // is untouched. If the transaction then fails, we remove the orphaned file.
  const storageKey = storage.newStorageKey(orgId);
  await storage.saveFile(storageKey, bytes);

  let row: DocumentRow;
  let previousKey: string | null;
  try {
    ({ row, previousKey } = await db.transaction(async (tx) => {
      await lockWorker(tx, orgId, existing.workerId);
      // Re-read under the lock: the document may have been verified (or given
      // another file) since we first looked.
      const [current] = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
        .limit(1);
      if (!current) throw notFound('Document');

      const [updated] = await tx
        .update(documents)
        .set({
          status: 'submitted',
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: bytes.length,
          storageKey,
          uploadedAt: new Date(),
          // A new file is a new submission: the previous review no longer applies.
          reviewNote: null,
          reviewedAt: null,
          reviewedBy: null,
        })
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.organizationId, orgId),
            ne(documents.status, 'verified'),
          ),
        )
        .returning();
      if (!updated) throw conflict('A verified document cannot be replaced', 'document_locked');

      await recordAudit(tx, actor, {
        action: 'document.uploaded',
        entityType: 'document',
        entityId: documentId,
        metadata: {
          workerId: updated.workerId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: bytes.length,
          replaced: current.storageKey !== null,
        },
      });
      return { row: updated, previousKey: current.storageKey };
    }));
  } catch (err) {
    await storage.deleteFile(storageKey).catch((cleanupErr: unknown) => {
      logger.warn({ err: cleanupErr, storageKey }, 'Could not remove orphaned upload');
    });
    throw err;
  }

  // Only after the commit: delete the file being replaced. If this fails we
  // leak a file on disk, which is harmless; deleting it earlier could leave the
  // database pointing at nothing.
  if (previousKey) {
    await storage.deleteFile(previousKey).catch((err: unknown) => {
      logger.warn({ err, storageKey: previousKey }, 'Could not remove replaced document file');
    });
  }
  return toDocumentDto(row);
}

export interface DocumentFile {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

/**
 * Turn a user-supplied file name into something safe for a
 * Content-Disposition header: no quotes, slashes, control or non-ASCII chars.
 */
export function sanitiseFileName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 150);
  return cleaned.length > 0 ? cleaned : 'document';
}

export async function downloadDocument(actor: Actor, documentId: string): Promise<DocumentFile> {
  const row = await findDocument(actor, documentId);
  if (!row.storageKey || !row.mimeType) throw notFound('File');
  const bytes = await storage.loadFile(row.storageKey);
  if (!bytes) {
    logger.error({ documentId, storageKey: row.storageKey }, 'Document file missing from storage');
    throw notFound('File');
  }
  return { bytes, mimeType: row.mimeType, fileName: sanitiseFileName(row.fileName ?? 'document') };
}

// ---------- review ----------

/** Platform admins only (enforced by the route): Meridian verifies identity documents. */
export async function reviewDocument(
  actor: Actor,
  documentId: string,
  input: ReviewDocumentInput,
): Promise<DocumentDto> {
  const orgId = requireOrgId(actor);
  const existing = await findDocument(actor, documentId);

  return db.transaction(async (tx) => {
    await lockWorker(tx, orgId, existing.workerId);

    // Conditional update: only a `submitted` document can be reviewed.
    const [row] = await tx
      .update(documents)
      .set({
        status: input.decision,
        reviewNote: input.note && input.note.length > 0 ? input.note : null,
        reviewedAt: new Date(),
        reviewedBy: actor.userId,
      })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, orgId),
          eq(documents.status, 'submitted'),
        ),
      )
      .returning();
    if (!row) {
      throw conflict('Only a submitted document can be reviewed', 'invalid_transition');
    }

    let checklistCompleted = false;
    if (input.decision === 'verified') {
      const [outstanding] = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.workerId, row.workerId),
            eq(documents.organizationId, orgId),
            ne(documents.status, 'verified'),
          ),
        )
        .limit(1);
      if (!outstanding) {
        const result = await completeOnboardingTask(
          tx,
          row.workerId,
          'documents_verified',
          actor.userId,
        );
        checklistCompleted = result.completed;
      }
    }

    await recordAudit(tx, actor, {
      action: input.decision === 'verified' ? 'document.verified' : 'document.rejected',
      entityType: 'document',
      entityId: row.id,
      metadata: {
        workerId: row.workerId,
        kind: row.kind,
        ...(row.reviewNote && { note: row.reviewNote }),
        ...(checklistCompleted && { documentsVerifiedCompleted: true }),
      },
    });
    return toDocumentDto(row);
  });
}
