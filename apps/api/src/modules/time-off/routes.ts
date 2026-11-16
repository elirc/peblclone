import {
  createTimeOffRequestSchema,
  decisionSchema,
  listTimeOffQuerySchema,
  timeOffBalanceQuerySchema,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const timeOffRouter = Router();

// Routes open to "staff, worker" only authenticate here; the service narrows a
// worker to their own records (resolveWorkerId / own-record checks -> 404).

timeOffRouter.get('/time-off/requests', authenticate, async (req, res) => {
  const query = parseQuery(listTimeOffQuerySchema, req);
  res.json(await service.listRequests(getActor(req), query));
});

timeOffRouter.post('/time-off/requests', authenticate, async (req, res) => {
  const input = parseBody(createTimeOffRequestSchema, req);
  res.status(201).json(await service.createRequest(getActor(req), input));
});

timeOffRouter.post(
  '/time-off/requests/:id/decision',
  authenticate,
  requireStaff,
  async (req, res) => {
    const input = parseBody(decisionSchema, req);
    res.json(await service.decideRequest(getActor(req), uuidParam(req), input));
  },
);

timeOffRouter.post('/time-off/requests/:id/cancel', authenticate, async (req, res) => {
  res.json(await service.cancelRequest(getActor(req), uuidParam(req)));
});

timeOffRouter.get('/time-off/balance', authenticate, async (req, res) => {
  const query = parseQuery(timeOffBalanceQuerySchema, req);
  res.json(await service.getBalance(getActor(req), query));
});
