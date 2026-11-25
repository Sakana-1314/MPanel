import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RefreshCw, Trash2 } from 'lucide-react';
import { getClient } from '../../api/client';
import { listTaskHistory, runTask, tasksKeys } from '../../api/tasks';
import { useAppMutation } from '../../lib/mutations';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { TaskRunTable } from './TaskRunTable';

export interface RunHistoryDrawerProps {
  taskId: string;
  open: boolean;
  onClose: () => void;
  taskName?: string;
  /** 展示在提示中的并发策略，仅用于说明文案。 */
  overlap?: 'skip' | 'allow';
  taskEnabled?: boolean;
}

interface ClearHistoryResult {
  cleared: true;
  id: string;
  removed: number;
}

/**
 * 运行历史抽屉：最近 100 条运行，运行中每 2 秒轮询；支持清理历史与立即运行（异步）。
 */
export function RunHistoryDrawer(props: RunHistoryDrawerProps): JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [clearOpen, setClearOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  const historyQuery = useQuery({
    queryKey: tasksKeys.history(props.taskId, { limit: 100 }),
    queryFn: () => listTaskHistory(props.taskId, { limit: 100 }),
    enabled: props.open && props.taskId.length > 0,
    retry: 0,
  });

  const runs = historyQuery.data?.items ?? [];
  const hasRunning = runs.some((run) => run.status === 'running');
  const previousRunning = useRef(false);

  useEffect(() => {
    if (previousRunning.current && !hasRunning) {
      void queryClient.invalidateQueries({ queryKey: tasksKeys.list() });
      void queryClient.invalidateQueries({ queryKey: tasksKeys.detail(props.taskId) });
    }
    previousRunning.current = hasRunning;
  }, [hasRunning, queryClient, props.taskId]);

  // 有运行中的实例时每 2 秒轮询，结束后自动停止。
  const refetchHistory = historyQuery.refetch;
  useEffect(() => {
    if (!props.open || !hasRunning) return;
    const timer = setInterval(() => {
      void refetchHistory();
    }, 2000);
    return () => clearInterval(timer);
  }, [props.open, hasRunning, refetchHistory]);

  useEffect(() => {
    if (props.open) return;
    setClearOpen(false);
    setRunOpen(false);
  }, [props.open]);

  const clearMutation = useAppMutation({
    mutationFn: () =>
      getClient().request<ClearHistoryResult>(
        `/tasks/${encodeURIComponent(props.taskId)}/history`,
        { method: 'DELETE' },
      ),
    successMessage: (data) => `已清空 ${data.removed} 条运行记录`,
    invalidate: [
      tasksKeys.history(props.taskId),
      tasksKeys.list(),
      tasksKeys.detail(props.taskId),
    ],
    onSuccess: () => setClearOpen(false),
  });

  const runMutation = useAppMutation({
    mutationFn: () => runTask(props.taskId),
    silentSuccess: true,
    invalidate: [
      tasksKeys.list(),
      tasksKeys.history(props.taskId),
      tasksKeys.detail(props.taskId),
    ],
    onSuccess: (result) => {
      setRunOpen(false);
      if (result.run.status === 'skipped') {
        toast.warning(
          '本次运行已跳过',
          props.overlap === 'allow'
            ? '服务端以 skipped 状态拒绝了本次运行，请查看输出。'
            : '已有实例正在运行（并发策略为 skip），本次运行记为已跳过。',
        );
      } else {
        toast.success('已触发立即运行', '任务在后台异步执行，运行状态每 2 秒自动刷新。');
      }
      void historyQuery.refetch();
    },
  });

  const counts = runs.reduce(
    (acc, run) => {
      if (run.status === 'running') acc.running += 1;
      else if (run.status === 'success') acc.success += 1;
      else if (run.status === 'failed' || run.status === 'timeout') acc.failed += 1;
      return acc;
    },
    { running: 0, success: 0, failed: 0 },
  );

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      size="xl"
      title={props.taskName === undefined ? '运行历史' : `运行历史 · ${props.taskName}`}
      description="最近 100 条运行记录；输出仅保留尾部（每段最多 16 KiB）。运行中会自动轮询。"
      bodyClassName="flex flex-col gap-3"
      footer={
        <Button variant="secondary" size="sm" onClick={props.onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="neutral">共 {runs.length} 条</Badge>
          {counts.running > 0 ? <Badge tone="info" dot>运行中 {counts.running}</Badge> : null}
          {counts.success > 0 ? <Badge tone="success">成功 {counts.success}</Badge> : null}
          {counts.failed > 0 ? <Badge tone="danger">失败/超时 {counts.failed}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            icon={<RefreshCw className={historyQuery.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
            onClick={() => {
              void historyQuery.refetch();
            }}
            disabled={historyQuery.isFetching}
          >
            刷新
          </Button>
          <Button
            variant="ghost"
            size="xs"
            icon={<Trash2 className="h-3.5 w-3.5" />}
            className="text-app-danger hover:text-app-danger"
            disabled={runs.length === 0 || clearMutation.isPending}
            onClick={() => setClearOpen(true)}
          >
            清空历史
          </Button>
          <Button
            variant="primary"
            size="xs"
            icon={<Play className="h-3.5 w-3.5" />}
            onClick={() => setRunOpen(true)}
            disabled={runMutation.isPending}
          >
            立即运行
          </Button>
        </div>
      </div>

      <TaskRunTable
        runs={runs}
        loading={historyQuery.isLoading || historyQuery.isFetching}
        error={historyQuery.error ?? undefined}
        onRetry={() => {
          void historyQuery.refetch();
        }}
        emptyText="该任务还没有运行记录。点击“立即运行”可手动触发一次。"
      />

      <p className="text-[11px] leading-relaxed text-app-muted">
        历史保留最近 1000 条或 30 天；每个任务的完整日志最多保留最近 50 次。清空历史只删除运行记录，不会停止正在运行的实例。
      </p>

      <ConfirmDialog
        open={clearOpen}
        title="清空运行历史？"
        message={
          <div className="flex flex-col gap-1.5">
            <p>将删除该任务的 {runs.length} 条运行记录（含输出尾部），此操作不可撤销。</p>
            <p>不会影响正在运行的实例。</p>
          </div>
        }
        confirmLabel="清空历史"
        danger
        loading={clearMutation.isPending}
        onConfirm={() =>
          clearMutation.mutateAsync().then(
            () => undefined,
            () => undefined,
          )
        }
        onCancel={() => setClearOpen(false)}
      />

      <ConfirmDialog
        open={runOpen}
        title="立即运行任务？"
        message={
          <div className="flex flex-col gap-1.5">
            <p>将在服务器上异步执行该任务，不会等待执行结束。</p>
            <p>
              {props.taskEnabled === false
                ? '任务当前已禁用，手动运行仍然允许。'
                : props.overlap === 'allow'
                  ? '并发策略为 allow：即使已有实例运行也会并行执行。'
                  : '并发策略为 skip：若已有实例运行，本次会记为已跳过。'}
            </p>
          </div>
        }
        confirmLabel="立即运行"
        danger={false}
        loading={runMutation.isPending}
        onConfirm={() =>
          runMutation.mutateAsync().then(
            () => undefined,
            () => undefined,
          )
        }
        onCancel={() => setRunOpen(false)}
      />
    </Drawer>
  );
}
