import { createHash, randomBytes } from 'node:crypto';
import {
  edgeEnrollResultSchema,
  PanelError,
  type EdgeEnrollResult,
} from '@mpanel/shared';
import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';
import { workerVersion } from '../registry.js';
import {
  readEdgeIdentity,
  removeEdgeIdentity,
  writeEdgeIdentity,
  type EdgeIdentity,
} from './identity.js';

/**
 * Edge enrollment client (docs/api-contract.md §5.4, worker side).
 *
 * MPANEL_CORE_URL is the core HTTP(S) base; the worker derives both the
 * enroll URL and the `/ws/worker` ws(s) URL itself. No tunnel frame changes.
 */

const ENROLL_TIMEOUT_MS = 10_000;
const ENROLL_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

export interface EdgeIdentityState {
  identity: EdgeIdentity | null;
  /** True when `MPANEL_EDGE_KEY` is set and the transport is reverse-ws. */
  enabled: boolean;
}

export function isEdgeMode(config: WorkerConfig): boolean {
  return config.transport === 'reverse-ws' && config.edgeKey !== undefined;
}

/** `http://host:port[/base]` → `http(s)://host:port[/base]/api/v1/edge/enroll`. */
export function enrollUrlFor(coreUrl: string): string {
  const url = parseCoreUrl(coreUrl);
  let pathname = stripTrailingSlash(url.pathname);
  if (pathname.endsWith('/ws/worker')) pathname = pathname.slice(0, -'/ws/worker'.length);
  url.pathname = `${pathname}/api/v1/edge/enroll`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/** `http://host:port[/base]` → `ws(s)://host:port[/base]/ws/worker`. */
export function wsUrlFor(coreUrl: string): string {
  const url = parseCoreUrl(coreUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  let pathname = stripTrailingSlash(url.pathname);
  if (pathname.endsWith('/ws/worker')) pathname = pathname.slice(0, -'/ws/worker'.length);
  url.pathname = `${pathname}/ws/worker`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function fingerprintEdgeKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Reuses `$MPANEL_HOME/edge.json` when the key fingerprint matches; otherwise
 * enrolls with the key and persists the new identity. Mutates `config` so the
 * existing reverse-ws transport dials with the enrolled secret.
 */
export async function ensureEdgeIdentity(
  config: WorkerConfig,
  logger: WorkerLogger,
): Promise<EdgeIdentity> {
  const key = config.edgeKey;
  if (key === undefined) {
    throw new PanelError('BAD_REQUEST', '边缘模式需要 MPANEL_EDGE_KEY');
  }
  const baseUrl = config.coreUrl;
  if (baseUrl === undefined) {
    throw new PanelError('BAD_REQUEST', '边缘模式需要 MPANEL_CORE_URL（core 的 HTTP(S) 基地址）');
  }
  const fingerprint = fingerprintEdgeKey(key);
  const stored = await readEdgeIdentity(config.home);

  if (stored !== null && stored.keyFingerprint === fingerprint) {
    const identity = await applyIdentity(config, {
      ...stored,
      wsUrl: wsUrlFor(baseUrl),
      updatedAt: new Date().toISOString(),
    });
    logger.info('复用已持久化的边缘身份', {
      machineId: identity.machineId,
      home: config.home,
    });
    return identity;
  }

  const identity = await enrollWithRetry(config, key, fingerprint, logger, stored?.token);
  const applied = await applyIdentity(config, identity);
  logger.info('边缘入网成功', {
    machineId: applied.machineId,
    core: baseUrl,
  });
  return applied;
}

async function enrolOnce(
  config: WorkerConfig,
  key: string,
  fingerprint: string,
  logger: WorkerLogger,
  previousToken: string | undefined,
): Promise<EdgeIdentity> {
  const baseUrl = config.coreUrl;
  if (baseUrl === undefined) {
    throw new PanelError('BAD_REQUEST', '边缘模式需要 MPANEL_CORE_URL');
  }
  const enrollUrl = enrollUrlFor(baseUrl);
  let response: Response;
  try {
    response = await fetch(enrollUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        key,
        platform: process.platform,
        arch: process.arch,
        version: workerVersion(),
      }),
      signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PanelError('UNAVAILABLE', '无法连接 core 入网端点', {
      hint: `检查 MPANEL_CORE_URL 与网络（${config.coreUrl ?? '未配置'}）`,
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
  }

  const text = await response.text().catch(() => '');
  const envelope = parseJson(text);
  if (!response.ok) {
    const code = envelope?.error?.code;
    const message = envelope?.error?.message ?? `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new PanelError('UNAUTHORIZED', `边缘入网被拒绝（HTTP 401 ${code ?? 'UNAUTHORIZED'}）：${message}`, {
        status: response.status,
      });
    }
    if (response.status === 403) {
      throw new PanelError('FORBIDDEN', `边缘入网被拒绝（HTTP 403 ${code ?? 'FORBIDDEN'}）：${message}`, {
        status: response.status,
      });
    }
    if (response.status >= 500) {
      throw new PanelError('UNAVAILABLE', `core 入网端点返回 HTTP ${response.status}`, {
        status: response.status,
      });
    }
    throw new PanelError('BAD_REQUEST', `边缘入网请求被拒绝（HTTP ${response.status}）：${message}`, {
      status: response.status,
    });
  }

  if (envelope === null || envelope.ok !== true || envelope.data === undefined) {
    throw new PanelError('UPSTREAM_ERROR', 'core 入网响应缺少成功信封');
  }
  const parsed = edgeEnrollResultSchema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new PanelError('UPSTREAM_ERROR', 'core 入网响应不符合契约', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  if (parsed.data.machine.edge !== true) {
    logger.warn('入网机器未标记 edge=true（core 版本可能较旧）', {
      machineId: parsed.data.machine.id,
    });
  }
  const now = new Date().toISOString();
  const token = config.token.length > 0 ? config.token : (previousToken ?? newLoopbackToken());
  return {
    schemaVersion: 1,
    keyFingerprint: fingerprint,
    machineId: parsed.data.machine.id,
    secret: parsed.data.secret,
    wsUrl: wsUrlFor(baseUrl),
    coreUrl: baseUrl,
    token,
    platform: process.platform,
    arch: process.arch,
    version: workerVersion(),
    enrolledAt: now,
    updatedAt: now,
  };
}

async function enrollWithRetry(
  config: WorkerConfig,
  key: string,
  fingerprint: string,
  logger: WorkerLogger,
  previousToken: string | undefined,
): Promise<EdgeIdentity> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ENROLL_ATTEMPTS; attempt += 1) {
    try {
      return await enrolOnce(config, key, fingerprint, logger, previousToken);
    } catch (error) {
      lastError = error;
      if (isNonRetryable(error)) throw error;
      if (attempt < ENROLL_ATTEMPTS) {
        logger.warn('边缘入网失败，稍后重试', {
          attempt,
          maxAttempts: ENROLL_ATTEMPTS,
          error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        });
        await delay(RETRY_BASE_MS * attempt);
      }
    }
  }
  throw new PanelError(
    'UNAVAILABLE',
    `边缘入网失败（已重试 ${ENROLL_ATTEMPTS} 次）：${lastError instanceof Error ? lastError.message : String(lastError)}`,
    {
      hint: '确认 core 已启动、MPANEL_CORE_URL 正确、MPANEL_EDGE_KEY 未吊销；修复后重启 worker。',
    },
  );
}

/**
 * Applies the identity to the live config object. The reverse-ws transport
 * reads `config.machineSecret`/`config.coreUrl` on every reconnect, so a
 * successful re-enrollment takes effect without touching the transport.
 */
async function applyIdentity(config: WorkerConfig, identity: EdgeIdentity): Promise<EdgeIdentity> {
  const next: EdgeIdentity = { ...identity };
  if (config.token.length > 0) {
    next.token = config.token;
  }
  config.machineId = next.machineId;
  config.machineSecret = next.secret;
  config.coreUrl = next.wsUrl;
  config.token = next.token;
  next.updatedAt = new Date().toISOString();
  await writeEdgeIdentity(config.home, next);
  return next;
}

export async function forgetEdgeIdentity(home: string): Promise<void> {
  await removeEdgeIdentity(home);
}

export async function loadEdgeIdentity(home: string): Promise<EdgeIdentity | null> {
  return readEdgeIdentity(home);
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

interface EnvelopeLike {
  ok?: unknown;
  data?: unknown;
  error?: { code?: unknown; message?: unknown };
}

function parseJson(text: string): EnvelopeLike | null {
  if (text.length === 0) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as EnvelopeLike;
  } catch {
    return null;
  }
}

function isNonRetryable(error: unknown): boolean {
  if (!(error instanceof PanelError)) return false;
  return error.code === 'UNAUTHORIZED' || error.code === 'FORBIDDEN' || error.code === 'BAD_REQUEST';
}

function parseCoreUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PanelError('BAD_REQUEST', `MPANEL_CORE_URL 不是合法 URL：${raw}`, {
      hint: '示例：http://127.0.0.1:8790 或 https://panel.example.com',
    });
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PanelError('BAD_REQUEST', `MPANEL_CORE_URL 只支持 http(s)/ws(s)：${raw}`);
  }
  return url;
}

function stripTrailingSlash(value: string): string {
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.length === 0 ? '' : trimmed;
}

function newLoopbackToken(): string {
  return `mp_${randomBytes(32).toString('base64url')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export type { EdgeEnrollResult };
