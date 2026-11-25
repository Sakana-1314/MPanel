import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Plus, Server, Settings2, User } from 'lucide-react';
import { coreLogin, workerMe } from '../api/auth';
import { AppError, describeError } from '../api/errors';
import { useConnectionStore } from '../lib/connection-store';
import { setSecret, removeSecret } from '../lib/connection-secrets';
import { setAuthState } from '../lib/auth-store';
import { useSession } from '../lib/use-session';
import { useTheme } from '../app/ThemeProvider';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { ConnectionManager } from '../components/ConnectionManager';
import { Alert } from '../components/ui/Alert';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { FormField } from '../components/ui/FormField';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';

interface LocationState {
  from?: string;
}

export default function LoginPage(): JSX.Element {
  const connections = useConnectionStore((state) => state.connections);
  const activeId = useConnectionStore((state) => state.activeId);
  const setActive = useConnectionStore((state) => state.setActive);
  const active = connections.find((connection) => connection.id === activeId);
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { theme, toggleTheme } = useTheme();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  const from = (location.state as LocationState | null)?.from ?? '/';

  useEffect(() => {
    setUsername(active?.username ?? '');
    setPassword('');
    setToken('');
    setError(null);
  }, [activeId, active?.username]);

  const afterLogin = (): void => {
    void queryClient.invalidateQueries();
    navigate(from, { replace: true });
  };

  const submitCore = async (): Promise<void> => {
    if (active === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const result = await coreLogin({ username: username.trim(), password });
      setAuthState(active.id, {
        authenticated: true,
        authType: 'session',
        role: 'core',
        user: result.user,
      });
      afterLogin();
    } catch (loginError) {
      setError(loginError);
    } finally {
      setBusy(false);
    }
  };

  const submitWorker = async (): Promise<void> => {
    if (active === undefined) return;
    if (token.trim().length === 0) {
      setError(new AppError('BAD_REQUEST', '请填写 agent token', 0, { hint: 'token 由 agent 配置 MPANEL_TOKEN 决定。' }));
      return;
    }
    setBusy(true);
    setError(null);
    setSecret(active.id, token.trim(), remember ? 'local' : 'session');
    try {
      const me = await workerMe();
      setAuthState(active.id, {
        authenticated: true,
        authType: me.authType,
        role: me.role,
        user: me.user ?? null,
      });
      afterLogin();
    } catch (loginError) {
      removeSecret(active.id);
      setError(loginError);
    } finally {
      setBusy(false);
    }
  };

  if (connections.length === 0) {
    return (
      <LoginLayout
        theme={theme}
        onToggleTheme={toggleTheme}
        title="连接你的第一台后端"
        description="MPanel 支持 agent 直连与 core 多机管理。先添加一个后端，再登录。"
      >
        <div className="flex flex-col gap-3">
          <Alert tone="info" title="两种连接方式">
            agent：使用 MPANEL_TOKEN 直连，适合单机部署。<br />
            core：账号密码登录，可管理多台机器并代理请求。
          </Alert>
          <Button fullWidth icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
            新增连接
          </Button>
        </div>
        <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      </LoginLayout>
    );
  }

  if (session.status === 'authenticated') {
    return <Navigate to={from} replace />;
  }

  const errorInfo = error === null ? null : describeError(error);

  return (
    <LoginLayout
      theme={theme}
      onToggleTheme={toggleTheme}
      title="登录 MPanel"
      description="选择连接后使用对应凭据登录。"
    >
      <div className="flex flex-col gap-4">
        <FormField label="后端连接" htmlFor="login-connection">
          <div className="flex items-center gap-2">
            <Select
              id="login-connection"
              value={activeId ?? ''}
              onChange={(event) => setActive(event.target.value)}
              options={connections.map((connection) => ({
                value: connection.id,
                label: `${connection.name}（${connection.kind}）`,
              }))}
            />
            <Button
              variant="secondary"
              size="icon"
              title="连接管理"
              aria-label="连接管理"
              onClick={() => setManagerOpen(true)}
            >
              <Settings2 className="h-4 w-4" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              title="新增连接"
              aria-label="新增连接"
              onClick={() => setDialogOpen(true)}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </FormField>

        {active === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2 text-xs text-app-muted">
            <Badge tone={active.kind === 'core' ? 'accent' : 'info'} dot>
              {active.kind}
            </Badge>
            <span className="break-all font-mono">{active.baseUrl}</span>
          </div>
        )}

        {session.status === 'checking' ? (
          <div className="flex items-center justify-center py-6">
            <Spinner label="正在验证登录状态…" />
          </div>
        ) : active?.kind === 'worker' ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitWorker();
            }}
          >
            <FormField label="agent token" required htmlFor="login-token" description="对应 agent 的 MPANEL_TOKEN。">
              <Input
                id="login-token"
                type="password"
                value={token}
                autoFocus
                autoComplete="current-password"
                placeholder="MPANEL_TOKEN"
                leading={<KeyRound className="h-3.5 w-3.5" />}
                onChange={(event) => setToken(event.target.value)}
              />
            </FormField>
            <Switch
              checked={remember}
              onChange={setRemember}
              label="记住 token（localStorage）"
              description="方便但不安全：任何 XSS 都可读取。共享电脑上不要勾选。"
            />
            <Button type="submit" fullWidth loading={busy}>
              连接
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCore();
            }}
          >
            <FormField label="用户名" required htmlFor="login-username">
              <Input
                id="login-username"
                value={username}
                autoFocus
                autoComplete="username"
                placeholder="admin"
                leading={<User className="h-3.5 w-3.5" />}
                onChange={(event) => setUsername(event.target.value)}
              />
            </FormField>
            <FormField label="密码" required htmlFor="login-password">
              <Input
                id="login-password"
                type="password"
                value={password}
                autoComplete="current-password"
                leading={<Lock className="h-3.5 w-3.5" />}
                onChange={(event) => setPassword(event.target.value)}
              />
            </FormField>
            <Button type="submit" fullWidth loading={busy} disabled={username.trim().length === 0 || password.length === 0}>
              登录
            </Button>
          </form>
        )}

        {errorInfo === null ? null : (
          <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
            {errorInfo.description}
          </Alert>
        )}

        <p className="text-center text-xs text-app-muted">
          <Link to="/" className="text-app-accent hover:underline">
            返回首页
          </Link>
        </p>
      </div>

      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConnectionManager open={managerOpen} onClose={() => setManagerOpen(false)} />
    </LoginLayout>
  );
}

function LoginLayout(props: {
  children: ReactNode;
  title: string;
  description: string;
  theme: 'dark' | 'light';
  onToggleTheme(): void;
}): JSX.Element {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-app-bg px-4 py-10 text-app-text">
      <button
        type="button"
        onClick={props.onToggleTheme}
        className="absolute right-4 top-4 rounded-md border border-app-border bg-app-surface px-2.5 py-1.5 text-xs text-app-muted hover:text-app-text"
      >
        {props.theme === 'dark' ? '浅色' : '深色'}
      </button>
      <div className="w-full max-w-md">
        <div className="mb-4 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-app-accent text-lg font-bold text-white">
            M
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">{props.title}</h1>
            <p className="text-xs text-app-muted">{props.description}</p>
          </div>
        </div>
        <div className="rounded-xl border border-app-border bg-app-surface p-5 shadow-panel">
          {props.children}
        </div>
        <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-app-muted">
          <Server className="h-3 w-3" />
          MPanel · self-hosted server control panel
        </p>
      </div>
    </div>
  );
}
