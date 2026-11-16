import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { authenticate, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', authenticate, requireStaff, async (req, res) => {
  res.json(await service.getDashboard(getActor(req)));
});
