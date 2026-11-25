import { PanelError } from '@mpanel/shared';
import type { WsTicket } from '@mpanel/shared';
import type { AuthContext } from './types.js';
import { normalizeTicketPath, randomToken } from './types.js';

export interface TicketStore {
  issue(input: {
    auth: AuthContext;
    path: string;
    machineId?: string;
    ttlSec?: number;
  }): WsTicket;
  consume(ticket: string, path: string): AuthContext;
  sweep(): void;
}

interface TicketRecord {
  auth: AuthContext;
  /** 规范化后的业务路径（已剔除 ticket/token 并排序 query）。 */
  path: string;
  machineId?: string;
  purpose: 'ws' | 'proxy-ws';
  expiresAtMs: number;
}

const DEFAULT_TICKET_TTL_SEC = 60;

function unauthorized(message: string, reason: string): PanelError {
  return new PanelError('UNAUTHORIZED', message, { reason });
}

/**
 * 一次性 WS ticket：默认 60 秒，绑定身份、machineId 与规范化路径。
 * 全部保存在内存中；consume 会先删除再校验，确保重放必然失败。
 */
export function createTicketStore(): TicketStore {
  const tickets = new Map<string, TicketRecord>();

  function sweepInternal(now = Date.now()): void {
    for (const [ticket, record] of tickets) {
      if (record.expiresAtMs <= now) tickets.delete(ticket);
    }
  }

  return {
    issue(input) {
      const now = Date.now();
      sweepInternal(now);
      const ttlSec = Math.max(1, input.ttlSec ?? DEFAULT_TICKET_TTL_SEC);
      const ticket = randomToken(32);
      const normalized = normalizeTicketPath(input.path);
      const purpose = normalized.startsWith('/api/v1/machines/') ? 'proxy-ws' : 'ws';
      const expiresAtMs = now + ttlSec * 1000;
      const record: TicketRecord = {
        auth: input.auth,
        path: normalized,
        purpose,
        expiresAtMs,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      };
      tickets.set(ticket, record);
      return {
        ticket,
        expiresAt: new Date(expiresAtMs).toISOString(),
        path: input.path,
        ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
      };
    },

    consume(ticket, path) {
      const record = tickets.get(ticket);
      if (record === undefined) throw unauthorized('WS 票据无效或已使用', 'ticket_invalid');
      // 一次性：无论后续校验是否通过都先移除。
      tickets.delete(ticket);
      if (record.expiresAtMs <= Date.now()) {
        throw unauthorized('WS 票据已过期', 'ticket_expired');
      }
      const normalized = normalizeTicketPath(path);
      if (normalized !== record.path) {
        throw unauthorized('WS 票据与请求路径不匹配', 'ticket_path_mismatch');
      }
      return record.auth;
    },

    sweep() {
      sweepInternal();
    },
  };
}
