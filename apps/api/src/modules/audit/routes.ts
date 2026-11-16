import { listAuditLogsQuerySchema } from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseQuery } from '../../lib/http';
import { authenticate, requireAdmin } from '../../middleware/auth';
import * as service from './service';

export const auditRouter = Router();

auditRouter.get('/audit-logs', authenticate, requireAdmin, async (req, res) => {
  const query = parseQuery(listAuditLogsQuerySchema, req);
  res.json(await service.listAuditLogs(getActor(req), query));
});
