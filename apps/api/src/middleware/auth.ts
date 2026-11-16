import type { UserRole } from '@meridian/shared';
import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import { db } from '../db/client';
import { organizations, users, workers } from '../db/schema';
import { getActor } from '../lib/actor';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors';
import { UUID_PATTERN } from '../lib/http';
import { findSession, SESSION_COOKIE } from '../lib/sessions';

/**
 * Turn the session cookie into `req.actor`, or respond 401.
 *
 * The user row is re-read on EVERY request (one indexed lookup), so a role
 * change or deactivation takes effect on the very next call — nothing about
 * the user is cached inside the cookie.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || token.length === 0) throw unauthorized();

  const session = await findSession(token);
  if (!session) throw unauthorized();

  const [user] = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      role: users.role,
      organizationId: users.organizationId,
      isActive: users.isActive,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!user || !user.isActive) throw unauthorized();

  let organizationId = user.organizationId;
  let workerId: string | null = null;

  if (user.role === 'platform_admin') {
    // Platform admins belong to no tenant; they name the one they are working in.
    const header = req.get('x-org-id');
    if (header) {
      if (!UUID_PATTERN.test(header)) throw badRequest('X-Org-Id must be a UUID');
      const [org] = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, header))
        .limit(1);
      if (!org) throw notFound('Organization');
      organizationId = org.id;
    }
  } else if (user.role === 'worker') {
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(eq(workers.userId, user.id))
      .limit(1);
    if (!worker) throw forbidden('This login is not linked to a worker record');
    workerId = worker.id;
  }
  // Note: a non-admin sending X-Org-Id is simply ignored. The tenant always
  // comes from the server-side user row, never from anything the client says.

  req.actor = { userId: user.id, fullName: user.fullName, role: user.role, organizationId, workerId };
  req.sessionId = session.id;
  next();
}

/** Route guard: `router.post('/x', requireRole('client_admin'), handler)`. */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!roles.includes(getActor(req).role)) throw forbidden();
    next();
  };
}

/** Everyone except workers. */
export const requireStaff = requireRole('platform_admin', 'client_admin', 'client_manager');
/** Client admins and platform admins. */
export const requireAdmin = requireRole('platform_admin', 'client_admin');
export const requirePlatformAdmin = requireRole('platform_admin');
