import { useEffect, useState } from 'react';
import {
  createMachine,
  machinesKeys,
  updateMachine,
} from '../../api/machines';
import type {
  Machine,
  MachineCreateInput,
  MachineCreateResult,
  MachineTransport,
  MachineUpdateInput,
} from '../../api/types';
import { describeError } from '../../api/errors';
import { formatDate } from '../../lib/format';
import { useAppMutation } from '../../lib/mutations';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { Textarea } from '../../components/ui/Textarea';

export interface MachineFormDialogProps {
  open: boolean;
  onClose: () => void;
  machine?: Machine;
  onSaved?: (result: MachineCreateResult) => void;
}

const TRANSPORT_LABEL: Record<MachineTransport, string> = {
  http: 'http · 直连 worker URL',
  stdio: 'stdio · core 拉起本地进程',
  'reverse-ws': 'reverse-ws · worker 主动连回 core',
};

const RESERVED_ENV_KEYS = new Set([
  'MPANEL_TRANSPORT',
  'MPANEL_TOKEN',
  'MPANEL_HOME',
  'MPANEL_CORE_URL',
  'MPANEL_MACHINE_ID',
  'MPANEL_MACHINE_SECRET',
]);

interface ParseResult<T> {
  value?: T;
  error?: string;
}

function parseEnvText(text: string): ParseResult<Record<string, string>> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) {
      return { error: `环境变量第 ${index + 1} 行应形如 KEY=VALUE。` };
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { error: `环境变量名不合法：${key}` };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return { error: `${key} 是 core 注入的保留键，不能在这里填写。` };
    }
    result[key] = value;
  }
  return { value: result };
}

function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/**
 * 新增/编辑机器（core 专属）。
 * - create 支持 http / stdio / reverse-ws 三种传输；
 * - 传输类型不可修改（契约：换传输请新建）；
 * - token 为 write-only，编辑时留空表示保持不变。
 */
