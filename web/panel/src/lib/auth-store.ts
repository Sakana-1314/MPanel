import { computed, reactive } from 'vue';
import type { AuthUser } from '../api/types';

export interface AuthState {
  authenticated: boolean;
  authType: 'session' | 'token' | null;
  role: 'core' | null;
  user: AuthUser | null;
}

export const EMPTY_AUTH: AuthState = {
  authenticated: false,
  authType: null,
  role: null,
  user: null,
};

const state = reactive<{ byConnection: Record<string, AuthState> }>({ byConnection: {} });

export function getAuthState(connectionId: string | null | undefined): AuthState {
  if (connectionId === null || connectionId === undefined) return EMPTY_AUTH;
  return state.byConnection[connectionId] ?? EMPTY_AUTH;
}

export function setAuthState(connectionId: string, next: AuthState): void {
  state.byConnection[connectionId] = next;
}

export function clearAuth(connectionId?: string): void {
  if (connectionId === undefined) {
    for (const key of Object.keys(state.byConnection)) delete state.byConnection[key];
    return;
  }
  delete state.byConnection[connectionId];
}

export function useAuthState(connectionId: () => string | null | undefined) {
  return computed(() => getAuthState(connectionId()));
}
