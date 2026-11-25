import type { WorkerTransport, WorkerTransportDeps } from './types.js';

/** 直连 HTTP 传输：按配置监听；启动时向 stdout 输出一行 listening JSON 供冒烟脚本发现端口。 */
export function createHttpTransport(deps: WorkerTransportDeps): WorkerTransport {
  const { app, config, logger } = deps;
  let started = false;
  let stopped = false;
  let stopResolve: (() => void) | null = null;
  const stoppedPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await app.close();
    } catch (error) {
      logger.warn('关闭 HTTP 服务失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stopResolve?.();
  };

  return {
    kind: 'http',
    async start(): Promise<void> {
      if (started) return;
      started = true;
      try {
        await app.listen({ host: config.host, port: config.port });
      } catch (error) {
        started = false;
        const message = error instanceof Error ? error.message : String(error);
        logger.error('HTTP 监听失败', { host: config.host, port: config.port, error: message });
        throw error;
      }
      const address = app.server.address();
      const port = address !== null && typeof address === 'object' ? address.port : config.port;
      const host = address !== null && typeof address === 'object' ? address.address : config.host;
      // 唯一允许写 stdout 的位置（smoke 读取该行获得随机端口）。
      process.stdout.write(
        `${JSON.stringify({ event: 'listening', host, port, transport: 'http' })}\n`,
      );
      logger.info('worker HTTP 服务已启动', { host, port, transport: 'http' });
    },
    stop,
    waitForStop: () => stoppedPromise,
  };
}
