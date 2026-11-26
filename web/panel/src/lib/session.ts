import { reactive } from 'vue';
import type { AuthMe, AuthUser } from '../api/types';
import { getCoreClient } from '../api/client';
import { AppError } from '../api/errors';
import { getActiveConnection, activeConnectionId } from './connection-store';
import { clearAuth, setAuthState } from './auth-store';

export type SessionStatus =
  | 'no-connection'
  | 'checking'
  | 'authenticated'
  | 'unauthenticated'
  | 'error';

export interface SessionSnapshot {
  status: SessionStatus;
  me: AuthMe | undefined;
  user: AuthUser | null;
  error: AppError | null;
}

const session = reactive<SessionSnapshot>({
  status: 'checking',
  me: undefined,
  user: null,
  error: null,
});

let inflight: Promise<void> | null = null;

export function sessionSnapshot(): SessionSnapshot {
  return session;
}

function reset(next: SessionStatus): void {
  session.status = next;
  session.me = undefined;
  session.user = null;
  session.error = null;
}

/**
 * 校验 core 会话（HttpOnly cookie）。
 * - 没有连接 → no-connection；
 * - 401 → unauthenticated，并清理本地登录态；
 * - 网络/5xx → error（不跳登录页，避免把 core 故障误判为登出）。
 */
export async function ensureSession(force = false): Promise<void> {
  const connection = getActiveConnection();
  if (connection === undefined) {
    reset('no-connection');
    return;
  }
  if (!force && session.status === 'authenticated') return;
  if (inflight !== null) return inflight;

  session.status = 'checking';
  session.error = null;
  inflight = (async () => {
    try {
      const me = await getCoreClient().auth.me();
      if (me.role !== 'core') {
        throw new AppError('INTERNAL', '连接的不是 MPanel 面板服务', 0, {
          hint: '请填写正确的面板服务地址。',
        });
      }
      session.me = me;
      session.user = me.user ?? null;
      session.status = 'authenticated';
      session.error = null;
      setAuthState(connection.id, {
        authenticated: true,
        authType: me.authType,
        role: 'core',
        user: me.user ?? null,
      });
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError('INTERNAL', error instanceof Error ? error.message : String(error));
      if (appError.status === 401 || appError.code === 'UNAUTHORIZED') {
        session.status = 'unauthenticated';
        session.me = undefined;
        session.user = null;
        session.error = null;
        clearAuth(connection.id);
      } else {
        session.status = 'error';
        session.error = appError;
      }
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function login(username: string, password: string): Promise<void> {
  const connection = getActiveConnection();
  if (connection === undefined) {
    throw new AppError('UNAVAILABLE', '请先填写服务器地址', 0, {
      hint: '在登录页填写服务器、用户名与密码。',
    });
  }
  const result = await getCoreClient().auth.login({ username: username.trim(), password });
  session.me = {
    authenticated: true,
    role: 'core',
    authType: 'session',
    user: result.user,
  };
  session.user = result.user;
  session.status = 'authenticated';
  session.error = null;
  setAuthState(connection.id, {
    authenticated: true,
    authType: 'session',
    role: 'core',
    user: result.user,
  });
}

export async function logout(): Promise<void> {
  try {
    await getCoreClient().auth.logout();
  } finally {
    const id = activeConnectionId.value;
    if (id !== null) clearAuth(id);
    reset('unauthenticated');
  }
}

/** 切换连接时调用：清空上一个连接的会话快照。 */
export function resetSession(): void {
  if (getActiveConnection() === undefined) reset('no-connection');
  else reset('checking');
}
