import {
  acceptInviteSchema,
  loginSchema,
  registerSchema,
  type AuthResponse,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { badRequest } from '../../lib/errors';
import { parseBody } from '../../lib/http';
import { clearSessionCookie, deleteSession, setSessionCookie } from '../../lib/sessions';
import { authenticate } from '../../middleware/auth';
import * as service from './service';

/**
 * Route handlers are deliberately boring. Each one does exactly three things:
 *   1. parse & validate input   (parseBody / parseQuery / uuidParam)
 *   2. call ONE service function (all business rules live there)
 *   3. shape the HTTP response   (status code, cookie, JSON)
 *
 * Express 5 forwards a rejected promise from an async handler to the error
 * middleware, so there is no try/catch here — throw and it is handled.
 */
export const authRouter = Router();

authRouter.post('/auth/register', async (req, res) => {
  const input = parseBody(registerSchema, req);
  const { user, sessionToken } = await service.register(input, req.get('user-agent'));
  setSessionCookie(res, sessionToken);
  res.status(201).json({ user } satisfies AuthResponse);
});

authRouter.post('/auth/login', async (req, res) => {
  const input = parseBody(loginSchema, req);
  const { user, sessionToken } = await service.login(
    input,
    req.ip ?? 'unknown',
    req.get('user-agent'),
  );
  setSessionCookie(res, sessionToken);
  res.json({ user } satisfies AuthResponse);
});

authRouter.post('/auth/logout', authenticate, async (req, res) => {
  if (req.sessionId) await deleteSession(req.sessionId);
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/auth/me', authenticate, async (req, res) => {
  const user = await service.getSessionUser(getActor(req).userId);
  res.json({ user } satisfies AuthResponse);
});

authRouter.get('/auth/invite', async (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || token.length < 20) throw badRequest('token is required');
  res.json(await service.previewInvite(token));
});

authRouter.post('/auth/accept-invite', async (req, res) => {
  const input = parseBody(acceptInviteSchema, req);
  const { user, sessionToken } = await service.acceptInvite(input, req.get('user-agent'));
  setSessionCookie(res, sessionToken);
  res.status(201).json({ user } satisfies AuthResponse);
});
