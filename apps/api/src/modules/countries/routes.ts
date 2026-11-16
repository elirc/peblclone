import {
  calculateQuoteSchema,
  paginationSchema,
  saveQuoteSchema,
  updateCountrySchema,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, parseQuery, uuidParam } from '../../lib/http';
import { authenticate, requirePlatformAdmin, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const countriesRouter = Router();

/** `:code` arrives as typed in the URL; the service normalises case. */
function codeParam(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}

countriesRouter.get('/countries', authenticate, async (_req, res) => {
  res.json({ items: await service.listCountries() });
});

countriesRouter.get('/countries/:code', authenticate, async (req, res) => {
  res.json(await service.getCountry(codeParam(req.params.code)));
});

countriesRouter.patch('/countries/:code', authenticate, requirePlatformAdmin, async (req, res) => {
  const input = parseBody(updateCountrySchema, req);
  res.json(await service.updateCountry(getActor(req), codeParam(req.params.code), input));
});

countriesRouter.post('/quotes/calculate', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(calculateQuoteSchema, req);
  res.json(await service.calculateQuote(input));
});

countriesRouter.post('/quotes', authenticate, requireStaff, async (req, res) => {
  const input = parseBody(saveQuoteSchema, req);
  res.status(201).json(await service.saveQuote(getActor(req), input));
});

countriesRouter.get('/quotes', authenticate, requireStaff, async (req, res) => {
  const page = parseQuery(paginationSchema, req);
  res.json(await service.listQuotes(getActor(req), page));
});

countriesRouter.delete('/quotes/:id', authenticate, requireStaff, async (req, res) => {
  await service.deleteQuote(getActor(req), uuidParam(req));
  res.status(204).end();
});