export function MachineFormDialog(props: MachineFormDialogProps): JSX.Element {
  const isEdit = props.machine !== undefined;
  const machine = props.machine;
  const hasToken = machine?.hasToken === true;

  const [name, setName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [transport, setTransport] = useState<MachineTransport>('http');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setName(machine?.name ?? '');
    setEnabled(machine?.enabled ?? true);
    setTransport(machine?.transport ?? 'http');
    setUrl(machine?.endpoint ?? '');
    setToken('');
    setCommand('');
    setArgsText('');
    setEnvText('');
    setError(null);
  }, [props.open, machine?.id, machine?.transport, machine?.endpoint, machine?.name, machine?.enabled]);

  const envParsed = parseEnvText(envText);
  const args = parseArgsText(argsText);
  const tokenRequired = transport === 'http' || transport === 'stdio';

  const invalidateKeys =
    isEdit && machine !== undefined
      ? [
          machinesKeys.list({ limit: 200 }),
          machinesKeys.detail(machine.id),
          machinesKeys.health(machine.id),
        ]
      : [machinesKeys.list({ limit: 200 })];

  const createMutation = useAppMutation<MachineCreateResult, MachineCreateInput>({
    mutationFn: (input) => createMachine(input),
    successMessage: (result) => `已创建机器 ${result.machine.name}`,
    successDescription: (result) =>
      result.enrollment === undefined
        ? 'core 已开始连接该机器，可在列表中查看状态。'
        : '下一步会显示一次性注册信息，请立即保存。',
    invalidate: invalidateKeys,
    onSuccess: (result) => {
      props.onSaved?.(result);
      props.onClose();
    },
  });

  const updateMutation = useAppMutation<
    Machine,
    { id: string; input: MachineUpdateInput }
  >({
    mutationFn: ({ id, input }) => updateMachine(id, input),
    successMessage: (updated) => `已保存机器 ${updated.name}`,
    invalidate: invalidateKeys,
    onSuccess: (updated) => {
      props.onSaved?.({ machine: updated });
      props.onClose();
    },
  });

  const submitting = createMutation.isPending || updateMutation.isPending;
  const mutationError = createMutation.error ?? updateMutation.error;

  useEffect(() => {
    if (!props.open) return;
    createMutation.reset();
    updateMutation.reset();
    // 仅在重新打开对话框时清除上一次失败提示。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  const validate = (): string | null => {
    if (name.trim().length === 0) return '请填写机器名称。';
    if (transport === 'http') {
      const normalized = normalizeUrl(url);
      if (normalized.length === 0) return '请填写 worker 的 HTTP URL。';
      try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return 'worker URL 必须是 http:// 或 https:// 开头。';
        }
      } catch {
        return 'worker URL 格式不正确，例如 http://127.0.0.1:8787。';
      }
    }
    if (transport === 'stdio') {
      if (envParsed.error !== undefined) return envParsed.error;
    }
    if (tokenRequired) {
      const requiresNew = !isEdit || !hasToken;
      if (requiresNew && token.trim().length === 0) {
        return transport === 'http'
          ? 'http 机器需要 worker 的 MPANEL_TOKEN。'
          : 'stdio 机器需要注入给 worker 的 MPANEL_TOKEN。';
      }
    }
    return null;
  };

  const buildCreateInput = (): MachineCreateInput => {
    const base = { name: name.trim(), enabled };
    if (transport === 'http') {
      return { ...base, transport: 'http', url: normalizeUrl(url), token: token.trim() };
    }
    if (transport === 'stdio') {
      return {
        ...base,
        transport: 'stdio',
        command: command.trim().length === 0 ? undefined : command.trim(),
        args: args.length === 0 ? undefined : args,
        env: envParsed.value,
        token: token.trim(),
      };
    }
    return { ...base, transport: 'reverse-ws' };
  };

  const buildUpdateInput = (): MachineUpdateInput => {
    const base: MachineUpdateInput = { name: name.trim(), enabled };
    if (transport === 'http') {
      base.url = normalizeUrl(url);
      if (token.trim().length > 0) base.token = token.trim();
      return base;
    }
    if (transport === 'stdio') {
      if (command.trim().length > 0) base.command = command.trim();
      // Machine 不返回 args/env；编辑时留空表示“保持不变”，避免误清空。
      if (argsText.trim().length > 0) base.args = args;
      if (envText.trim().length > 0) base.env = envParsed.value;
      if (token.trim().length > 0) base.token = token.trim();
      return base;
    }
    return base;
  };

  const submit = (): void => {
    const problem = validate();
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    if (isEdit && machine !== undefined) {
      updateMutation.mutate({ id: machine.id, input: buildUpdateInput() });
      return;
    }
    createMutation.mutate(buildCreateInput());
  };

  return (
    <Modal
      open={props.open}
      onClose={submitting ? () => undefined : props.onClose}
      title={isEdit ? `编辑机器 · ${machine?.name ?? ''}` : '新增机器'}
      description="core 通过 http / stdio / reverse-ws 管理 worker；机器凭据只写不读。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={submitting}>
            取消
          </Button>
          <Button size="sm" loading={submitting} onClick={submit}>
            {isEdit ? '保存' : '创建机器'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {isEdit ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-app-muted">
            <Badge tone="accent">{machine?.transport}</Badge>
            <span>创建于 {formatDate(machine?.createdAt)}</span>
            <span>· 更新于 {formatDate(machine?.updatedAt)}</span>
            {hasToken ? <Badge tone="success">已保存 token</Badge> : null}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="名称" required htmlFor="machine-name">
            <Input
              id="machine-name"
              value={name}
              placeholder="例如：生产 VPS / 本地 docker"
              onChange={(event) => setName(event.target.value)}
            />
          </FormField>
          <FormField
            label="启用"
            description="禁用会强制停机；desiredState 仍保留 running/stopped 语义。"
          >
            <Switch
              checked={enabled}
              onChange={setEnabled}
              label={enabled ? '已启用' : '已禁用'}
            />
          </FormField>
        </div>

        <FormField
          label="传输类型"
          required
          description={isEdit ? '契约不允许修改传输类型；换传输请新建机器。' : '创建后不可更改。'}
        >
          <Select
            value={transport}
            disabled={isEdit}
            onChange={(event) => setTransport(event.target.value as MachineTransport)}
            options={[
              { value: 'http', label: TRANSPORT_LABEL.http },
              { value: 'stdio', label: TRANSPORT_LABEL.stdio },
              { value: 'reverse-ws', label: TRANSPORT_LABEL['reverse-ws'] },
            ]}
          />
        </FormField>

        {transport === 'http' ? (
          <>
            <Alert tone="info" title="http 传输">
              core 直连 worker 的 HTTP API；创建后会立即探测 /system/info，失败不阻止创建（状态为
              error）。
            </Alert>
            <FormField
              label="worker URL"
              required
              htmlFor="machine-url"
              hint="worker 服务根地址，不要带 /api/v1，例如 https://worker.example.com 或 http://127.0.0.1:8787。"
            >
              <Input
                id="machine-url"
                value={url}
                placeholder="http://127.0.0.1:8787"
                onChange={(event) => setUrl(event.target.value)}
                autoComplete="off"
              />
            </FormField>
          </>
        ) : null}

        {transport === 'stdio' ? (
          <>
            <Alert tone="warning" title="stdio 传输需要显式开启">
              core 会拉起本地 worker 进程（等同宿主命令执行能力）。需要设置
              MPANEL_ALLOW_STDIO=1；未配置 MPANEL_WORKER_ENTRY 时必须填写命令与参数。
            </Alert>
            <FormField
              label="命令"
              htmlFor="machine-command"
              hint="留空使用 core 的 process.execPath（配合 MPANEL_WORKER_ENTRY）。"
            >
              <Input
                id="machine-command"
                value={command}
                placeholder="node"
                onChange={(event) => setCommand(event.target.value)}
              />
            </FormField>
            <FormField
              label="参数"
              htmlFor="machine-args"
              hint={
                isEdit
                  ? '参数与 env 不会回显；留空表示保持不变。'
                  : '每行一个参数，不按空格拆分；例如：server/worker/dist/index.js。'
              }
            >
              <Textarea
                id="machine-args"
                mono
                rows={3}
                value={argsText}
                placeholder={'server/worker/dist/index.js'}
                onChange={(event) => setArgsText(event.target.value)}
              />
            </FormField>
            <FormField
              label="环境变量"
              htmlFor="machine-env"
              hint={
                isEdit
                  ? '环境变量不会回显；留空表示保持不变。保留键由 core 注入，不能覆盖。'
                  : '每行 KEY=VALUE；MPANEL_TRANSPORT / MPANEL_TOKEN / MPANEL_HOME / MPANEL_MACHINE_SECRET 由 core 注入，不能覆盖。'
              }
              error={envParsed.error}
            >
              <Textarea
                id="machine-env"
                mono
                rows={4}
                value={envText}
                placeholder={'NODE_OPTIONS=--max-old-space-size=512'}
                onChange={(event) => setEnvText(event.target.value)}
              />
            </FormField>
          </>
        ) : null}

        {transport === 'reverse-ws' ? (
          <Alert tone="info" title="reverse-ws 传输">
            创建后 core 生成 machine secret 与独立 token，worker 使用注册 URL 主动连回 core；
            core 不主动拨号。secret 只显示一次，请配合“轮换密钥”使用。
          </Alert>
        ) : null}

        {transport === 'http' || transport === 'stdio' ? (
          <FormField
            label="worker token"
            required={!isEdit || !hasToken}
            htmlFor="machine-token"
            hint={
              isEdit && hasToken
                ? '已保存 token；留空保持不变。'
                : '对应 worker 的 MPANEL_TOKEN；写入后不再回显。'
            }
          >
            <Input
              id="machine-token"
              type="password"
              value={token}
              placeholder={isEdit && hasToken ? '••••••（保持不变）' : 'MPANEL_TOKEN'}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="new-password"
            />
          </FormField>
        ) : null}

        {error === null ? null : (
          <Alert tone="danger" title="请检查表单">
            {error}
          </Alert>
        )}

        {mutationError === null ? null : (
          <Alert tone="danger" title={describeError(mutationError).title} hint={describeError(mutationError).hint}>
            {describeError(mutationError).description}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
