import type { FastifyBaseLogger } from 'fastify';
import type { Capabilities, MachineTransport, WorkerDescriptor } from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import type {
  DriverStatus,
  MachineHttpRequest,
  MachineHttpResponse,
  MachineRecord,
  MachineWsConnection,
  MachineWsOpenRequest,
} from '../machines/types.js';

export interface TransportDriver {
  readonly kind: MachineTransport;
  start(machine: MachineRecord): Promise<void>;
  stop(machineId: string): Promise<void>;
  request(machineId: string, req: MachineHttpRequest): Promise<MachineHttpResponse>;
  openWs(machineId: string, req: MachineWsOpenRequest): Promise<MachineWsConnection>;
  status(machineId: string): DriverStatus;
  attach?(
    machineId: string,
    socket: import('ws').WebSocket,
    req: import('node:http').IncomingMessage,
  ): Promise<void>;
}

/**
 * 可选的驱动事件回调。网关/服务层用它把隧道握手、断线与健康状态同步到
 * 机器运行时快照；未提供时驱动仍可独立工作。
 */
export interface TransportEvents {
  onStarting?(machineId: string): void;
  onOnline?(
    machineId: string,
    payload: { worker?: WorkerDescriptor; capabilities?: Capabilities | null; latencyMs?: number },
  ): void;
  onOffline?(machineId: string, error: string, status?: DriverStatus['status']): void;
}

export interface TransportDriverDeps {
  config: CoreConfig;
  credentials: {
    getToken(machine: MachineRecord): Promise<string>;
    getSecret(machine: MachineRecord): Promise<string>;
  };
  logger: FastifyBaseLogger;
  /** 见 TransportEvents；网关注入，驱动不依赖具体实现。 */
  events?: TransportEvents;
}

export type TransportDriverFactory = (deps: TransportDriverDeps) => TransportDriver;

/**
 * 传输层日志接口（message + 结构化字段），与 FastifyBaseLogger 的重载签名
 * 解耦；服务/驱动统一通过 toTransportLogger 适配。
 */
export interface TransportLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export function toTransportLogger(logger: FastifyBaseLogger): TransportLogger {
  return {
    debug: (message, details) => logger.debug(details ?? {}, message),
    info: (message, details) => logger.info(details ?? {}, message),
    warn: (message, details) => logger.warn(details ?? {}, message),
    error: (message, details) => logger.error(details ?? {}, message),
  };
}

/** 逐跳头 + core/浏览器凭据头，绝不转发给 worker。 */
const DROP_ALWAYS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'authorization',
  'content-length',
]);

const DROP_WS = new Set([
  ...DROP_ALWAYS,
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'sec-websocket-protocol',
]);

/**
 * 清洗要转发给 worker 的请求头：删除逐跳头、cookie/authorization/host，
 * 丢弃 undefined 值，保留重复头为数组。WS 额外删除 sec-websocket-*。
 */
export function sanitizeForwardHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: { forWs?: boolean } = {},
): Record<string, string | string[]> {
  const drop = options.forWs === true ? DROP_WS : DROP_ALWAYS;
  const result: Record<string, string | string[]> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = rawName.toLowerCase();
    if (drop.has(name)) continue;
    if (name.startsWith('x-mpanel-')) continue;
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** 响应头清洗：core 不透传 set-cookie 与逐跳头，保留业务头（含 content-disposition）。 */
export function sanitizeResponseHeaders(headers: Headers): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (name === 'set-cookie') return;
    if (DROP_ALWAYS.has(name)) return;
    result[name] = value;
  });
  return result;
}
