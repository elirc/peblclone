import { listInvoicesQuerySchema } from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requireAdmin, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const invoicesRouter = Router();

invoicesRouter.get('/invoices', authenticate, requireStaff, async (req, res) => {
  const query = parseQuery(listInvoicesQuerySchema, req);
  res.json(await service.listInvoices(getActor(req), query));
});

invoicesRouter.get('/invoices/:id', authenticate, requireStaff, async (req, res) => {
  res.json(await service.getInvoice(getActor(req), uuidParam(req)));
});

invoicesRouter.post('/invoices/:id/pay', authenticate, requireAdmin, async (req, res) => {
  res.json(await service.payInvoice(getActor(req), uuidParam(req)));
});
