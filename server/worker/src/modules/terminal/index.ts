import {
  PanelError,
  terminalCreateSchema,
  type ListResult,
  type ShellInfo,
  type TerminalCreateInput,
} from '@mpanel/shared';
import type { WorkerModule } from '../../registry.js';
import { parsePage } from '../../util.js';
import { createTerminalManager, listShells } from './sessions.js';
import { registerTerminalWs } from './ws.js';

const MAX_NAME_LENGTH = 120;

/** Terminal API 模块：prefixes: ['/terminal']。 */
export function createTerminalModule(): WorkerModule {
  return {
    name: 'terminal',
    prefixes: ['/terminal'],
    register(ctx): void {
      const manager = createTerminalManager({ config: ctx.config, logger: ctx.logger });

      registerTerminalWs(ctx.wsBridge, manager);

      ctx.app.addHook('onClose', async () => {
        await manager.dispose();
      });

      ctx.app.get('/terminal/shells', async () => {
        const shells = await listShells(ctx.config);
        const result: ListResult<ShellInfo> =
          shells.length === 0
            ? { available: false, reason: '宿主上未找到可用的 shell', items: [] }
            : { available: true, items: shells, total: shells.length };
        return ok(result);
      });

      ctx.app.get('/terminal/sessions', async (request) => {
        const q = asRecord(request.query);
        const page = parsePage(q);
        const sessions = await manager.list();
        return ok(paginate(sessions, page.limit, page.cursor));
      });

      ctx.app.post('/terminal/sessions', async (request, reply) => {
        const parsed = terminalCreateSchema.safeParse(asRecord(request.body));
        if (!parsed.success) {
          throw validationError(parsed.error.issues);
        }
        const session = await manager.create(parsed.data as TerminalCreateInput);
        reply.code(201);
        return ok(session);
      });

      ctx.app.get('/terminal/sessions/:id', async (request) => {
        const { id } = request.params as { id: string };
        const session = await manager.get(id);
        if (session === undefined) {
          throw new PanelError('NOT_FOUND', '终端会话不存在', { resource: 'terminal_session', id });
        }
        return ok(session);
      });

      ctx.app.patch('/terminal/sessions/:id', async (request) => {
        const { id } = request.params as { id: string };
        const body = asRecord(request.body);
        const rawName = body.name;
        if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
          throw new PanelError('BAD_REQUEST', 'name 必须是字符串或 null', { field: 'name' });
        }
        const name = typeof rawName === 'string' ? rawName : null;
        if (name !== null && name.length > MAX_NAME_LENGTH) {
          throw new PanelError('BAD_REQUEST', `name 不能超过 ${MAX_NAME_LENGTH} 个字符`, {
            field: 'name',
            maxLength: MAX_NAME_LENGTH,
          });
        }
        return ok(await manager.rename(id, name));
      });

      ctx.app.delete('/terminal/sessions/:id', async (request) => {
        const { id } = request.params as { id: string };
        const session = await manager.get(id);
        if (session === undefined) {
          throw new PanelError('NOT_FOUND', '终端会话不存在', { resource: 'terminal_session', id });
        }
        await manager.close(id);
        return ok({ closed: true as const, id });
      });
    },
  };
}

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validationError(issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[]): PanelError {
  return new PanelError('BAD_REQUEST', '请求参数校验失败', {
    issues: issues.map((issue) => ({
      path: issue.path.map((part) => String(part)).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  });
}

function paginate<T>(
  items: T[],
  limit: number,
  cursor: string | undefined,
): ListResult<T> {
  const offset = decodeOffset(cursor);
  const slice = items.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  const result: ListResult<T> = {
    available: true,
    items: slice,
    total: items.length,
  };
  if (nextOffset < items.length && slice.length > 0) {
    result.nextCursor = String(nextOffset);
  }
  return result;
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PanelError('BAD_REQUEST', '无效的分页 cursor', { cursor });
  }
  return parsed;
}
