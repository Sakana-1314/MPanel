import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import type { ExecResult } from '../../api/types';
import { execContainer } from '../../api/containers';
import { describeError } from '../../api/errors';
import { formatDuration } from '../../lib/format';
import { useAppMutation } from '../../lib/mutations';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import type { SelectOption } from '../../components/ui/Select';

export interface ContainerExecDialogProps {
  id: string;
  open: boolean;
  onClose: () => void;
}

const TIMEOUT_OPTIONS: readonly SelectOption[] = [
  { value: '5000', label: '5 秒' },
  { value: '30000', label: '30 秒（默认）' },
  { value: '60000', label: '60 秒' },
  { value: '300000', label: '300 秒（上限）' },
];

/** 容器内执行一次性命令。参数按 argv 数组提交，worker 不经过 shell。 */
export function ContainerExecDialog(props: ContainerExecDialogProps): JSX.Element {
  const [command, setCommand] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [workdir, setWorkdir] = useState('');
  const [user, setUser] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (props.open) {
      setValidation(null);
      setError(null);
      setResult(null);
    }
  }, [props.open, props.id]);

  const execMutation = useAppMutation<ExecResult, void>({
    mutationFn: async () => {
      const argv = parseArgv(command);
      if (argv.length === 0) throw new Error('请输入要执行的命令。');
      return execContainer(props.id, {
        command: argv,
        timeoutMs,
        workdir: workdir.trim().length > 0 ? workdir.trim() : undefined,
        user: user.trim().length > 0 ? user.trim() : undefined,
      });
    },
    silentSuccess: true,
    silentError: true,
    onSuccess: (data) => {
      setError(null);
      setResult(data);
    },
    onError: (caught) => {
      setError(caught);
      setResult(null);
    },
  });

  const run = (): void => {
    setValidation(null);
    setError(null);
    try {
      const argv = parseArgv(command);
      if (argv.length === 0) {
        setValidation('请输入要执行的命令。');
        return;
      }
    } catch (caught) {
      setValidation(caught instanceof Error ? caught.message : '命令格式不正确。');
      return;
    }
    execMutation.mutate();
  };

  const outputLines = result === null ? [] : splitLines(result.stdout);

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="在容器中执行命令"
      description={`容器 ${props.id}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            关闭
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Play className="h-4 w-4" />}
            loading={execMutation.isPending}
            disabled={command.trim().length === 0}
            onClick={run}
          >
            执行
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField
          label="命令"
          required
          error={validation ?? undefined}
          hint="按 argv 数组执行，不经过 shell。需要管道或重定向时请使用 sh -c '…'。"
          htmlFor="container-exec-command"
        >
          <Input
            id="container-exec-command"
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              if (validation !== null) setValidation(null);
            }}
            placeholder="例如 ls -la /app"
            invalid={validation !== null}
            className="font-mono"
            autoFocus
          />
        </FormField>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="超时" htmlFor="container-exec-timeout">
            <Select
              id="container-exec-timeout"
              options={TIMEOUT_OPTIONS}
              value={String(timeoutMs)}
              onChange={(event) => setTimeoutMs(Number(event.target.value))}
            />
          </FormField>
          <FormField label="工作目录" hint="可选，容器内路径。" htmlFor="container-exec-workdir">
            <Input
              id="container-exec-workdir"
              value={workdir}
              onChange={(event) => setWorkdir(event.target.value)}
              placeholder="/app"
              className="font-mono"
            />
          </FormField>
          <FormField label="用户" hint="可选，例如 root 或 uid。" htmlFor="container-exec-user">
            <Input
              id="container-exec-user"
              value={user}
              onChange={(event) => setUser(event.target.value)}
              placeholder="root"
              className="font-mono"
            />
          </FormField>
        </div>

        {error === null ? null : (
          <Alert tone="danger" title="命令执行失败" hint={describeError(error).hint}>
            {describeError(error).description}
          </Alert>
        )}

        {result === null ? null : (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-xs text-app-muted">
              <span>退出码</span>
              <Badge tone={result.exitCode === 0 ? 'success' : result.exitCode === null ? 'warning' : 'danger'}>
                {result.exitCode === null ? '超时/未知' : String(result.exitCode)}
              </Badge>
              <span>耗时 {formatDuration(result.durationMs)}</span>
              {result.truncated ? <Badge tone="warning">输出已截断</Badge> : null}
            </div>
            {result.truncated ? (
              <Alert tone="warning" title="输出被截断">
                单条流超过 1 MiB 或命令超时，仅返回已捕获的部分输出。
              </Alert>
            ) : null}
            <div>
              <p className="mb-1 text-[11px] font-medium text-app-muted">
                stdout（{outputLines.length} 行）
              </p>
              <CodeBlock
                code={result.stdout.length === 0 ? '' : result.stdout}
                language="text"
                emptyText="无 stdout 输出。"
                maxHeight="260px"
              />
            </div>
            {result.stderr.length === 0 ? null : (
              <div>
                <p className="mb-1 text-[11px] font-medium text-app-danger">stderr</p>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-app-danger/40 bg-app-danger/5 p-2 font-mono text-[11px] text-app-danger">
                  {result.stderr}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** 支持单/双引号与反斜杠转义的 argv 解析；不调用 shell。 */
export function parseArgv(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      started = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (char === quote) {
        quote = null;
        started = true;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current.length > 0) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  if (escaped) current += '\\';
  if (quote !== null) throw new Error('命令中的引号未闭合。');
  if (started || current.length > 0) args.push(current);
  return args;
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n$/, '').split('\n');
}
