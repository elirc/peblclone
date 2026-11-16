import type {
  AcceptInviteInput,
  InvitePreviewDto,
  LoginInput,
  RegisterInput,
  SessionUser,
} from '@meridian/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { db } from '../../db/client';
import { countries, invitations, organizations, users, workers } from '../../db/schema';
import { recordAudit } from '../../lib/audit';
import { getDummyHash, hashPassword, hashToken, verifyPassword } from '../../lib/crypto';
import { badRequest, conflict, isUniqueViolation, notFound, unauthorized } from '../../lib/errors';
import { createRateLimiter } from '../../lib/rate-limit';
import { createSession } from '../../lib/sessions';

/** 10 attempts per 5 minutes per (ip, email). See lib/rate-limit.ts for the caveats. */
export const loginLimiter = createRateLimiter({ limit: 10, windowMs: 5 * 60 * 1000 });

interface AuthResult {
  user: SessionUser;
  /** Plaintext session token — goes into the cookie and nowhere else. */
  sessionToken: string;
}

/** Load the public view of a user. This is the ONLY shape of user that leaves the API. */
export async function getSessionUser(userId: string): Promise<SessionUser> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      organizationId: users.organizationId,
      organizationName: organizations.name,
      workerId: workers.id,
    })
    .from(users)
    .leftJoin(organizations, eq(organizations.id, users.organizationId))
    .leftJoin(workers, eq(workers.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw unauthorized();
  return row;
}

/**
 * Self-serve signup: creates the organization AND its first admin in one
 * transaction. If the email is taken, neither row is left behind.
 */
export async function register(input: RegisterInput, userAgent?: string): Promise<AuthResult> {
  const [country] = await db
    .select({ code: countries.code })
    .from(countries)
    .where(eq(countries.code, input.countryCode))
    .limit(1);
  if (!country) throw badRequest('Unknown country code', 'unknown_country');

  const passwordHash = await hashPassword(input.password);

  try {
    const { userId, sessionToken } = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({
          name: input.organizationName,
          legalName: input.organizationName,
          countryCode: input.countryCode,
          billingEmail: input.email,
        })
        .returning({ id: organizations.id });
      if (!org) throw new Error('Failed to create organization');

      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          fullName: input.fullName,
          role: 'client_admin',
          organizationId: org.id,
        })
        .returning({ id: users.id });
      if (!user) throw new Error('Failed to create user');

      await recordAudit(
        tx,
        { userId: user.id, organizationId: org.id },
        { action: 'organization.registered', entityType: 'organization', entityId: org.id },
      );
      const token = await createSession(tx, user.id, userAgent);
      return { userId: user.id, sessionToken: token };
    });
    return { user: await getSessionUser(userId), sessionToken };
  } catch (err) {
    // The unique index is the real guard against duplicates (a "does it exist?"
    // SELECT beforehand would race). We just translate the constraint error.
    if (isUniqueViolation(err, 'users_email_unique')) {
      throw conflict('An account with this email already exists', 'email_taken');
    }
    throw err;
  }
}

export async function login(input: LoginInput, ip: string, userAgent?: string): Promise<AuthResult> {
  const limiterKey = `${ip}:${input.email}`;
  loginLimiter.hit(limiterKey);

  const [user] = await db
    .select({ id: users.id, passwordHash: users.passwordHash, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  // Always run one scrypt verification, even for an unknown email, so response
  // time does not reveal which emails have accounts.
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));

  // One message for every failure. "No such user" vs "wrong password" would be
  // a free account-enumeration oracle.
  if (!user || !passwordOk || !user.isActive) {
    throw unauthorized('Invalid email or password');
  }

  loginLimiter.clear(limiterKey);
  const sessionToken = await createSession(db, user.id, userAgent);
  return { user: await getSessionUser(user.id), sessionToken };
}

async function findLiveInvitation(token: string) {
  const [invite] = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  // Expired, used and never-existed all look the same from outside.
  if (!invite) throw notFound('Invitation');
  return invite;
}

export async function previewInvite(token: string): Promise<InvitePreviewDto> {
  const invite = await findLiveInvitation(token);
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invite.organizationId))
    .limit(1);
  let suggestedName: string | null = null;
  if (invite.workerId) {
    const [worker] = await db
      .select({ firstName: workers.firstName, lastName: workers.lastName })
      .from(workers)
      .where(eq(workers.id, invite.workerId))
      .limit(1);
    if (worker) suggestedName = `${worker.firstName} ${worker.lastName}`;
  }
  return {
    email: invite.email,
    organizationName: org?.name ?? '',
    role: invite.role,
    suggestedName,
  };
}

/** Turn an invitation into a real user (and link the worker record for portal invites). */
export async function acceptInvite(input: AcceptInviteInput, userAgent?: string): Promise<AuthResult> {
  const invite = await findLiveInvitation(input.token);
  const passwordHash = await hashPassword(input.password);

  try {
    const { userId, sessionToken } = await db.transaction(async (tx) => {
      // Claim the invite first, conditionally. If two requests race with the
      // same token, exactly one UPDATE matches a row; the other gets nothing.
      const claimed = await tx
        .update(invitations)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invitations.id, invite.id), isNull(invitations.acceptedAt)))
        .returning({ id: invitations.id });
      if (claimed.length === 0) throw notFound('Invitation');

      const [user] = await tx
        .insert(users)
        .values({
          email: invite.email,
          passwordHash,
          fullName: input.fullName,
          role: invite.role,
          organizationId: invite.organizationId,
        })
        .returning({ id: users.id });
      if (!user) throw new Error('Failed to create user');

      if (invite.workerId) {
        await tx.update(workers).set({ userId: user.id }).where(eq(workers.id, invite.workerId));
      }
      await recordAudit(
        tx,
        { userId: user.id, organizationId: invite.organizationId },
        {
          action: 'invitation.accepted',
          entityType: 'user',
          entityId: user.id,
          metadata: { role: invite.role },
        },
      );
      const token = await createSession(tx, user.id, userAgent);
      return { userId: user.id, sessionToken: token };
    });
    return { user: await getSessionUser(userId), sessionToken };
  } catch (err) {
    if (isUniqueViolation(err, 'users_email_unique')) {
      throw conflict('An account with this email already exists', 'email_taken');
    }
    throw err;
  }
}
