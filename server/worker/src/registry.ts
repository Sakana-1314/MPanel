import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { PanelError } from '@mpanel/shared';
import type {
  Capabilities,
  CommandRunner,
  ModuleContext,
  ModuleRegistration,
  ShellRunner,
  WorkerDescriptor,
  WsBridge,
} from '@mpanel/shared';
import type { WorkerConfig } from './config.js';
import type { StoreFactory } from './store.js';
import type { PathSandbox } from './paths.js';
import type { WorkerAuth } from './auth.js';
import type { CapabilityService } from './capabilities.js';
import { summarizeCapabilities } from './capabilities.js';

export type WorkerModuleContext = ModuleContext<FastifyInstance> & {
  app: FastifyInstance;
  config: WorkerConfig;
  store: StoreFactory;
  paths: PathSandbox;
  runner: CommandRunner & ShellRunner;
  wsBridge: WsBridge;
  auth: WorkerAuth;
};

export type WorkerModule = ModuleRegistration<FastifyInstance, WorkerModuleContext>;

/** 挂在 Fastify 实例上的运行时对象；传输层用它读取能力快照与模块信息。 */
export interface WorkerRuntime {
  config: WorkerConfig;
  capabilities: CapabilityService;
  auth: WorkerAuth;
  wsBridge: WsBridge;
  modules: readonly WorkerModule[];
  startedAt: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    mpanel: WorkerRuntime;
  }
}

export interface ModuleRegistryLike {
  registerAll(context: WorkerModuleContext): Promise<void>;
  list(): readonly WorkerModule[];
}

export const WORKER_NAME = 'mpanel-worker';
export const API_VERSION = 1;
export const PROTOCOL_VERSION = 1;

let cachedVersion: string | null = null;

/** 从包清单读取版本号；部署产物与源码运行都能解析。 */
export function workerVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

/** hello 帧 / system.info 共用的 worker 描述。 */
export function describeWorker(capabilities?: Capabilities): WorkerDescriptor {
  return {
    name: WORKER_NAME,
    version: workerVersion(),
    apiVersion: API_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    ...(capabilities === undefined
      ? {}
      : { capabilities: summarizeCapabilities(capabilities) }),
  };
}

export interface ModuleCatalogEntry {
  name: string;
  prefixes: string[];
  requires?: string[];
}

/** 诊断/`system/info` 的模块目录（只暴露元数据，不暴露实现）。 */
export function moduleCatalog(modules: readonly WorkerModule[]): ModuleCatalogEntry[] {
  return modules.map((module) => ({
    name: module.name,
    prefixes: [...module.prefixes],
    ...(module.requires === undefined ? {} : { requires: [...module.requires] }),
  }));
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim();
  if (trimmed.length === 0) return '/';
  return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') || '/' : `/${trimmed.replace(/\/+$/, '')}`;
}

function validateModules(modules: readonly WorkerModule[]): void {
  const names = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const module of modules) {
    if (typeof module.name !== 'string' || module.name.length === 0) {
      throw new PanelError('INTERNAL', '存在未命名的 worker 模块');
    }
    if (names.has(module.name)) {
      throw new PanelError('INTERNAL', `worker 模块重复注册：${module.name}`, {
        module: module.name,
      });
    }
    names.add(module.name);
    for (const prefix of module.prefixes) {
      const normalized = normalizePrefix(prefix);
      const owner = prefixes.get(normalized);
      if (owner !== undefined) {
        throw new PanelError(
          'INTERNAL',
          `worker 模块前缀冲突：${normalized} 同时属于 ${owner} 与 ${module.name}`,
          { prefix: normalized, modules: [owner, module.name] },
        );
      }
      prefixes.set(normalized, module.name);
    }
  }
}

/**
 * 只在调用方提供的 /api/v1 作用域内注册一次；模块自己注册完整 API 相对路径。
 * `requires` 仅用于诊断，绝不因能力缺失阻止启动。
 */
export class ModuleRegistry implements ModuleRegistryLike {
  private registered = false;

  constructor(private readonly modules: WorkerModule[]) {
    validateModules(modules);
  }

  async registerAll(context: WorkerModuleContext): Promise<void> {
    if (this.registered) {
      throw new PanelError('INTERNAL', 'worker 模块已经注册过，不能重复挂载');
    }
    this.registered = true;
    for (const module of this.modules) {
      const started = Date.now();
      try {
        await module.register(context);
      } catch (error) {
        context.logger.error('worker 模块注册失败', {
          module: module.name,
          prefixes: module.prefixes,
          error,
        });
        if (error instanceof PanelError) throw error;
        throw new PanelError(
          'INTERNAL',
          `worker 模块注册失败：${module.name}`,
          { module: module.name, prefixes: module.prefixes },
          { cause: error },
        );
      }
      context.logger.debug('worker 模块已注册', {
        module: module.name,
        prefixes: module.prefixes,
        durationMs: Date.now() - started,
      });
    }
  }

  list(): readonly WorkerModule[] {
    return this.modules;
  }
}

export function createModuleRegistry(modules: WorkerModule[]): ModuleRegistry {
  return new ModuleRegistry(modules);
}
