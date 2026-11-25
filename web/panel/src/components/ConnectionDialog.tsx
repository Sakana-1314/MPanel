import { useEffect, useState } from 'react';
import type { BackendConnection } from '../api/types';
import { probeConnection } from '../api/client';
import { normalizeBaseUrl, makeConnectionId, useConnectionStore } from '../lib/connection-store';
import { getSecret, removeSecret, setSecret } from '../lib/connection-secrets';
import { Alert } from './ui/Alert';
import { Button } from './ui/Button';
import { FormField } from './ui/FormField';
import { Input } from './ui/Input';
import { Modal } from './ui/Modal';
import { Select } from './ui/Select';
import { Switch } from './ui/Switch';

export interface ConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  initial?: BackendConnection;
  onSaved?: (connection: BackendConnection) => void;
}

interface ProbeState {
  ok: boolean;
  message: string;
}

/**
 * 新增/编辑后端连接。
 * - worker：需要 token（默认 sessionStorage，勾选“记住”才写 localStorage 并提示 XSS 风险）；
 * - core：用户名密码在登录页输入，这里只保存地址与可选用户名提示。
 */
export function ConnectionDialog(props: ConnectionDialogProps): JSX.Element {
  const add = useConnectionStore((state) => state.add);
  const update = useConnectionStore((state) => state.update);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'worker' | 'core'>('worker');
  const [baseUrl, setBaseUrl] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [remember, setRemember] = useState(false);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<ProbeState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const initialId = props.initial?.id;

  useEffect(() => {
    if (!props.open) return;
    const current = props.initial;
    setName(current?.name ?? '');
    setKind(current?.kind ?? 'worker');
    setBaseUrl(current?.baseUrl ?? '');
    setUsername(current?.username ?? '');
    setToken('');
    setRemember(false);
    setHasStoredToken(current !== undefined && getSecret(current.id) !== undefined);
    setProbe(null);
    setError(null);
  }, [props.open, initialId]);

  const isEdit = props.initial !== undefined;

  const validate = (): string | null => {
    if (name.trim().length === 0) return '请填写连接名称。';
    if (baseUrl.trim().length === 0) return '请填写后端地址。';
    const normalized = normalizeBaseUrl(baseUrl);
    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '后端地址必须是 http:// 或 https:// 开头。';
      }
    } catch {
      return '后端地址格式不正确，例如 https://panel.example.com。';
    }
    if (kind === 'worker' && token.length === 0 && !hasStoredToken) {
      return 'agent 连接需要 Bearer token，请在下方填写。';
    }
    return null;
  };

  const runProbe = async (): Promise<void> => {
    const problem = validate();
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setTesting(true);
    setProbe(null);
    const existingToken =
      props.initial === undefined ? undefined : getSecret(props.initial.id);
    const result = await probeConnection({
      baseUrl: normalizeBaseUrl(baseUrl),
      kind,
      token: kind === 'worker' ? (token.length > 0 ? token : existingToken) : undefined,
    });
    setTesting(false);
    if (result.ok) {
      const info = result.info;
      setProbe({
        ok: true,
        message:
          info === undefined
            ? (result.notice ?? `连接成功 · ${result.latencyMs} ms`)
            : `连接成功 · ${info.name} v${info.version} · ${result.latencyMs} ms`,
      });
    } else {
      setProbe({
        ok: false,
        message: `${result.error?.message ?? '连接失败'}：${result.error?.hint ?? '请检查地址与凭据。'}`,
      });
    }
  };

  const save = (): void => {
    const problem = validate();
    if (problem !== null) {
      setError(problem);
      return;
    }
    const normalized = normalizeBaseUrl(baseUrl);
    const normalizedName = name.trim();

    if (isEdit && props.initial !== undefined) {
      const id = props.initial.id;
      update(id, {
        name: normalizedName,
        kind,
        baseUrl: normalized,
        username: username.trim().length === 0 ? undefined : username.trim(),
      });
      if (kind === 'worker' && token.length > 0) {
        setSecret(id, token, remember ? 'local' : 'session');
      }
      if (kind === 'core') removeSecret(id);
      props.onSaved?.({
        ...props.initial,
        name: normalizedName,
        kind,
        baseUrl: normalized,
      });
    } else {
      const id = makeConnectionId();
      const connection: BackendConnection = {
        id,
        name: normalizedName,
        kind,
        baseUrl: normalized,
        username: username.trim().length === 0 ? undefined : username.trim(),
        createdAt: new Date().toISOString(),
      };
      add(connection);
      if (kind === 'worker' && token.length > 0) {
        setSecret(id, token, remember ? 'local' : 'session');
      }
      props.onSaved?.(connection);
    }
    props.onClose();
  };

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={isEdit ? '编辑连接' : '新增后端连接'}
      description="agent 直连 /api/v1；core 通过机器代理访问各主机。"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose}>
            取消
          </Button>
          <Button variant="secondary" size="sm" loading={testing} onClick={() => void runProbe()}>
            测试连接
          </Button>
          <Button size="sm" onClick={save}>
            {isEdit ? '保存' : '添加连接'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="名称" required htmlFor="connection-name" description="显示在侧边栏连接切换器中。">
          <Input
            id="connection-name"
            value={name}
            placeholder="例如：生产 core"
            onChange={(event) => setName(event.target.value)}
            invalid={error !== null && name.trim().length === 0}
          />
        </FormField>

        <FormField label="类型" required htmlFor="connection-kind">
          <Select
            id="connection-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value === 'core' ? 'core' : 'worker')}
            options={[
              { value: 'worker', label: 'agent · 直连（Bearer token）' },
              { value: 'core', label: 'core · 多机管理（会话登录）' },
            ]}
          />
        </FormField>

        <FormField
          label="后端地址"
          required
          htmlFor="connection-url"
          description="服务根地址，不要带 /api/v1；例如 https://panel.example.com 或 http://127.0.0.1:8787。"
        >
          <Input
            id="connection-url"
            value={baseUrl}
            placeholder="https://panel.example.com"
            onChange={(event) => setBaseUrl(event.target.value)}
            invalid={error !== null && baseUrl.trim().length === 0}
            autoComplete="off"
          />
        </FormField>

        {kind === 'worker' ? (
          <>
            <FormField
              label="worker token"
              htmlFor="connection-token"
              hint={
                hasStoredToken && token.length === 0
                  ? '已保存 token；留空则保持不变。'
                  : '保存在当前标签页会话（sessionStorage）。'
              }
              required={!hasStoredToken}
            >
              <Input
                id="connection-token"
                type="password"
                value={token}
                placeholder={hasStoredToken ? '••••••（保持不变）' : 'MPANEL_TOKEN'}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
              />
            </FormField>
            <Switch
              checked={remember}
              onChange={setRemember}
              label="记住 token（localStorage）"
              description="方便但不安全：任何 XSS 都可读取。共享电脑上不要勾选。"
            />
          </>
        ) : (
          <FormField
            label="用户名"
            htmlFor="connection-username"
            description="仅用于登录页预填，密码只提交给 core，不存储。"
          >
            <Input
              id="connection-username"
              value={username}
              placeholder="admin"
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </FormField>
        )}

        {error === null ? null : (
          <Alert tone="danger" title="请检查表单">
            {error}
          </Alert>
        )}

        {probe === null ? null : (
          <Alert tone={probe.ok ? 'success' : 'danger'} title={probe.ok ? '连接成功' : '连接失败'}>
            {probe.message}
          </Alert>
        )}
      </div>
    </Modal>
  );
}
