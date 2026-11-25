import type { ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useSession } from '../lib/use-session';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { Spinner } from '../components/ui/Spinner';

/**
 * 认证门：
 * - core 依赖 HttpOnly cookie 会话，/auth/me 401 时跳登录页；
 * - worker 依赖 Bearer token，没有 token 视为未登录；
 * - 网络错误不跳转，展示重试，避免把后端故障误判为登出。
 */
export function LoginGate(props: { children: ReactNode }): JSX.Element {
  const session = useSession();
  const location = useLocation();

  if (session.status === 'authenticated' || session.status === 'no-connection') {
    return <>{props.children}</>;
  }

  if (session.status === 'no-credentials' || session.status === 'unauthenticated') {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  if (session.status === 'checking') {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Spinner size="lg" label="正在验证登录状态…" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <Alert
        tone="danger"
        title="无法验证登录状态"
        hint="请确认后端地址可访问；跨域部署时 core 需要允许 credentials 与 CORS。"
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldAlert className="h-3.5 w-3.5" />}
              onClick={session.refetch}
            >
              重试
            </Button>
            <Link to="/login">
              <Button variant="ghost" size="sm">
                切换连接 / 登录
              </Button>
            </Link>
          </div>
        }
      >
        {session.error?.message ?? '未知错误'}
      </Alert>
    </div>
  );
}
