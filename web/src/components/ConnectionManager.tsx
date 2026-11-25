import { useState } from 'react';
import { BadgeCheck, Check, KeyRound, Pencil, Plus, Server, Trash2, Wifi } from 'lucide-react';
import type { BackendConnection } from '../api/types';
import { probeConnection } from '../api/client';
import { getSecret } from '../lib/connection-secrets';
import { useConnectionStore } from '../lib/connection-store';
import { ConnectionDialog } from './ConnectionDialog';
import { Alert } from './ui/Alert';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Drawer } from './ui/Drawer';
import { EmptyState } from './ui/EmptyState';
import { Input } from './ui/Input';
import { useToast } from './ui/Toast';
import { formatDate } from '../lib/format';

export interface ConnectionManagerProps {
  open: boolean;
  onClose: () => void;
}

interface ProbeEntry {
  state: 'testing' | 'ok' | 'fail';
  message: string;
}

/** 连接管理抽屉：新增、编辑、测试、重命名、设为默认、删除。 */
export function ConnectionManager(props: ConnectionManagerProps): JSX.Element {
  const connections = useConnectionStore((state) => state.connections);
  const activeId = useConnectionStore((state) => state.activeId);
  const setDefault = useConnectionStore((state) => state.setDefault);
  const rename = useConnectionStore((state) => state.rename);
  const remove = useConnectionStore((state) => state.remove);
  const toast = useToast();

  const [editing, setEditing] = useState<BackendConnection | undefined>(undefined);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleting, setDeleting] = useState<BackendConnection | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeEntry>>({});

  const openCreate = (): void => {
    setEditing(undefined);
    setDialogOpen(true);
  };

  const openEdit = (connection: BackendConnection): void => {
    setEditing(connection);
    setDialogOpen(true);
  };

  const test = async (connection: BackendConnection): Promise<void> => {
    setProbes((current) => ({
      ...current,
      [connection.id]: { state: 'testing', message: '正在测试…' },
    }));
    const result = await probeConnection({
      baseUrl: connection.baseUrl,
      kind: connection.kind,
      token: connection.kind === 'worker' ? getSecret(connection.id) : undefined,
    });
    setProbes((current) => ({
      ...current,
      [connection.id]: result.ok
        ? {
            state: 'ok',
            message:
              result.info === undefined
                ? `${result.notice ?? '连接成功'} · ${result.latencyMs} ms`
                : `成功 · ${result.info.name} v${result.info.version} · ${result.latencyMs} ms`,
          }
        : {
            state: 'fail',
            message: `${result.error?.message ?? '失败'} · ${result.error?.hint ?? ''}`.trim(),
          },
    }));
  };

  const startRename = (connection: BackendConnection): void => {
    setRenamingId(connection.id);
    setRenameValue(connection.name);
  };

  const commitRename = (): void => {
    if (renamingId === null) return;
    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      toast.push({ title: '名称不能为空', tone: 'warning' });
      return;
    }
    rename(renamingId, trimmed);
    setRenamingId(null);
    toast.success('已重命名连接');
  };

  return (
    <>
      <Drawer
        open={props.open}
        onClose={props.onClose}
        title="连接管理"
        description="连接对象不含 token；worker token 单独存储在当前会话。"
        size="lg"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              关闭
            </Button>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
              新增连接
            </Button>
          </>
        }
      >
        {connections.length === 0 ? (
          <EmptyState
            title="还没有后端连接"
            description="添加一个 worker（直连 token）或 core（账号登录、多机管理）连接后即可开始。"
            action={
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
                新增连接
              </Button>
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {connections.map((connection) => {
              const active = connection.id === activeId;
              const probe = probes[connection.id];
              const hasToken = connection.kind === 'worker' && getSecret(connection.id) !== undefined;
              return (
                <li
                  key={connection.id}
                  className="rounded-lg border border-app-border bg-app-elevated/40 p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Server className="h-4 w-4 text-app-muted" />
                        {renamingId === connection.id ? (
                          <div className="flex items-center gap-1">
                            <Input
                              value={renameValue}
                              onChange={(event) => setRenameValue(event.target.value)}
                              className="h-7 w-48 text-xs"
                              autoFocus
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') commitRename();
                                if (event.key === 'Escape') setRenamingId(null);
                              }}
                            />
                            <Button
                              size="icon"
                              variant="ghost"
                              title="保存名称"
                              onClick={commitRename}
                            >
                              <Check className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          <span className="truncate text-sm font-medium text-app-text">
                            {connection.name}
                          </span>
                        )}
                        <Badge tone={connection.kind === 'core' ? 'accent' : 'info'}>
                          {connection.kind}
                        </Badge>
                        {active ? (
                          <Badge tone="success" dot>
                            当前默认
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-[11px] text-app-muted">
                        {connection.baseUrl}
                      </p>
                      <p className="mt-0.5 text-[11px] text-app-muted">
                        {connection.kind === 'worker'
                          ? hasToken
                            ? 'token 已保存'
                            : '未保存 token'
                          : 'core 会话登录'}
                        {connection.createdAt === undefined
                          ? ''
                          : ` · 添加于 ${formatDate(connection.createdAt)}`}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Wifi className="h-3.5 w-3.5" />}
                        loading={probe?.state === 'testing'}
                        onClick={() => {
                          void test(connection);
                        }}
                      >
                        测试
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => openEdit(connection)}
                      >
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<KeyRound className="h-3.5 w-3.5" />}
                        onClick={() => startRename(connection)}
                      >
                        重命名
                      </Button>
                      {active ? null : (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<BadgeCheck className="h-3.5 w-3.5" />}
                          onClick={() => {
                            setDefault(connection.id);
                            toast.success('已设为默认连接', connection.name);
                          }}
                        >
                          设为默认
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-app-danger"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => setDeleting(connection)}
                      >
                        删除
                      </Button>
                    </div>
                  </div>

                  {probe === undefined ? null : (
                    <div className="mt-2">
                      <Alert tone={probe.state === 'ok' ? 'success' : probe.state === 'fail' ? 'danger' : 'info'}>
                        {probe.message}
                      </Alert>
                    </div>
                  )}
                  {connection.kind === 'worker' && !hasToken ? (
                    <div className="mt-2">
                      <Alert tone="warning" title="缺少 token">
                        worker 连接需要 Bearer token 才能访问 API，请点击“编辑”填写。
                      </Alert>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Drawer>

      <ConnectionDialog
        open={dialogOpen}
        initial={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={(connection) => {
          toast.success(editing === undefined ? '已新增连接' : '已保存连接', connection.name);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="删除连接"
        message={
          <span>
            确定删除连接 <strong className="text-app-text">{deleting?.name}</strong>？
            对应的 token 与机器选择会一并清除；不会影响服务器本身。
          </span>
        }
        confirmLabel="删除"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) {
            remove(deleting.id);
            setDeleting(null);
            toast.success('已删除连接');
          }
        }}
      />
    </>
  );
}
