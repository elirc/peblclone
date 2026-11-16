import { and, eq, gt, lt } from 'drizzle-orm';
import type { CookieOptions, Response } from 'express';
import { config } from '../config';
import { db, type DbOrTx } from '../db/client';
import { sessions } from '../db/schema';
import { generateToken, hashToken } from './crypto';

/**
 * Server-side sessions (ADR 0004).
 *
 * The browser holds an opaque random token in an httpOnly cookie; the database
 * holds its SHA-256. Logging out — or an admin deactivating a user — deletes
 * the row and the session is dead immediately. That instant revocation is the
 * main thing a stateless JWT cannot give you.
 */
export const SESSION_COOKIE = 'meridian_session';

const cookieOptions = (): CookieOptions => ({
  httpOnly: true, // JavaScript cannot read it, so XSS cannot steal it
  sameSite: 'lax', // not sent on cross-site POSTs: the first CSRF defence
  secure: config.isProduction, // HTTPS only in production
  path: '/',
  maxAge: config.sessionTtlMs,
});

export async function createSession(
  dbOrTx: DbOrTx,
  userId: string,
  userAgent: string | undefined,
): Promise<string> {
  const token = generateToken();
  await dbOrTx.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    userAgent: userAgent?.slice(0, 300),
    expiresAt: new Date(Date.now() + config.sessionTtlMs),
  });
  return token;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  const { maxAge: _maxAge, ...rest } = cookieOptions();
  res.clearCookie(SESSION_COOKIE, rest);
}

export async function findSession(token: string) {
  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/** Kill every session a user has — used when they are deactivated. */
export async function deleteUserSessions(dbOrTx: DbOrTx, userId: string): Promise<void> {
  await dbOrTx.delete(sessions).where(eq(sessions.userId, userId));
}

export async function deleteExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
