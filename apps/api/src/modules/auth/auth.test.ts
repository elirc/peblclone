import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db } from '../../db/client';
import { auditLogs, invitations, organizations, sessions, users, workers } from '../../db/schema';
import { hashToken } from '../../lib/crypto';
import { createInvitation } from '../../lib/invites';
import { SESSION_COOKIE } from '../../lib/sessions';
import {
  anonymous,
  client,
  createTenant,
  createUser,
  createWorker,
  loginAs,
  TEST_PASSWORD,
} from '../../test/helpers';

const validRegistration = {
  organizationName: 'Globex',
  countryCode: 'us', // lower-case on purpose: the schema normalises it
  fullName: 'Ada Lovelace',
  email: 'Ada@Globex.test',
  password: 'a-long-enough-password',
};

/** Pull the session token out of a Set-Cookie header. */
function sessionTokenFrom(res: { headers: Record<string, unknown> }): string {
  const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = cookies?.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error('No session cookie in response');
  return cookie.split(';')[0]!.split('=')[1]!;
}

describe('POST /auth/register', () => {
  it('creates an organization, its first admin, and a session', async () => {
    const res = await anonymous().post('/auth/register').send(validRegistration);

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'ada@globex.test',
      fullName: 'Ada Lovelace',
      role: 'client_admin',
      organizationName: 'Globex',
      workerId: null,
    });
    // The response must never contain credential material.
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);

    const [org] = await db.select().from(organizations);
    expect(org?.countryCode).toBe('US');

    // The cookie works for an authenticated call…
    const me = await client(sessionTokenFrom(res)).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ada@globex.test');
  });

  it('sets an httpOnly, SameSite=Lax cookie and stores only a hash of the token', async () => {
    const res = await anonymous().post('/auth/register').send(validRegistration);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const token = sessionTokenFrom(res);
    const [session] = await db.select().from(sessions);
    expect(session?.tokenHash).toBe(hashToken(token));
    expect(session?.tokenHash).not.toBe(token);
  });

  it('writes an audit record in the same transaction', async () => {
    await anonymous().post('/auth/register').send(validRegistration);
    const logs = await db.select().from(auditLogs);
    expect(logs.map((l) => l.action)).toEqual(['organization.registered']);
  });

  it('rejects a duplicate email with 409 and leaves no orphan organization', async () => {
    await anonymous().post('/auth/register').send(validRegistration);
    const res = await anonymous()
      .post('/auth/register')
      .send({ ...validRegistration, organizationName: 'Second Org' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_taken');
    // The transaction rolled back: the second organization must not exist.
    expect(await db.select().from(organizations)).toHaveLength(1);
  });

  it('returns field-level details for invalid input', async () => {
    const res = await anonymous()
      .post('/auth/register')
      .send({ ...validRegistration, email: 'not-an-email', password: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(Object.keys(res.body.error.details).sort()).toEqual(['email', 'password']);
  });

  it('rejects an unknown country', async () => {
    const res = await anonymous()
      .post('/auth/register')
      .send({ ...validRegistration, countryCode: 'ZZ' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_country');
  });
});

describe('POST /auth/login', () => {
  it('logs in with correct credentials (email is case-insensitive)', async () => {
    const { adminUser } = await createTenant();
    const res = await anonymous()
      .post('/auth/login')
      .send({ email: adminUser.email.toUpperCase(), password: TEST_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(adminUser.id);
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const { adminUser } = await createTenant();
    const wrongPassword = await anonymous()
      .post('/auth/login')
      .send({ email: adminUser.email, password: 'wrong-password-123' });
    const unknownEmail = await anonymous()
      .post('/auth/login')
      .send({ email: 'nobody@example.test', password: 'wrong-password-123' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identical bodies: an attacker cannot tell which emails are registered.
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('refuses deactivated users', async () => {
    const { org } = await createTenant();
    const user = await createUser('client_manager', org.id, { isActive: false });
    const res = await anonymous()
      .post('/auth/login')
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('rate-limits repeated failures for the same email', async () => {
    const { adminUser } = await createTenant();
    const attempt = () =>
      anonymous().post('/auth/login').send({ email: adminUser.email, password: 'nope-nope-nope' });

    for (let i = 0; i < 10; i += 1) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  });
});

describe('sessions', () => {
  it('rejects requests with no cookie or a made-up cookie', async () => {
    expect((await anonymous().get('/auth/me')).status).toBe(401);
    expect((await client('not-a-real-token').get('/auth/me')).status).toBe(401);
  });

  it('logout revokes the session server-side', async () => {
    const res = await anonymous().post('/auth/register').send(validRegistration);
    const authed = client(sessionTokenFrom(res));

    expect((await authed.post('/auth/logout')).status).toBe(204);
    // Replaying the old cookie no longer works: the row is gone.
    expect((await authed.get('/auth/me')).status).toBe(401);
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it('rejects an expired session', async () => {
    const { adminUser } = await createTenant();
    const authed = await loginAs(adminUser);
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await authed.get('/auth/me')).status).toBe(401);
  });

  it('stops working the moment the user is deactivated', async () => {
    const { adminUser, admin } = await createTenant();
    expect((await admin.get('/auth/me')).status).toBe(200);
    await db.update(users).set({ isActive: false }).where(eq(users.id, adminUser.id));
    expect((await admin.get('/auth/me')).status).toBe(401);
  });
});

describe('CSRF origin check', () => {
  it('blocks state-changing requests from another origin', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/auth/logout').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    // …and the session survived the attempt.
    expect((await admin.get('/auth/me')).status).toBe(200);
  });

  it('allows the web app origin', async () => {
    const { admin } = await createTenant();
    const res = await admin.post('/auth/logout').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(204);
  });
});

describe('invitations', () => {
  it('previews and accepts a team invite, creating a user in the right org', async () => {
    const { org, adminUser } = await createTenant();
    const { token } = await createInvitation(db, {
      organizationId: org.id,
      email: 'newbie@example.test',
      role: 'client_manager',
      invitedBy: adminUser.id,
    });

    const preview = await anonymous().get(`/auth/invite?token=${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      email: 'newbie@example.test',
      organizationName: org.name,
      role: 'client_manager',
    });

    const res = await anonymous()
      .post('/auth/accept-invite')
      .send({ token, fullName: 'New Person', password: 'a-long-enough-password' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'newbie@example.test',
      role: 'client_manager',
      organizationId: org.id,
    });
  });

  it('links a worker invite to the worker record', async () => {
    const { org, adminUser } = await createTenant();
    const worker = await createWorker(org.id);
    const { token } = await createInvitation(db, {
      organizationId: org.id,
      email: worker.email,
      role: 'worker',
      workerId: worker.id,
      invitedBy: adminUser.id,
    });

    const res = await anonymous()
      .post('/auth/accept-invite')
      .send({ token, fullName: 'Wanda Worker', password: 'a-long-enough-password' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'worker', workerId: worker.id });
    const [reloaded] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(reloaded?.userId).toBe(res.body.user.id);
  });

  it('cannot be used twice', async () => {
    const { org } = await createTenant();
    const { token } = await createInvitation(db, {
      organizationId: org.id,
      email: 'once@example.test',
      role: 'client_manager',
      invitedBy: null,
    });
    const body = { token, fullName: 'Once Only', password: 'a-long-enough-password' };

    expect((await anonymous().post('/auth/accept-invite').send(body)).status).toBe(201);
    expect((await anonymous().post('/auth/accept-invite').send(body)).status).toBe(404);
  });

  it('rejects expired and unknown tokens identically', async () => {
    const { org } = await createTenant();
    const { token, invite } = await createInvitation(db, {
      organizationId: org.id,
      email: 'late@example.test',
      role: 'client_manager',
      invitedBy: null,
    });
    await db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, invite.id));

    const expired = await anonymous().get(`/auth/invite?token=${token}`);
    const unknown = await anonymous().get(`/auth/invite?token=${'x'.repeat(43)}`);
    expect(expired.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(expired.body).toEqual(unknown.body);
  });
});
