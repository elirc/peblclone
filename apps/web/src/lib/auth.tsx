import type {
  AcceptInviteInput,
  AuthResponse,
  LoginInput,
  RegisterInput,
  SessionUser,
} from '@meridian/shared';
import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getActingOrgId, isApiError, setActingOrgId, setUnauthorizedHandler } from './api';
import { keys, queryClient } from './query';

interface AuthContextValue {
  /** null = definitely logged out. */
  user: SessionUser | null;
  /** True only during the very first "who am I?" check. */
  isLoading: boolean;
  login(input: LoginInput): Promise<SessionUser>;
  register(input: RegisterInput): Promise<SessionUser>;
  acceptInvite(input: AcceptInviteInput): Promise<SessionUser>;
  logout(): Promise<void>;
  /** Platform admins: the tenant currently being worked in. */
  actingOrgId: string | null;
  setActingOrg(orgId: string | null): void;
  /** The tenant requests will run against (own org, or the acting org for platform admins). */
  hasOrgContext: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchMe(): Promise<SessionUser | null> {
  try {
    return (await api.get<AuthResponse>('/auth/me')).user;
  } catch (err) {
    // "Not logged in" is an answer, not an error.
    if (isApiError(err) && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({ queryKey: keys.me, queryFn: fetchMe, staleTime: 60_000 });
  const [actingOrgId, setActingOrgState] = useState<string | null>(() => getActingOrgId());

  // If any request anywhere returns 401 (session expired / revoked), drop to logged-out.
  useEffect(() => {
    setUnauthorizedHandler(() => queryClient.setQueryData(keys.me, null));
  }, []);

  /** After any change of identity or tenant, every cached answer is suspect: start clean. */
  const signIn = useCallback((user: SessionUser) => {
    queryClient.clear();
    queryClient.setQueryData(keys.me, user);
    return user;
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const user = data ?? null;
    return {
      user,
      isLoading,
      login: async (input) => signIn((await api.post<AuthResponse>('/auth/login', input)).user),
      register: async (input) => signIn((await api.post<AuthResponse>('/auth/register', input)).user),
      acceptInvite: async (input) =>
        signIn((await api.post<AuthResponse>('/auth/accept-invite', input)).user),
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } finally {
          setActingOrgId(null);
          setActingOrgState(null);
          queryClient.clear();
          queryClient.setQueryData(keys.me, null);
        }
      },
      actingOrgId,
      setActingOrg: (orgId) => {
        setActingOrgId(orgId);
        setActingOrgState(orgId);
        // Different tenant = different data for every query.
        const me = queryClient.getQueryData(keys.me);
        queryClient.clear();
        queryClient.setQueryData(keys.me, me);
      },
      hasOrgContext: Boolean(user && (user.organizationId || actingOrgId)),
    };
  }, [data, isLoading, actingOrgId, signIn]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** The logged-in user. Only call inside routes that are behind <RequireAuth>. */
export function useUser(): SessionUser {
  const { user } = useAuth();
  if (!user) throw new Error('useUser called while logged out');
  return user;
}

// Role helpers mirror the API's (apps/api/src/lib/actor.ts). They only decide what to
// SHOW — the server enforces every rule regardless of what the UI renders.
export const isWorkerRole = (user: SessionUser) => user.role === 'worker';
export const isStaffRole = (user: SessionUser) => user.role !== 'worker';
export const isAdminRole = (user: SessionUser) =>
  user.role === 'client_admin' || user.role === 'platform_admin';
export const isPlatformAdminRole = (user: SessionUser) => user.role === 'platform_admin';
