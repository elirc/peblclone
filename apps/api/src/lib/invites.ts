import type { InviteDto, UserRole } from '@meridian/shared';
import { config } from '../config';
import type { DbOrTx } from '../db/client';
import { invitations } from '../db/schema';
import { generateToken, hashToken } from './crypto';
import { iso } from './http';

export type InvitationRow = typeof invitations.$inferSelect;

export function toInviteDto(row: InvitationRow): InviteDto {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    workerId: row.workerId,
    expiresAt: iso(row.expiresAt),
    acceptedAt: iso(row.acceptedAt),
    createdAt: iso(row.createdAt),
  };
}

/** The link a human opens to set their password. Only the web app knows this route. */
export function buildAcceptUrl(token: string): string {
  return `${config.webOrigin}/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * Create an invitation and return the ONE-TIME plaintext token.
 * Only the hash is stored, so the link cannot be recovered later — a new
 * invite must be issued instead. (Same idea as password-reset tokens.)
 *
 * Used for teammates (role client_admin/client_manager) and for worker portal
 * access (role 'worker' + workerId).
 */
export async function createInvitation(
  dbOrTx: DbOrTx,
  input: {
    organizationId: string;
    email: string;
    role: UserRole;
    workerId?: string | null;
    invitedBy: string | null;
  },
): Promise<{ invite: InvitationRow; token: string; acceptUrl: string }> {
  const token = generateToken();
  const [invite] = await dbOrTx
    .insert(invitations)
    .values({
      organizationId: input.organizationId,
      email: input.email,
      role: input.role,
      workerId: input.workerId ?? null,
      invitedBy: input.invitedBy,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + config.inviteTtlMs),
    })
    .returning();
  if (!invite) throw new Error('Failed to create invitation');
  return { invite, token, acceptUrl: buildAcceptUrl(token) };
}
