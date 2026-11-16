import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { MAX_DOCUMENT_BYTES, type DocumentKind } from '@meridian/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../config';
import { db } from '../../db/client';
import { auditLogs, documents, onboardingTasks, workers } from '../../db/schema';
import {
  createManager,
  createPlatformAdmin,
  createTenant,
  createWorker,
  loginAsWorker,
  type TestClient,
  type WorkerRow,
} from '../../test/helpers';

// ---------- fixtures ----------

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n');
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);

const pdfUpload = (fileName = 'passport.pdf', bytes: Buffer = PDF) => ({
  fileName,
  mimeType: 'application/pdf',
  dataBase64: bytes.toString('base64'),
});

/** Uploaded files outlive the per-test TRUNCATE; remove every org folder we created. */
const orgsWithFiles = new Set<string>();
afterAll(async () => {
  for (const orgId of orgsWithFiles) {
    await rm(path.join(config.storageDir, orgId), { recursive: true, force: true });
  }
});

async function tenant() {
  const t = await createTenant();
  orgsWithFiles.add(t.org.id);
  return t;
}

/** An onboarding worker with the standard checklist. */
const onboardingWorker = (orgId: string, overrides: Partial<typeof workers.$inferInsert> = {}) =>
  createWorker(orgId, { status: 'onboarding', ...overrides }, { withTasks: true });

async function insertDocument(
  worker: WorkerRow,
  overrides: Partial<typeof documents.$inferInsert> = {},
) {
  const [row] = await db
    .insert(documents)
    .values({
      organizationId: worker.organizationId,
      workerId: worker.id,
      kind: 'passport' as DocumentKind,
      title: 'Passport',
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('document insert failed');
  return row;
}

async function reload(documentId: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!row) throw new Error('document vanished');
  return row;
}

async function taskStatus(workerId: string, key: string) {
  const [task] = await db
    .select({ status: onboardingTasks.status })
    .from(onboardingTasks)
    .where(and(eq(onboardingTasks.workerId, workerId), eq(onboardingTasks.key, key)));
  return task?.status;
}

const auditsFor = (action: string) =>
  db.select().from(auditLogs).where(eq(auditLogs.action, action));

const download = (c: TestClient, documentId: string) =>
  c.get(`/documents/${documentId}/file`).responseType('blob');

const storagePath = (key: string) => path.join(config.storageDir, key);

// ---------- list ----------

describe('GET /workers/:id/documents', () => {
  it('lists a worker’s documents for staff and for the worker themselves', async () => {
    const { org, admin } = await tenant();
    const manager = await createManager(org.id);
    const worker = await onboardingWorker(org.id);
    await insertDocument(worker, { kind: 'passport', title: 'Passport' });
    await insertDocument(worker, { kind: 'tax_form', title: 'Tax form' });
    const me = await loginAsWorker(worker);

    for (const c of [admin, manager.client, me.client]) {
      const res = await c.get(`/workers/${worker.id}/documents`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
    }
    const res = await admin.get(`/workers/${worker.id}/documents`);
    expect(Object.keys(res.body.items[0]).sort()).toEqual([
      'createdAt',
      'fileName',
      'id',
      'kind',
      'mimeType',
      'reviewNote',
      'reviewedAt',
      'sizeBytes',
      'status',
      'title',
      'uploadedAt',
      'workerId',
    ]);
  });

  it('answers 404 to a worker asking for a colleague’s documents', async () => {
    const { org } = await tenant();
    const mine = await onboardingWorker(org.id);
    const colleague = await onboardingWorker(org.id);
    await insertDocument(colleague);
    const me = await loginAsWorker(mine);
    expect((await me.client.get(`/workers/${colleague.id}/documents`)).status).toBe(404);
  });

  it('answers 404 for another organization’s worker or an unknown worker', async () => {
    const a = await tenant();
    const b = await tenant();
    const foreign = await onboardingWorker(b.org.id);
    await insertDocument(foreign);
    expect((await a.admin.get(`/workers/${foreign.id}/documents`)).status).toBe(404);
    expect(
      (await a.admin.get('/workers/00000000-0000-4000-8000-000000000000/documents')).status,
    ).toBe(404);
  });
});

// ---------- request ----------

describe('POST /workers/:id/documents', () => {
  it('requests a document (201) and re-opens documents_verified for an onboarding worker', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(
        and(eq(onboardingTasks.workerId, worker.id), eq(onboardingTasks.key, 'documents_verified')),
      );

    const res = await admin
      .post(`/workers/${worker.id}/documents`)
      .send({ kind: 'work_permit', title: 'Work permit (EU Blue Card)' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workerId: worker.id,
      kind: 'work_permit',
      title: 'Work permit (EU Blue Card)',
      status: 'requested',
      fileName: null,
    });
    expect(await taskStatus(worker.id, 'documents_verified')).toBe('pending');
    const [audit] = await auditsFor('document.requested');
    expect(audit).toMatchObject({ entityId: res.body.id, organizationId: org.id });
  });

  it('leaves the checklist alone once the worker is active', async () => {
    const { org, admin } = await tenant();
    const worker = await createWorker(org.id, {}, { withTasks: true });
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(onboardingTasks.workerId, worker.id));

    const res = await admin
      .post(`/workers/${worker.id}/documents`)
      .send({ kind: 'other', title: 'Visa' });
    expect(res.status).toBe(201);
    expect(await taskStatus(worker.id, 'documents_verified')).toBe('completed');
  });

  it('validates the body', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    const res = await admin
      .post(`/workers/${worker.id}/documents`)
      .send({ kind: 'selfie', title: '' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details).sort()).toEqual(['kind', 'title']);
  });

  it('is staff-only and tenant-scoped', async () => {
    const a = await tenant();
    const b = await tenant();
    const worker = await onboardingWorker(a.org.id);
    const foreign = await onboardingWorker(b.org.id);
    const me = await loginAsWorker(worker);
    const manager = await createManager(a.org.id);
    const body = { kind: 'other', title: 'Diploma' };

    expect((await me.client.post(`/workers/${worker.id}/documents`).send(body)).status).toBe(403);
    expect((await a.admin.post(`/workers/${foreign.id}/documents`).send(body)).status).toBe(404);
    expect((await manager.client.post(`/workers/${worker.id}/documents`).send(body)).status).toBe(
      201,
    );
  });
});

