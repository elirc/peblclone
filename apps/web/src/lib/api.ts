import type { ApiErrorBody } from '@meridian/shared';

/**
 * The ONLY place in the web app that calls `fetch`.
 *
 * Every page goes through `api.get/post/…`, which means auth, error shape,
 * JSON handling and the platform-admin tenant header are handled once.
 */

/** An error response from the API, with the server's stable `code`. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const isApiError = (err: unknown): err is ApiError => err instanceof ApiError;

/** A message safe to show a user, whatever was thrown. */
export function errorMessage(err: unknown): string {
  if (isApiError(err)) return err.message;
  return 'Something went wrong. Please try again.';
}

// ----- platform admins: which tenant are we working in? -----
const ACTING_ORG_KEY = 'meridian.actingOrgId';

export function getActingOrgId(): string | null {
  try {
    return window.localStorage.getItem(ACTING_ORG_KEY);
  } catch {
    return null;
  }
}

export function setActingOrgId(orgId: string | null): void {
  try {
    if (orgId) window.localStorage.setItem(ACTING_ORG_KEY, orgId);
    else window.localStorage.removeItem(ACTING_ORG_KEY);
  } catch {
    // Storage can be unavailable (private mode); the header is simply not sent.
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

function buildUrl(path: string, params?: Params): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return `/api/v1${path}${qs ? `?${qs}` : ''}`;
}

/** Called when any request comes back 401, so the app can drop to the login screen. */
let onUnauthorized: (() => void) | undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function send(
  method: string,
  path: string,
  options: { params?: Params; body?: unknown } = {},
) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const actingOrgId = getActingOrgId();
  // Harmless for non-admins: the API ignores this header unless you are a platform admin.
  if (actingOrgId) headers['X-Org-Id'] = actingOrgId;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.params), {
      method,
      headers,
      credentials: 'same-origin', // send the session cookie
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection.');
  }

  if (!response.ok) {
    let body: Partial<ApiErrorBody> = {};
    try {
      body = (await response.json()) as Partial<ApiErrorBody>;
    } catch {
      // Non-JSON error (e.g. a proxy's HTML 502 page).
    }
    if (response.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiError(
      response.status,
      body.error?.code ?? 'unknown_error',
      body.error?.message ?? `Request failed (${response.status})`,
      body.error?.details,
    );
  }
  return response;
}

async function json<T>(
  method: string,
  path: string,
  options?: { params?: Params; body?: unknown },
) {
  const response = await send(method, path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, params?: Params) => json<T>('GET', path, { params }),
  post: <T>(path: string, body?: unknown) => json<T>('POST', path, { body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => json<T>('PATCH', path, { body }),
  delete: <T = void>(path: string) => json<T>('DELETE', path),
  /** Fetch a binary file (e.g. an uploaded document) as a Blob. */
  blob: async (path: string) => (await send('GET', path)).blob(),
};

/** Save a Blob to the user's disk with a given file name. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Read a File as base64 (without the `data:…;base64,` prefix) for JSON upload. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}
