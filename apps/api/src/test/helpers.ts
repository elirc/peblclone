import type { UserRole } from '@meridian/shared';
import { eq } from 'drizzle-orm';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../app';
import { db } from '../db/client';
import { countries, onboardingTasks, organizations, users, workers } from '../db/schema';
import { hashPassword } from '../lib/crypto';
import { ONBOARDING_TASK_TEMPLATES } from '../lib/onboarding';
import { createSession, SESSION_COOKIE } from '../lib/sessions';

/**
 * Test helpers. Two ideas:
 *
 *  1. FACTORIES insert rows directly (fast, no HTTP) and take `overrides`, so a
 *     test states only what it cares about: `createWorker(org.id, { countryCode: 'DE' })`.
 *  2. A CLIENT wraps supertest with a session cookie, so tests read like a
 *     user's actions: `await admin.post('/workers').send({...})`.
 *
 * Tests exercise the real app against a real Postgres. No mocks of our own code.
 */

let app: Express | undefined;
export function getApp(): Express {
  return (app ??= createApp());
}

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface TestClient {
  get(url: string): request.Test;
  post(url: string): request.Test;
  patch(url: string): request.Test;
  put(url: string): request.Test;
  delete(url: string): request.Test;
}

/** An HTTP client for the API. Pass a session token to act as that user. */
export function client(sessionToken?: string, headers: Record<string, string> = {}): TestClient {
  const call = (method: Method) => (url: string) => {
    const req = request(getApp())[method](`/api/v1${url}`);
    if (sessionToken) req.set('Cookie', `${SESSION_COOKIE}=${sessionToken}`);
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req;
  };
  return {
    get: call('get'),
    post: call('post'),
    patch: call('patch'),
    put: call('put'),
    delete: call('delete'),
  };
}

/** A client with no session — for asserting 401s. */
export const anonymous = () => client();

let counter = 0;
/** Unique-per-test suffix so factories never collide on unique columns. */
export const unique = () => `${Date.now().toString(36)}${(counter += 1)}`;

// A single precomputed hash keeps factories fast (scrypt is deliberately slow).
export const TEST_PASSWORD = 'correct-horse-battery';
let passwordHashPromise: Promise<string> | undefined;
const testPasswordHash = () => (passwordHashPromise ??= hashPassword(TEST_PASSWORD));

export type OrganizationRow = typeof organizations.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type WorkerRow = typeof workers.$inferSelect;

export async function createOrganization(
  overrides: Partial<typeof organizations.$inferInsert> = {},
): Promise<OrganizationRow> {
  const suffix = unique();
  const [org] = await db
    .insert(organizations)
    .values({
      name: `Acme ${suffix}`,
      legalName: `Acme ${suffix} Inc.`,
      countryCode: 'US',
      billingEmail: `billing-${suffix}@acme.test`,
      ...overrides,
    })
    .returning();
  return org!;
}

export async function createUser(
  role: UserRole,
  organizationId: string | null,
  overrides: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  const [user] = await db
    .insert(users)
    .values({
      email: `${role}-${unique()}@example.test`,
      passwordHash: await testPasswordHash(),
      fullName: `Test ${role}`,
      role,
      organizationId,
      ...overrides,
    })
    .returning();
  return user!;
}

/** Create a session for a user and return a logged-in client. */
export async function loginAs(user: UserRow, headers: Record<string, string> = {}): Promise<TestClient> {
  const token = await createSession(db, user.id, 'vitest');
  return client(token, headers);
}

export interface Tenant {
  org: OrganizationRow;
  adminUser: UserRow;
  /** Logged in as the organization's client_admin. */
  admin: TestClient;
}

/** The most common starting point: an organization with a logged-in admin. */
export async function createTenant(
  overrides: Partial<typeof organizations.$inferInsert> = {},
): Promise<Tenant> {
  const org = await createOrganization(overrides);
  const adminUser = await createUser('client_admin', org.id);
  return { org, adminUser, admin: await loginAs(adminUser) };
}

/** A logged-in client_manager in the given organization. */
export async function createManager(organizationId: string) {
  const user = await createUser('client_manager', organizationId);
  return { user, client: await loginAs(user) };
}

/**
 * A logged-in platform admin. Pass `organizationId` to act inside that tenant
 * (sets the X-Org-Id header on every request).
 */
export async function createPlatformAdmin(organizationId?: string) {
  const user = await createUser('platform_admin', null);
  const headers = organizationId ? { 'X-Org-Id': organizationId } : undefined;
  return { user, client: await loginAs(user, headers) };
}

/**
 * Insert a worker directly. Defaults to an ACTIVE employee in Germany on
 * €60,000/year who started 2025-01-01 — override whatever the test is about.
 * `withTasks: true` also creates the pending onboarding checklist.
 */
export async function createWorker(
  organizationId: string,
  overrides: Partial<typeof workers.$inferInsert> = {},
  options: { withTasks?: boolean } = {},
): Promise<WorkerRow> {
  const suffix = unique();
  const countryCode = overrides.countryCode ?? 'DE';
  const [country] = await db
    .select({ currency: countries.currency })
    .from(countries)
    .where(eq(countries.code, countryCode))
    .limit(1);
  if (!country) throw new Error(`Test country ${countryCode} is not seeded`);

  const [worker] = await db
    .insert(workers)
    .values({
      organizationId,
      type: 'employee',
      status: 'active',
      firstName: 'Wanda',
      lastName: `Worker${suffix}`,
      email: `worker-${suffix}@example.test`,
      countryCode,
      jobTitle: 'Software Engineer',
      startDate: '2025-01-01',
      salaryMinor: 6_000_000,
      payBasis: 'annual',
      currency: country.currency,
      ...overrides,
    })
    .returning();

  if (options.withTasks) {
    await db.insert(onboardingTasks).values(
      ONBOARDING_TASK_TEMPLATES.map((t, i) => ({
        organizationId,
        workerId: worker!.id,
        key: t.key,
        title: t.title,
        description: t.description,
        assignee: t.assignee,
        automatic: t.automatic,
        sortOrder: i,
      })),
    );
  }
  return worker!;
}

/** Give a worker a portal login and return a client logged in as them. */
export async function loginAsWorker(worker: WorkerRow) {
  const user = await createUser('worker', worker.organizationId, {
    email: worker.email,
    fullName: `${worker.firstName} ${worker.lastName}`,
  });
  await db.update(workers).set({ userId: user.id }).where(eq(workers.id, worker.id));
  return { user, client: await loginAs(user) };
}
