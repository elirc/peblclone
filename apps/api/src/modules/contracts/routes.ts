import {
  createContractSchema,
  listContractsQuerySchema,
  signContractSchema,
  updateContractSchema,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requireAdmin, requireRole, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const contractsRouter = Router();

// Staff and workers may both read; the service narrows a worker to their own
// non-draft, non-void contracts.
contractsRouter.get('/contracts', authenticate, async (req, res) => {
  const query = parseQuery(listContractsQuerySchema, req);
  res.json(await service.listContracts(getActor(req), query));
});

contractsRouter.post('/contracts', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(createContractSchema, req);
  res.status(201).json(await service.createContract(getActor(req), input));
});

contractsRouter.get('/contracts/:id', authenticate, async (req, res) => {
  res.json(await service.getContract(getActor(req), uuidParam(req)));
});

contractsRouter.patch('/contracts/:id', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(updateContractSchema, req);
  res.json(await service.updateContract(getActor(req), uuidParam(req), input));
});

contractsRouter.post('/contracts/:id/send', authenticate, requireStaff, async (req, res) => {
  res.json(await service.sendContract(getActor(req), uuidParam(req)));
});

contractsRouter.post('/contracts/:id/recall', authenticate, requireStaff, async (req, res) => {
  res.json(await service.recallContract(getActor(req), uuidParam(req)));
});

// Only the worker signs their own contract — a client admin "signing for" an
// employee would make the signature meaningless.
contractsRouter.post('/contracts/:id/sign', authenticate, requireRole('worker'), async (req, res) => {
  const input = parseBody(signContractSchema, req);
  res.json(
    await service.signContract(getActor(req), uuidParam(req), input, req.ip ?? 'unknown'),
  );
});

contractsRouter.post('/contracts/:id/activate', authenticate, requireAdmin, async (req, res) => {
  res.json(await service.activateContract(getActor(req), uuidParam(req)));
});

contractsRouter.post('/contracts/:id/void', authenticate, requireAdmin, async (req, res) => {
  res.json(await service.voidContract(getActor(req), uuidParam(req)));
});

contractsRouter.post('/contracts/:id/terminate', authenticate, requireAdmin, async (req, res) => {
  res.json(await service.terminateContract(getActor(req), uuidParam(req)));
});
