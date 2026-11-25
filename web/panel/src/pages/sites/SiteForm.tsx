import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type {
  FileServerHandler,
  RedirectHandler,
  ReverseProxyHandler,
  SiteConfig,
  SiteHandler,
} from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { cn } from '../../lib/cn';

export interface SiteDraft {
  name: string;
  enabled: boolean;
  config: SiteConfig;
}

export const EMPTY_SITE_DRAFT: SiteDraft = {
  name: '',
  enabled: true,
  config: {
    domains: [''],
    handler: { type: 'reverse_proxy', upstreams: [''] },
    tls: { mode: 'auto' },
    encode: ['gzip', 'zstd'],
    log: true,
  },
};

export interface SiteFormProps {
  value: SiteDraft;
  onChange: (value: SiteDraft) => void;
  onSubmit: () => void;
  submitting?: boolean;
  submitLabel?: string;
  onCancel?: () => void;
  onPreview?: () => void;
  previewLoading?: boolean;
  /** 站点的只读状态信息（侧栏/提示）。 */
  aside?: ReactNode;
  /** 页脚额外操作（如“应用此站点”）。 */
  footerExtra?: ReactNode;
}

const HOSTNAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

const HANDLER_LABEL: Record<SiteHandler['type'], string> = {
  reverse_proxy: '反向代理',
  file_server: '静态文件',
  redirect: '重定向',
};

