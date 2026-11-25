import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { List, Plus, TerminalSquare } from 'lucide-react';
import type { TerminalSession } from '../../api/types';
import {
  closeSession as closeTerminalSession,
  listSessions,
  terminalKeys,
} from '../../api/terminal';
import { getSystemInfo, systemKeys } from '../../api/system';
import { describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { useBasePath } from '../../lib/connection-store';
import { useToast } from '../../components/ui/Toast';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { TerminalTabs, createTabState, type TerminalTabState } from './TerminalTabs';
import { TerminalView } from './TerminalView';
import { SessionList } from './SessionList';
import { NewSessionDialog } from './NewSessionDialog';

const FONT_STORAGE_KEY = 'mpanel.terminal.fontSize.v1';
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 13;

function readFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_STORAGE_KEY);
    if (raw === null) return DEFAULT_FONT_SIZE;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE) return value;
  } catch {
    // 隐私模式下忽略。
  }
  return DEFAULT_FONT_SIZE;
}

/**
 * 终端页面：多标签 xterm 会话 + 服务端会话列表。
 * - 新建/打开/重命名/关闭标签；关闭标签只断开 WS，远端会话仍可恢复。
 * - 关闭有活动会话的标签/其他标签会二次确认；浏览器关闭/刷新由 beforeunload 提示。
 */
