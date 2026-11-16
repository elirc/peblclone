import type { Router } from 'express';
import { auditRouter } from './audit/routes';
import { authRouter } from './auth/routes';
import { contractsRouter } from './contracts/routes';
import { countriesRouter } from './countries/routes';
import { dashboardRouter } from './dashboard/routes';
import { documentsRouter } from './documents/routes';
import { expensesRouter } from './expenses/routes';
import { invoicesRouter } from './invoices/routes';
import { organizationsRouter } from './organizations/routes';
import { payrollRouter } from './payroll/routes';
import { timeOffRouter } from './time-off/routes';
import { workersRouter } from './workers/routes';

/**
 * The module registry. One folder per business capability; each exports a
 * router. Modules do not import each other — shared behaviour lives in `lib/`.
 */
export const moduleRouters: Router[] = [
  authRouter,
  organizationsRouter,
  countriesRouter,
  workersRouter,
  documentsRouter,
  contractsRouter,
  timeOffRouter,
  expensesRouter,
  payrollRouter,
  invoicesRouter,
  auditRouter,
  dashboardRouter,
];
