import type { Readable } from 'node:stream';
import type {
  Capabilities,
  Machine,
  MachineDesiredState,
  MachineStatus,
  MachineTransport,
  SystemSnapshot,
  WorkerDescriptor,
} from '@mpanel/shared';

/** Internal machine record. Never expose encrypted credentials to routes. */
export interface MachineRecord {
  id: string;
  name: string;
  transport: MachineTransport;
  enabled: boolean;
  desiredState: MachineDesiredState;
  endpoint: string | null;
  /** AES-256-GCM worker token (http/stdio) or loopback token. */
  tokenCipher: string | null;
  /** SHA-256 of the reverse-ws machine secret. */
  secretHash: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  status: MachineStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  /** 内存健康快照定期落盘（不通过 API 返回）。 */
  lastLatencyMs?: number;
  worker?: WorkerDescriptor | null;
  capabilities?: Capabilities | null;
  /** Edge enrollment provenance (docs/api-contract.md §5.4); optional for old records. */
  edge?: boolean;
  group?: string | null;
  edgeKeyId?: string | null;
  /** Last successful GET /system/snapshot from the node. */
  snapshot?: SystemSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    reverseWsMachine?: Machine;
  }
}

export interface MachineHttpRequest {
  method: string;
  /** Starts with /api/v1/ or /healthz. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Readable | null;
  requestId: string;
  /** 已认证用户名；core 注入 `x-mpanel-user`，worker 仅用于日志。 */
  userId?: string;
  remoteAddress?: string;
  signal?: AbortSignal;
}

export interface MachineHttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Readable;
}

export interface MachineWsOpenRequest {
  /** /ws/... including query. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  protocols?: string[];
}

export interface MachineWsConnection {
  send(data: string | Uint8Array, binary: boolean): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: string | Uint8Array, binary: boolean) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export interface DriverStatus {
  status: MachineStatus;
  lastSeenAt: string | null;
  latencyMs?: number;
  consecutiveFailures: number;
  lastError?: string;
}
