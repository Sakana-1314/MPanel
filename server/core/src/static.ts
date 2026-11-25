import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { errorEnvelope } from '@mpanel/shared';
import type { CoreConfig } from './config.js';
import { splitRequestUrl } from './auth/types.js';

const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_REVALIDATE = 'public, max-age=3600';

function buildCsp(config: CoreConfig): string {
  if (config.csp !== undefined && config.csp.trim() !== '') return config.csp;
  const frameSrc = ["'self'", ...(config.dbxOrigin === undefined ? [] : [config.dbxOrigin])].join(' ');
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    // 面板允许用户添加远端 worker 连接，因此放开 http/https/ws 目标。
    "connect-src 'self' http: https: ws: wss:",
    `frame-src ${frameSrc}`,
    "form-action 'self'",
  ].join('; ');
}

function applySecurityHeaders(reply: FastifyReply, config: CoreConfig): void {
  reply.header('content-security-policy', buildCsp(config));
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'SAMEORIGIN');
}

function generatedConfig(config: CoreConfig): string {
  return JSON.stringify({
    backends: [
      {
        id: 'core',
        url: config.publicUrl ?? '',
        kind: 'core',
        label: 'MPanel Core',
      },
    ],
    dbxUrl: config.dbxOrigin ?? '',
  });
}

async function resolveWebRoot(config: CoreConfig): Promise<string | undefined> {
  if (config.webDir === undefined) return undefined;
  try {
    const info = await stat(config.webDir);
    return info.isDirectory() ? config.webDir : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @fastify/static + SPA fallback. Never swallows /api, /ws or /healthz.
 * Sets CSP (frame-src includes dbx), X-Content-Type-Options and Referrer-Policy.
 */
export async function registerStatic(
  app: FastifyInstance,
  config: CoreConfig,
): Promise<void> {
  const webRoot = await resolveWebRoot(config);
  const indexCandidate = webRoot === undefined ? undefined : join(webRoot, 'index.html');
  const indexFile =
    indexCandidate !== undefined && existsSync(indexCandidate) ? indexCandidate : undefined;

  if (webRoot !== undefined) {
    app.log.info({ webDir: webRoot }, '托管前端静态文件');
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      index: ['index.html'],
      cacheControl: true,
      maxAge: '1h',
      setHeaders: (reply, filePath) => {
        applySecurityHeaders(reply, config);
        if (filePath.endsWith('index.html') || filePath.endsWith('config.json')) {
          reply.header('cache-control', 'no-store');
        } else if (filePath.replace(/\\/g, '/').includes('/assets/')) {
          reply.header('cache-control', CACHE_IMMUTABLE);
        } else {
          reply.header('cache-control', CACHE_REVALIDATE);
        }
      },
    });
  } else {
    app.log.warn({ webDir: config.webDir }, '前端静态目录不存在，仅提供 API');
  }

  /*
   * /config.json：优先使用构建产物中的文件；不存在时按环境变量生成，
   * 便于容器一键部署（不得包含任何 token/密码）。
   */
  app.get('/config.json', async (_req, reply) => {
    reply.header('content-type', 'application/json; charset=utf-8');
    reply.header('cache-control', 'no-store');
    applySecurityHeaders(reply, config);
    const file = webRoot === undefined ? undefined : join(webRoot, 'config.json');
    if (file !== undefined) {
      try {
        const content = await readFile(file, 'utf8');
        return content;
      } catch {
        // 文件不存在或不可读时回退到环境变量生成。
      }
    }
    return generatedConfig(config);
  });

  app.setNotFoundHandler((req, reply) => {
    const { path } = splitRequestUrl(req.url);
    if (path.startsWith('/api/v1') || path.startsWith('/ws/') || path === '/healthz') {
      return reply.code(404).send(errorEnvelope('NOT_FOUND', '接口不存在', { resource: path }));
    }

    const serveSpa =
      indexFile !== undefined &&
      (req.method === 'GET' || req.method === 'HEAD');

    if (serveSpa) {
      applySecurityHeaders(reply, config);
      reply.header('cache-control', 'no-store');
      return reply.sendFile('index.html');
    }

    return reply.code(404).send(errorEnvelope('NOT_FOUND', '资源不存在', { resource: path }));
  });
}
