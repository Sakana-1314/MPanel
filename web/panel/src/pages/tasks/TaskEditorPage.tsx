import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Task, TaskCreateInput, TaskUpdateInput } from '../../api/types';
import { createTask, getTask, tasksKeys, updateTask } from '../../api/tasks';
import { formatDate } from '../../lib/format';
import { useAppMutation } from '../../lib/mutations';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { ErrorState } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';
import {
  TaskForm,
  draftFromTask,
  draftToCreateInput,
  draftToUpdateInput,
  emptyTaskDraft,
  serializeTaskDraft,
  type TaskDraft,
} from './TaskForm';

/**
 * 任务编辑器路由（/tasks/new 与 /tasks/:id）：以右侧抽屉承载表单。
 * 新建成功后 replace 到 /tasks/:id 以便立即展示服务端计算的 next-runs；保存更新后停留在编辑器。
 */
export default function TaskEditorPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const closeTo = useCallback(() => navigate('/tasks'), [navigate]);

  if (id === undefined) {
    return (
      <>
        <TaskEditorBody onClose={closeTo} />
      </>
    );
  }
  return (
    <>
      <ExistingTaskEditor taskId={id} onClose={closeTo} />
    </>
  );
}

function ExistingTaskEditor(props: { taskId: string; onClose: () => void }): JSX.Element {
  const taskQuery = useQuery({
    queryKey: tasksKeys.detail(props.taskId),
    queryFn: () => getTask(props.taskId),
    retry: 0,
  });

  if (taskQuery.isLoading) {
    return (
      <Drawer
        open
        onClose={props.onClose}
        size="xl"
        title="加载任务…"
        description="正在读取任务配置与调度信息。"
      >
        <div className="flex items-center justify-center py-16">
          <Spinner size="lg" label="加载任务…" />
        </div>
      </Drawer>
    );
  }

  if (taskQuery.error !== null && taskQuery.error !== undefined) {
    return (
      <Drawer
        open
        onClose={props.onClose}
        size="xl"
        title="任务加载失败"
        footer={
          <Button variant="secondary" size="sm" onClick={props.onClose}>
            返回列表
          </Button>
        }
      >
        <ErrorState
          error={taskQuery.error}
          onRetry={() => {
            void taskQuery.refetch();
          }}
        />
      </Drawer>
    );
  }

  const task = taskQuery.data;
  if (task === undefined) {
    return (
      <Drawer open onClose={props.onClose} size="xl" title="任务不存在">
        <ErrorState error={new Error('任务不存在或已被删除')} />
      </Drawer>
    );
  }

  return <TaskEditorBody key={task.id} task={task} onClose={props.onClose} />;
}

interface CreateVariables {
  payload: TaskCreateInput;
}

interface UpdateVariables {
  id: string;
  payload: TaskUpdateInput;
  snapshot: string;
}

function TaskEditorBody(props: { task?: Task; onClose: () => void }): JSX.Element {
  const navigate = useNavigate();
  const task = props.task;
  const [draft, setDraft] = useState<TaskDraft>(() =>
    task === undefined ? emptyTaskDraft() : draftFromTask(task),
  );
  const initialSnapshot = useRef(serializeTaskDraft(draft));
  const [discardOpen, setDiscardOpen] = useState(false);

  const dirty = serializeTaskDraft(draft) !== initialSnapshot.current;

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const createMutation = useAppMutation({
    mutationFn: (variables: CreateVariables) => createTask(variables.payload),
    successMessage: '任务已创建',
    successDescription: '调度已生效；正在展示服务端计算的未来运行时间。',
    invalidate: [tasksKeys.list()],
    onSuccess: (created) => {
      navigate(`/tasks/${created.id}`, { replace: true });
    },
  });

  const updateMutation = useAppMutation({
    mutationFn: (variables: UpdateVariables) => updateTask(variables.id, variables.payload),
    successMessage: '任务已保存',
    successDescription: '调度已按新配置生效。',
    invalidate:
      task === undefined
        ? [tasksKeys.list()]
        : [tasksKeys.list(), tasksKeys.detail(task.id)],
    onSuccess: (_updated, variables) => {
      initialSnapshot.current = variables.snapshot;
    },
  });

  const submitting = createMutation.isPending || updateMutation.isPending;

  const requestClose = (): void => {
    if (submitting) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    props.onClose();
  };

  const handleSubmit = (): void => {
    if (task === undefined) {
      createMutation.mutate({ payload: draftToCreateInput(draft) });
      return;
    }
    updateMutation.mutate({
      id: task.id,
      payload: draftToUpdateInput(draft),
      snapshot: serializeTaskDraft(draft),
    });
  };

  return (
    <>
      <Drawer
        open
        onClose={requestClose}
        size="xl"
        title={task === undefined ? '新建计划任务' : `编辑任务 · ${task.name}`}
        description={
          task === undefined
            ? '填写 cron 计划与命令；保存后立即开始调度。'
            : `任务 ${task.id} · 上次更新 ${formatDate(task.updatedAt)}`
        }
        bodyClassName="pb-8"
      >
        <TaskForm
          value={draft}
          onChange={setDraft}
          onSubmit={handleSubmit}
          submitting={submitting}
          mode={task === undefined ? 'create' : 'edit'}
          taskId={task?.id}
          savedSchedule={task?.schedule}
          onCancel={requestClose}
        />
      </Drawer>

      <ConfirmDialog
        open={discardOpen}
        title="放弃未保存的修改？"
        message="当前表单有未保存的更改，关闭编辑器后这些修改会丢失。"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        danger
        onConfirm={() => {
          setDiscardOpen(false);
          props.onClose();
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </>
  );
}
