import type {
  AuthMe,
  ChangePasswordInput,
  LoginInput,
  LoginResult,
  WsTicket,
  WsTicketRequest,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export const authKeys = {
  me: () => scopedKey('auth', 'me'),
};

export interface AuthApi {
  me(): Promise<AuthMe>;
  login(input: LoginInput): Promise<LoginResult>;
  logout(): Promise<{ ok: true }>;
  changePassword(input: ChangePasswordInput): Promise<{ ok: true }>;
  wsTicket(input: WsTicketRequest): Promise<WsTicket>;
}

/** 认证端点固定走连接根 /api/v1（core 代理路径下没有 /auth/*）。 */
export function createAuthApi(http: ApiTransport): AuthApi {
  return {
    me: () => http.requestRoot<AuthMe>('/auth/me'),
    login: (input) => http.requestRoot<LoginResult>('/auth/login', { method: 'POST', body: input }),
    logout: () => http.requestRoot<{ ok: true }>('/auth/logout', { method: 'POST', body: {} }),
    changePassword: (input) =>
      http.requestRoot<{ ok: true }>('/auth/password', { method: 'POST', body: input }),
    wsTicket: (input) =>
      http.requestRoot<WsTicket>('/auth/ws-ticket', { method: 'POST', body: input }),
  };
}

export function workerMe(): Promise<AuthMe> {
  return currentClient().auth.me();
}

export function coreLogin(input: LoginInput): Promise<LoginResult> {
  return currentClient().auth.login(input);
}

export function coreLogout(): Promise<{ ok: true }> {
  return currentClient().auth.logout();
}

export function coreMe(): Promise<AuthMe> {
  return currentClient().auth.me();
}

export function changePassword(input: ChangePasswordInput): Promise<{ ok: true }> {
  return currentClient().auth.changePassword(input);
}

export function requestWsTicket(input: WsTicketRequest): Promise<WsTicket> {
  return currentClient().auth.wsTicket(input);
}
