import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { databasesKeys, getJob } from '../../api/databases';
import { describeError } from '../../api/errors';
import { formatDate } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { Spinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/StatusBadge';

export interface JobProgressProps {
  jobId: string;
  /** 作业进入 success/failed 时触发一次（用于刷新备份列表）。 */
  onDone?: () => void;
  onDismiss?(): void;
  className?: string;
}

/** 后台备份/恢复作业进度：轮询 /databases/jobs/:id，终态回调 onDone。 */
export function JobProgress(props: JobProgressProps): JSX.Element {
  const query = useQuery({
    queryKey: databasesKeys.job(props.jobId),
    queryFn: () => getJob(props.jobId),
    retry: 0,
    refetchInterval: (current) => {
      const status = current.state.data?.status;
      return status === 'queued' || status === 'running' ? 1500 : false;
    },
  });

  const job = query.data;
  const status = job?.status;
  const finished = status === 'success' || status === 'failed';
  const active = query.isLoading || status === 'queued' || status === 'running';
  const notified = useRef<string | null>(null);

  useEffect(() => {
    if (job === undefined || !finished) return;
    const marker = `${job.id}:${job.status}`;
    if (notified.current === marker) return;
    notified.current = marker;
    props.onDone?.();
  }, [job, finished, props.onDone]);

  if (query.isError) {
    const info = describeError(query.error, '读取作业状态失败');
    return (
      <Card compact className={cn('flex flex-col gap-2', props.className)}>
        <Alert
          tone="danger"
          title={info.title}
          hint={info.hint}
          action={
            <Button variant="secondary" size="xs" onClick={() => void query.refetch()}>
              重试
            </Button>
          }
        >
          {info.description}
        </Alert>
      </Card>
    );
  }

  return (
    <Card compact className={cn('flex flex-col gap-2', props.className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {active ? <Spinner size="sm" /> : <StatusBadge status={job?.status ?? 'queued'} />}
          <span className="text-sm font-medium text-app-text">
            {job === undefined
              ? '加载作业状态…'
              : job.type === 'backup'
                ? '备份作业'
                : '恢复作业'}
          </span>
          {job?.backupId === null || job?.backupId === undefined ? null : (
            <span className="font-mono text-[10px] text-app-muted">backup {job.backupId}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="max-w-[12rem] truncate font-mono text-[10px] text-app-muted" title={props.jobId}>
            {props.jobId}
          </span>
          {props.onDismiss === undefined ? null : (
            <Button
              size="xs"
              variant="ghost"
              icon={<X className="h-3 w-3" />}
              onClick={props.onDismiss}
            >
              关闭
            </Button>
          )}
        </div>
      </div>

      {job?.progress === null || job?.progress === undefined ? null : (
        <p className="text-xs text-app-muted">{job.progress}</p>
      )}

      {job?.error === null || job?.error === undefined ? null : (
        <Alert tone="danger" title="作业失败" hint="修复错误后可重新创建备份/恢复作业。">
          {job.error}
        </Alert>
      )}

      <p className="text-[10px] text-app-muted">
        开始：{job?.startedAt === null || job?.startedAt === undefined ? '—' : formatDate(job.startedAt)}
        {' · '}
        结束：{job?.finishedAt === null || job?.finishedAt === undefined ? '—' : formatDate(job.finishedAt)}
      </p>
    </Card>
  );
}
