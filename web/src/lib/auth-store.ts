import { create } from 'zustand';
import type { AuthUser } from '../api/types';

export interface AuthState {
  authenticated: boolean;
  authType: 'session' | 'token' | null;
  role: 'core' | 'worker' | null;
  user: AuthUser | null;
}

const initialState: AuthState = {
  authenticated: false,
  authType: null,
  role: null,
  user: null,
};

interface AuthStoreState {
  byConnection: Record<string, AuthState>;
  set(connectionId: string, state: AuthState): void;
  clear(connectionId?: string): void;
}

/** 登录态按连接 id 记录；只存用户信息，绝不存密码。 */
export const useAuthStore = create<AuthStoreState>()((set) => ({
  byConnection: {},
  set: (connectionId, state) =>
    set((current) => ({ byConnection: { ...current.byConnection, [connectionId]: state } })),
  clear: (connectionId) =>
    set((current) => {
      if (connectionId === undefined) return { byConnection: {} };
      const next = { ...current.byConnection };
      delete next[connectionId];
      return { byConnection: next };
    }),
}));

export function getAuthState(connectionId: string): AuthState {
  return useAuthStore.getState().byConnection[connectionId] ?? initialState;
}

export function setAuthState(connectionId: string, state: AuthState): void {
  useAuthStore.getState().set(connectionId, state);
}

export function clearAuth(connectionId?: string): void {
  useAuthStore.getState().clear(connectionId);
}

/** React 订阅版本。 */
export function useAuthState(connectionId: string | null | undefined): AuthState {
  return useAuthStore((state) =>
    connectionId === null || connectionId === undefined
      ? initialState
      : (state.byConnection[connectionId] ?? initialState),
  );
}
