import type { FastifyError, FastifyInstance } from 'fastify';
import type {} from '@fastify/websocket';
import { errorEnvelope, isPanelError } from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import type { AuditLog } from '../audit.js';
import type { AuthService } from '../auth/types.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import type { MachineService } from '../machines/service.js';
import { proxyHttpHandler } from './http.js';
import { proxyWsHandler } from './ws.js';

export interface ProxyDeps {
  machines: MachineService;
  auth: AuthService;
  config: CoreConfig;
  audit: AuditLog;
  rateLimit: RateLimiter;
}

/** 代理路由的请求体上限：必须 ≥ 110 MiB（worker 上传上限 100 MiB）。 */
const PROXY_BODY_LIMIT = 110 * 1024 * 1024;

/**
 * 代理路由必须放在独立封装插件中：
 * - catch-all no-op content-type parser（不消费 body，handler 只读 req.raw）；
 * - route bodyLimit ≥ 110 MiB，避免默认 1 MiB JSON 限制破坏上传；
 * - HTTP 通配路由不得吞掉更具体的 `/proxy/ws/*`；
 * - 不在此层重复鉴权（网关在 `/api/v1` 作用域统一注入 req.auth）。
 */
export async function registerProxyRoutes(app: FastifyInstance, deps: ProxyDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_request, _payload, done) {
      // 不读取 payload：代理 handler 直接使用 req.raw 原始流。
      done(null, null);
    });

    scope.setErrorHandler((error: FastifyError, _request, reply) => {
      if (reply.sent) return;
      if (isPanelError(error)) {
        return reply.code(error.status).send(errorEnvelope(error.code, error.message, error.details));
      }
      const code = (error as { code?: string }).code;
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
        return reply.code(400).send(
          errorEnvelope('BAD_REQUEST', '请求体过大或 content-type 不受支持', {
            hint: '检查上传大小（worker 默认 100 MiB）与 Content-Type 后重试',
          }),
        );
      }
      return reply.code(500).send(errorEnvelope('INTERNAL', '代理请求失败'));
    });

    // WS 路由必须先于 HTTP 通配注册，且路径更具体。
    scope.route({
      method: 'GET',
      url: '/machines/:machineId/proxy/ws/*',
      bodyLimit: PROXY_BODY_LIMIT,
      websocket: true,
      handler: proxyWsHandler(deps) as never,
    });

    scope.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      url: '/machines/:machineId/proxy/*',
      bodyLimit: PROXY_BODY_LIMIT,
      handler: proxyHttpHandler(deps),
    });
  });
}
