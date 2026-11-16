import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { forbidden } from '../lib/errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence, layer two (layer one is the SameSite=Lax cookie).
 *
 * Browsers attach an `Origin` header to cross-site state-changing requests.
 * If one arrives from an origin that is not our web app, refuse it. Requests
 * with no Origin at all (curl, server-to-server, tests) are allowed: CSRF is
 * an attack on *browsers*, and those callers are not browsers.
 */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== config.webOrigin) throw forbidden('Cross-origin request blocked');
  next();
}
