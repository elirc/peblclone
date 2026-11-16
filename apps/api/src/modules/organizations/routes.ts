import {
  createTeamInviteSchema,
  updateOrganizationSchema,
  updateTeamMemberSchema,
} from '@meridian/shared';
import { Router } from 'express';
import { getActor } from '../../lib/actor';
import { parseBody, uuidParam } from '../../lib/http';
import { authenticate, requireAdmin, requirePlatformAdmin, requireStaff } from '../../middleware/auth';
import * as service from './service';

export const organizationsRouter = Router();

organizationsRouter.get('/organization', authenticate, async (req, res) => {
  res.json(await service.getOrganization(getActor(req)));
});

organizationsRouter.patch('/organization', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(updateOrganizationSchema, req);
  res.json(await service.updateOrganization(getActor(req), input));
});

organizationsRouter.get(
  '/admin/organizations',
  authenticate,
  requirePlatformAdmin,
  async (_req, res) => {
    res.json({ items: await service.listOrganizations() });
  },
);

organizationsRouter.get('/team', authenticate, requireStaff, async (req, res) => {
  res.json({ items: await service.listTeam(getActor(req)) });
});

organizationsRouter.get('/team/invites', authenticate, requireAdmin, async (req, res) => {
  res.json({ items: await service.listPendingInvites(getActor(req)) });
});

organizationsRouter.post('/team/invites', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(createTeamInviteSchema, req);
  res.status(201).json(await service.inviteTeamMember(getActor(req), input));
});

organizationsRouter.delete('/team/invites/:id', authenticate, requireAdmin, async (req, res) => {
  await service.revokeInvite(getActor(req), uuidParam(req));
  res.status(204).end();
});

organizationsRouter.patch('/team/:id', authenticate, requireAdmin, async (req, res) => {
  const input = parseBody(updateTeamMemberSchema, req);
  res.json(await service.updateTeamMember(getActor(req), uuidParam(req), input));
});
