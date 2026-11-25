import type { MachineHealth, MachineStatus } from '@mpanel/shared';
import type { MachineStore } from './store.js';
import type { MachineService } from './service.js';

export interface HealthMonitor {
  start(): void;
  stop(): void;
  check(id: string): Promise<MachineHealth>;
  markOnline(id: string, latency?: number): void;
  markOffline(id: string, error?: string): void;
}

export interface HealthStatusUpdate {
  status: MachineStatus;
  latencyMs?: number;
  lastSeenAt?: string;
  error?: string;
}

export interface HealthMonitorDeps {
  store: MachineStore;
  machines: MachineService;
  /** 基础轮询间隔，默认 15 秒。 */
  intervalMs?: number;
  /** 指数退避上限，默认 60 秒。 */
  maxIntervalMs?: number;
  /** 同时探测的机器数上限，默认 4。 */
  concurrency?: number;
  /** 状态变化回调；服务用它同步内存运行时快照并定期落盘。 */
  onStatus?: (id: string, update: HealthStatusUpdate) => void;
  logger?: {
    warn(message: string, details?: Record<string, unknown>): void;
    debug?(message: string, details?: Record<string, unknown>): void;
  };
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_INTERVAL_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;
/** 单个健康探测的时间上限，避免慢机器拖住轮询。 */
const CHECK_TIMEOUT_MS = 20_000;

/**
 * 机器健康轮询：默认 15 秒一次，连续失败按 2^n 退避到最多 60 秒，
 * 并发上限默认 4。任何单台机器失败都不会影响 core 启动或其它机器。
 */
export function createHealthMonitor(deps: HealthMonitorDeps): HealthMonitor {
  return new HealthMonitorImpl(deps);
}

class HealthMonitorImpl implements HealthMonitor {
  private readonly intervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly concurrency: number;
  private readonly failures = new Map<string, number>();
  private readonly nextCheckAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = true;

  constructor(private readonly deps: HealthMonitorDeps) {
    this.intervalMs = Math.max(1_000, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.maxIntervalMs = Math.max(this.intervalMs, deps.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS);
    this.concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    // 首个周期稍作延迟，让 app/驱动完成启动；创建/连接路径已有即时探测。
    this.schedule(1_500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.failures.clear();
    this.nextCheckAt.clear();
  }

  async check(id: string): Promise<MachineHealth> {
    const startedAt = Date.now();
    let reachable = false;
    let error: string | undefined;
    let latencyMs: number | undefined;

    try {
      const result = await withTimeout(this.deps.machines.test(id), CHECK_TIMEOUT_MS);
      reachable = result.reachable;
      latencyMs = result.latencyMs ?? undefined;
      if (!result.reachable) error = result.error ?? '健康探测失败';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }

    const duration = Date.now() - startedAt;
    if (reachable) {
      this.markOnline(id, latencyMs ?? duration);
    } else {
      this.markOffline(id, error ?? '健康探测失败');
      this.deps.logger?.debug?.('机器健康探测失败', { machineId: id, error });
    }

    return this.deps.machines.health(id);
  }

  markOnline(id: string, latency?: number): void {
    this.failures.set(id, 0);
    this.nextCheckAt.set(id, Date.now() + this.intervalMs);
    this.deps.onStatus?.(id, {
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      ...(latency === undefined ? {} : { latencyMs: latency }),
    });
  }

  markOffline(id: string, error?: string): void {
    const failures = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, failures);
    const backoff = Math.min(this.intervalMs * 2 ** Math.min(failures - 1, 6), this.maxIntervalMs);
    this.nextCheckAt.set(id, Date.now() + backoff);
    const status: MachineStatus = failures >= 3 ? 'offline' : 'degraded';
    this.deps.onStatus?.(id, {
      status,
      ...(error === undefined ? {} : { error }),
    });
  }

  /* ------------------------------------------------------------------ */

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      this.timer = undefined;
      void this.runCycle();
    }, Math.max(250, delayMs));
    timer.unref?.();
    this.timer = timer;
  }

  private async runCycle(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const records = await this.deps.store.list();
      const now = Date.now();
      const due = records.filter((record) => {
        if (!record.enabled || record.desiredState !== 'running') return false;
        const next = this.nextCheckAt.get(record.id);
        return next === undefined || next <= now;
      });
      // 清理已删除机器/已停机机器的调度状态。
      const live = new Set(records.map((record) => record.id));
      for (const id of [...this.nextCheckAt.keys()]) {
        if (!live.has(id)) {
          this.nextCheckAt.delete(id);
          this.failures.delete(id);
        }
      }

      let cursor = 0;
      const workerCount = Math.min(this.concurrency, due.length);
      const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          if (index >= due.length) return;
          const record = due[index];
          if (record === undefined) return;
          try {
            await this.check(record.id);
          } catch (error) {
            this.deps.logger?.warn('健康检查异常', {
              machineId: record.id,
              error: error instanceof Error ? error.message : String(error),
            });
            this.markOffline(record.id, error instanceof Error ? error.message : String(error));
          }
        }
      });
      await Promise.all(workers);
    } catch (error) {
      this.deps.logger?.warn('健康轮询周期失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
      this.schedule(this.nextDelay());
    }
  }

  private nextDelay(): number {
    if (this.nextCheckAt.size === 0) return this.intervalMs;
    let earliest = Number.POSITIVE_INFINITY;
    for (const at of this.nextCheckAt.values()) {
      if (at < earliest) earliest = at;
    }
    const delay = earliest - Date.now();
    if (!Number.isFinite(delay)) return this.intervalMs;
    return Math.max(250, Math.min(delay, this.maxIntervalMs));
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('健康探测超时'));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
