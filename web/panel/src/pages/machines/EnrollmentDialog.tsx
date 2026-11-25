import type { MachineEnrollment } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { CopyButton } from '../../components/ui/CopyButton';
import { Modal } from '../../components/ui/Modal';
import { SecretReveal } from '../../components/ui/SecretReveal';

export interface EnrollmentDialogProps {
  enrollment: MachineEnrollment;
  onClose: () => void;
  /** 默认“机器注册信息”；密钥轮换时传入自定义标题。 */
  title?: string;
  description?: string;
}

function envText(enrollment: MachineEnrollment): string {
  return Object.entries(enrollment.workerEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/**
 * 一次性注册信息：url、machine secret 与 worker 环境变量。
 * secret 只显示一次，绝不写入 localStorage / 连接 store。
 */
export function EnrollmentDialog(props: EnrollmentDialogProps): JSX.Element {
  const env = envText(props.enrollment);

  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.title ?? '机器注册信息'}
      description={
        props.description ??
        '把这些值写入 agent 环境后启动 agent；它会主动连回 core。'
      }
      size="lg"
      footer={
        <>
          <CopyButton value={env} label="复制全部环境变量" variant="secondary" />
          <Button size="sm" onClick={props.onClose}>
            关闭
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Alert tone="warning" title="只显示一次">
          machine secret 与 MPANEL_TOKEN 只在这里显示一次；关闭后无法再次查看。core 只保存 secret 的
          SHA-256，丢失后请“轮换密钥”。
        </Alert>

        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 text-sm">
          <dt className="text-xs text-app-muted">machineId</dt>
          <dd className="flex items-center gap-1 break-all font-mono text-xs">
            {props.enrollment.machineId}
            <CopyButton value={props.enrollment.machineId} title="复制 machineId" />
          </dd>
          <dt className="text-xs text-app-muted">注册 URL</dt>
          <dd className="flex items-center gap-1 break-all font-mono text-xs">
            {props.enrollment.url.length === 0 ? '—' : props.enrollment.url}
            {props.enrollment.url.length === 0 ? null : (
              <CopyButton value={props.enrollment.url} title="复制 URL" />
            )}
          </dd>
        </dl>

        <SecretReveal
          value={props.enrollment.secret}
          title="MPANEL_MACHINE_SECRET"
          onDone={props.onClose}
          description="把它与下方环境变量一起写入 agent 配置；不要提交到版本库。"
        />

        <div>
          <p className="mb-1 flex items-center justify-between text-xs text-app-muted">
            <span>agent 环境变量</span>
            <CopyButton value={env} label="复制" />
          </p>
          <CodeBlock code={env} maxHeight="14rem" copyable={false} />
        </div>
      </div>
    </Modal>
  );
}
