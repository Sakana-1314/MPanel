import type { ContainerSummary } from '../../api/types';
import type { StatusTone } from '../../components/ui/tones';
import { statusLabel } from '../../components/ui/tones';

export const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const STACK_ACTION_LABEL = {
  up: '启动',
  down: '停止',
  restart: '重启',
  pull: '拉取镜像',
  remove: '删除',
} as const;

export function validateStackName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '请填写项目名。';
  if (!STACK_NAME_PATTERN.test(trimmed)) {
    return '项目名只能包含小写字母、数字、下划线和短横线，且必须以字母或数字开头（最长 63 个字符）。';
  }
  return null;
}

export function validateComposeYaml(yaml: string): string | null {
  if (yaml.trim().length === 0) return 'Compose 内容不能为空。';
  return null;
}

/** compose ls 的状态可能是 `running(2)`、`exited(1)` 等组合。 */
export function stackStatusLabel(status: string): string {
  const head = status.split('(')[0]?.trim().toLowerCase() ?? status;
  const labels: Record<string, string> = {
    running: '运行中',
    exited: '已停止',
    stopped: '已停止',
    restarting: '重启中',
    paused: '已暂停',
    dead: '异常',
    created: '已创建',
    unknown: '未知',
  };
  return labels[head] ?? statusLabel(status);
}

export function stackStatusTone(status: string): StatusTone {
  const head = status.split('(')[0]?.trim().toLowerCase() ?? status;
  if (head === 'running') return 'success';
  if (head === 'restarting' || head === 'paused' || head === 'created') return 'warning';
  if (head === 'dead') return 'danger';
  if (head === 'exited' || head === 'stopped') return 'neutral';
  return 'neutral';
}

/** 从首个 compose 配置文件推导工作目录；优先使用详情里的 composePath。 */
export function stackWorkingDir(
  configFiles: readonly string[],
  composePath?: string | null,
): string {
  const file = composePath ?? configFiles[0];
  if (file === undefined || file.length === 0) return '—';
  const normalized = file.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '—';
  return normalized.slice(0, index) || '/';
}

export function stackComposeFile(
  configFiles: readonly string[],
  composePath?: string | null,
): string {
  return composePath ?? configFiles[0] ?? '—';
}

/**
 * 从 compose YAML 中提取静态 image 引用（用于“拉取镜像”）。
 * 带 ${VAR} 的引用无法在浏览器端解析，直接跳过；运行中容器镜像会作为补充来源。
 */
export function extractComposeImages(yaml: string): string[] {
  const result: string[] = [];
  const pattern = /^\s*image:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gm;
  for (const match of yaml.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (raw.length === 0) continue;
    if (raw.startsWith('&') || raw.startsWith('*') || raw.startsWith('!')) continue;
    if (raw.includes('${') || raw.includes('$')) continue;
    if (!result.includes(raw)) result.push(raw);
  }
  return result;
}

export function collectStackImages(yaml: string): string[] {
  return extractComposeImages(yaml);
}

export function stackServiceName(container: ContainerSummary): string {
  if (container.composeService !== undefined && container.composeService !== null) {
    return container.composeService;
  }
  const name = container.names[0]?.replace(/^\//, '');
  if (name !== undefined && name.length > 0) return name;
  return container.id.slice(0, 12);
}

export function stackPullHint(count: number): string {
  return count > 1
    ? `将依次拉取 ${count} 个镜像，每个镜像最长约 10 分钟；页面保持打开以查看进度。`
    : '镜像拉取为同步请求，最长可能需要约 10 分钟。';
}
