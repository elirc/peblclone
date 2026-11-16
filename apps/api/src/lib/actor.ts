import type { UserRole } from '@meridian/shared';
import type { Request } from 'express';
import { badRequest, forbidden, notFound, unauthorized } from './errors';

/**
 * The Actor: "who is making this request, and on behalf of which tenant".
 *
 * It is built once by the `authenticate` middleware and then passed explicitly
 * into every service function. Services never look at `req`; they only know
 * the actor. That keeps business logic testable without HTTP and makes the
 * permission question visible in every function signature.
 */
export interface Actor {
  userId: string;
  fullName: string;
  role: UserRole;
  /**
   * The tenant this request operates on.
   *  - client users & workers: always their own organization
   *  - platform admins: the org named in the `X-Org-Id` header, or null
   */
  organizationId: string | null;
  /** Set when role === 'worker'. */
  workerId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
    sessionId?: string;
  }
}

export function getActor(req: Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

/** The tenant id for this request, or a 400 telling a platform admin to pick one. */
export function requireOrgId(actor: Actor): string {
  if (!actor.organizationId) {
    throw badRequest('Select an organization first (X-Org-Id header)', 'organization_required');
  }
  return actor.organizationId;
}

export const isPlatformAdmin = (actor: Actor) => actor.role === 'platform_admin';
export const isWorker = (actor: Actor) => actor.role === 'worker';
/** Client-side staff plus platform admins: everyone who manages workers. */
export const isStaff = (actor: Actor) => actor.role !== 'worker';
export const isAdmin = (actor: Actor) =>
  actor.role === 'client_admin' || actor.role === 'platform_admin';

export function assertRole(actor: Actor, ...roles: UserRole[]): void {
  if (!roles.includes(actor.role)) throw forbidden();
}

/**
 * Which worker is this request about?
 *  - a worker can only ever act on themselves (any workerId they send must match)
 *  - staff must say which worker they mean
 */
export function resolveWorkerId(actor: Actor, requested: string | undefined): string {
  if (isWorker(actor)) {
    if (!actor.workerId) throw forbidden();
    if (requested && requested !== actor.workerId) throw notFound('Worker');
    return actor.workerId;
  }
  if (!requested) throw badRequest('workerId is required');
  return requested;
}

/** Throws 404 (not 403) if a worker-role actor reaches for someone else's record. */
export function assertCanAccessWorker(actor: Actor, workerId: string): void {
  if (isWorker(actor) && actor.workerId !== workerId) throw notFound('Worker');
}
