import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import type { Task, TaskCreateInput, TaskOverlap, TaskUpdateInput } from '../../api/types';
import { cn } from '../../lib/cn';
import { Button } from '../../components/ui/Button';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { Textarea } from '../../components/ui/Textarea';
import { CRON_PRESETS, NextRunsPreview, validateCronExpression } from './NextRunsPreview';

/** 表单草稿：可空字段用空字符串表示（Task 中的 null 在保存时还原）。 */
export interface TaskDraft {
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  enabled: boolean;
  /** null = 使用服务端默认值（300 秒）。 */
  timeoutSec: number | null;
  overlap: TaskOverlap;
}

export interface TaskFormProps {
  value: TaskDraft;
  onChange: (value: TaskDraft) => void;
  onSubmit: () => void;
  submitting?: boolean;
  mode?: 'create' | 'edit';
  /** 编辑已有任务时传入，用于服务端 next-runs 预览。 */
  taskId?: string;
  savedSchedule?: string | null;
  onCancel?: () => void;
  className?: string;
}

export interface TaskDraftErrors {
  name?: string;
  description?: string;
  schedule?: string;
  timezone?: string;
  command?: string;
  cwd?: string;
  timeoutSec?: string;
  env?: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** 允许大小写/下划线以外的字符，但拒绝会破坏环境变量表示的 “=” 与控制字符。 */
const ENV_KEY_FORBIDDEN = /[=\u0000-\u001f\u007f]/;

function envKeyIssue(key: string): string | null {
  if (key.length === 0) return '变量名不能为空';
  if (key.length > 128) return '变量名最长 128 个字符';
  if (ENV_KEY_FORBIDDEN.test(key)) return '变量名不能包含“=”或控制字符';
  return null;
}

let envRowSeq = 0;

interface EnvRow {
  id: string;
  key: string;
  value: string;
}

function nextEnvRowId(): string {
  envRowSeq += 1;
  return `env-row-${envRowSeq}`;
}

export function emptyTaskDraft(): TaskDraft {
  return {
    name: '',
    description: '',
    schedule: '',
    timezone: '',
    command: '',
    cwd: '',
    env: {},
    enabled: true,
    timeoutSec: null,
    overlap: 'skip',
  };
}

export function draftFromTask(task: Task): TaskDraft {
  return {
    name: task.name,
    description: task.description ?? '',
    schedule: task.schedule,
    timezone: task.timezone ?? '',
    command: task.command,
    cwd: task.cwd ?? '',
    env: { ...task.env },
    enabled: task.enabled,
    timeoutSec: task.timeoutSec,
    overlap: task.overlap,
  };
}

function normalizedEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const trimmed = key.trim();
    if (trimmed.length === 0) continue;
    result[trimmed] = env[key] ?? '';
  }
  return result;
}

export function draftToCreateInput(draft: TaskDraft): TaskCreateInput {
  const description = draft.description.trim();
  const timezone = draft.timezone.trim();
  const cwd = draft.cwd.trim();
  return {
    name: draft.name.trim(),
    schedule: draft.schedule.trim(),
    command: draft.command.trim(),
    enabled: draft.enabled,
    overlap: draft.overlap,
    env: normalizedEnv(draft.env),
    ...(description.length === 0 ? {} : { description }),
    ...(timezone.length === 0 ? {} : { timezone }),
    ...(cwd.length === 0 ? {} : { cwd }),
    ...(draft.timeoutSec === null ? {} : { timeoutSec: draft.timeoutSec }),
  };
}

export function draftToUpdateInput(draft: TaskDraft): TaskUpdateInput {
  const description = draft.description.trim();
  const timezone = draft.timezone.trim();
  const cwd = draft.cwd.trim();
  return {
    name: draft.name.trim(),
    description: description.length === 0 ? null : description,
    schedule: draft.schedule.trim(),
    timezone: timezone.length === 0 ? null : timezone,
    command: draft.command.trim(),
    cwd: cwd.length === 0 ? null : cwd,
    env: normalizedEnv(draft.env),
    enabled: draft.enabled,
    timeoutSec: draft.timeoutSec ?? 300,
    overlap: draft.overlap,
  };
}

/** 用于编辑页判断“是否有未保存修改”。 */
export function serializeTaskDraft(draft: TaskDraft): string {
  return JSON.stringify({
    name: draft.name,
    description: draft.description,
    schedule: draft.schedule,
    timezone: draft.timezone,
    command: draft.command,
    cwd: draft.cwd,
    env: normalizedEnv(draft.env),
    enabled: draft.enabled,
    timeoutSec: draft.timeoutSec,
    overlap: draft.overlap,
  });
}

