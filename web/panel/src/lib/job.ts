import type { ApiClient } from '@/api/client';
import type { Job } from '@/api/types';
import { AppError } from '@/api/errors';

export function isJobTerminal(job: Job): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
}

/** Poll a job until it reaches a terminal state; onChange is called on every snapshot. */
export async function waitForJob(
  api: ApiClient,
  jobId: string,
  onChange?: (job: Job) => void,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<Job> {
  const interval = opts.intervalMs ?? 800;
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const job = await api.jobs.get(jobId);
      onChange?.(job);
      if (isJobTerminal(job)) return job;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw lastError instanceof AppError
    ? lastError
    : new AppError('TIMEOUT', '任务进度查询超时', 0, { hint: '任务可能仍在后台执行，请到任务中心查看。' });
}

export function jobStatusLabel(status: Job['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '执行中';
    case 'succeeded':
      return '已完成';
    case 'failed':
      return '失败';
    case 'cancelled':
      return '已取消';
    default:
      return status;
  }
}
