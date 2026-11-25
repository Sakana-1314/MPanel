import { useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Server, Settings2 } from 'lucide-react';
import { useActiveConnection } from '../lib/connection-store';
import { ConnectionDialog } from '../components/ConnectionDialog';
import { ConnectionManager } from '../components/ConnectionManager';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';

/**
 * 未配置任何后端连接时阻止特性页渲染。
 * 默认连接可由 VITE_DEFAULT_BACKEND(S) / config.json 注入（bootstrapConnections）。
 */
export function ConnectionGate(props: { children: ReactNode }): JSX.Element {
  const connection = useActiveConnection();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);

  if (connection !== undefined) return <>{props.children}</>;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 py-10">
      <EmptyState
        icon={<Server className="h-5 w-5" />}
        title="尚未连接后端"
        description="MPanel 需要一个 agent（直连 token）或 core（账号登录、多机管理）后端才能工作。添加连接后即可管理站点、证书、容器与文件。"
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDialogOpen(true)}>
              新增连接
            </Button>
            <Button
              variant="secondary"
              icon={<Settings2 className="h-4 w-4" />}
              onClick={() => setManagerOpen(true)}
            >
              连接管理
            </Button>
          </div>
        }
      />
      <Alert tone="info" title="部署提示">
        静态前端可通过 config.json 或 VITE_DEFAULT_BACKEND* 预置默认后端；config.json 是公开文件，不能包含
        token。
      </Alert>

      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      <ConnectionManager open={managerOpen} onClose={() => setManagerOpen(false)} />
    </div>
  );
}
