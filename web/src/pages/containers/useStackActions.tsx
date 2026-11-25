import { useState } from 'react';
import { Download } from 'lucide-react';
import type { StackActionInput } from '../../api/types';
import { deleteStack, getStack, pullImage, stackAction } from '../../api/containers';
import { getClient } from '../../api/client';
import { isAppError } from '../../api/errors';
import { scopedKey } from '../../lib/query-keys';
import { toastError, useInvalidate } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { Alert } from '../../components/ui/Alert';
import { collectStackImages, STACK_ACTION_LABEL } from './stack-utils';

export type StackOperation = keyof typeof STACK_ACTION_LABEL;

export interface StackBusyState {
  name: string;
  operation: StackOperation;
}

export interface StackPullProgress {
  name: string;
  done: number;
  total: number;
  current: string;
}

export interface StackActionsApi {
  busy: StackBusyState | null;
  pullProgress: StackPullProgress | null;
  /** 执行 up/down/restart；失败时已 toast 并重新抛出，调用方需 catch。 */
  runAction(name: string, action: 'up' | 'down' | 'restart', body?: StackActionInput): Promise<void>;
  /** 拉取 compose 中引用到的全部静态镜像；失败时已 toast 并重新抛出。 */
  pull(name: string): Promise<void>;
  remove(name: string, force?: boolean): Promise<void>;
}

/**
 * 编排页共用的写操作：统一 toast、invalidate 与 busy 状态。
 * 注意：docs 契约没有 `docker compose pull` 端点；当前 worker 实现了扩展端点
 * `/stacks/:name/pull`，优先使用它；若 worker 不提供（404），回退到从 compose
 * YAML 提取静态 image 引用后逐个调用 /images/pull。
 */
export function useStackActions(options: { onRemoved?: (name: string) => void } = {}): StackActionsApi {
  const toast = useToast();
  const invalidate = useInvalidate();
  // 在渲染期计算，跟随当前连接/机器作用域，避免模块加载时固化。
  const stacksRoot = scopedKey('stacks', 'list');
  const stackDetailRoot = scopedKey('stacks', 'detail');
  const containersRoot = scopedKey('containers', 'list');
  const imagesRoot = scopedKey('images', 'list');
  const [busy, setBusy] = useState<StackBusyState | null>(null);
  const [pullProgress, setPullProgress] = useState<StackPullProgress | null>(null);

  const runAction = async (
    name: string,
    action: 'up' | 'down' | 'restart',
    body: StackActionInput = {},
  ): Promise<void> => {
    setBusy({ name, operation: action });
    try {
      const result = await stackAction(name, action, body);
      toast.success(`${name}：${STACK_ACTION_LABEL[action]}完成`, summarizeOutput(result.output));
      await invalidate([stacksRoot, stackDetailRoot, containersRoot, imagesRoot]);
    } catch (error) {
      toastError(toast, error, `${name}：${STACK_ACTION_LABEL[action]}失败`);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  const pull = async (name: string): Promise<void> => {
    setBusy({ name, operation: 'pull' });
    try {
      const stack = await getStack(name);
      let detail: string | undefined;
      try {
        const result = await getClient().request<{ ok: true; output: string }>(
          `/stacks/${encodeURIComponent(name)}/pull`,
          { method: 'POST', body: {}, timeoutMs: 620_000 },
        );
        detail = summarizeOutput(result.output);
      } catch (error) {
        // 契约没有该端点；老 worker 返回 404 时退化为逐镜像拉取。
        if (!isAppError(error, 'NOT_FOUND')) throw error;
        const references = collectStackImages(stack.composeYaml);
        if (references.length === 0) {
          toast.warning(
            '未找到可拉取的镜像',
            'compose 文件中没有静态 image 引用（可能全部使用 build，或使用了 ${VAR} 变量），未执行拉取。',
          );
          return;
        }
        for (const [index, reference] of references.entries()) {
          setPullProgress({ name, done: index, total: references.length, current: reference });
          await pullImage(reference);
          setPullProgress({ name, done: index + 1, total: references.length, current: reference });
        }
        detail = `共拉取 ${references.length} 个镜像。`;
      }
      toast.success(`${name}：镜像拉取完成`, detail);
      await invalidate([imagesRoot, stackDetailRoot, stacksRoot]);
    } catch (error) {
      toastError(toast, error, `${name}：镜像拉取失败`);
      throw error;
    } finally {
      setPullProgress(null);
      setBusy(null);
    }
  };

  const remove = async (name: string, force = false): Promise<void> => {
    setBusy({ name, operation: 'remove' });
    try {
      await deleteStack(name, force);
      toast.success(`${name}：已删除编排`, '只删除了 compose 文件，容器需先停止。');
      await invalidate([stacksRoot, stackDetailRoot, containersRoot]);
      options.onRemoved?.(name);
    } catch (error) {
      toastError(toast, error, `${name}：删除失败`);
      throw error;
    } finally {
      setBusy(null);
    }
  };

  return { busy, pullProgress, runAction, pull, remove };
}

/** 拉取多个镜像时的进度条；无进行中的拉取时返回 null。 */
export function StackPullProgressBanner(props: {
  progress: StackPullProgress | null;
}): JSX.Element | null {
  const progress = props.progress;
  if (progress === null) return null;
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <Alert
      tone="info"
      title={`正在拉取 ${progress.name} 的镜像`}
      icon={<Download className="h-4 w-4" />}
      className="mb-3"
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="truncate font-mono">{progress.current}</span>
          <span className="shrink-0 tabular-nums text-app-muted">
            {progress.done}/{progress.total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-app-border">
          <div
            className="h-full rounded-full bg-app-accent transition-all"
            style={{ width: `${Math.max(percent, 3)}%` }}
          />
        </div>
        <span>镜像逐个同步拉取，单个镜像最长约 10 分钟。</span>
      </div>
    </Alert>
  );
}

function summarizeOutput(output: string): string | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed;
}
