import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RotateCw, Save } from 'lucide-react';
import type { StackDetail } from '../../api/types';
import { containersKeys, createStack, getStack, updateStack } from '../../api/containers';
import { describeError, isAppError } from '../../api/errors';
import { scopedKey } from '../../lib/query-keys';
import { useAppMutation } from '../../lib/mutations';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { ErrorState, LoadingSkeleton } from '../../components/ui/ErrorState';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { PageHeader } from '../../components/ui/PageHeader';
import { validateComposeYaml, validateStackName } from './stack-utils';

/** 编辑页复用：/stacks/new/edit?create=1 表示新建，避免占用真实项目名 new。 */
const CREATE_QUERY = '1';

export default function StackEditorPage(): JSX.Element {
  const params = useParams<{ name: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const routeName = params.name ?? '';
  const isNew = searchParams.get('create') === CREATE_QUERY;

  const [nameInput, setNameInput] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);

  const stackQuery = useQuery({
    queryKey: containersKeys.stack(routeName),
    queryFn: () => getStack(routeName),
    enabled: !isNew && routeName.length > 0,
    retry: 1,
  });

  const stack = stackQuery.data;
  const yaml = draft ?? (isNew ? '' : (stack?.composeYaml ?? ''));
  const dirty = isNew ? draft !== null && draft.length > 0 : draft !== null && draft !== (stack?.composeYaml ?? '');

  useEffect(() => {
    setDraft(null);
    setNameInput('');
    setNameError(null);
    setYamlError(null);
    setSaveError(null);
  }, [routeName, isNew]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const stacksRoot = scopedKey('stacks', 'list');
  const stackDetailRoot = scopedKey('stacks', 'detail');

  const saveMutation = useAppMutation<StackDetail, void>({
    mutationFn: async () => {
      if (isNew) {
        return createStack({ name: nameInput.trim(), composeYaml: yaml });
      }
      return updateStack(routeName, { composeYaml: yaml });
    },
    successMessage: isNew ? '编排已创建' : 'compose 文件已保存',
    successDescription: (data) => `配置文件：${data.composePath}`,
    silentError: true,
    invalidate: [stacksRoot, stackDetailRoot],
    onSuccess: (data) => {
      setSaveError(null);
      setDraft(null);
      navigate(`/stacks/${encodeURIComponent(data.name)}`);
    },
    onError: (error) => {
      setSaveError(error);
    },
  });

  const submit = (): void => {
    const nextNameError = isNew ? validateStackName(nameInput) : null;
    const nextYamlError = validateComposeYaml(yaml);
    setNameError(nextNameError);
    setYamlError(nextYamlError);
    setSaveError(null);
    if (nextNameError !== null || nextYamlError !== null) return;
    saveMutation.mutate(undefined);
  };

  const reset = (): void => {
    setDraft(null);
    setYamlError(null);
    setSaveError(null);
  };

  const backTarget = isNew
    ? '/stacks'
    : `/stacks/${encodeURIComponent(routeName)}`;

  const title = isNew ? '新建编排' : `编辑编排 · ${routeName}`;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {title}
            {dirty ? <Badge tone="warning">未保存</Badge> : null}
          </span>
        }
        description="Compose YAML 保存前会在 agent 侧执行 docker compose config 校验。"
        breadcrumbs={
          <>
            <Link to="/stacks" className="hover:text-app-text">
              编排
            </Link>
            <span className="mx-1">/</span>
            {isNew ? (
              <span>新建</span>
            ) : (
              <>
                <Link to={backTarget} className="font-mono hover:text-app-text">
                  {routeName}
                </Link>
                <span className="mx-1">/</span>
                <span>编辑</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate(backTarget)}>
              取消
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<RotateCw className="h-4 w-4" />}
              disabled={!dirty || saveMutation.isPending}
              onClick={reset}
            >
              还原
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Save className="h-4 w-4" />}
              loading={saveMutation.isPending}
              disabled={
                !isNew &&
                (stackQuery.isLoading ||
                  (stackQuery.error !== null && stackQuery.error !== undefined))
              }
              onClick={submit}
            >
              {isNew ? '创建编排' : '保存'}
            </Button>
          </>
        }
      />

      {!isNew && stackQuery.isLoading ? (
        <LoadingSkeleton rows={8} />
      ) : !isNew && stackQuery.error !== null && stackQuery.error !== undefined ? (
        <div className="flex flex-col gap-3">
          <ErrorState
            error={stackQuery.error}
            title="加载 compose 文件失败"
            onRetry={() => {
              void stackQuery.refetch();
            }}
          />
          <div>
            <Button variant="secondary" size="sm" onClick={() => navigate('/stacks')}>
              返回编排列表
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {isNew ? (
            <FormField
              label="项目名"
              required
              error={nameError ?? undefined}
              hint="只能包含小写字母、数字、下划线、短横线，以字母或数字开头，最长 63 字符。"
              htmlFor="stack-name"
            >
              <Input
                id="stack-name"
                value={nameInput}
                invalid={nameError !== null}
                placeholder="例如 my-app"
                className="max-w-sm font-mono"
                onChange={(event) => {
                  setNameInput(event.target.value);
                  if (nameError !== null) setNameError(null);
                  if (saveError !== null) setSaveError(null);
                }}
              />
            </FormField>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs text-app-muted">
              <span>
                项目名 <span className="font-mono text-app-text">{routeName}</span>
              </span>
              <span>
                配置文件{' '}
                <span className="font-mono text-app-text">
                  {stack?.composePath ?? '—'}
                </span>
              </span>
            </div>
          )}

          <FormField
            label="compose.yaml"
            required
            error={yamlError ?? undefined}
            hint="编辑器当前使用纯文本模式；保存时后端会校验 YAML 结构与 compose 语义。"
            htmlFor="stack-compose-editor"
          >
            <CodeEditor
              value={yaml}
              onChange={(next) => {
                setDraft(next);
                if (yamlError !== null) setYamlError(null);
                if (saveError !== null) setSaveError(null);
              }}
              language="text"
              height="58vh"
              placeholder={'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"'}
              ariaLabel="compose YAML 编辑器"
            />
          </FormField>

          <div className="flex flex-wrap items-start gap-2 rounded-lg border border-app-border bg-app-elevated/40 p-3 text-xs text-app-muted">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-app-warning" />
            <p className="min-w-0 flex-1 leading-relaxed">
              Compose YAML 属于可信属主功能，可挂载宿主目录、设置 privileged 或覆盖网络；
              请只粘贴你信任的内容。保存成功后不会自动启动容器，需要回到详情页执行「启动」。
            </p>
          </div>

          {saveError === null ? null : (
            <div className="flex flex-col gap-2">
              <Alert tone="danger" title="保存失败" hint={describeError(saveError).hint}>
                {describeError(saveError).description}
              </Alert>
              {composeValidationOutput(saveError) === null ? null : (
                <CodeBlock
                  code={composeValidationOutput(saveError) ?? ''}
                  language="text"
                  maxHeight="240px"
                  copyable
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** docker compose config 失败时后端把命令输出放在 details.output。 */
function composeValidationOutput(error: unknown): string | null {
  if (!isAppError(error, 'BAD_REQUEST')) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return null;
  const output = (details as Record<string, unknown>).output;
  return typeof output === 'string' && output.trim().length > 0 ? output : null;
}