export default function TerminalPage(): JSX.Element {
  const toast = useToast();
  const basePath = useBasePath();
  const [tabs, setTabs] = useState<TerminalTabState[]>([]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<TerminalTabState | null>(null);
  const [closeOthersOpen, setCloseOthersOpen] = useState(false);
  const [killTarget, setKillTarget] = useState<TerminalSession | null>(null);
  const [fontSize, setFontSize] = useState<number>(readFontSize);
  const basePathRef = useRef(basePath);

  const sessionsQuery = useQuery({
    queryKey: terminalKeys.sessions({ limit: 100 }),
    queryFn: () => listSessions({ limit: 100 }),
    refetchInterval: 15_000,
    retry: 0,
  });

  const systemQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    staleTime: 60_000,
    retry: 0,
  });

  const closeMutation = useAppMutation({
    mutationFn: (session: TerminalSession) => closeTerminalSession(session.id),
    successMessage: (_result, session) => `已终止终端会话 ${session.id.slice(0, 8)}`,
    invalidate: [terminalKeys.sessions()],
    onSuccess: (_result, session) => {
      removeTab(session.id);
      setKillTarget(null);
    },
  });

  // 连接/机器切换后，旧会话 id 不再属于当前后端，清空标签避免误连。
  useEffect(() => {
    if (basePathRef.current === basePath) return;
    basePathRef.current = basePath;
    setTabs([]);
    setActiveId(null);
    setCloseTarget(null);
    setKillTarget(null);
    toast.info('后端连接已切换', '终端标签已清空；旧连接上的远端会话不会自动终止。');
  }, [basePath, toast]);

  useEffect(() => {
    try {
      localStorage.setItem(FONT_STORAGE_KEY, String(fontSize));
    } catch {
      // 忽略持久化失败。
    }
  }, [fontSize]);

  const runningTabs = tabs.filter((tab) => tab.status === 'running');
  useEffect(() => {
    if (runningTabs.length === 0) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [runningTabs.length]);

  // SPA 路由没有 beforeunload；拦截站内链接点击，提示仍有活动会话。
  // （React Router 的 useBlocker 只支持 data router，外壳使用 BrowserRouter，故在此兜底。）
  useEffect(() => {
    if (runningTabs.length === 0) return;
    const handler = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const href = anchor.getAttribute('href');
      if (href === null || href.length === 0 || href.startsWith('#')) return;
      // 跳过外部链接（http:、mailto: 等）。
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      let nextPath: string;
      try {
        nextPath = new URL(href, window.location.href).pathname;
      } catch {
        return;
      }
      if (nextPath === window.location.pathname) return;
      const confirmed = window.confirm(
        `仍有 ${runningTabs.length} 个活动终端会话。离开页面只会断开 WebSocket，远端 shell 会继续运行。确定要离开吗？`,
      );
      if (!confirmed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [runningTabs.length]);

  const updateTab = useCallback((id: string, patch: Partial<TerminalTabState>): void => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    );
  }, []);

  const removeTab = useCallback((id: string): void => {
    const remaining = tabsRef.current.filter((tab) => tab.id !== id);
    setTabs(remaining);
    setActiveId((current) => {
      if (current !== id) return current;
      const last = remaining[remaining.length - 1];
      return last === undefined ? null : last.id;
    });
  }, []);

  const openSession = useCallback((session: TerminalSession): void => {
    setTabs((current) => {
      if (current.some((tab) => tab.id === session.id)) return current;
      return [...current, createTabState(session)];
    });
    setActiveId(session.id);
  }, []);

  const handleCreated = useCallback(
    (session: TerminalSession): void => {
      openSession(session);
      setSessionsOpen(false);
    },
    [openSession],
  );

  const requestCloseTab = (id: string): void => {
    const tab = tabsRef.current.find((item) => item.id === id);
    if (tab === undefined) return;
    if (tab.status === 'exited') {
      removeTab(id);
      return;
    }
    setCloseTarget(tab);
  };

  const confirmCloseTab = (): void => {
    if (closeTarget === null) return;
    removeTab(closeTarget.id);
    setCloseTarget(null);
  };

  const otherTabCount = tabs.filter((tab) => tab.id !== activeId).length;

  const confirmCloseOthers = (): void => {
    const current = activeId;
    setTabs((items) => items.filter((tab) => tab.id === current));
    setCloseOthersOpen(false);
    toast.info('已关闭其他标签', '远端会话仍在运行，可在“会话列表”中重新打开或终止。');
  };

  const handleFontSize = useCallback((next: number): void => {
    setFontSize(Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(next))));
  }, []);

  const sessions = sessionsQuery.data?.items ?? [];
  const sessionsAvailable = sessionsQuery.data?.available;
  const sessionsReason = sessionsQuery.data?.reason;
  const ptyCapability = systemQuery.data?.capabilities.pty;
  const systemError =
    systemQuery.error === null || systemQuery.error === undefined
      ? null
      : describeError(systemQuery.error);

  return (
    <div className="flex flex-col">
      <PageHeader
        title="终端"
        description="基于 ticket WebSocket 的多标签终端。关闭标签或离开页面只会断开 WS，远端 shell 会继续运行；需在会话列表中“终止”才会结束进程。"
        meta={
          <Badge tone={runningTabs.length > 0 ? 'accent' : 'neutral'} dot>
            {runningTabs.length} 个活动标签
          </Badge>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<List className="h-4 w-4" />}
              onClick={() => setSessionsOpen(true)}
            >
              会话列表
            </Button>
            <Button
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => setNewOpen(true)}
            >
              新建会话
            </Button>
          </>
        }
      />

      {systemError === null ? null : (
        <Alert tone="warning" title="无法读取 PTY 能力" hint={systemError.hint} className="mb-3">
          {systemError.description} 终端仍可创建，但可能以降级模式运行。
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-panel">
        <TerminalTabs
          sessions={tabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={requestCloseTab}
          onNew={() => setNewOpen(true)}
          onRename={(id, title) => updateTab(id, { title })}
          onCloseOthers={tabs.length > 1 ? () => setCloseOthersOpen(true) : undefined}
          fontSize={fontSize}
          onFontSizeChange={handleFontSize}
        />

        <div className="relative h-[calc(100dvh-18rem)] min-h-[360px]">
          {tabs.length === 0 ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="max-w-lg">
                <EmptyState
                  icon={<TerminalSquare className="h-5 w-5" />}
                  title="还没有打开的终端会话"
                  description="新建一个 shell 会话，或从会话列表重新打开仍在运行的会话。会话由 worker 托管，刷新页面不会丢失。"
                  action={
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setNewOpen(true)}>
                        新建会话
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => setSessionsOpen(true)}>
                        查看会话列表
                      </Button>
                    </div>
                  }
                />
              </div>
            </div>
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === activeId ? 'absolute inset-0' : 'hidden'}
                aria-hidden={tab.id !== activeId}
              >
                <TerminalView
                  sessionId={tab.id}
                  session={tab.session}
                  active={tab.id === activeId}
                  fontSize={fontSize}
                  ptyHint={ptyCapability?.reason}
                  onStatusChange={(state) => updateTab(tab.id, { connection: state })}
                  onSessionUpdate={(session) =>
                    updateTab(tab.id, {
                      session,
                      status: session.status,
                      pty: session.pty,
                      exitCode: session.exitCode,
                    })
                  }
                  onExit={(code) => updateTab(tab.id, { status: 'exited', exitCode: code })}
                  onFontSizeChange={handleFontSize}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <NewSessionDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={handleCreated}
        pty={ptyCapability}
        activeSessionCount={
          sessionsQuery.data === undefined
            ? runningTabs.length
            : sessions.filter((session) => session.status === 'running').length
        }
      />

      <Drawer
        open={sessionsOpen}
        onClose={() => setSessionsOpen(false)}
        title="终端会话"
        description="worker 上所有会话（包括已从标签栏关闭但仍在运行的会话）。"
        size="xl"
        footer={
          <Button variant="secondary" size="sm" onClick={() => setSessionsOpen(false)}>
            关闭
          </Button>
        }
      >
        <SessionList
          sessions={sessions}
          loading={sessionsQuery.isLoading}
          error={sessionsQuery.error ?? undefined}
          available={sessionsAvailable}
          reason={sessionsReason}
          openIds={tabs.map((tab) => tab.id)}
          onOpen={(session) => {
            openSession(session);
            setSessionsOpen(false);
          }}
          onDelete={(session) => setKillTarget(session)}
          onRetry={() => {
            void sessionsQuery.refetch();
          }}
          onNew={() => {
            setSessionsOpen(false);
            setNewOpen(true);
          }}
        />
      </Drawer>

      <ConfirmDialog
        open={closeTarget !== null}
        title="关闭终端标签？"
        message={
          <div className="flex flex-col gap-1.5">
            <p>
              将关闭标签「{closeTarget?.title ?? ''}」并断开 WebSocket，但远端 shell
              会话仍在运行，可从“会话列表”重新打开。
            </p>
            <p>如需真正结束进程，请在会话列表中点击“终止”。</p>
          </div>
        }
        confirmLabel="关闭标签"
        danger={false}
        onConfirm={confirmCloseTab}
        onCancel={() => setCloseTarget(null)}
      />

      <ConfirmDialog
        open={closeOthersOpen}
        title="关闭其他终端标签？"
        message={`将关闭 ${otherTabCount} 个其他标签，远端会话会继续运行。之后可在“会话列表”中重新打开或终止。`}
        confirmLabel="关闭其他"
        danger={false}
        onConfirm={confirmCloseOthers}
        onCancel={() => setCloseOthersOpen(false)}
      />

      <ConfirmDialog
        open={killTarget !== null}
        title="终止远端会话？"
        message={
          <div className="flex flex-col gap-1.5">
            <p>
              终止会话 <span className="font-mono">{killTarget?.id.slice(0, 8) ?? ''}</span> 会结束远端
              shell 进程，未保存的工作将丢失。
            </p>
            <p>这是不可撤销的操作；已打开的标签会同时关闭。</p>
          </div>
        }
        confirmLabel="终止会话"
        danger
        loading={closeMutation.isPending}
        onConfirm={() => {
          if (killTarget === null) return;
          return closeMutation.mutateAsync(killTarget).then(
            () => undefined,
            () => undefined,
          );
        }}
        onCancel={() => setKillTarget(null)}
      />
    </div>
  );
}
