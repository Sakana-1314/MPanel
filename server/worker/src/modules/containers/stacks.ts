import {
  badRequest,
  isPanelError,
  PanelError,
  type StackActionInput,
  type StackCreateInput,
  type StackDetail,
  type StackSummary,
  type StackUpdateInput,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import {
  assertSince,
  assertStackName,
  truncateText,
  type ContainerLogsOptions,
  type DockerClient,
  type DockerLogEntry,
} from './docker.js';

/** 栈日志合并流中的一行，container 用于区分来源。 */
export interface StackLogEntry {
  stream: 'stdout' | 'stderr';
  container: string;
  data: string;
  ts?: string;
}

export interface StackService {
  list(): Promise<StackSummary[]>;
  get(name: string): Promise<StackDetail>;
  create(input: StackCreateInput): Promise<StackDetail>;
  update(name: string, input: StackUpdateInput): Promise<StackDetail>;
  up(name: string, opts: StackActionInput): Promise<{ ok: true; output: string }>;
  down(name: string, opts: StackActionInput): Promise<{ ok: true; output: string }>;
  restart(name: string): Promise<{ ok: true; output: string }>;
  pull(name: string): Promise<{ ok: true; output: string }>;
  remove(name: string, force?: boolean): Promise<{ deleted: true; name: string }>;
  logs(name: string, opts: ContainerLogsOptions): Promise<AsyncIterable<StackLogEntry>>;
  logsText(
    name: string,
    opts: ContainerLogsOptions,
  ): Promise<{ logs: string; truncated: boolean }>;
}

const MAX_STACK_LOG_BYTES = 1024 * 1024;
const MAX_STACK_LOG_CONTAINERS = 50;
const MAX_COMPOSE_YAML_BYTES = 1_048_576;

export function createStackService(
  docker: DockerClient,
  config: WorkerConfig,
): StackService {
  // compose 文件根由 docker 客户端统一约束在 $MPANEL_HOME/stacks；config 保留以符合模块工厂签名。
  void config;
  const service: StackService = {
    async list() {
      const [projects, managed] = await Promise.all([
        docker.composeLs(),
        docker.managedStackDirectories(),
      ]);
      const merged = new Map<string, StackSummary>();
      for (const project of projects) merged.set(project.name, project);
      for (const file of managed) {
        if (merged.has(file.name)) continue;
        merged.set(file.name, {
          name: file.name,
          status: 'stopped',
          configFiles: [file.path],
          containerCount: 0,
          runningCount: 0,
          updatedAt: file.updatedAt,
        });
      }
      return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
    },

    async get(name) {
      assertStackName(name);
      const [managed, projects] = await Promise.all([
        docker.readManagedCompose(name),
        docker.composeLs(),
      ]);
      const allContainers = await docker.listContainers({ all: true });
      const containers = allContainers
        .filter((container) => projectOf(container) === name)
        .sort(compareCreatedDesc);
      const project = projects.find((entry) => entry.name === name);
      if (!managed && !project) {
        throw new PanelError('NOT_FOUND', `栈 ${name} 不存在`, { resource: 'stack', name });
      }
      const runningCount = containers.filter((container) => container.state === 'running').length;
      const composePath = managed?.path ?? project?.configFiles[0] ?? docker.composePathFor(name);
      const configFiles =
        project !== undefined && project.configFiles.length > 0
          ? project.configFiles
          : managed !== null
            ? [managed.path]
            : [composePath];
      const status = project?.status ?? statusFromContainers(containers);
      return {
        name,
        status,
        configFiles,
        containerCount: containers.length,
        runningCount,
        updatedAt: project?.updatedAt ?? null,
        composePath,
        composeYaml: managed?.yaml ?? '',
        containers,
      } satisfies StackDetail;
    },

    async create(input) {
      assertStackName(input.name);
      const yaml = assertComposeYaml(input.composeYaml);
      const existing = await docker.readManagedCompose(input.name);
      if (existing !== null) {
        throw new PanelError('CONFLICT', `栈 ${input.name} 已存在`, {
          resource: 'stack',
          field: 'name',
        });
      }
      await requireDockerAvailable(docker);
      await docker.validateComposeYaml(input.name, yaml);
      await docker.writeManagedCompose(input.name, yaml);
      return service.get(input.name);
    },

    async update(name, input) {
      assertStackName(name);
      const yaml = assertComposeYaml(input.composeYaml);
      const existing = await docker.readManagedCompose(name);
      if (existing === null) {
        throw new PanelError('NOT_FOUND', `栈 ${name} 的 compose 文件不存在`, {
          resource: 'stack',
          name,
        });
      }
      await requireDockerAvailable(docker);
      await docker.validateComposeYaml(name, yaml);
      await docker.writeManagedCompose(name, yaml);
      return service.get(name);
    },

    async up(name, opts) {
      assertStackName(name);
      await requireManagedCompose(docker, name, '启动');
      const result = await docker.composeUp(name, {
        build: opts.build,
        forceRecreate: opts.forceRecreate,
      });
      return { ok: true, output: result.output };
    },

    async down(name, opts) {
      assertStackName(name);
      await requireManagedCompose(docker, name, '停止');
      const result = await docker.composeDown(name, {
        removeVolumes: opts.removeVolumes,
        removeImages: opts.removeImages,
      });
      return { ok: true, output: result.output };
    },

    async restart(name) {
      assertStackName(name);
      await requireManagedCompose(docker, name, '重启');
      const result = await docker.composeRestart(name);
      return { ok: true, output: result.output };
    },

    async pull(name) {
      assertStackName(name);
      await requireManagedCompose(docker, name, '拉取镜像');
      const result = await docker.composePull(name);
      return { ok: true, output: result.output };
    },

    async remove(name, force) {
      assertStackName(name);
      const [managed, projects] = await Promise.all([
        docker.readManagedCompose(name),
        docker.composeLs(),
      ]);
      const project = projects.find((entry) => entry.name === name);
      if (managed === null) {
        if (project !== undefined) {
          throw badRequest(
            `栈 ${name} 由外部 Compose 创建，MPanel 只删除自己管理的文件，请使用 docker compose 手动处理`,
            { name },
          );
        }
        throw new PanelError('NOT_FOUND', `栈 ${name} 不存在`, { resource: 'stack', name });
      }
      if (project !== undefined && project.runningCount > 0 && force !== true) {
        throw new PanelError('CONFLICT', `栈 ${name} 仍有运行中的容器，请先 down 或使用 force`, {
          resource: 'stack',
          name,
          runningCount: project.runningCount,
        });
      }
      await docker.removeStackDirectory(name);
      return { deleted: true, name };
    },

    async logs(name, opts) {
      assertStackName(name);
      if (opts.since !== undefined) assertSince(opts.since);
      if (
        opts.tail !== undefined &&
        (!Number.isInteger(opts.tail) || opts.tail < 0 || opts.tail > 10_000)
      ) {
        throw badRequest('tail 参数必须是 0..10000 的整数', { field: 'tail' });
      }
      const all = await docker.listContainers({ all: true });
      const containers = all
        .filter((container) => projectOf(container) === name)
        .slice(0, MAX_STACK_LOG_CONTAINERS);
      if (containers.length === 0) {
        const managed = await docker.readManagedCompose(name);
        const projects = await docker.composeLs();
        if (managed === null && !projects.some((entry) => entry.name === name)) {
          throw new PanelError('NOT_FOUND', `栈 ${name} 不存在`, { resource: 'stack', name });
        }
        throw new PanelError('NOT_FOUND', `栈 ${name} 没有可读取日志的容器`, {
          resource: 'stack',
          name,
        });
      }
      const sources: AsyncIterable<StackLogEntry>[] = containers.map((container) => {
        const label = container.names[0] ?? container.id.slice(0, 12);
        return wrapSource(label, docker.logs(container.id, opts));
      });
      return mergeLogs(sources);
    },

    async logsText(name, opts) {
      const source = await service.logs(name, { ...opts, follow: false });
      let buffer = '';
      let truncated = false;
      for await (const entry of source) {
        buffer += `${entry.container} | ${entry.data}`;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_STACK_LOG_BYTES) {
          const clipped = truncateText(buffer, MAX_STACK_LOG_BYTES);
          buffer = clipped.text;
          truncated = true;
          break;
        }
      }
      return { logs: buffer, truncated };
    },
  };
  return service;
}

