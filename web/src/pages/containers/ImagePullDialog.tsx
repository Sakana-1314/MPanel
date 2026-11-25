import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { ImageSummary } from '../../api/types';
import { pullImage } from '../../api/containers';
import { describeError } from '../../api/errors';
import { scopedKey } from '../../lib/query-keys';
import { useAppMutation } from '../../lib/mutations';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';

export interface ImagePullDialogProps {
  open: boolean;
  onClose: () => void;
  onPulled?: (image: ImageSummary) => void;
}

/** 镜像引用校验：禁止空白与以 `-` 开头，其余交给仓库解析。 */
export function validateImageReference(reference: string): string | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) return '请输入镜像名称，例如 nginx:latest 或 ghcr.io/org/app:1.0。';
  if (/\s/.test(trimmed)) return '镜像名称不能包含空白字符。';
  if (trimmed.startsWith('-')) return '镜像名称不能以 “-” 开头。';
  if (trimmed.length > 255) return '镜像名称过长。';
  return null;
}

/**
 * 拉取镜像：后端同步等待 docker pull（最长 620 秒）。
 * 浏览器端无法获取逐层进度，因此展示已等待时间与不确定进度条，避免误以为卡死。
 */
export function ImagePullDialog(props: ImagePullDialogProps): JSX.Element {
  const [reference, setReference] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [elapsedSec, setElapsedSec] = useState(0);

  const imagesRoot = scopedKey('images', 'list');

  useEffect(() => {
    if (props.open) {
      setValidation(null);
      setError(null);
    }
  }, [props.open]);

  const pullMutation = useAppMutation<{ image: ImageSummary }, string>({
    mutationFn: (value) => pullImage(value.trim()),
    successMessage: (_, value) => `镜像 ${value.trim()} 拉取完成`,
    silentSuccess: false,
    silentError: true,
    invalidate: [imagesRoot],
    onSuccess: (data) => {
      setError(null);
      props.onPulled?.(data.image);
      setReference('');
      props.onClose();
    },
    onError: (caught) => {
      setError(caught);
    },
  });

  const pulling = pullMutation.isPending;

  useEffect(() => {
    if (!pulling) {
      setElapsedSec(0);
      return;
    }
    const started = Date.now();
    setElapsedSec(0);
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pulling]);

  const submit = (): void => {
    const message = validateImageReference(reference);
    setValidation(message);
    if (message !== null) return;
    setError(null);
    pullMutation.mutate(reference.trim());
  };

  return (
    <Modal
      open={props.open}
      onClose={() => {
        if (!pulling) props.onClose();
      }}
      title="拉取镜像"
      description="docker pull 同步执行，最长约 620 秒"
      size="md"
      closeOnOverlay={!pulling}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={pulling}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Download className="h-4 w-4" />}
            loading={pulling}
            disabled={reference.trim().length === 0}
            onClick={submit}
          >
            {pulling ? '拉取中…' : '开始拉取'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField
          label="镜像名称"
          required
          error={validation ?? undefined}
          hint="支持 Docker Hub、私有仓库与 digest，例如 nginx:1.27、ghcr.io/org/app:latest。"
          htmlFor="image-pull-reference"
        >
          <Input
            id="image-pull-reference"
            value={reference}
            invalid={validation !== null}
            disabled={pulling}
            placeholder="nginx:latest"
            className="font-mono"
            autoFocus
            onChange={(event) => {
              setReference(event.target.value);
              if (validation !== null) setValidation(null);
              if (error !== null) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !pulling) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </FormField>

        {pulling ? (
          <div className="rounded-lg border border-app-border bg-app-elevated/50 p-3">
            <div className="flex items-center justify-between gap-2 text-xs text-app-muted">
              <span className="flex items-center gap-2">
                <Spinner size="xs" />
                正在拉取 <span className="font-mono text-app-text">{reference.trim()}</span>
              </span>
              <span className="tabular-nums">已等待 {elapsedSec} 秒</span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-app-border">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-app-accent" />
            </div>
            <p className="mt-2 text-[10px] text-app-muted">
              拉取期间请保持页面打开；超大镜像可能需要数分钟。请求完成前无法取消。
            </p>
          </div>
        ) : null}

        {error === null ? null : (
          <Alert tone="danger" title="镜像拉取失败" hint={describeError(error).hint}>
            {describeError(error).description}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
