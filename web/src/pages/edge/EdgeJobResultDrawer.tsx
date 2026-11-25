import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { Machine } from '../../api/types';
import { edgeKeys, getEdgeJob } from '../../api/edge';
import { formatDate } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { CopyButton } from '../../components/ui/CopyButton';
import { Drawer } from '../../components/ui/Drawer';
import { ErrorState } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';
import { RelativeTime } from '../../components/ui/RelativeTime';
import {
  EDGE_JOB_KIND_LABEL,
  EDGE_JOB_STATUS_LABEL,
  EDGE_JOB_STATUS_TONE,
  edgeJobDurationText,
  isTruncatedJobResult,
  jsonText,
  machineName,
} from './edge-utils';
import { usePageVisible } from './use-page-visible';

export interface EdgeJobResultDrawerProps {
  jobId: string | null;
  machines: readonly Machine[];
  onClose: () => void;
}

/** 作业结果抽屉：payload / result 只读 JSON，running/pending 时自动轮询。 */
export function EdgeJobResultDrawer(props: EdgeJobResultDrawerProps): JSX.Element {
  const visible = usePageVisible();
  const jobId = props.jobId;
  const [refreshing, setRefreshing] = useState(false);

  const jobQuery = useQuery({
    queryKey: edgeKeys.job(jobId ?? 'missing'),
    queryFn: () => getEdgeJob(jobId ?? ''),
    enabled: jobId !== null,
    retry: 0,
    refetchInterval: (query) => {
      if (!visible) return false;
      const status = query.state.data?.status;
      if (status === 'running') return 2_000;
      if (status === 'pending') return 5_000;
      return false;
    },
  });

  const job = jobQuery.data;
  const resultText = job === undefined ? '' : jsonText(job.result);
  const payloadText = job === undefined ? '' : jsonText(job.payload);
  const truncated = job !== undefined && isTruncatedJobResult(job.result, resultText);

  const refreshJob = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await jobQuery.refetch();
    } catch {
      // 错误态由抽屉内的 ErrorState 展示。
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Drawer
      open={jobId !== null}
      onClose={props.onClose}
      title={job === undefined ? '作业详情' : `作业 ${job.id}`}
      description={
        job === undefined
          ? '读取 GET /edge/jobs/:id。'
          : `${EDGE_JOB_KIND_LABEL[job.kind]} · ${machineName(props.machines, job.machineId)}`
      }
      size="xl"
      footer={
        <>
          <CopyButton value={resultText} label="复制结果 JSON" variant="secondary" />
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
            loading={refreshing}
            onClick={() => {
              void refreshJob();
            }}
          >
            刷新
          </Button>
          <Button size="sm" onClick={props.onClose}>
            关闭
          </Button>
        </>
      }
    >
      {jobQuery.isLoading ? (
        <div className="flex min-h-40 items-center justify-center">
          <Spinner label="加载作业…" />
        </div>
      ) : jobQuery.isError ? (
        <ErrorState error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />
      ) : job === undefined ? (
        <p className="text-xs text-app-muted">作业不存在或已被删除。</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={EDGE_JOB_STATUS_TONE[job.status]} dot>
              {EDGE_JOB_STATUS_LABEL[job.status]}
            </Badge>
            <Badge tone="neutral">{EDGE_JOB_KIND_LABEL[job.kind]}</Badge>
            <span className="font-mono text-[11px] text-app-muted">
              HTTP {job.httpStatus ?? '—'}
            </span>
          </div>

          {job.error === null ? null : (
            <Alert tone="danger" title="作业失败原因">
              {job.error}
            </Alert>
          )}

          <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-xs text-app-muted">作业 ID</dt>
            <dd className="break-all font-mono text-xs text-app-text">{job.id}</dd>
            <dt className="text-xs text-app-muted">机器</dt>
            <dd className="text-app-text">
              {machineName(props.machines, job.machineId)}
              <span className="ml-1 font-mono text-[10px] text-app-muted">{job.machineId}</span>
            </dd>
            <dt className="text-xs text-app-muted">创建时间</dt>
            <dd className="text-app-text">
              {formatDate(job.createdAt)}
              <span className="ml-1 text-[10px] text-app-muted">
                （<RelativeTime value={job.createdAt} />）
              </span>
            </dd>
            <dt className="text-xs text-app-muted">开始时间</dt>
            <dd className="text-app-text">
              {job.startedAt === null ? '—' : formatDate(job.startedAt)}
            </dd>
            <dt className="text-xs text-app-muted">结束时间</dt>
            <dd className="text-app-text">
              {job.finishedAt === null ? '—' : formatDate(job.finishedAt)}
            </dd>
            <dt className="text-xs text-app-muted">耗时</dt>
            <dd className="tabular-nums text-app-text">{edgeJobDurationText(job)}</dd>
          </dl>

          <div>
            <p className="mb-1 text-xs font-medium text-app-text">请求 payload</p>
            <CodeEditor
              value={payloadText.length === 0 ? '{}' : payloadText}
              readOnly
              language="json"
              height="140px"
              ariaLabel="作业 payload JSON"
            />
          </div>

          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium text-app-text">响应 result</p>
              {truncated ? (
                <Badge tone="warning" className="text-[10px]">
                  truncated
                </Badge>
              ) : null}
            </div>
            {truncated ? (
              <Alert tone="warning" title="结果已截断" className="mb-2">
                result 超过 16KB（或 core 标记 truncated=true），这里展示的是截断后的 JSON；
                完整响应需在目标节点查看。
              </Alert>
            ) : null}
            <CodeEditor
              value={resultText}
              readOnly
              language="json"
              height="360px"
              placeholder="作业尚未返回结果"
              ariaLabel="作业 result JSON"
            />
          </div>

          <p className="text-[11px] leading-relaxed text-app-muted">
            待执行 / 执行中的作业会自动刷新（待执行 5 秒、执行中 2 秒）；窗口隐藏时暂停。
          </p>
        </div>
      )}
    </Drawer>
  );
}