/** 站点表单（受控）：域名多值、类型切换、上游/根目录、TLS、响应头、启用开关。 */
export function SiteForm(props: SiteFormProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const draft = props.value;

  const update = (patch: Partial<SiteDraft>): void => {
    props.onChange({ ...draft, ...patch });
  };
  const updateConfig = (patch: Partial<SiteConfig>): void => {
    update({ config: { ...draft.config, ...patch } });
  };
  const handler = draft.config.handler;
  type HandlerPatch =
    | Partial<Omit<ReverseProxyHandler, 'type'>>
    | Partial<Omit<FileServerHandler, 'type'>>
    | Partial<Omit<RedirectHandler, 'type'>>;
  const patchHandler = (patch: HandlerPatch): void => {
    updateConfig({ handler: { ...handler, ...patch } as SiteHandler });
  };

  const changeHandlerType = (type: SiteHandler['type']): void => {
    if (type === handler.type) return;
    if (type === 'reverse_proxy') {
      updateConfig({ handler: { type, upstreams: [''] } });
    } else if (type === 'file_server') {
      updateConfig({ handler: { type, root: '', spa: false, browse: false } });
    } else {
      updateConfig({ handler: { type, to: '', permanent: true, preserveQuery: true } });
    }
  };

  const submit = (): void => {
    const problem = validateSiteDraft(draft);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    props.onSubmit();
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={cn('grid gap-4', props.aside === undefined ? '' : 'xl:grid-cols-[minmax(0,1fr)_20rem]')}>
        <div className="flex min-w-0 flex-col gap-4">
          {/* 基础信息 */}
          <Card>
            <CardHeader title="基础信息" description="站点名称仅用于面板展示；域名会写入 Caddyfile。" />
            <CardBody className="grid gap-3 sm:grid-cols-2">
              <FormField label="站点名称" required htmlFor="site-name">
                <Input
                  id="site-name"
                  value={draft.name}
                  placeholder="例如：官网 / blog"
                  onChange={(event) => update({ name: event.target.value })}
                />
              </FormField>
              <FormField label="启用" description="禁用后全量应用时会从 Caddy 中移除。">
                <Switch
                  checked={draft.enabled}
                  onChange={(enabled) => update({ enabled })}
                  label={draft.enabled ? '已启用' : '已禁用'}
                />
              </FormField>

              <div className="sm:col-span-2">
                <FormField
                  label="域名"
                  required
                  hint="支持多域名、localhost 与通配符 *.example.com；不要带协议或路径。"
                >
                  <div className="flex flex-col gap-2">
                    {draft.config.domains.map((domain, index) => (
                      <div key={index} className="flex items-center gap-2">
                        <Input
                          value={domain}
                          placeholder={index === 0 ? 'example.com' : 'www.example.com'}
                          onChange={(event) => {
                            const domains = [...draft.config.domains];
                            domains[index] = event.target.value;
                            updateConfig({ domains });
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          title="删除域名"
                          aria-label="删除域名"
                          disabled={draft.config.domains.length <= 1}
                          onClick={() => {
                            const domains = draft.config.domains.filter((_, i) => i !== index);
                            updateConfig({ domains });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                    <div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        icon={<Plus className="h-3.5 w-3.5" />}
                        disabled={draft.config.domains.length >= 50}
                        onClick={() => updateConfig({ domains: [...draft.config.domains, ''] })}
                      >
                        添加域名
                      </Button>
                    </div>
                  </div>
                </FormField>
              </div>

              <div className="sm:col-span-2">
                <FormField
                  label="监听地址（可选）"
                  hint="留空使用 Caddy 默认；多个地址用逗号分隔，例如 127.0.0.1:8080。"
                >
                  <CommaListInput
                    value={draft.config.listen}
                    onChange={(listen) => updateConfig({ listen })}
                    placeholder="127.0.0.1:8080"
                  />
                </FormField>
              </div>
            </CardBody>
          </Card>

          {/* 处理方式 */}
          <Card>
            <CardHeader title="处理方式" description="静态文件、反向代理或重定向。" />
            <CardBody className="flex flex-col gap-3">
              <FormField label="类型" required>
                <Select
                  value={handler.type}
                  onChange={(event) => changeHandlerType(event.target.value as SiteHandler['type'])}
                  options={[
                    { value: 'reverse_proxy', label: '反向代理 reverse_proxy' },
                    { value: 'file_server', label: '静态文件 file_server' },
                    { value: 'redirect', label: '重定向 redirect' },
                  ]}
                />
              </FormField>

              {handler.type === 'reverse_proxy' ? (
                <div className="flex flex-col gap-3">
                  <FormField
                    label="上游列表"
                    required
                    hint="例如 127.0.0.1:8080、http://10.0.0.2:3000；禁止空白/引号/花括号。"
                  >
                    <div className="flex flex-col gap-2">
                      {handler.upstreams.map((upstream, index) => (
                        <div key={index} className="flex items-center gap-2">
                          <Input
                            value={upstream}
                            placeholder={index === 0 ? '127.0.0.1:8080' : '10.0.0.2:3000'}
                            onChange={(event) => {
                              const upstreams = [...handler.upstreams];
                              upstreams[index] = event.target.value;
                              patchHandler({ upstreams });
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            title="删除上游"
                            aria-label="删除上游"
                            disabled={handler.upstreams.length <= 1}
                            onClick={() => {
                              patchHandler({
                                upstreams: handler.upstreams.filter((_, i) => i !== index),
                              });
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                      <div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          icon={<Plus className="h-3.5 w-3.5" />}
                          onClick={() =>
                            patchHandler({ upstreams: [...handler.upstreams, ''] })
                          }
                        >
                          添加上游
                        </Button>
                      </div>
                    </div>
                  </FormField>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="负载均衡">
                      <Select
                        value={handler.loadBalance ?? ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          patchHandler({
                            loadBalance:
                              value === ''
                                ? undefined
                                : (value as ReverseProxyHandler['loadBalance']),
                          });
                        }}
                        options={[
                          { value: '', label: '默认（random）' },
                          { value: 'round_robin', label: 'round_robin' },
                          { value: 'random', label: 'random' },
                          { value: 'least_conn', label: 'least_conn' },
                          { value: 'uri_hash', label: 'uri_hash' },
                        ]}
                      />
                    </FormField>
                    <FormField label="健康检查 URI" hint="例如 /healthz；留空关闭主动健康检查。">
                      <Input
                        value={handler.healthUri ?? ''}
                        placeholder="/healthz"
                        onChange={(event) =>
                          patchHandler({
                            healthUri: event.target.value.length === 0 ? undefined : event.target.value,
                          })
                        }
                      />
                    </FormField>
                  </div>

                  <div className="flex flex-wrap gap-6">
                    <Switch
                      checked={handler.websocket !== false}
                      onChange={(webSocket) => patchHandler({ websocket: webSocket })}
                      label="WebSocket 升级"
                    />
                    <Switch
                      checked={handler.tlsSkipVerify === true}
                      onChange={(skip) => patchHandler({ tlsSkipVerify: skip })}
                      label="跳过上游证书校验"
                      description="仅用于自签证书的上游。"
                    />
                  </div>

                  <HeaderEditor
                    title="上游请求头（header_up，可选）"
                    headers={handler.headers}
                    onChange={(headers) => patchHandler({ headers })}
                  />
                </div>
              ) : null}

              {handler.type === 'file_server' ? (
                <div className="flex flex-col gap-3">
                  <FormField
                    label="根目录"
                    required
                    hint="必须是 agent 上 MPANEL_SITES_ROOTS 白名单内的绝对路径。"
                  >
                    <Input
                      value={handler.root}
                      placeholder="/var/www/site 或 C:\\sites\\www"
                      onChange={(event) => patchHandler({ root: event.target.value })}
                    />
                  </FormField>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label="索引文件（可选）" hint="留空使用 Caddy 默认 index.html。">
                      <CommaListInput
                        value={handler.indexNames}
                        onChange={(indexNames) => patchHandler({ indexNames })}
                        placeholder="index.html, index.htm"
                      />
                    </FormField>
                    <div className="flex flex-wrap items-center gap-6 pt-6">
                      <Switch
                        checked={handler.spa === true}
                        onChange={(spa) => patchHandler({ spa })}
                        label="SPA 回退到 index.html"
                      />
                      <Switch
                        checked={handler.browse === true}
                        onChange={(browse) => patchHandler({ browse })}
                        label="目录浏览"
                      />
                    </div>
                  </div>
                  <FormField label="预压缩文件">
                    <div className="flex gap-6">
                      <label className="flex items-center gap-2 text-xs text-app-muted">
                        <input
                          type="checkbox"
                          checked={(handler.precompressed ?? []).includes('gzip')}
                          onChange={(event) => {
                            const current = new Set(handler.precompressed ?? []);
                            if (event.target.checked) current.add('gzip');
                            else current.delete('gzip');
                            patchHandler({
                              precompressed: current.size === 0 ? undefined : ([...current] as ('gzip' | 'zstd')[]),
                            });
                          }}
                        />
                        gzip
                      </label>
                      <label className="flex items-center gap-2 text-xs text-app-muted">
                        <input
                          type="checkbox"
                          checked={(handler.precompressed ?? []).includes('zstd')}
                          onChange={(event) => {
                            const current = new Set(handler.precompressed ?? []);
                            if (event.target.checked) current.add('zstd');
                            else current.delete('zstd');
                            patchHandler({
                              precompressed: current.size === 0 ? undefined : ([...current] as ('gzip' | 'zstd')[]),
                            });
                          }}
                        />
                        zstd
                      </label>
                    </div>
                  </FormField>
                </div>
              ) : null}

              {handler.type === 'redirect' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <FormField label="重定向目标" required hint="例如 https://example.com；禁止引号与换行。">
                      <Input
                        value={handler.to}
                        placeholder="https://example.com"
                        onChange={(event) => patchHandler({ to: event.target.value })}
                      />
                    </FormField>
                  </div>
                  <Switch
                    checked={handler.permanent !== false}
                    onChange={(permanent) => patchHandler({ permanent })}
                    label="永久重定向（308）"
                  />
                  <Switch
                    checked={handler.preserveQuery !== false}
                    onChange={(preserveQuery) => patchHandler({ preserveQuery })}
                    label="保留查询参数（追加 {uri}）"
                  />
                </div>
              ) : null}
            </CardBody>
          </Card>

          {/* TLS 与响应 */}
          <Card>
            <CardHeader title="TLS 与响应" description="证书模式、额外响应头、压缩与访问日志。" />
            <CardBody className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="TLS 模式" required>
                  <Select
                    value={draft.config.tls?.mode ?? 'auto'}
                    onChange={(event) => {
                      const mode = event.target.value as 'auto' | 'internal' | 'off';
                      updateConfig({
                        tls:
                          mode === 'auto'
                            ? { mode, email: draft.config.tls?.email }
                            : { mode },
                      });
                    }}
                    options={[
                      { value: 'auto', label: 'auto · 自动申请证书' },
                      { value: 'internal', label: 'internal · Caddy 内部 CA' },
                      { value: 'off', label: 'off · 仅 HTTP' },
                    ]}
                  />
                </FormField>
                {draft.config.tls?.mode === 'auto' ? (
                  <FormField label="ACME 邮箱（可选）" hint="用于证书到期通知。">
                    <Input
                      value={draft.config.tls?.email ?? ''}
                      placeholder="ops@example.com"
                      onChange={(event) => {
                        const email = event.target.value.trim();
                        updateConfig({
                          tls: { mode: 'auto', email: email.length === 0 ? undefined : email },
                        });
                      }}
                    />
                  </FormField>
                ) : null}
              </div>

              <HeaderEditor
                title="额外响应头"
                description="每个响应头一行，例如 X-Frame-Options: DENY。"
                headers={draft.config.headers}
                onChange={(headers) => updateConfig({ headers })}
              />

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="压缩编码">
                  <div className="flex gap-6">
                    {(['gzip', 'zstd'] as const).map((encoding) => (
                      <label key={encoding} className="flex items-center gap-2 text-xs text-app-muted">
                        <input
                          type="checkbox"
                          checked={(draft.config.encode ?? []).includes(encoding)}
                          onChange={(event) => {
                            const current = new Set(draft.config.encode ?? []);
                            if (event.target.checked) current.add(encoding);
                            else current.delete(encoding);
                            updateConfig({
                              encode: current.size === 0 ? undefined : ([...current] as ('gzip' | 'zstd')[]),
                            });
                          }}
                        />
                        {encoding}
                      </label>
                    ))}
                  </div>
                </FormField>
                <div className="pt-6">
                  <Switch
                    checked={draft.config.log !== false}
                    onChange={(log) => updateConfig({ log })}
                    label="访问日志"
                    description="写入 Caddy 默认访问日志。"
                  />
                </div>
              </div>

              <Alert tone="info" title="基础认证暂不可用">
                api-contract §6.1 的 SiteConfig 未定义 basicauth 字段，Caddyfile 生成器也没有对应指令；
                为避免配置被静默丢弃，表单暂不提供基础认证。需要时请在 Caddy 侧独立维护。
              </Alert>
            </CardBody>
          </Card>

          {error === null ? null : (
            <Alert tone="danger" title="无法保存">
              {error}
            </Alert>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-app-border pt-3">
            {props.footerExtra}
            {props.onCancel === undefined ? null : (
              <Button type="button" variant="ghost" onClick={props.onCancel} disabled={props.submitting}>
                取消
              </Button>
            )}
            {props.onPreview === undefined ? null : (
              <Button
                type="button"
                variant="secondary"
                loading={props.previewLoading === true}
                onClick={props.onPreview}
              >
                预览 Caddyfile
              </Button>
            )}
            <Button type="submit" loading={props.submitting}>
              {props.submitLabel ?? '保存'}
            </Button>
          </div>
        </div>

        {props.aside === undefined ? null : (
          <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-4 xl:self-start">{props.aside}</aside>
        )}
      </div>
    </form>
  );
}

/* ------------------------------ 子组件 ------------------------------ */

function CommaListInput(props: {
  value: string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  placeholder?: string;
}): JSX.Element {
  const serialized = JSON.stringify(props.value ?? []);
  const [text, setText] = useState((props.value ?? []).join(', '));
  const lastRef = useRef(serialized);

  useEffect(() => {
    if (serialized === lastRef.current) return;
    lastRef.current = serialized;
    setText((props.value ?? []).join(', '));
  }, [serialized, props.value]);

  const commit = (): void => {
    const list = text
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    lastRef.current = JSON.stringify(list);
    setText(list.join(', '));
    props.onChange(list.length === 0 ? undefined : list);
  };

  return (
    <Input
      value={text}
      placeholder={props.placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

interface HeaderRow {
  key: string;
  value: string;
}

function HeaderEditor(props: {
  title: string;
  description?: string;
  headers: Record<string, string> | undefined;
  onChange: (headers: Record<string, string> | undefined) => void;
}): JSX.Element {
  const serialized = JSON.stringify(props.headers ?? {});
  const [rows, setRows] = useState<HeaderRow[]>(() => toRows(props.headers));
  const lastRef = useRef(serialized);

  useEffect(() => {
    if (serialized === lastRef.current) return;
    lastRef.current = serialized;
    setRows(toRows(props.headers));
  }, [serialized, props.headers]);

  const commit = (nextRows: HeaderRow[]): void => {
    setRows(nextRows);
    const next: Record<string, string> = {};
    for (const row of nextRows) {
      const key = row.key.trim();
      if (key.length === 0) continue;
      next[key] = row.value;
    }
    lastRef.current = JSON.stringify(next);
    props.onChange(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <FormField label={props.title} hint={props.description}>
      <div className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={row.key}
              placeholder="Header-Name"
              className="w-1/3 font-mono text-xs"
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, key: event.target.value };
                commit(next);
              }}
            />
            <Input
              value={row.value}
              placeholder="value"
              className="flex-1 font-mono text-xs"
              onChange={(event) => {
                const next = [...rows];
                next[index] = { ...row, value: event.target.value };
                commit(next);
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              title="删除响应头"
              aria-label="删除响应头"
              onClick={() => commit(rows.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => setRows([...rows, { key: '', value: '' }])}
          >
            添加响应头
          </Button>
        </div>
      </div>
    </FormField>
  );
}

function toRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

/* ------------------------------ 校验 ------------------------------ */

export function validateSiteDraft(draft: SiteDraft): string | null {
  if (draft.name.trim().length === 0) return '请填写站点名称。';
  if (draft.name.length > 100) return '站点名称不能超过 100 个字符。';

  const domains = draft.config.domains.map((domain) => domain.trim()).filter((domain) => domain.length > 0);
  if (domains.length === 0) return '至少填写一个域名。';
  if (domains.length > 50) return '域名最多 50 个。';
  const seen = new Set<string>();
  for (const domain of domains) {
    const problem = validateDomain(domain);
    if (problem !== null) return `${problem}：${domain}`;
    if (seen.has(domain.toLowerCase())) return `域名重复：${domain}`;
    seen.add(domain.toLowerCase());
  }

  for (const listen of draft.config.listen ?? []) {
    if (listen.trim().length === 0) return '监听地址不能为空。';
    if (/[\s]/.test(listen.trim())) return `监听地址不能包含空白：${listen}`;
  }

  const handler = draft.config.handler;
  if (handler.type === 'reverse_proxy') {
    const upstreams = handler.upstreams.map((item) => item.trim()).filter((item) => item.length > 0);
    if (upstreams.length === 0) return '反向代理至少需要一个上游地址。';
    for (const upstream of upstreams) {
      if (/[\s"'{}]/.test(upstream)) return `上游地址包含非法字符（空白/引号/花括号）：${upstream}`;
    }
    if (handler.healthUri !== undefined && /[\s"'{}]/.test(handler.healthUri)) {
      return '健康检查 URI 不能包含空白、引号或花括号。';
    }
    const headerProblem = validateHeaders(handler.headers);
    if (headerProblem !== null) return headerProblem;
  } else if (handler.type === 'file_server') {
    const root = handler.root.trim();
    if (root.length === 0) return '静态文件站点需要根目录。';
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(root)) {
      return '根目录必须是绝对路径（以 / 或盘符开头）。';
    }
  } else {
    const to = handler.to.trim();
    if (to.length === 0) return '请填写重定向目标。';
    if (/[\u0000-\u001f"]/.test(to)) return '重定向目标不能包含引号或控制字符。';
  }

  const headerProblem = validateHeaders(draft.config.headers);
  if (headerProblem !== null) return headerProblem;

  const email = draft.config.tls?.email;
  if (email !== undefined && email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'ACME 邮箱格式不正确。';
  }

  return null;
}

function validateDomain(domain: string): string | null {
  if (domain.length > 253) return '域名过长';
  if (domain.includes('://')) return '域名不能包含协议';
  if (/[\s/\\]/.test(domain)) return '域名不能包含空白或路径';
  if (domain === 'localhost') return null;
  if (IPV4_RE.test(domain)) return null;
  if (!HOSTNAME_RE.test(domain)) return '域名格式不正确';
  return null;
}

function validateHeaders(headers: Record<string, string> | undefined): string | null {
  if (headers === undefined) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) return `响应头名称不合法：${name}`;
    if (/[\u0000-\u001f\u007f]/.test(value)) return `响应头值包含控制字符：${name}`;
  }
  return null;
}

export { HANDLER_LABEL };
