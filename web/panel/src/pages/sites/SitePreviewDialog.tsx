import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { previewSite, sitesKeys } from '../../api/sites';
import type { SitePreviewRequest } from '../../api/sites';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { CopyButton } from '../../components/ui/CopyButton';
import { ErrorState } from '../../components/ui/ErrorState';
import { Modal } from '../../components/ui/Modal';
import { Spinner } from '../../components/ui/Spinner';
import { Switch } from '../../components/ui/Switch';

export interface SitePreviewDialogProps {
  open: boolean;
  onClose: () => void;
  /** 恰好包含 site 或 siteId 之一。 */
  request: SitePreviewRequest;
}

/**
 * Caddyfile 预览：POST /sites/preview。
 * 即使 Caddy 不可用也会返回片段（validation=null），只是无法执行 validate。
 */
export function SitePreviewDialog(props: SitePreviewDialogProps): JSX.Element {
  const [validate, setValidate] = useState(props.request.validate === true);

  useEffect(() => {
    if (props.open) setValidate(props.request.validate === true);
  }, [props.open, props.request.validate]);

  const request: SitePreviewRequest = { ...props.request, validate };

  const query = useQuery({
    queryKey: sitesKeys.preview({ key: JSON.stringify(request) }),
    queryFn: () => previewSite(request),
    enabled: props.open,
    retry: false,
    staleTime: 0,
  });

  const result = query.data;

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="Caddyfile 预览"
      description="预览只渲染片段，不写入线上目录、不修改 revision。"
      size="xl"
      footer={
        <>
          <Switch checked={validate} onChange={setValidate} label="执行 caddy validate" />
          <span className="flex-1" />
          {result === undefined ? null : <CopyButton value={result.caddyfile} label="复制" variant="secondary" />}
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            loading={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            重新生成
          </Button>
          <Button size="sm" onClick={props.onClose}>
            关闭
          </Button>
        </>
      }
    >
      {query.isLoading ? (
        <div className="flex min-h-[240px] items-center justify-center">
          <Spinner size="lg" label="生成 Caddyfile…" />
        </div>
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : result === undefined ? null : (
        <div className="flex flex-col gap-3">
          {result.warnings.length > 0 ? (
            <Alert tone="warning" title="生成警告">
              <ul className="list-disc pl-4">
                {result.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </Alert>
          ) : null}

          {result.validation === null ? (
            <Alert
              tone="warning"
              title="未执行 caddy validate"
              hint="预览片段仍可用；修复 Caddy 后重新生成即可获得校验结果。"
            >
              {result.validationUnavailableReason ?? 'Caddy 不可用。'}
            </Alert>
          ) : result.validation.ok ? (
            <Alert tone="success" title="caddy validate 通过">
              {result.validation.output.trim().length === 0 ? '无输出。' : result.validation.output}
            </Alert>
          ) : (
            <Alert tone="danger" title="caddy validate 失败" hint="线上配置未改变，请修正后重试。">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
                {result.validation.output}
              </pre>
            </Alert>
          )}

          <CodeEditor
            value={result.caddyfile}
            readOnly
            language="caddyfile"
            height="420px"
            ariaLabel="Caddyfile 预览"
          />
        </div>
      )}
    </Modal>
  );
}
