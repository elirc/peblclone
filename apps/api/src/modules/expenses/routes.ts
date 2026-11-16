import { createExpenseSchema, decisionSchema, listExpensesQuerySchema } from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const expensesRouter = Router();

// "staff, worker" routes only authenticate; the service keeps a worker to their own expenses.

expensesRouter.get('/expenses', authenticate, async (req, res) => {
  const query = parseQuery(listExpensesQuerySchema, req);
  res.json(await service.listExpenses(getActor(req), query));
});

expensesRouter.post('/expenses', authenticate, async (req, res) => {
  const input = parseBody(createExpenseSchema, req);
  res.status(201).json(await service.createExpense(getActor(req), input));
});

expensesRouter.post('/expenses/:id/decision', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(decisionSchema, req);
  res.json(await service.decideExpense(getActor(req), uuidParam(req), input));
});

expensesRouter.delete('/expenses/:id', authenticate, async (req, res) => {
  await service.deleteExpense(getActor(req), uuidParam(req));
  res.status(204).end();
});