async function requireManagedCompose(
  docker: DockerClient,
  name: string,
  action: string,
): Promise<void> {
  const managed = await docker.readManagedCompose(name);
  if (managed === null) {
    throw badRequest(
      `栈 ${name} 没有 MPANEL_HOME/stacks 下的 compose 文件，无法${action}；外部 Compose 项目请用 docker compose 手动操作`,
      { name },
    );
  }
}

async function requireDockerAvailable(docker: DockerClient): Promise<void> {
  const status = await docker.probe();
  if (status.available) return;
  throw new PanelError('UNAVAILABLE', status.reason ?? 'Docker 不可用', {
    capability: 'docker',
    reason: status.reason,
    hint: '请安装 Docker CLI 并启动 daemon，然后重试；也可设置 MPANEL_DOCKER_BIN。',
  });
}

function assertComposeYaml(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('composeYaml 不能为空', { field: 'composeYaml' });
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_COMPOSE_YAML_BYTES) {
    throw badRequest('composeYaml 超过 1 MiB 上限', { field: 'composeYaml' });
  }
  return value;
}

function projectOf(container: {
  composeProject?: string | null;
  labels: Record<string, string>;
}): string {
  return container.composeProject ?? container.labels['com.docker.compose.project'] ?? '';
}

function compareCreatedDesc(
  left: { created: string; id: string },
  right: { created: string; id: string },
): number {
  if (left.created === right.created) return left.id.localeCompare(right.id);
  return left.created < right.created ? 1 : -1;
}

