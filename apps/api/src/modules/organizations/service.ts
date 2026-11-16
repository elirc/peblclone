import type {
  CreateTeamInviteInput,
  InviteCreatedDto,
  InviteDto,
  OrganizationDto,
  OrganizationSummaryDto,
  TeamMemberDto,
  UpdateOrganizationInput,
  UpdateTeamMemberInput,
} from '@meridian/shared';
import { and, asc, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { db } from '../../db/client';
import { countries, invitations, organizations, users, workers } from '../../db/schema';
import { requireOrgId, type Actor } from '../../lib/actor';
import { recordAudit } from '../../lib/audit';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { iso } from '../../lib/http';
import { createInvitation, toInviteDto } from '../../lib/invites';
import { deleteUserSessions } from '../../lib/sessions';

type OrganizationRow = typeof organizations.$inferSelect;

/** Row -> DTO. Explicit field list: a new column is private until someone adds it here. */
function toOrganizationDto(row: OrganizationRow): OrganizationDto {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legalName,
    countryCode: row.countryCode,
    billingEmail: row.billingEmail,
    createdAt: iso(row.createdAt),
  };
}

export async function getOrganization(actor: Actor): Promise<OrganizationDto> {
  const [row] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, requireOrgId(actor)))
    .limit(1);
  if (!row) throw notFound('Organization');
  return toOrganizationDto(row);
}

export async function updateOrganization(
  actor: Actor,
  input: UpdateOrganizationInput,
): Promise<OrganizationDto> {
  const orgId = requireOrgId(actor);
  if (Object.keys(input).length === 0) return getOrganization(actor);

  if (input.countryCode) {
    const [country] = await db
      .select({ code: countries.code })
      .from(countries)
      .where(eq(countries.code, input.countryCode))
      .limit(1);
    if (!country) throw badRequest('Unknown country code', 'unknown_country');
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(organizations)
      .set(input)
      .where(eq(organizations.id, orgId))
      .returning();
    if (!row) throw notFound('Organization');
    await recordAudit(tx, actor, {
      action: 'organization.updated',
      entityType: 'organization',
      entityId: orgId,
      metadata: { fields: Object.keys(input) },
    });
    return toOrganizationDto(row);
  });
}

/** Platform admins only: every client organization with its headcount. */
export async function listOrganizations(): Promise<OrganizationSummaryDto[]> {
  const rows = await db
    .select({ org: organizations, workerCount: count(workers.id) })
    .from(organizations)
    .leftJoin(workers, eq(workers.organizationId, organizations.id))
    .groupBy(organizations.id)
    .orderBy(asc(organizations.name));
  return rows.map((r) => ({ ...toOrganizationDto(r.org), workerCount: r.workerCount }));
}

// ---------- team ----------

/** Teammates = client-side users. Workers with portal logins are not "team". */
export async function listTeam(actor: Actor): Promise<TeamMemberDto[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(eq(users.organizationId, requireOrgId(actor)), ne(users.role, 'worker')))
    .orderBy(asc(users.fullName));
  return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
}

export async function listPendingInvites(actor: Actor): Promise<InviteDto[]> {
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, requireOrgId(actor)),
        isNull(invitations.acceptedAt),
        inArray(invitations.role, ['client_admin', 'client_manager']),
      ),
    )
    .orderBy(desc(invitations.createdAt));
  return rows.map(toInviteDto);
}

export async function inviteTeamMember(
  actor: Actor,
  input: CreateTeamInviteInput,
): Promise<InviteCreatedDto> {
  const orgId = requireOrgId(actor);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);
  if (existing) throw conflict('A user with this email already exists', 'email_taken');

  // One email = one login = one role. Someone who is a worker here gets a WORKER
  // login; making them a teammate as well would strand their worker record
  // (found in review: journal chapter 17).
  const [asWorker] = await db
    .select({ id: workers.id })
    .from(workers)
    .where(and(eq(workers.organizationId, orgId), eq(workers.email, input.email)))
    .limit(1);
  if (asWorker) {
    throw conflict('This email belongs to one of your workers', 'email_belongs_to_worker');
  }

  return db.transaction(async (tx) => {
    // Re-inviting replaces any earlier unaccepted invite for the same address,
    // so there is only ever one live link per person.
    await tx
      .delete(invitations)
      .where(
        and(
          eq(invitations.organizationId, orgId),
          eq(invitations.email, input.email),
          isNull(invitations.acceptedAt),
          // Team invites only: never delete a worker's portal invite from here.
          isNull(invitations.workerId),
        ),
      );
    const { invite, acceptUrl } = await createInvitation(tx, {
      organizationId: orgId,
      email: input.email,
      role: input.role,
      invitedBy: actor.userId,
    });
    await recordAudit(tx, actor, {
      action: 'team.invited',
      entityType: 'invitation',
      entityId: invite.id,
      metadata: { email: input.email, role: input.role },
    });
    return { invite: toInviteDto(invite), acceptUrl };
  });
}

export async function revokeInvite(actor: Actor, inviteId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(invitations)
      .where(
        and(
          eq(invitations.id, inviteId),
          // The tenant filter is part of the WHERE clause itself: an id from
          // another organization simply matches zero rows.
          eq(invitations.organizationId, requireOrgId(actor)),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id, email: invitations.email });
    const [row] = deleted;
    if (!row) throw notFound('Invitation');
    await recordAudit(tx, actor, {
      action: 'team.invite_revoked',
      entityType: 'invitation',
      entityId: row.id,
      metadata: { email: row.email },
    });
  });
}

export async function updateTeamMember(
  actor: Actor,
  userId: string,
  input: UpdateTeamMemberInput,
): Promise<TeamMemberDto> {
  const orgId = requireOrgId(actor);
  if (userId === actor.userId) {
    // Otherwise the last admin can lock the whole organization out.
    throw badRequest('You cannot change your own role or status', 'cannot_modify_self');
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set(input)
      .where(and(eq(users.id, userId), eq(users.organizationId, orgId), ne(users.role, 'worker')))
      .returning();
    if (!row) throw notFound('Team member');

    // Deactivation must bite immediately, not when the session cookie expires.
    if (input.isActive === false) await deleteUserSessions(tx, userId);

    await recordAudit(tx, actor, {
      action: 'team.member_updated',
      entityType: 'user',
      entityId: userId,
      metadata: { ...input },
    });
    return {
      id: row.id,
      email: row.email,
      fullName: row.fullName,
      role: row.role,
      isActive: row.isActive,
      createdAt: iso(row.createdAt),
    };
  });
}