export function validateTaskDraft(draft: TaskDraft): TaskDraftErrors {
  const errors: TaskDraftErrors = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = '请输入任务名称';
  else if (name.length > 120) errors.name = '任务名称最长 120 个字符';

  if (draft.description.length > 2000) errors.description = '描述最长 2000 个字符';

  const schedule = draft.schedule.trim();
  if (schedule.length === 0) errors.schedule = '请输入 cron 表达式';
  else {
    const check = validateCronExpression(schedule);
    if (!check.valid) errors.schedule = check.error ?? 'cron 表达式无效';
  }

  const timezone = draft.timezone.trim();
  if (timezone.length > 64) errors.timezone = '时区名称最长 64 个字符';
  else if (timezone.length > 0 && !isValidTimezone(timezone)) {
    errors.timezone = '时区不是合法的 IANA 名称（如 Asia/Shanghai）';
  }

  const command = draft.command.trim();
  if (command.length === 0) errors.command = '请输入要执行的命令';
  else if (command.length > 65_536) errors.command = '命令最长 64 KiB';

  const cwd = draft.cwd.trim();
  if (cwd.length > 4096) errors.cwd = '工作目录最长 4096 个字符';
  else if (CONTROL_CHARS.test(cwd)) errors.cwd = '工作目录不能包含控制字符';

  if (draft.timeoutSec !== null) {
    if (!Number.isInteger(draft.timeoutSec) || draft.timeoutSec < 1 || draft.timeoutSec > 86_400) {
      errors.timeoutSec = '超时必须是 1–86400 之间的整数秒';
    }
  }

  const envKeys = Object.keys(draft.env);
  for (const key of envKeys) {
    const trimmed = key.trim();
    const issue = envKeyIssue(trimmed);
    if (issue !== null) {
      errors.env = `环境变量名“${key}”：${issue}`;
      break;
    }
    if ((draft.env[key] ?? '').length > 4096) {
      errors.env = `环境变量“${key}”的值超过 4096 个字符`;
      break;
    }
  }

  return errors;
}

