import type {
  ListResult,
  PageQuery,
  ShellInfo,
  TerminalCreateInput,
  TerminalSession,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export const terminalKeys = {
  shells: () => scopedKey('terminal', 'shells'),
  sessions: (params?: object) => scopedKey('terminal', 'sessions', params ?? {}),
  session: (id: string) => scopedKey('terminal', 'session', id),
};

export interface TerminalApi {
  shells(): Promise<ListResult<ShellInfo>>;
  list(q?: PageQuery): Promise<ListResult<TerminalSession>>;
  create(input: TerminalCreateInput): Promise<TerminalSession>;
  get(id: string): Promise<TerminalSession>;
  close(id: string): Promise<{ closed: true; id: string }>;
}

export function createTerminalApi(http: ApiTransport): TerminalApi {
  const base = (id: string): string => `/terminal/sessions/${encodeURIComponent(id)}`;
  return {
    shells: () => http.request<ListResult<ShellInfo>>('/terminal/shells'),
    list: (q = {}) => http.request<ListResult<TerminalSession>>('/terminal/sessions', { query: q }),
    create: (input) =>
      http.request<TerminalSession>('/terminal/sessions', { method: 'POST', body: input }),
    get: (id) => http.request<TerminalSession>(base(id)),
    close: (id) => http.request<{ closed: true; id: string }>(base(id), { method: 'DELETE' }),
  };
}

export function listShells(): Promise<ListResult<ShellInfo>> {
  return currentClient().terminal.shells();
}

export function listSessions(q: PageQuery = {}): Promise<ListResult<TerminalSession>> {
  return currentClient().terminal.list(q);
}

export function createSession(input: TerminalCreateInput): Promise<TerminalSession> {
  return currentClient().terminal.create(input);
}

export function getSession(id: string): Promise<TerminalSession> {
  return currentClient().terminal.get(id);
}

export function closeSession(id: string): Promise<{ closed: true; id: string }> {
  return currentClient().terminal.close(id);
}