// ---------- upload & download ----------

describe('POST /documents/:id/file (upload) and GET (download)', () => {
  it('stores a PDF, marks the document submitted, and downloads the same bytes', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    const doc = await insertDocument(worker);

    const res = await admin.post(`/documents/${doc.id}/file`).send(pdfUpload());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: doc.id,
      status: 'submitted',
      fileName: 'passport.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
    });
    expect(res.body.uploadedAt).toEqual(expect.any(String));

    const file = await download(admin, doc.id);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toBe('attachment; filename="passport.pdf"');
    expect(Buffer.compare(file.body, PDF)).toBe(0);

    const [audit] = await auditsFor('document.uploaded');
    expect(audit).toMatchObject({ entityId: doc.id, organizationId: org.id });
  });

  it('stores the file under <storageDir>/<orgId>/<random uuid>, never under the file name', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    const doc = await insertDocument(worker);

    const res = await admin
      .post(`/documents/${doc.id}/file`)
      .send(pdfUpload('../../../evil"name".pdf'));
    expect(res.status).toBe(200);
    // The name is kept as a label only.
    expect(res.body.fileName).toBe('../../../evil"name".pdf');

    const row = await reload(doc.id);
    expect(row.storageKey).toMatch(
      new RegExp(`^${org.id}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
    );
    const onDisk = await readFile(storagePath(row.storageKey ?? ''));
    expect(Buffer.compare(onDisk, PDF)).toBe(0);
    expect(await readdir(path.join(config.storageDir, org.id))).toHaveLength(1);

    // And the download header carries a sanitised name: no slashes, no quotes.
    const file = await download(admin, doc.id);
    expect(file.headers['content-disposition']).toBe(
      'attachment; filename="_.._.._evil_name_.pdf"',
    );
  });

  it('accepts PNG and JPEG files whose bytes match', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    const png = await insertDocument(worker);
    const jpeg = await insertDocument(worker, { kind: 'national_id', title: 'ID' });

    const a = await admin
      .post(`/documents/${png.id}/file`)
      .send({ fileName: 'scan.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') });
    expect(a.status).toBe(200);
    const b = await admin
      .post(`/documents/${jpeg.id}/file`)
      .send({ fileName: 'id.jpg', mimeType: 'image/jpeg', dataBase64: JPEG.toString('base64') });
    expect(b.status).toBe(200);

    const file = await download(admin, png.id);
    expect(file.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(file.body, PNG)).toBe(0);
  });

  it('refuses a file whose bytes do not match the declared type (400 invalid_file)', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    const doc = await insertDocument(worker);

    const pngAsPdf = await admin
      .post(`/documents/${doc.id}/file`)
      .send({ fileName: 'x.pdf', mimeType: 'application/pdf', dataBase64: PNG.toString('base64') });
    expect(pngAsPdf.status).toBe(400);
    expect(pngAsPdf.body.error.code).toBe('invalid_file');

    const pdfAsJpeg = await admin
      .post(`/documents/${doc.id}/file`)
      .send({ fileName: 'x.jpg', mimeType: 'image/jpeg', dataBase64: PDF.toString('base64') });
    expect(pdfAsJpeg.body.error.code).toBe('invalid_file');

    expect((await reload(doc.id)).status).toBe('requested');
    expect(existsSync(path.join(config.storageDir, org.id))).toBe(false);
  });

  it('refuses data that is not valid base64 (400 invalid_file)', async () => {
    const { org, admin } = await tenant();
    const doc = await insertDocument(await onboardingWorker(org.id));
    const res = await admin
      .post(`/documents/${doc.id}/file`)
      .send({ fileName: 'x.pdf', mimeType: 'application/pdf', dataBase64: '%PDF-not*base64!' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_file');
  });

  it('enforces MAX_DOCUMENT_BYTES: one byte over is 413, exactly the limit is fine', async () => {
    const { org, admin } = await tenant();
    const worker = await onboardingWorker(org.id);
    const doc = await insertDocument(worker);

    const tooBig = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x20);
    PDF.copy(tooBig);
    const over = await admin.post(`/documents/${doc.id}/file`).send(pdfUpload('big.pdf', tooBig));
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe('payload_too_large');
    expect((await reload(doc.id)).status).toBe('requested');

    const atLimit = tooBig.subarray(0, MAX_DOCUMENT_BYTES);
    const ok = await admin.post(`/documents/${doc.id}/file`).send(pdfUpload('max.pdf', atLimit));
    expect(ok.status).toBe(200);
    expect(ok.body.sizeBytes).toBe(MAX_DOCUMENT_BYTES);
  });

  it('validates the upload body (mime type outside the allow-list is a 400)', async () => {
    const { org, admin } = await tenant();
    const doc = await insertDocument(await onboardingWorker(org.id));
    const res = await admin
      .post(`/documents/${doc.id}/file`)
      .send({ fileName: '', mimeType: 'text/html', dataBase64: '' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.details).sort()).toEqual([
      'dataBase64',
      'fileName',
      'mimeType',
    ]);
  });

  it('replacing a file deletes the old one and clears the previous review', async () => {
    const { org, admin } = await tenant();
    const doc = await insertDocument(await onboardingWorker(org.id));
    await admin.post(`/documents/${doc.id}/file`).send(pdfUpload('v1.pdf'));
    const firstKey = (await reload(doc.id)).storageKey ?? '';
    expect(existsSync(storagePath(firstKey))).toBe(true);

    // Meridian rejects it, the worker tries again.
    await db
      .update(documents)
      .set({ status: 'rejected', reviewNote: 'Blurry', reviewedAt: new Date() })
      .where(eq(documents.id, doc.id));

    const v2 = Buffer.concat([PDF, Buffer.from('% second version\n')]);
    const res = await admin.post(`/documents/${doc.id}/file`).send(pdfUpload('v2.pdf', v2));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'submitted',
      fileName: 'v2.pdf',
      reviewNote: null,
      reviewedAt: null,
    });

    const secondKey = (await reload(doc.id)).storageKey ?? '';
    expect(secondKey).not.toBe(firstKey);
    expect(existsSync(storagePath(firstKey))).toBe(false);
    expect(Buffer.compare((await download(admin, doc.id)).body, v2)).toBe(0);
    const [latest] = (await auditsFor('document.uploaded')).filter(
      (a) => a.metadata.replaced === true,
    );
    expect(latest).toBeDefined();
  });

  it('refuses to replace a verified document (409 document_locked)', async () => {
    const { org, admin } = await tenant();
    const doc = await insertDocument(await onboardingWorker(org.id), { status: 'verified' });
    const res = await admin.post(`/documents/${doc.id}/file`).send(pdfUpload());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('document_locked');
  });

  it('lets a worker upload and download their own document, not a colleague’s (404)', async () => {
    const { org } = await tenant();
    const mine = await onboardingWorker(org.id);
    const colleague = await onboardingWorker(org.id);
    const myDoc = await insertDocument(mine);
    const theirDoc = await insertDocument(colleague);
    const me = await loginAsWorker(mine);

    expect((await me.client.post(`/documents/${myDoc.id}/file`).send(pdfUpload())).status).toBe(
      200,
    );
    expect((await download(me.client, myDoc.id)).status).toBe(200);

    expect((await me.client.post(`/documents/${theirDoc.id}/file`).send(pdfUpload())).status).toBe(
      404,
    );
    expect((await reload(theirDoc.id)).status).toBe('requested');
  });

  it('answers 404 for another organization’s document, on upload and download', async () => {
    const a = await tenant();
    const b = await tenant();
    const foreignDoc = await insertDocument(await onboardingWorker(b.org.id));
    await b.admin.post(`/documents/${foreignDoc.id}/file`).send(pdfUpload());

    expect((await a.admin.post(`/documents/${foreignDoc.id}/file`).send(pdfUpload())).status).toBe(
      404,
    );
    expect((await download(a.admin, foreignDoc.id)).status).toBe(404);
  });

  it('download answers 404 while no file has been uploaded', async () => {
    const { org, admin } = await tenant();
    const doc = await insertDocument(await onboardingWorker(org.id));
    const res = await admin.get(`/documents/${doc.id}/file`);
    expect(res.status).toBe(404);
  });
});

// ---------- review ----------

describe('POST /documents/:id/review', () => {
  async function submittedDoc(orgId: string, worker?: WorkerRow) {
    const w = worker ?? (await onboardingWorker(orgId));
    const doc = await insertDocument(w, { status: 'submitted' });
    return { worker: w, doc };
  }

  it('lets a platform admin verify a submitted document', async () => {
    const { org } = await tenant();
    const platform = await createPlatformAdmin(org.id);
    const { doc } = await submittedDoc(org.id);

    const res = await platform.client
      .post(`/documents/${doc.id}/review`)
      .send({ decision: 'verified' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'verified', reviewNote: null });
    expect(res.body.reviewedAt).toEqual(expect.any(String));
    expect((await reload(doc.id)).reviewedBy).toBe(platform.user.id);
    expect(await auditsFor('document.verified')).toHaveLength(1);
  });

  it('rejects with a note and leaves documents_verified pending', async () => {
    const { org } = await tenant();
    const platform = await createPlatformAdmin(org.id);
    const { worker, doc } = await submittedDoc(org.id);

    const res = await platform.client
      .post(`/documents/${doc.id}/review`)
      .send({ decision: 'rejected', note: 'Photo page is cut off' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', reviewNote: 'Photo page is cut off' });
    expect(await taskStatus(worker.id, 'documents_verified')).toBe('pending');
    expect(await auditsFor('document.rejected')).toHaveLength(1);
  });

  it('verifying the last outstanding document completes documents_verified', async () => {
    const { org } = await tenant();
    const platform = await createPlatformAdmin(org.id);
    const worker = await onboardingWorker(org.id);
    const first = await insertDocument(worker, { status: 'submitted' });
    const second = await insertDocument(worker, {
      kind: 'tax_form',
      title: 'Tax',
      status: 'submitted',
    });

    await platform.client.post(`/documents/${first.id}/review`).send({ decision: 'verified' });
    expect(await taskStatus(worker.id, 'documents_verified')).toBe('pending');

    await platform.client.post(`/documents/${second.id}/review`).send({ decision: 'verified' });
    expect(await taskStatus(worker.id, 'documents_verified')).toBe('completed');
  });

  it('activates the worker when that was the last pending checklist item', async () => {
    const { org } = await tenant();
    const platform = await createPlatformAdmin(org.id);
    const worker = await onboardingWorker(org.id);
    await db
      .update(onboardingTasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(onboardingTasks.workerId, worker.id));
    await db
      .update(onboardingTasks)
      .set({ status: 'pending', completedAt: null })
      .where(
        and(eq(onboardingTasks.workerId, worker.id), eq(onboardingTasks.key, 'documents_verified')),
      );
    const { doc } = await submittedDoc(org.id, worker);

    await platform.client.post(`/documents/${doc.id}/review`).send({ decision: 'verified' });
    const [after] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(after?.status).toBe('active');
  });

  it('only reviews submitted documents (409 invalid_transition otherwise)', async () => {
    const { org } = await tenant();
    const platform = await createPlatformAdmin(org.id);
    const worker = await onboardingWorker(org.id);
    for (const status of ['requested', 'verified', 'rejected'] as const) {
      const doc = await insertDocument(worker, { status });
      for (const decision of ['verified', 'rejected']) {
        const res = await platform.client.post(`/documents/${doc.id}/review`).send({ decision });
        expect(res.status, `${status} -> ${decision}`).toBe(409);
        expect(res.body.error.code).toBe('invalid_transition');
      }
      expect((await reload(doc.id)).status).toBe(status);
    }
  });

  it('is platform-admin only: client admins, managers and workers get 403', async () => {
    const { org, admin } = await tenant();
    const manager = await createManager(org.id);
    const { worker, doc } = await submittedDoc(org.id);
    const me = await loginAsWorker(worker);
    for (const c of [admin, manager.client, me.client]) {
      expect(
        (await c.post(`/documents/${doc.id}/review`).send({ decision: 'verified' })).status,
      ).toBe(403);
    }
    expect((await reload(doc.id)).status).toBe('submitted');
  });

  it('needs the right tenant: no X-Org-Id is 400, another org is 404', async () => {
    const a = await tenant();
    const b = await tenant();
    const { doc } = await submittedDoc(a.org.id);
    const noOrg = await createPlatformAdmin();
    const wrongOrg = await createPlatformAdmin(b.org.id);

    const missing = await noOrg.client
      .post(`/documents/${doc.id}/review`)
      .send({ decision: 'verified' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('organization_required');
    expect(
      (await wrongOrg.client.post(`/documents/${doc.id}/review`).send({ decision: 'verified' }))
        .status,
    ).toBe(404);
  });

  it('validates the decision', async () => {
    const { org } = await tenant();
    const platform = await createPlatformAdmin(org.id);
    const { doc } = await submittedDoc(org.id);
    const res = await platform.client
      .post(`/documents/${doc.id}/review`)
      .send({ decision: 'maybe' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toHaveProperty('decision');
  });
});
