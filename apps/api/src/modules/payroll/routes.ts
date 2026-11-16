import {
  createPayrollRunSchema,
  listPayrollRunsQuerySchema,
  listPayslipsQuerySchema,
  rejectPayrollRunSchema,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requireAdmin, requirePlatformAdmin, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const payrollRouter = Router();

// ---------- runs ----------

payrollRouter.get('/payroll/runs', authenticate, requireStaff, async (req, res) => {
  const query = parseQuery(listPayrollRunsQuerySchema, req);
  res.json(await service.listRuns(getActor(req), query));
});

payrollRouter.post('/payroll/runs', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(createPayrollRunSchema, req);
  res.status(201).json(await service.createRun(getActor(req), input));
});

payrollRouter.get('/payroll/runs/:id', authenticate, requireStaff, async (req, res) => {
  res.json(await service.getRun(getActor(req), uuidParam(req)));
});

payrollRouter.post('/payroll/runs/:id/recalculate', authenticate, requireAdmin, async (req, res) => {
  res.json(await service.recalculateRun(getActor(req), uuidParam(req)));
});

payrollRouter.delete('/payroll/runs/:id', authenticate, requireAdmin, async (req, res) => {
  await service.deleteRun(getActor(req), uuidParam(req));
  res.status(204).end();
});

// Managers may prepare and submit; only admins sign off on spending the money.
payrollRouter.post('/payroll/runs/:id/submit', authenticate, requireStaff, async (req, res) => {
  res.json(await service.submitRun(getActor(req), uuidParam(req)));
});

payrollRouter.post('/payroll/runs/:id/approve', authenticate, requireAdmin, async (req, res) => {
  res.json(await service.approveRun(getActor(req), uuidParam(req)));
});

payrollRouter.post('/payroll/runs/:id/reject', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(rejectPayrollRunSchema, req);
  res.json(await service.rejectRun(getActor(req), uuidParam(req), input));
});

// Moving money is Meridian's job, not the client's.
payrollRouter.post(
  '/payroll/runs/:id/process',
  authenticate,
  requirePlatformAdmin,
  async (req, res) => {
    res.json(await service.processRun(getActor(req), uuidParam(req)));
  },
);

payrollRouter.post(
  '/payroll/runs/:id/mark-paid',
  authenticate,
  requirePlatformAdmin,
  async (req, res) => {
    res.json(await service.markRunPaid(getActor(req), uuidParam(req)));
  },
);

// ---------- payslips (staff and workers; the service scopes workers to themselves) ----------

payrollRouter.get('/payslips', authenticate, async (req, res) => {
  const query = parseQuery(listPayslipsQuerySchema, req);
  res.json(await service.listPayslips(getActor(req), query));
});

payrollRouter.get('/payslips/:id', authenticate, async (req, res) => {
  res.json(await service.getPayslip(getActor(req), uuidParam(req)));
});
