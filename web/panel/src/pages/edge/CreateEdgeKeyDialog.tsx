import { useEffect, useState } from 'react';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { CopyButton } from '../../components/ui/CopyButton';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { describeError } from '../../api/errors';
import { createEdgeKey, edgeKeys } from '../../api/edge';
import type { EdgeKeyCreateResult } from '../../api/types';
import { useAppMutation } from '../../lib/mutations';
import { formatDate } from '../../lib/format';
import { buildWorkerCommands } from './edge-utils';

export interface CreateEdgeKeyDialogProps {
  open: boolean;
  onClose: () => void;
  /** 当前 core 连接地址（connection.baseUrl）。 */
  coreUrl: string;
}

/** 新建边缘入网密钥：创建成功后在对话框内一次性展示 secret 与 worker 启动命令。 */
export function CreateEdgeKeyDialog(props: CreateEdgeKeyDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [ttlSec, setTtlSec] = useState('');
  const [maxUses, setMaxUses] = useState('0');
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<EdgeKeyCreateResult | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setName('');
    setGroup('');
    setTtlSec('');
    setMaxUses('0');
    setFormError(null);
    setCreated(null);
  }, [props.open]);

  const mutation = useAppMutation<EdgeKeyCreateResult, void>({
    mutationFn: () => {
      const trimmedTtl = ttlSec.trim().length === 0 ? undefined : Number(ttlSec);
      return createEdgeKey({
        name: name.trim(),
        group: group.trim().length === 0 ? undefined : group.trim(),
        ttlSec: trimmedTtl,
        maxUses: Number(maxUses),
      });
    },
    successMessage: (result) => `已创建入网密钥 ${result.key.name}`,
    successDescription: '密钥只显示一次；请立即复制 secret 与启动命令。',
    invalidate: [edgeKeys.keysRoot()],
    onSuccess: (result) => setCreated(result),
  });

  const submit = (): void => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setFormError('请输入密钥名称。');
      return;
    }
    if (ttlSec.trim().length > 0) {
      const ttl = Number(ttlSec);
      if (!Number.isInteger(ttl) || ttl <= 0) {
        setFormError('有效期必须是正整数秒数，或留空表示不过期。');
        return;
      }
    }
    const uses = Number(maxUses);
    if (!Number.isInteger(uses) || uses < 0) {
      setFormError('最大使用次数必须是非负整数（0 表示不限）。');
      return;
    }
    setFormError(null);
    mutation.mutate();
  };

  const createdKey = created?.key;
  const createdExpiresAt = createdKey?.expiresAt ?? null;
  const commands = created === null ? null : buildWorkerCommands(props.coreUrl, created.secret);
  const allText =
    created === null || commands === null
      ? ''
      : [
          `MPANEL_EDGE_KEY=${created.secret}`,
          '',
          '# Linux / macOS',
          commands.unix,
          '',
          '# Windows（cmd）',
          commands.windows,
        ].join('\n');

  const errorInfo = mutation.isError ? describeError(mutation.error) : null;

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={created === null ? '新建入网密钥' : '入网密钥已创建'}
      description={
        created === null
          ? '密钥用于 NAT/防火墙后的 agent 主动注册；注册后的节点与普通 reverse-ws 机器同构。'
          : '密钥只显示这一次；关闭后列表只保留元数据。'
      }
      size="lg"
      closeOnOverlay={created === null}
      footer={
        created === null ? (
          <>
            <Button variant="ghost" size="sm" onClick={props.onClose} disabled={mutation.isPending}>
              取消
            </Button>
            <Button size="sm" loading={mutation.isPending} onClick={submit}>
              创建密钥
            </Button>
          </>
        ) : (
          <>
            <CopyButton value={allText} label="复制密钥与命令" variant="secondary" />
            <Button size="sm" onClick={props.onClose}>
              我已保存并关闭
            </Button>
          </>
        )
      }
    >
      {created === null ? (
        <div className="flex flex-col gap-3">
          <FormField label="名称" required htmlFor="edge-key-name">
            <Input
              id="edge-key-name"
              value={name}
              placeholder="例如：机房 A 批量入网"
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </FormField>
          <FormField
            label="分组"
            htmlFor="edge-key-group"
            hint="可选；入网机器会自动继承该分组，用于本页筛选。"
          >
            <Input
              id="edge-key-group"
              value={group}
              placeholder="例如：edge-shanghai"
              onChange={(event) => setGroup(event.target.value)}
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="有效期（秒）"
              htmlFor="edge-key-ttl"
              hint="可选；留空表示不过期，86400 为 1 天。"
            >
              <Input
                id="edge-key-ttl"
                type="number"
                min={1}
                step={1}
                value={ttlSec}
                placeholder="留空 = 不过期"
                onChange={(event) => setTtlSec(event.target.value)}
              />
            </FormField>
            <FormField
              label="最大使用次数"
              htmlFor="edge-key-uses"
              hint="0 表示不限次数；达到上限后入网返回 FORBIDDEN。"
            >
              <Input
                id="edge-key-uses"
                type="number"
                min={0}
                step={1}
                value={maxUses}
                onChange={(event) => setMaxUses(event.target.value)}
              />
            </FormField>
          </div>

          {formError === null ? null : (
            <Alert tone="danger" title="请检查表单">
              {formError}
            </Alert>
          )}
          {errorInfo === null ? null : (
            <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
              {errorInfo.description}
            </Alert>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Alert tone="warning" title="只显示一次">
            secret 与启动命令只在这里显示一次；关闭后无法再次查看。请立即复制并妥善保存。
          </Alert>

          <dl className="grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-xs text-app-muted">名称</dt>
            <dd className="text-app-text">{createdKey?.name}</dd>
            <dt className="text-xs text-app-muted">分组</dt>
            <dd className="text-app-text">{createdKey?.group ?? '（未分组）'}</dd>
            <dt className="text-xs text-app-muted">使用上限</dt>
            <dd className="text-app-text">
              {createdKey === undefined
                ? '—'
                : createdKey.maxUses === 0
                  ? '不限次数'
                  : `${createdKey.maxUses} 次`}
            </dd>
            <dt className="text-xs text-app-muted">过期时间</dt>
            <dd className="text-app-text">
              {createdExpiresAt === null ? '不过期' : formatDate(createdExpiresAt)}
            </dd>
          </dl>

          <div>
            <p className="mb-1 flex items-center justify-between text-xs text-app-muted">
              <span>入网密钥（secret）</span>
              <CopyButton value={created.secret} label="复制密钥" />
            </p>
            <CodeBlock code={created.secret} maxHeight={100} copyable={false} />
          </div>

          <div>
            <p className="mb-1 flex items-center justify-between text-xs text-app-muted">
              <span>Linux / macOS 启动命令</span>
              <CopyButton value={commands?.unix ?? ''} label="复制命令" />
            </p>
            <CodeBlock code={commands?.unix ?? ''} maxHeight={140} copyable={false} />
          </div>

          <div>
            <p className="mb-1 flex items-center justify-between text-xs text-app-muted">
              <span>Windows 启动命令（cmd）</span>
              <CopyButton value={commands?.windows ?? ''} label="复制命令" />
            </p>
            <CodeBlock code={commands?.windows ?? ''} maxHeight={140} copyable={false} />
            <p className="mt-1 text-[11px] leading-relaxed text-app-muted">
              Windows 使用 <code className="font-mono">set</code> 形式；同一行用{' '}
              <code className="font-mono">&amp;&amp;</code> 连接。若 secret 含 cmd 特殊字符，请改用
              PowerShell 的 <code className="font-mono">$env:MPANEL_EDGE_KEY</code> 写法。
            </p>
          </div>

          <p className="text-[11px] leading-relaxed text-app-muted">
            目标机需要有 agent 构建产物（示例为 <code className="font-mono">server/worker/dist/index.js</code>）；
            agent 会用密钥拨号 <code className="font-mono">/ws/worker</code>，注册成功后自动出现在本页。
          </p>
        </div>
      )}
    </Modal>
  );
}
