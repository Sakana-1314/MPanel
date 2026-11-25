import { statfs } from 'node:fs/promises';
import * as os from 'node:os';
import { okEnvelope, type SystemMetrics, type SystemSnapshot } from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { WorkerLogger } from '../../logger.js';
import type { WorkerModule } from '../../registry.js';
import { workerVersion } from '../../registry.js';

/**
 * Worker node telemetry used by core edge nodes
 * (docs/api-contract.md §5.5). Both endpoints are read-only, require the
 * normal worker Bearer token, and never depend on external commands.
 */

export interface SystemTelemetryDeps {
  config: WorkerConfig;
  capabilities: { get(force?: boolean): Promise<{ pty: { available: boolean } }> };
  logger?: WorkerLogger;
}

const CPU_SAMPLE_MS = 200;
const DISK_TIMEOUT_MS = 2_000;

interface DiskUsage {
  totalBytes: number | null;
  freeBytes: number | null;
}

export async function collectSystemSnapshot(deps: SystemTelemetryDeps): Promise<SystemSnapshot> {
  const capabilities = await deps.capabilities.get().catch(() => null);
  const disk = await readDiskUsage(deps.config.home, deps.logger);
  return {
    collectedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    nodeVersion: process.version,
    workerVersion: workerVersion(),
    uptimeSec: Math.max(0, Math.round(process.uptime())),
    cpuCount: os.cpus().length,
    loadavg: readLoadAverage(),
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    diskTotalBytes: disk.totalBytes,
    diskFreeBytes: disk.freeBytes,
    ips: collectIps(),
    transport: deps.config.transport,
    pty: capabilities?.pty.available === true,
  };
}

export async function collectSystemMetrics(deps: SystemTelemetryDeps): Promise<SystemMetrics> {
  const [cpuPercent, disk] = await Promise.all([
    sampleCpuPercent(),
    readDiskUsage(deps.config.home, deps.logger),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    cpuPercent,
    cpuCount: os.cpus().length,
    loadavg: readLoadAverage(),
    memTotalBytes: os.totalmem(),
    memFreeBytes: os.freemem(),
    diskTotalBytes: disk.totalBytes,
    diskFreeBytes: disk.freeBytes,
    uptimeSec: Math.max(0, Math.round(process.uptime())),
  };
}

/** `modules/system` 只注册 §5.5 的两个端点；/system/info 由 http.ts 提供。 */
export function createSystemModule(): WorkerModule {
  return {
    name: 'system',
    prefixes: ['/system'],
    register(ctx): void {
      const deps: SystemTelemetryDeps = {
        config: ctx.config,
        capabilities: ctx.capabilities,
        logger: ctx.logger as WorkerLogger,
      };

      ctx.app.get('/system/snapshot', async () => okEnvelope(await collectSystemSnapshot(deps)));
      ctx.app.get('/system/metrics', async () => okEnvelope(await collectSystemMetrics(deps)));
    },
  };
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

/** Windows 的 os.loadavg() 恒为 0,0,0；契约要求 null。 */
function readLoadAverage(): [number, number, number] | null {
  if (process.platform === 'win32') return null;
  const [one, five, fifteen] = os.loadavg();
  return [
    typeof one === 'number' ? one : 0,
    typeof five === 'number' ? five : 0,
    typeof fifteen === 'number' ? fifteen : 0,
  ];
}

function collectIps(): string[] {
  const addresses = new Set<string>();
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4' && entry.family !== 'IPv6') continue;
      if (entry.address.length === 0) continue;
      addresses.add(entry.address);
    }
  }
  return [...addresses].sort();
}

async function readDiskUsage(home: string, logger?: WorkerLogger): Promise<DiskUsage> {
  try {
    const stats = await withTimeout(statfs(home), DISK_TIMEOUT_MS);
    const blockSize = Number(stats.bsize);
    const blocks = Number(stats.blocks);
    const available = Number(stats.bavail);
    if (!Number.isFinite(blockSize) || !Number.isFinite(blocks) || !Number.isFinite(available)) {
      return { totalBytes: null, freeBytes: null };
    }
    return {
      totalBytes: Math.max(0, blockSize * blocks),
      freeBytes: Math.max(0, blockSize * available),
    };
  } catch (error) {
    logger?.debug('读取磁盘容量失败（返回 null）', {
      home,
      error: error instanceof Error ? error.message : String(error),
    });
    return { totalBytes: null, freeBytes: null };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('statfs timeout')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface CpuTotals {
  idle: number;
  total: number;
}

function cpuTotals(): CpuTotals {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** 200ms 整机 CPU 使用率；采样失败返回 null（docs/api-contract.md §5.5）。 */
async function sampleCpuPercent(): Promise<number | null> {
  try {
    const first = cpuTotals();
    await delay(CPU_SAMPLE_MS);
    const second = cpuTotals();
    const idleDelta = second.idle - first.idle;
    const totalDelta = second.total - first.total;
    if (!Number.isFinite(totalDelta) || totalDelta <= 0) return null;
    const percent = ((totalDelta - idleDelta) / totalDelta) * 100;
    if (!Number.isFinite(percent)) return null;
    return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
