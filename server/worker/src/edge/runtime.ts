import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';
import { ensureEdgeIdentity, forgetEdgeIdentity, isEdgeMode } from './enroll.js';

/**
 * Runtime edge supervisor.
 *
 * The reverse-ws transport reports a rejected registration through its logger
 * (`reverse-ws 注册被 core 拒绝`, details.status = 401/403). We treat that as
 * the signal to forget `edge.json` and enroll again with the still-valid
 * MPANEL_EDGE_KEY, at most three times per process. The transport reconnect
 * loop reads `config.machineSecret` on every attempt, so the new secret is
 * picked up without any tunnel changes.
 */

const MAX_REENROLL_ATTEMPTS = 3;

export interface EdgeRuntime {
  ensureIdentity(): Promise<void>;
  /** Wraps the transport logger so 401/403 registration rejections trigger re-enrollment. */
  wrapLogger(logger: WorkerLogger): WorkerLogger;
  stop(): void;
}

export function createEdgeRuntime(
  config: WorkerConfig,
  baseLogger: WorkerLogger,
): EdgeRuntime | null {
  if (!isEdgeMode(config)) return null;

  let attempts = 0;
  let renewing = false;
  let stopped = false;
  let capReported = false;

  const ensureIdentity = async (): Promise<void> => {
    await ensureEdgeIdentity(config, baseLogger);
    attempts = 0;
    capReported = false;
  };

  const onAuthRejected = async (): Promise<void> => {
    if (stopped || renewing) return;
    if (attempts >= MAX_REENROLL_ATTEMPTS) {
      if (!capReported) {
        capReported = true;
        baseLogger.error('边缘机器 secret 被 core 拒绝，重新入网已达次数上限，worker 保持离线重试', {
          attempts,
          maxAttempts: MAX_REENROLL_ATTEMPTS,
        });
      }
      return;
    }
    attempts += 1;
    renewing = true;
    try {
      baseLogger.warn('边缘机器 secret 被 core 拒绝，正在重新入网', {
        attempt: attempts,
        maxAttempts: MAX_REENROLL_ATTEMPTS,
      });
      await forgetEdgeIdentity(config.home);
      const identity = await ensureEdgeIdentity(config, baseLogger);
      baseLogger.info('边缘身份已重新入网，等待隧道重连', {
        machineId: identity.machineId,
      });
    } catch (error) {
      baseLogger.error('边缘身份重新入网失败', {
        attempt: attempts,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    } finally {
      renewing = false;
    }
  };

  const wrapLogger = (logger: WorkerLogger): WorkerLogger => {
    const wrapped: WorkerLogger = {
      debug: (message, details) => logger.debug(message, details),
      info: (message, details) => logger.info(message, details),
      warn: (message, details) => logger.warn(message, details),
      error: (message, details) => {
        logger.error(message, details);
        if (
          message.includes('注册被 core 拒绝') &&
          (details?.status === 401 || details?.status === 403)
        ) {
          void onAuthRejected();
        }
      },
      child: (bindings) => wrapLogger(logger.child(bindings)),
      close: () => logger.close?.(),
    };
    return wrapped;
  };

  return {
    ensureIdentity,
    wrapLogger,
    stop: () => {
      stopped = true;
    },
  };
}
