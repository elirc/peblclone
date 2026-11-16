import {
  createWorkerSchema,
  listWorkersQuerySchema,
  transitionWorkerSchema,
  updateWorkerSchema,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requireAdmin, requireRole, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const workersRouter = Router();

workersRouter.get('/workers', authenticate, requireStaff, async (req, res) => {
  const query = parseQuery(listWorkersQuerySchema, req);
  res.json(await service.listWorkers(getActor(req), query));
});

workersRouter.post('/workers', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(createWorkerSchema, req);
  res.status(201).json(await service.createWorker(getActor(req), input));
});

// Staff, or the worker themselves: the service turns "someone else" into a 404.
workersRouter.get('/workers/:id', authenticate, async (req, res) => {
  res.json(await service.getWorker(getActor(req), uuidParam(req)));
});

workersRouter.patch('/workers/:id', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(updateWorkerSchema, req);
  res.json(await service.updateWorker(getActor(req), uuidParam(req), input));
});

workersRouter.post('/workers/:id/transition', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(transitionWorkerSchema, req);
  res.json(await service.transitionWorker(getActor(req), uuidParam(req), input));
});

workersRouter.post('/workers/:id/invite', authenticate, requireStaff, async (req, res) => {
  res.status(201).json(await service.inviteWorker(getActor(req), uuidParam(req)));
});

workersRouter.get('/me/worker', authenticate, requireRole('worker'), async (req, res) => {
  res.json(await service.getMyWorker(getActor(req)));
});

// Any role may call this; who may complete WHICH task is a rule in the service.
workersRouter.post('/onboarding-tasks/:id/complete', authenticate, async (req, res) => {
  res.json(await service.completeTask(getActor(req), uuidParam(req)));
});
