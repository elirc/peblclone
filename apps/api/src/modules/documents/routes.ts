import { requestDocumentSchema, reviewDocumentSchema, uploadDocumentSchema } from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, uuidParam } from '../../lib/http';
import { authenticate, requirePlatformAdmin, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const documentsRouter = Router();

// "Staff, or the worker": routes only authenticate; the service answers 404
// when a worker reaches for someone else's documents.
documentsRouter.get('/workers/:id/documents', authenticate, async (req, res) => {
  res.json({ items: await service.listDocuments(getActor(req), uuidParam(req)) });
});

documentsRouter.post('/workers/:id/documents', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(requestDocumentSchema, req);
  res.status(201).json(await service.requestDocument(getActor(req), uuidParam(req), input));
});

documentsRouter.post('/documents/:id/file', authenticate, async (req, res) => {
  const input = parseBody(uploadDocumentSchema, req);
  res.json(await service.uploadDocument(getActor(req), uuidParam(req), input));
});

documentsRouter.get('/documents/:id/file', authenticate, async (req, res) => {
  const file = await service.downloadDocument(getActor(req), uuidParam(req));
  res.setHeader('Content-Type', file.mimeType);
  // `attachment`: the browser saves the file instead of rendering it inline, so
  // an uploaded file can never run as a page on our origin.
  res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  res.setHeader('Content-Length', String(file.bytes.length));
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(file.bytes);
});

documentsRouter.post('/documents/:id/review', authenticate, requirePlatformAdmin, async (req, res) => {
  const input = parseBody(reviewDocumentSchema, req);
  res.json(await service.reviewDocument(getActor(req), uuidParam(req), input));
});
