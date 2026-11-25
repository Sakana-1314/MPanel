import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CapabilityStatus, TerminalCreateInput, TerminalSession } from '../../api/types';
import { listShells, terminalKeys, createSession } from '../../api/terminal';
import { describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';

export interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (session: TerminalSession) => void;
  /** 来自 /system/info 的 PTY 能力；不可用时提示降级模式。 */
  pty?: CapabilityStatus | null;
  /** 当前 worker 上已有会话数（用于 20 上限提示）。 */
  activeSessionCount?: number;
  /** shell 列表不可用时的原因（可覆盖查询结果）。 */
  shellsUnavailableReason?: string;
}

const CUSTOM_SHELL = '__custom__';
const DEFAULT_SHELL = '';
const MAX_SESSIONS = 20;

/** 新建终端会话：可选 shell 与工作目录；PTY 不可用时提示无 PTY 降级模式。 */
export function NewSessionDialog(props: NewSessionDialogProps): JSX.Element {
  const [shell, setShell] = useState<string>(DEFAULT_SHELL);
  const [customShell, setCustomShell] = useState('');
  const [cwd, setCwd] = useState('');
  const [shellError, setShellError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setShell(DEFAULT_SHELL);
    setCustomShell('');
    setCwd('');
    setShellError(null);
  }, [props.open]);

  const shellsQuery = useQuery({
    queryKey: terminalKeys.shells(),
    queryFn: () => listShells(),
    enabled: props.open,
    retry: 0,
    staleTime: 60_000,
  });

  const createMutation = useAppMutation({
    mutationFn: (input: TerminalCreateInput) => createSession(input),
    successMessage: (_session) => '终端会话已创建',
    invalidate: [terminalKeys.sessions()],
    silentError: true,
    onSuccess: (session) => {
      props.onCreated(session);
      props.onClose();
    },
  });

  const shells = shellsQuery.data?.items ?? [];
  const shellsAvailable = shellsQuery.data?.available !== false;
  const shellsReason =
    props.shellsUnavailableReason ??
    shellsQuery.data?.reason ??
    (shellsQuery.error === null || shellsQuery.error === undefined
      ? undefined
      : describeError(shellsQuery.error).description);
  const ptyAvailable = props.pty === undefined || props.pty === null ? true : props.pty.available;
  const atLimit = (props.activeSessionCount ?? 0) >= MAX_SESSIONS;

  const handleSubmit = (): void => {
    setShellError(null);
    let resolvedShell: string | undefined;
    if (shell === CUSTOM_SHELL) {
      const custom = customShell.trim();
      if (custom.length === 0) {
        setShellError('请输入 shell 的绝对路径');
        return;
      }
      resolvedShell = custom;
    } else if (shell.length > 0) {
      resolvedShell = shell;
    }
    const trimmedCwd = cwd.trim();
    const input: TerminalCreateInput = {
      ...(resolvedShell === undefined ? {} : { shell: resolvedShell }),
      ...(trimmedCwd.length === 0 ? {} : { cwd: trimmedCwd }),
    };
    createMutation.mutate(input);
  };

  const mutationInfo =
    createMutation.error === null || createMutation.error === undefined
      ? null
      : describeError(createMutation.error, '创建终端会话失败');

  const shellOptions = [
    { value: DEFAULT_SHELL, label: '默认 shell（由服务器选择）' },
    ...shells.map((item) => ({ value: item.path, label: `${item.name} · ${item.path}` })),
    { value: CUSTOM_SHELL, label: '自定义 shell 路径…' },
  ];

  return (
    <Modal
      open={props.open}
      onClose={createMutation.isPending ? () => undefined : props.onClose}
      title="新建终端会话"
      description="在目标机器上启动一个交互式 shell；面板凭据会从环境中移除。"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={createMutation.isPending}>
            取消
          </Button>
          <Button type="submit" form="new-terminal-session" size="sm" loading={createMutation.isPending}>
            创建会话
          </Button>
        </>
      }
    >
      <form
        id="new-terminal-session"
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        {atLimit ? (
          <Alert tone="danger" title={`会话数量已达上限（${MAX_SESSIONS}）`}>
            请先在“会话列表”中终止不再使用的会话，再创建新会话。
          </Alert>
        ) : null}

        {!ptyAvailable ? (
          <Alert
            tone="warning"
            title="PTY 不可用，将使用无 PTY 的降级模式"
            hint={props.pty?.reason ?? 'agent 未能加载 node-pty。'}
          >
            降级会话通过管道运行 shell：resize 不生效，交互式提示符、颜色与行编辑可能缺失，但命令仍可执行。
          </Alert>
        ) : null}

        <FormField
          label="Shell"
          htmlFor="terminal-shell"
          description="留空使用服务器默认：Windows 为 powershell.exe，POSIX 为 $SHELL 或 /bin/bash。"
          error={shellError ?? undefined}
        >
          <Select
            id="terminal-shell"
            value={shell}
            onChange={(event) => {
              setShell(event.target.value);
              setShellError(null);
            }}
            options={shellOptions}
            disabled={createMutation.isPending}
            invalid={shellError !== null}
          />
        </FormField>

        {shell === CUSTOM_SHELL ? (
          <FormField label="自定义 shell 路径" htmlFor="terminal-shell-custom" required>
            <Input
              id="terminal-shell-custom"
              value={customShell}
              onChange={(event) => {
                setCustomShell(event.target.value);
                setShellError(null);
              }}
              placeholder="/bin/zsh 或 C:\\Windows\\System32\\cmd.exe"
              className="font-mono"
              invalid={shellError !== null}
              disabled={createMutation.isPending}
              autoFocus
            />
          </FormField>
        ) : null}

        <FormField
          label="工作目录"
          htmlFor="terminal-cwd"
          description="留空使用服务器默认工作目录（MPANEL_HOME）；填写时必须是服务器上已存在的目录。"
        >
          <Input
            id="terminal-cwd"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="/home/user 或 C:\\Users\\admin"
            className="font-mono"
            disabled={createMutation.isPending}
            maxLength={4096}
          />
        </FormField>

        {shellsQuery.isFetching ? (
          <p className="flex items-center gap-1.5 text-xs text-app-muted">
            <Spinner size="xs" />
            正在读取可用 shell 列表…
          </p>
        ) : null}
        {shellsQuery.isFetched && !shellsAvailable ? (
          <Alert
            tone="warning"
            title="无法枚举服务器上的 shell"
            hint={shellsReason ?? '可继续使用默认 shell，或填写已知的 shell 绝对路径。'}
          >
            这不影响创建会话；只是预设列表不可用。
          </Alert>
        ) : null}
        {shellsQuery.error !== null && shellsQuery.error !== undefined && shellsAvailable ? (
          <Alert tone="warning" title="读取 shell 列表失败" hint={describeError(shellsQuery.error).hint}>
            {describeError(shellsQuery.error).description}
          </Alert>
        ) : null}

        {mutationInfo === null ? null : (
          <Alert tone="danger" title={`创建失败 · ${mutationInfo.title}`} hint={mutationInfo.hint}>
            {mutationInfo.description}
            {mutationInfo.status > 0 ? `（HTTP ${mutationInfo.status}）` : ''}
          </Alert>
        )}

        <p className="text-[11px] leading-relaxed text-app-muted">
          终端是可信属主功能，命令会以 agent 进程权限执行；请勿在共享环境中创建长期空闲的会话。
        </p>
      </form>
    </Modal>
  );
}
