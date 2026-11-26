import { reactive } from 'vue';
import type { Job } from '@/api/types';

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

export function closeJobProgress(): void {
  state.open = false;
  state.jobId = null;
  state.title = '';
  state.invalidate = [];
  completedHandler = null;
  failedHandler = null;
}

export function finishJobProgress(job: Job): void {
  if (job.status === 'succeeded') {
    completedHandler?.(job);
    if (state.closeOnSuccess) closeJobProgress();
    return;
  }
  failedHandler?.(job);
}

export function jobProgressState(): JobProgressState {
  return state;
}