function statusFromContainers(containers: { state: string }[]): string {
  if (containers.length === 0) return 'stopped';
  const counts = new Map<string, number>();
  for (const container of containers) {
    const state = container.state === '' ? 'unknown' : container.state;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const order = ['running', 'paused', 'restarting', 'created', 'exited', 'dead', 'removing'];
  const pieces = order
    .filter((state) => (counts.get(state) ?? 0) > 0)
    .map((state) => `${state}(${counts.get(state) ?? 0})`);
  for (const state of [...counts.keys()].filter((entry) => !order.includes(entry)).sort()) {
    pieces.push(`${state}(${counts.get(state) ?? 0})`);
  }
  return pieces.join(', ');
}

/** 单容器日志包装：容器在流期间被删除等竞态不会中断整个栈日志流。 */
async function* wrapSource(
  container: string,
  source: AsyncIterable<DockerLogEntry>,
): AsyncGenerator<StackLogEntry> {
  try {
    for await (const entry of source) {
      yield {
        stream: entry.stream,
        container,
        data: entry.data,
        ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
      };
    }
  } catch (error) {
    if (isPanelError(error) && error.code === 'UNAVAILABLE') throw error;
    // 其他错误视为该容器日志结束。
  }
}

type Settled<T> =
  | { index: number; ok: true; result: IteratorResult<T> }
  | { index: number; ok: false; error: unknown };

/** 把多个容器日志异步迭代器合并成一条流；退出时对全部来源调用 return（杀子进程）。 */
async function* mergeLogs<T>(sources: AsyncIterable<T>[]): AsyncGenerator<T> {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const next = (index: number): Promise<Settled<T>> => {
    const iterator = iterators[index];
    return iterator.next().then(
      (result): Settled<T> => ({ index, ok: true, result }),
      (error: unknown): Settled<T> => ({ index, ok: false, error }),
    );
  };
  const pending = new Map<number, Promise<Settled<T>>>();
  iterators.forEach((_iterator, index) => pending.set(index, next(index)));
  try {
    while (pending.size > 0) {
      const settled = await Promise.race(pending.values());
      pending.delete(settled.index);
      if (!settled.ok) throw settled.error;
      if (settled.result.done === true) continue;
      yield settled.result.value;
      pending.set(settled.index, next(settled.index));
    }
  } finally {
    await Promise.allSettled(iterators.map((iterator) => Promise.resolve(iterator.return?.())));
  }
}
