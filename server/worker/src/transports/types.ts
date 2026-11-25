import type { FastifyInstance } from 'fastify';
import type { WorkerConfig } from '../config.js';
import type { WorkerLogger } from '../logger.js';

export interface WorkerTransport {
  readonly kind: 'http' | 'stdio' | 'reverse-ws';
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * 进程内检测传输是否被动结束（stdio EOF、心跳超时等）。index.ts 用它
   * 触发优雅退出；不实现时永远不 resolve。
   */
  waitForStop?(): Promise<void>;
}

export interface WorkerTransportDeps {
  config: WorkerConfig;
  /** 已注册全部路由/WS 网关的 Fastify 实例（三种传输共享）。 */
  app: FastifyInstance;
  logger: WorkerLogger;
}

/** 传输层的固定 loopback 主机；隧道模式绝不能绑定公网。 */
export const TRANSPORT_LOOPBACK_HOST = '127.0.0.1';
