import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EdgeJob, EdgeJobKind, Machine } from '../../api/types';
import {
  createEdgeJob,
  edgeKeys,
  listEdgeTargetSites,
  listEdgeTargetTasks,
} from '../../api/edge';
import { describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { statusLabel } from '../../components/ui/tones';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import {
  EDGE_JOB_KIND_LABEL,
  EDGE_JOB_KIND_OPTIONS,
} from './edge-utils';

export interface CreateEdgeJobDialogProps {
  open: boolean;
  /** 边缘节点（edge=true），作为作业目标。 */
  machines: Machine[];
  initialMachineId?: string;
  onClose: () => void;
  onCreated: (job: EdgeJob) => void;
}

interface IdOption {
  value: string;
  label: string;
}

function withManualOption(options: IdOption[], value: string, label: string): IdOption[] {
  if (value.trim().length === 0) return options;
  if (options.some((option) => option.value === value)) return options;
  return [...options, { value, label: `${label}：${value}` }];
}

/** 新建边缘作业：snapshot 无 payload；run-task / apply-site 从目标机读取下拉，失败允许手填 ID。 */
export function CreateEdgeJobDialog(props: CreateEdgeJobDialogProps): JSX.Element {
  const [machineId, setMachineId] = useState('');
  const [kind, setKind] = useState<EdgeJobKind>('snapshot');
  const [taskId, setTaskId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const preferred =
      props.initialMachineId !== undefined &&
      props.machines.some((machine) => machine.id === props.initialMachineId)
        ? props.initialMachineId
        : (props.machines[0]?.id ?? '');
    setMachineId(preferred);
    setKind('snapshot');
    setTaskId('');
    setSiteId('');
    setFormError(null);
    // 只在打开/指定机器变化时重置；不要在 machines 轮询刷新时清空表单。
  }, [props.open, props.initialMachineId]);

  const tasksQuery = useQuery({
    queryKey: edgeKeys.machineTasks(machineId),
    queryFn: () => listEdgeTargetTasks(machineId),
    enabled: props.open && kind === 'run-task' && machineId.length > 0,
    retry: 0,
  });

  const sitesQuery = useQuery({
    queryKey: edgeKeys.machineSites(machineId),
    queryFn: () => listEdgeTargetSites(machineId),
    enabled: props.open && kind === 'apply-site' && machineId.length > 0,
    retry: 0,
  });

  const payload = (): Record<string, unknown> => {
    if (kind === 'run-task') return { taskId: taskId.trim() };
    if (kind === 'apply-site') return { siteId: siteId.trim() };
    return {};
  };

  const mutation = useAppMutation<EdgeJob, void>({
    mutationFn: () => createEdgeJob({ machineId, kind, payload: payload() }),
    successMessage: (job) => `已创建「${EDGE_JOB_KIND_LABEL[job.kind]}」作业`,
    successDescription: '节点离线时作业保持 pending；上线后按创建时间顺序串行执行。',
    invalidate: [edgeKeys.jobsRoot()],
    onSuccess: (job) => {
      props.onCreated(job);
      props.onClose();
    },
  });

  const submit = (): void => {
    if (machineId.length === 0) {
      setFormError('请选择目标机器。');
      return;
    }
    if (kind === 'run-task' && taskId.trim().length === 0) {
      setFormError('请选择任务或手动填写任务 ID。');
      return;
    }
    if (kind === 'apply-site' && siteId.trim().length === 0) {
      setFormError('请选择站点或手动填写站点 ID。');
      return;
    }
    setFormError(null);
    mutation.mutate();
  };

  const taskItems = tasksQuery.data?.items ?? [];
  const siteItems = sitesQuery.data?.items ?? [];
  const taskOptions = withManualOption(
    taskItems.map((task) => ({ value: task.id, label: `${task.name}（${task.id}）` })),
    taskId,
    '手动 ID',
  );
  const siteOptions = withManualOption(
    siteItems.map((site) => ({ value: site.id, label: `${site.name}（${site.id}）` })),
    siteId,
    '手动 ID',
  );

  const taskError = tasksQuery.isError ? describeError(tasksQuery.error) : null;
  const siteError = sitesQuery.isError ? describeError(sitesQuery.error) : null;
  const mutationError = mutation.isError ? describeError(mutation.error) : null;
  const selectedKind = EDGE_JOB_KIND_OPTIONS.find((option) => option.value === kind);

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="新建边缘作业"
      description="作业由 core 在目标节点在线时串行执行；离线节点会保持 pending。"
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={mutation.isPending}>
            取消
          </Button>
          <Button
            size="sm"
            loading={mutation.isPending}
            disabled={props.machines.length === 0}
            onClick={submit}
          >
            创建作业
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {props.machines.length === 0 ? (
          <Alert tone="warning" title="没有可选的边缘节点">
            请先创建入网密钥并让 worker 接入；作业目标必须是 edge=true 的机器。
          </Alert>
        ) : null}

        <FormField label="目标机器" required htmlFor="edge-job-machine">
          <Select
            id="edge-job-machine"
            value={machineId}
            placeholder="选择机器…"
            onChange={(event) => {
              setMachineId(event.target.value);
              setTaskId('');
              setSiteId('');
            }}
            options={props.machines.map((machine) => ({
              value: machine.id,
              label: `${machine.name}（${statusLabel(machine.status)}）`,
            }))}
            disabled={props.machines.length === 0}
          />
        </FormField>

        <FormField
          label="作业类型"
          required
          htmlFor="edge-job-kind"
          hint={selectedKind?.description}
        >
          <Select
            id="edge-job-kind"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as EdgeJobKind);
              setTaskId('');
              setSiteId('');
            }}
            options={EDGE_JOB_KIND_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />
        </FormField>

        {kind === 'snapshot' ? (
          <Alert tone="info" title="快照作业不需要 payload">
            执行时调用目标节点的 GET /system/snapshot，并刷新 core 上的节点快照。
          </Alert>
        ) : null}

        {kind === 'run-task' ? (
          <div className="flex flex-col gap-2">
            <FormField
              label="任务"
              hint={
                tasksQuery.isLoading
                  ? '正在读取目标机器的任务…'
                  : '下拉来自目标机器的 GET /tasks；读取失败时可手动填写任务 ID。'
              }
            >
              <Select
                value={taskId}
                placeholder="选择任务…"
                onChange={(event) => setTaskId(event.target.value)}
                options={taskOptions}
                disabled={tasksQuery.isLoading || props.machines.length === 0}
              />
            </FormField>
            {tasksQuery.isLoading ? (
              <span className="flex items-center gap-2 text-[11px] text-app-muted">
                <Spinner size="xs" />
                加载任务列表
              </span>
            ) : null}
            {taskError === null ? null : (
              <Alert tone="warning" title={taskError.title} hint="仍可在下方手动填写任务 ID。">
                {taskError.description}
              </Alert>
            )}
            {tasksQuery.data?.available === false ? (
              <Alert tone="warning" title="任务列表不可用" hint="仍可手动填写任务 ID。">
                {tasksQuery.data.reason ?? 'worker 返回 available=false。'}
              </Alert>
            ) : null}
            <FormField label="任务 ID（可手动填写）" htmlFor="edge-job-task-id">
              <Input
                id="edge-job-task-id"
                value={taskId}
                placeholder="tk_..."
                onChange={(event) => setTaskId(event.target.value)}
              />
            </FormField>
          </div>
        ) : null}

        {kind === 'apply-site' ? (
          <div className="flex flex-col gap-2">
            <FormField
              label="站点"
              hint={
                sitesQuery.isLoading
                  ? '正在读取目标机器的站点…'
                  : '下拉来自目标机器的 GET /sites；读取失败时可手动填写站点 ID。'
              }
            >
              <Select
                value={siteId}
                placeholder="选择站点…"
                onChange={(event) => setSiteId(event.target.value)}
                options={siteOptions}
                disabled={sitesQuery.isLoading || props.machines.length === 0}
              />
            </FormField>
            {sitesQuery.isLoading ? (
              <span className="flex items-center gap-2 text-[11px] text-app-muted">
                <Spinner size="xs" />
                加载站点列表
              </span>
            ) : null}
            {siteError === null ? null : (
              <Alert tone="warning" title={siteError.title} hint="仍可在下方手动填写站点 ID。">
                {siteError.description}
              </Alert>
            )}
            {sitesQuery.data?.available === false ? (
              <Alert tone="warning" title="站点列表不可用" hint="仍可手动填写站点 ID。">
                {sitesQuery.data.reason ?? 'worker 返回 available=false。'}
              </Alert>
            ) : null}
            <FormField label="站点 ID（可手动填写）" htmlFor="edge-job-site-id">
              <Input
                id="edge-job-site-id"
                value={siteId}
                placeholder="st_..."
                onChange={(event) => setSiteId(event.target.value)}
              />
            </FormField>
          </div>
        ) : null}

        {formError === null ? null : (
          <Alert tone="danger" title="请检查表单">
            {formError}
          </Alert>
        )}
        {mutationError === null ? null : (
          <Alert tone="danger" title={mutationError.title} hint={mutationError.hint}>
            {mutationError.description}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
