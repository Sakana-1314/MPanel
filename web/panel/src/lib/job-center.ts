import { reactive } from 'vue';
import type { Job } from '@/api/types';
import { getMachineClient } from '@/api/client';
import { queryClient } from '@/lib/query-client';

/**
 * Global "long operation" modal state. Pages start an async request, then call
 * openJobProgress(job.id) to show the shared progress dialog. The dialog polls
 * GET /jobs/{id} and invalidates the provided query keys when the job ends.
 */
interface JobProgressOptions {
  machineId: string;
  jobId: string;
  title?: string;
  invalidate?: readonly (readonly unknown[])[];
  closeOnSuccess?: boolean;
  onCompleted?: (job: Job) => void;
  onFailed?: (job: Job) => void;
}

interface JobProgressState {
  open: boolean;
  machineId: string;
  jobId: string | null;
  title: string;
  invalidate: readonly (readonly unknown[])[];
  closeOnSuccess: boolean;
}

const state = reactive<JobProgressState>({
  open: false,
  machineId: '',
  jobId: null,
  title: '',
  invalidate: [],
  closeOnSuccess: true,
});

let completedHandler: ((job: Job) => void) | null = null;
let failedHandler: ((job: Job) => void) | null = null;

export function openJobProgress(options: JobProgressOptions): void {
  state.machineId = options.machineId;
  state.jobId = options.jobId;
  state.title = options.title ?? '';
  state.invalidate = options.invalidate ?? [];
  state.closeOnSuccess = options.closeOnSuccess !== false;
  state.open = true;
  completedHandler = options.onCompleted ?? null;
  failedHandler = options.onFailed ?? null;
}

export function closeJobProgress(skipMonitor = false): void {
  const jobId = state.jobId;
  const machineId = state.machineId;
  const invalidate = state.invalidate;
  state.open = false;
  state.jobId = null;
  state.title = '';
  state.invalidate = [];
  completedHandler = null;
  failedHandler = null;
  // Closing the dialog while the job still runs must not lose cache
  // invalidation: keep a lightweight monitor until the job terminates.
  if (!skipMonitor && jobId !== null && machineId.length > 0) {
    monitorFinishedJob(machineId, jobId, invalidate);
  }
}

function monitorFinishedJob(
  machineId: string,
  jobId: string,
  invalidate: readonly (readonly unknown[])[],
): void {
  const api = getMachineClient(machineId);
  const tick = async (): Promise<void> => {
    try {
      const job = await api.jobs.get(jobId);
      if (job.status === 'queued' || job.status === 'running') {
        window.setTimeout(() => void tick(), 1_500);
        return;
      }
      for (const key of invalidate) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    } catch {
      // 连接切换/任务不可达时停止监视；任务中心仍可重新查看。
    }
  };
  void tick();
}

export function finishJobProgress(job: Job): void {
  if (job.status === 'succeeded') {
    completedHandler?.(job);
    if (state.closeOnSuccess) closeJobProgress(true);
    return;
  }
  failedHandler?.(job);
}

export function jobProgressState(): JobProgressState {
  return state;
}
