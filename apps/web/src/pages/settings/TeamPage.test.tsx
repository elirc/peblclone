import type { InviteDto, TeamMemberDto } from '@meridian/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch } from '../../test/render';
import { makeUser, polyfillDialog, renderPage, route, signedInAs } from '../payroll/test-fixtures';
import TeamPage from './TeamPage';

beforeAll(polyfillDialog);
afterEach(() => vi.unstubAllGlobals());

const admin = makeUser('client_admin');
const members: TeamMemberDto[] = [
  { id: admin.id, email: admin.email, fullName: admin.fullName, role: 'client_admin', isActive: true, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'm2', email: 'mo@example.com', fullName: 'Mo Manager', role: 'client_manager', isActive: true, createdAt: '2026-02-01T00:00:00.000Z' },
];
const invite: InviteDto = {
  id: 'inv1',
  email: 'new@example.com',
  role: 'client_manager',
  workerId: null,
  expiresAt: '2099-01-01T00:00:00.000Z',
  acceptedAt: null,
  createdAt: '2026-03-01T00:00:00.000Z',
};

const team = route('GET', '/team', () => jsonResponse({ items: members }));
const invites = route('GET', '/team/invites', () => jsonResponse({ items: [invite] }));

describe('TeamPage', () => {
  it('lets an admin manage others but never their own row', async () => {
    mockFetch(signedInAs(admin), team, invites);
    renderPage(<TeamPage />, { path: '/team', pattern: '/team' });

    expect(await screen.findByRole('button', { name: 'Deactivate Mo Manager' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Role for Mo Manager' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Deactivate ${admin.fullName}` })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: `Role for ${admin.fullName}` })).not.toBeInTheDocument();
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
  });

  it('shows a manager the team read-only and never requests invites', async () => {
    const { calls } = mockFetch(signedInAs(makeUser('client_manager', { id: 'm2' })), team);
    renderPage(<TeamPage />, { path: '/team', pattern: '/team' });

    expect(await screen.findByText('Mo Manager')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /deactivate/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite teammate' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/team/invites'))).toBe(false);
  });

  it('deactivates a teammate after confirmation', async () => {
    const { calls } = mockFetch(
      signedInAs(admin),
      team,
      invites,
      route('PATCH', '/team/m2', () => jsonResponse({ ...members[1], isActive: false })),
    );
    renderPage(<TeamPage />, { path: '/team', pattern: '/team' });

    await userEvent.click(await screen.findByRole('button', { name: 'Deactivate Mo Manager' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Mo Manager?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ isActive: false }));
  });

  it('shows the accept link after creating an invite, noting that no email is sent', async () => {
    const { calls } = mockFetch(
      signedInAs(admin),
      team,
      invites,
      route('POST', '/team/invites', () =>
        jsonResponse(
          {
            invite: { ...invite, id: 'inv2', email: 'sam@example.com', role: 'client_admin' },
            acceptUrl: 'http://localhost:5173/accept-invite?token=abc123abc123abc123abc123',
          },
          201,
        ),
      ),
    );
    renderPage(<TeamPage />, { path: '/team', pattern: '/team' });

    await userEvent.click(await screen.findByRole('button', { name: 'Invite teammate' }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a teammate' });
    await userEvent.type(within(dialog).getByLabelText(/work email/i), 'Sam@Example.com');
    await userEvent.selectOptions(within(dialog).getByLabelText(/role/i), 'client_admin');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create invite' }));

    const done = await screen.findByRole('dialog', { name: 'Invitation created' });
    expect(within(done).getByText('No email is sent')).toBeInTheDocument();
    expect(within(done).getByLabelText('Invite link')).toHaveValue(
      'http://localhost:5173/accept-invite?token=abc123abc123abc123abc123',
    );
    expect(within(done).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'sam@example.com', role: 'client_admin' });
  });
});