export function hasTaskDraftErrors(errors: TaskDraftErrors): boolean {
  return Object.values(errors).some((value) => typeof value === 'string' && value.length > 0);
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** 任务表单：基本信息、cron（实时校验 + 未来运行时间）、命令、环境变量与保存。 */
export function TaskForm(props: TaskFormProps): JSX.Element {
  const { value, onChange } = props;
  const [submitted, setSubmitted] = useState(false);
  const [envRows, setEnvRows] = useState<EnvRow[]>(() =>
    Object.entries(value.env).map(([key, envValue]) => ({
      id: nextEnvRowId(),
      key,
      value: envValue,
    })),
  );

  const errors = useMemo(() => validateTaskDraft(value), [value]);
  const cronCheck = useMemo(() => validateCronExpression(value.schedule), [value.schedule]);
  const presetMatch = CRON_PRESETS.find((preset) => preset.value === value.schedule.trim());
  const showCronError = (submitted || value.schedule.trim().length > 0) && !cronCheck.valid;
  const hasErrors = hasTaskDraftErrors(errors);

  const envRowErrors = useMemo(() => {
    const result: Record<string, string> = {};
    const seen = new Map<string, string>();
    for (const row of envRows) {
      const key = row.key.trim();
      if (key.length === 0) {
        if (row.value.length > 0) result[row.id] = '变量名不能为空';
        continue;
      }
      const issue = envKeyIssue(key);
      if (issue !== null) {
        result[row.id] = issue;
        continue;
      }
      if (row.value.length > 4096) {
        result[row.id] = '变量值最长 4096 个字符';
        continue;
      }
      const previous = seen.get(key);
      if (previous !== undefined) {
        result[row.id] = '变量名重复';
        if (result[previous] === undefined) result[previous] = '变量名重复';
        continue;
      }
      seen.set(key, row.id);
    }
    return result;
  }, [envRows]);

  const hasEnvRowErrors = Object.keys(envRowErrors).length > 0;

  const patch = (partial: Partial<TaskDraft>): void => {
    onChange({ ...value, ...partial });
  };

  const emitEnv = (rows: EnvRow[]): void => {
    const env: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key.length > 0) env[key] = row.value;
    }
    onChange({ ...value, env });
  };

  const addEnvRow = (): void => {
    setEnvRows((rows) => [...rows, { id: nextEnvRowId(), key: '', value: '' }]);
  };

  const updateEnvRow = (id: string, partial: Partial<Omit<EnvRow, 'id'>>): void => {
    const next = envRows.map((row) => (row.id === id ? { ...row, ...partial } : row));
    setEnvRows(next);
    emitEnv(next);
  };

  const removeEnvRow = (id: string): void => {
    const next = envRows.filter((row) => row.id !== id);
    setEnvRows(next);
    emitEnv(next);
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (hasErrors || hasEnvRowErrors) return;
    props.onSubmit();
  };

  return (
    <form className={cn('flex flex-col gap-4', props.className)} onSubmit={handleSubmit} noValidate>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-app-text">基本信息</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="任务名称"
            htmlFor="task-name"
            required
            error={submitted ? errors.name : undefined}
          >
            <Input
              id="task-name"
              value={value.name}
              onChange={(event) => patch({ name: event.target.value })}
              placeholder="例如：每日备份"
              maxLength={120}
              invalid={submitted && errors.name !== undefined}
              disabled={props.submitting === true}
            />
          </FormField>
          <FormField
            label="启用状态"
            description="禁用后不再按计划触发，但仍可手动“立即运行”。"
          >
            <div className="flex h-9 items-center">
              <Switch
                checked={value.enabled}
                onChange={(enabled) => patch({ enabled })}
                label={value.enabled ? '已启用' : '已禁用'}
                disabled={props.submitting === true}
              />
            </div>
          </FormField>
        </div>
        <FormField
          label="描述"
          htmlFor="task-description"
          error={submitted ? errors.description : undefined}
          hint="可选，用于说明任务用途（最长 2000 字符）。"
        >
          <Textarea
            id="task-description"
            value={value.description}
            onChange={(event) => patch({ description: event.target.value })}
            rows={2}
            maxLength={2000}
            placeholder="这个任务做什么？"
            disabled={props.submitting === true}
          />
        </FormField>
      </section>

      <section className="flex flex-col gap-3 border-t border-app-border pt-4">
        <h3 className="text-sm font-semibold text-app-text">调度</h3>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_13rem]">
          <FormField
            label="Cron 表达式"
            htmlFor="task-schedule"
            required
            error={showCronError ? (errors.schedule ?? cronCheck.error) : undefined}
            description={
              cronCheck.valid
                ? `计划说明：${cronCheck.description}`
                : '支持 5–7 段 cron 表达式（分 时 日 月 周，可选秒/年）；L、W、# 等高级语法由服务端校验。'
            }
          >
            <Input
              id="task-schedule"
              value={value.schedule}
              onChange={(event) => patch({ schedule: event.target.value })}
              placeholder="*/5 * * * *"
              className="font-mono"
              maxLength={128}
              invalid={showCronError}
              disabled={props.submitting === true}
              spellCheck={false}
            />
          </FormField>
          <FormField label="常用预设" htmlFor="task-schedule-preset" description={presetMatch?.description}>
            <Select
              id="task-schedule-preset"
              value=""
              onChange={(event) => {
                const preset = event.target.value;
                if (preset.length > 0) patch({ schedule: preset });
              }}
              options={CRON_PRESETS.map((preset) => ({
                value: preset.value,
                label: `${preset.label} · ${preset.value}`,
              }))}
              placeholder="选择预设快速填入"
              disabled={props.submitting === true}
            />
          </FormField>
        </div>

        <NextRunsPreview
          taskId={props.taskId}
          schedule={value.schedule}
          savedSchedule={props.savedSchedule}
          timezone={value.timezone}
        />

        <FormField
          label="时区（IANA，可选）"
          htmlFor="task-timezone"
          error={submitted || value.timezone.trim().length > 0 ? errors.timezone : undefined}
          hint="例如 Asia/Shanghai；留空使用 agent 本地时区。"
        >
          <Input
            id="task-timezone"
            value={value.timezone}
            onChange={(event) => patch({ timezone: event.target.value })}
            placeholder="Asia/Shanghai"
            className="font-mono"
            maxLength={64}
            invalid={(submitted || value.timezone.trim().length > 0) && errors.timezone !== undefined}
            disabled={props.submitting === true}
            spellCheck={false}
          />
        </FormField>
      </section>

      <section className="flex flex-col gap-3 border-t border-app-border pt-4">
        <h3 className="text-sm font-semibold text-app-text">命令</h3>
        <FormField
          label="Shell 命令"
          required
          error={submitted ? errors.command : undefined}
          hint="由服务器 shell 执行；超时会终止整个进程树。面板凭据会从运行环境中移除。"
        >
          <CodeEditor
            value={value.command}
            onChange={(command) => patch({ command })}
            height="180px"
            placeholder="node --version"
            language="text"
            ariaLabel="任务命令"
          />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField
            label="工作目录（可选）"
            htmlFor="task-cwd"
            error={submitted ? errors.cwd : undefined}
            hint="必须是服务器上已存在的目录；留空使用 agent 默认目录。"
            className="sm:col-span-1"
          >
            <Input
              id="task-cwd"
              value={value.cwd}
              onChange={(event) => patch({ cwd: event.target.value })}
              placeholder="/opt/app"
              className="font-mono"
              maxLength={4096}
              invalid={submitted && errors.cwd !== undefined}
              disabled={props.submitting === true}
            />
          </FormField>
          <FormField
            label="超时（秒）"
            htmlFor="task-timeout"
            error={submitted ? errors.timeoutSec : undefined}
            hint="1–86400 秒，留空使用默认 300 秒。"
          >
            <Input
              id="task-timeout"
              type="number"
              min={1}
              max={86_400}
              step={1}
              value={value.timeoutSec === null ? '' : String(value.timeoutSec)}
              onChange={(event) => {
                const raw = event.target.value.trim();
                if (raw.length === 0) {
                  patch({ timeoutSec: null });
                  return;
                }
                const parsed = Number(raw);
                patch({ timeoutSec: Number.isNaN(parsed) ? null : parsed });
              }}
              placeholder="300"
              invalid={submitted && errors.timeoutSec !== undefined}
              disabled={props.submitting === true}
            />
          </FormField>
          <FormField
            label="并发策略"
            htmlFor="task-overlap"
            hint="已有实例运行时：跳过本次，或允许并发执行。"
          >
            <Select
              id="task-overlap"
              value={value.overlap}
              onChange={(event) => patch({ overlap: event.target.value === 'allow' ? 'allow' : 'skip' })}
              options={[
                { value: 'skip', label: '跳过（skip）' },
                { value: 'allow', label: '允许并发（allow）' },
              ]}
              disabled={props.submitting === true}
            />
          </FormField>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-t border-app-border pt-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-app-text">环境变量</h3>
            <p className="text-xs text-app-muted">明文保存在任务配置中；MPANEL_TOKEN 等面板凭据会被强制移除。</p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={addEnvRow}
            disabled={props.submitting === true}
          >
            添加变量
          </Button>
        </div>
        {errors.env === undefined ? null : (
          <p className="text-xs text-app-danger" role="alert">
            {errors.env}
          </p>
        )}
        {envRows.length === 0 ? (
          <p className="rounded-md border border-dashed border-app-border px-3 py-2 text-xs text-app-muted">
            暂无环境变量。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {envRows.map((row) => {
              const rowError = envRowErrors[row.id];
              return (
                <div key={row.id} className="flex flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={row.key}
                      onChange={(event) => updateEnvRow(row.id, { key: event.target.value })}
                      placeholder="KEY"
                      className="font-mono"
                      aria-label="环境变量名"
                      invalid={rowError !== undefined}
                      disabled={props.submitting === true}
                    />
                    <Input
                      value={row.value}
                      onChange={(event) => updateEnvRow(row.id, { value: event.target.value })}
                      placeholder="value"
                      className="font-mono"
                      aria-label="环境变量值"
                      invalid={rowError !== undefined}
                      disabled={props.submitting === true}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="删除环境变量"
                      title="删除该变量"
                      onClick={() => removeEnvRow(row.id)}
                      disabled={props.submitting === true}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {rowError === undefined ? null : (
                    <p className="text-xs text-app-danger" role="alert">
                      {rowError}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border pt-3">
        <p className="text-xs text-app-muted">
          {submitted && (hasErrors || hasEnvRowErrors)
            ? '请修正表单错误后再保存。'
            : props.mode === 'edit'
              ? '保存后调度立即按新配置生效。'
              : '保存后调度立即生效；历史保留最近 1000 条或 30 天。'}
        </p>
        <div className="flex items-center gap-2">
          {props.onCancel === undefined ? null : (
            <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={props.submitting === true}>
              取消
            </Button>
          )}
          <Button
            type="submit"
            size="sm"
            icon={<Save className="h-4 w-4" />}
            loading={props.submitting === true}
          >
            保存任务
          </Button>
        </div>
      </footer>
    </form>
  );
}
