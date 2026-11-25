import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { AuthMe } from '../api/types';
import { AppError } from '../api/errors';
import { getClient } from '../api/client';
import { authKeys } from '../api/auth';
import { clearAuth, setAuthState, useAuthState } from './auth-store';
import { useActiveConnection } from './connection-store';

export type SessionStatus =
  | 'no-connection'
  | 'no-credentials'
  | 'checking'
  | 'authenticated'
  | 'unauthenticated'
  | 'error';

export interface SessionState {
  status: SessionStatus;
  me: AuthMe | undefined;
  error: Error | null;
  refetch(): void;
}

/**
 * 当前连接的登录态：
 * - core：cookie/session，/auth/me 走连接根（不会代理到 worker）；
 * - worker：Bearer token，没有 token 时直接视为未认证。
 */
export function useSession(): SessionState {
  const connection = useActiveConnection();
  const cached = useAuthState(connection?.id);
  const hasToken = connection !== undefined && (connection.token ?? '').length > 0;
  const enabled = connection !== undefined && (connection.kind === 'core' || hasToken);

  const query = useQuery<AuthMe, Error>({
    queryKey: authKeys.me(),
    queryFn: () => getClient().auth.me(),
    enabled,
    retry: (failureCount, error) => {
      if (error instanceof AppError && error.status === 401) return false;
      return failureCount < 1;
    },
    staleTime: 60_000,
    refetchOnMount: 'always',
  });

  const connectionId = connection?.id;
  const authType = query.data?.authType;
  const role = query.data?.role;
  const user = query.data?.user ?? null;

  useEffect(() => {
    if (connectionId === undefined || query.data === undefined) return;
    setAuthState(connectionId, {
      authenticated: true,
      authType: query.data.authType,
      role: query.data.role,
      user: query.data.user ?? null,
    });
  }, [connectionId, query.data]);

  useEffect(() => {
    if (connectionId === undefined || query.error === null) return;
    if (query.error instanceof AppError && query.error.status === 401) clearAuth(connectionId);
  }, [connectionId, query.error]);

  let status: SessionStatus;
  if (connection === undefined) status = 'no-connection';
  else if (!enabled) status = 'no-credentials';
  else if (query.data !== undefined) status = 'authenticated';
  else if (query.error instanceof AppError && query.error.status === 401) status = 'unauthenticated';
  else if (query.error !== null) status = 'error';
  else if (query.isLoading) status = 'checking';
  else if (cached.authenticated) status = 'authenticated';
  else status = 'checking';

  return {
    status,
    me: query.data,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
