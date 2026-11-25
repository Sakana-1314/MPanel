import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { Button } from '../components/ui/Button';

export default function NotFoundPage(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-app-bg px-4 text-app-text">
      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-app-border bg-app-surface text-app-muted">
        <Compass className="h-6 w-6" />
      </span>
      <p className="text-3xl font-semibold tracking-tight">404</p>
      <p className="text-sm text-app-muted">页面不存在，或链接已失效。</p>
      <div className="mt-2 flex gap-2">
        <Link to="/">
          <Button size="sm">返回仪表盘</Button>
        </Link>
        <Button variant="secondary" size="sm" onClick={() => window.history.back()}>
          返回上一页
        </Button>
      </div>
    </div>
  );
}
