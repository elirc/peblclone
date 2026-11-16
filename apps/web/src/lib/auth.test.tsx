import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, renderApp, signedOut } from '../test/render';
import { useAuth } from './auth';

afterEach(() => vi.unstubAllGlobals());

const ada = {
  id: 'u1',
  email: 'ada@example.com',
  fullName: 'Ada Lovelace',
  role: 'client_admin',
  organizationId: 'o1',
  organizationName: 'Acme',
  workerId: null,
};

/** Shows who the app thinks is signed in, with buttons to sign in and out. */
function Probe() {
  const { user, isLoading, login, logout } = useAuth();
  if (isLoading) return <p>loading</p>;
  return (
    <div>
      <p data-testid="who">{user ? user.email : 'nobody'}</p>
      <button onClick={() => void login({ email: 'ada@example.com', password: 'x' })}>in</button>
      <button onClick={() => void logout()}>out</button>
    </div>
  );
}

describe('AuthProvider', () => {
  // Regression: login() used queryClient.clear(), which detached the mounted
  // "who am I" query — the app showed "nobody" right after a successful login
  // and bounced the user back to the login screen. Found in a real browser.
  it('knows who you are immediately after a successful login, without a reload', async () => {
    mockFetch(signedOut, ({ url, method }) =>
      method === 'POST' && url.endsWith('/auth/login') ? jsonResponse({ user: ada }) : undefined,
    );
    renderApp(<Probe />);
    expect(await screen.findByTestId('who')).toHaveTextContent('nobody');

    await userEvent.click(screen.getByRole('button', { name: 'in' }));

    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('ada@example.com'));
  });

  it('forgets you immediately after logout', async () => {
    mockFetch(({ url, method }) => {
      if (url.endsWith('/auth/me')) return jsonResponse({ user: ada });
      if (method === 'POST' && url.endsWith('/auth/logout')) return jsonResponse(null, 204);
      return undefined;
    });
    renderApp(<Probe />);
    expect(await screen.findByTestId('who')).toHaveTextContent('ada@example.com');

    await userEvent.click(screen.getByRole('button', { name: 'out' }));

    await waitFor(() => expect(screen.getByTestId('who')).toHaveTextContent('nobody'));
  });
});
