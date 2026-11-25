import { useState } from 'react';
import { Plus, Settings2 } from 'lucide-react';
import { useConnectionStore } from '../../lib/connection-store';
import { getSecret } from '../../lib/connection-secrets';
import { ConnectionManager } from '../../components/ConnectionManager';
import { ConnectionDialog } from '../../components/ConnectionDialog';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';

/** 设置页的连接摘要；完整操作（测试/重命名/删除/设为默认）在连接管理抽屉里。 */
export function ConnectionsPanel(): JSX.Element {
  const connections = useConnectionStore((state) => state.connections);
  const activeId = useConnectionStore((state) => state.activeId);
  const [managerOpen, setManagerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      {connections.length === 0 ? (
        <EmptyState
          compact
          title="还没有连接"
          description="添加一个 agent 或 core 后端。"
          action={
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
              新增连接
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-app-border">
          {connections.map((connection) => {
            const active = connection.id === activeId;
            const hasToken =
              connection.kind === 'worker' && getSecret(connection.id) !== undefined;
            return (
              <li key={connection.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-app-text">{connection.name}</span>
                    <Badge tone={connection.kind === 'core' ? 'accent' : 'info'}>{connection.kind}</Badge>
                    {active ? <Badge tone="success">默认</Badge> : null}
                    {connection.kind === 'worker' && !hasToken ? (
                      <Badge tone="warning">缺 token</Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-app-muted">
                    {connection.baseUrl}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Settings2 className="h-3.5 w-3.5" />}
          onClick={() => setManagerOpen(true)}
        >
          连接管理
        </Button>
        <Button variant="ghost" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setDialogOpen(true)}>
          新增连接
        </Button>
      </div>

      <ConnectionManager open={managerOpen} onClose={() => setManagerOpen(false)} />
      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
