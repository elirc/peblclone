import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse, mockFetch, renderApp, signedOut } from '../../test/render';
import { LoginPage } from './LoginPage';

afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('validates in the browser before calling the API', async () => {
    const { calls } = mockFetch(signedOut);
    renderApp(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/work email/i), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    // Nothing was sent: the only request so far is the initial "who am I?".
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('sends normalised credentials and shows the server error on failure', async () => {
    const { calls } = mockFetch(signedOut, ({ url, method }) =>
      method === 'POST' && url.endsWith('/auth/login')
        ? jsonResponse({ error: { code: 'unauthorized', message: 'Invalid email or password' } }, 401)
        : undefined,
    );
    renderApp(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/work email/i), '  Ada@Example.COM ');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    const login = calls.find((c) => c.method === 'POST');
    // The shared schema trimmed and lower-cased the email before it left the browser.
    expect(login?.body).toEqual({ email: 'ada@example.com', password: 'wrong-password' });
  });

  it('disables the button while the request is in flight', async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((resolve) => (release = resolve));
    mockFetch(signedOut);
    const base = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/auth/login') ? pending : base(input, init),
    );
    renderApp(<LoginPage />);

    await userEvent.type(screen.getByLabelText(/work email/i), 'ada@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'a-long-password');
    const button = screen.getByRole('button', { name: /sign in/i });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    release(jsonResponse({ error: { code: 'unauthorized', message: 'Invalid email or password' } }, 401));
    await waitFor(() => expect(button).toBeEnabled());
  });
});
