import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ClipboardPaste,
  Copy,
  Eraser,
  PlugZap,
  RotateCw,
  Square,
  TextSelect,
  X,
} from 'lucide-react';
import { Terminal } from 'xterm';
import type { ITheme } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import type {
  TerminalClientMessage,
  TerminalServerMessage,
  TerminalSession,
} from '../../api/types';
import { connectWs, type WsSession } from '../../api/ws';
import { AppError, describeError, isAppError } from '../../api/errors';
import { cn } from '../../lib/cn';
import { useTheme } from '../../app/ThemeProvider';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { copyText } from '../../components/ui/CopyButton';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { TERMINAL_CONNECTION_LABEL, type TerminalConnectionState } from './TerminalTabs';

export interface TerminalViewProps {
  sessionId: string;
  /** 只有激活标签才执行 fit/focus；隐藏标签保持 WS 连接以持续接收输出。 */
  active: boolean;
  session?: TerminalSession | null;
  fontSize?: number;
  /** PTY 不可用时的补充说明（来自 /system/info capabilities.pty.reason）。 */
  ptyHint?: string;
  className?: string;
  onStatusChange?: (state: TerminalConnectionState) => void;
  onSessionUpdate?: (session: TerminalSession) => void;
  onExit?: (code: number | null) => void;
  onFontSizeChange?: (size: number) => void;
}

const TERMINAL_FONT =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

const DARK_THEME: ITheme = {
  background: '#0b1220',
  foreground: '#e2e8f0',
  cursor: '#60a5fa',
  cursorAccent: '#0b1220',
  selectionBackground: '#1e3a5f99',
  black: '#0b1220',
  red: '#f47185',
  green: '#34d399',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e2e8f0',
  brightBlack: '#64748b',
  brightRed: '#fb7185',
  brightGreen: '#6ee7b7',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
};

const LIGHT_THEME: ITheme = {
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#2563eb',
  cursorAccent: '#f8fafc',
  selectionBackground: '#bfdbfecc',
  black: '#0f172a',
  red: '#dc2626',
  green: '#059669',
  yellow: '#b45309',
  blue: '#2563eb',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#f1f5f9',
  brightBlack: '#64748b',
  brightRed: '#ef4444',
  brightGreen: '#10b981',
  brightYellow: '#d97706',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#0891b2',
  brightWhite: '#ffffff',
};

/** 致命关闭码：重连也不会成功（会话不存在/未认证）。 */
const FATAL_CLOSE_CODES = new Set([4401, 4404]);
const MAX_AUTO_RETRIES = 5;
const DEFAULT_FONT_SIZE = 13;

interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

/**
 * xterm 终端视图：先取 ticket 再建立 WS、fit addon 自适应、ResizeObserver 回传尺寸、
 * 右键菜单与快捷键复制粘贴、断线自动重连、主题与字号跟随。
 * 组件卸载（关闭标签/离开页面）只断开 WS，不删除服务端会话。
 */
export function TerminalView(props: TerminalViewProps): JSX.Element {
  const { theme } = useTheme();
  const toast = useToast();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WsSession | null>(null);
  const ptyRef = useRef<boolean | null>(props.session?.pty ?? null);
  const activeRef = useRef(props.active);
  const exitedRef = useRef(false);
  const autoReconnectRef = useRef(true);
  const cancelRetryRef = useRef<() => void>(() => undefined);
  const themeRef = useRef(theme);
  const fontSizeRef = useRef(props.fontSize ?? DEFAULT_FONT_SIZE);
  fontSizeRef.current = props.fontSize ?? DEFAULT_FONT_SIZE;

  const [connection, setConnection] = useState<TerminalConnectionState>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [connectError, setConnectError] = useState<unknown>(null);
  const [serverError, setServerError] = useState<{ code: string; message: string } | null>(null);
  const [exitInfo, setExitInfo] = useState<{ code: number | null; signal: string | null } | null>(
    null,
  );
  const [size, setSize] = useState<{ cols: number; rows: number }>({
    cols: props.session?.cols ?? 80,
    rows: props.session?.rows ?? 24,
  });
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  themeRef.current = theme;
  activeRef.current = props.active;

  const onStatusChangeRef = useRef(props.onStatusChange);
  onStatusChangeRef.current = props.onStatusChange;
  const onSessionUpdateRef = useRef(props.onSessionUpdate);
  onSessionUpdateRef.current = props.onSessionUpdate;
  const onExitRef = useRef(props.onExit);
  onExitRef.current = props.onExit;
  const onFontSizeChangeRef = useRef(props.onFontSizeChange);
  onFontSizeChangeRef.current = props.onFontSizeChange;

  /** 发送 JSON 控制帧；WS 未就绪时静默丢弃（ready 后会补发尺寸）。 */
  const send = useCallback((message: TerminalClientMessage): void => {
    const socket = wsRef.current;
    if (socket === null) return;
    try {
      socket.sendText(JSON.stringify(message));
    } catch {
      // 桥接已关闭；重连后由 ready 重新同步。
    }
  }, []);

  const fitTerminal = useCallback((): void => {
    const host = hostRef.current;
    const term = terminalRef.current;
    const fit = fitRef.current;
    if (host === null || term === null || fit === null) return;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fit.fit();
      return;
    } catch {
      // addon 与 xterm 版本不匹配时回退到本地测量，保证 resize 仍会生效。
    }
    const cell = readCellSize(term);
    if (cell === null) return;
    const style = window.getComputedStyle(host);
    const paddingX =
      Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
    const paddingY =
      Number.parseFloat(style.paddingTop || '0') + Number.parseFloat(style.paddingBottom || '0');
    // 有回滚缓冲时右侧会显示滚动条，预留与 addon-fit 相同的 14px。
    const scrollbar = term.options.scrollback === 0 ? 0 : 14;
    const width = host.clientWidth - paddingX - scrollbar;
    const height = host.clientHeight - paddingY;
    if (width <= 0 || height <= 0 || cell.width <= 0 || cell.height <= 0) return;
    const cols = Math.max(2, Math.floor(width / cell.width));
    const rows = Math.max(1, Math.floor(height / cell.height));
    if (cols === term.cols && rows === term.rows) return;
    try {
      term.resize(cols, rows);
    } catch {
      // 终端尚未完成初始化时忽略，后续 ResizeObserver 会再次尝试。
    }
  }, []);

  const sendCurrentSize = useCallback((): void => {
    const term = terminalRef.current;
    if (term === null) return;
    if (ptyRef.current === false) return;
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }, [send]);

  const copySelection = useCallback(async (): Promise<void> => {
    const term = terminalRef.current;
    const selection = term?.getSelection() ?? '';
    if (selection.length === 0) {
      toast.info('没有选中的终端文本');
      return;
    }
    const ok = await copyText(selection);
    if (ok) toast.success('已复制终端选区');
    else toast.warning('复制失败', '浏览器拒绝访问剪贴板，请手动选择文本后复制。');
  }, [toast]);

  const copySelectionRef = useRef(copySelection);
  copySelectionRef.current = copySelection;

  const pasteFromClipboard = useCallback(async (): Promise<void> => {
    const term = terminalRef.current;
    if (term === null) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) term.paste(text);
    } catch {
      toast.warning(
        '无法读取剪贴板',
        '浏览器需要剪贴板读取权限；也可以在终端内直接使用 Ctrl+V / Cmd+V 粘贴。',
      );
    }
  }, [toast]);

  const pasteRef = useRef(pasteFromClipboard);
  pasteRef.current = pasteFromClipboard;

  const clearTerminal = useCallback((): void => {
    terminalRef.current?.clear();
  }, []);

  // 1) 创建 xterm 实例（每个会话一次）；主题/字号后续走独立 effect。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize: props.fontSize ?? DEFAULT_FONT_SIZE,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      convertEol: false,
      allowTransparency: false,
      macOptionIsMeta: true,
      theme: themeRef.current === 'light' ? LIGHT_THEME : DARK_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terminalRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (data.length > 0) send({ type: 'input', data });
    });
    term.onResize(({ cols, rows }) => {
      setSize({ cols, rows });
      if (ptyRef.current === false) return;
      send({ type: 'resize', cols, rows });
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const key = event.key;
      const isCopyCombo =
        (event.ctrlKey && event.shiftKey && (key === 'C' || key === 'c')) ||
        (event.metaKey && !event.ctrlKey && (key === 'C' || key === 'c') && term.hasSelection());
      if (isCopyCombo) {
        void copySelectionRef.current();
        return false;
      }
      if (
        (event.ctrlKey && event.shiftKey && (key === 'V' || key === 'v')) ||
        (event.metaKey && (key === 'V' || key === 'v'))
      ) {
        void pasteRef.current();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && (key === 'K' || key === 'k')) {
        clearTerminal();
        return false;
      }
      const fontHandler = onFontSizeChangeRef.current;
      if (event.ctrlKey && event.shiftKey && fontHandler !== undefined) {
        if (key === '+' || key === '=') {
          fontHandler(fontSizeRef.current + 1);
          return false;
        }
        if (key === '-' || key === '_') {
          fontHandler(fontSizeRef.current - 1);
          return false;
        }
        if (key === '0') {
          fontHandler(DEFAULT_FONT_SIZE);
          return false;
        }
      }
      return true;
    });

    const raf = requestAnimationFrame(() => {
      if (!activeRef.current) return;
      fitTerminal();
      term.focus();
    });
    const timer = setTimeout(() => {
      if (activeRef.current) fitTerminal();
    }, 250);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      term.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // 实例只随会话 id 重建；字号/主题由下方 effect 更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  // 2) 主题跟随外壳。
  useEffect(() => {
    const term = terminalRef.current;
    if (term === null) return;
    term.options.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME;
  }, [theme]);

  // 3) 字号变化：更新并重新 fit。
  useEffect(() => {
    const term = terminalRef.current;
    if (term === null) return;
    term.options.fontSize = props.fontSize ?? DEFAULT_FONT_SIZE;
    const raf = requestAnimationFrame(() => fitTerminal());
    return () => cancelAnimationFrame(raf);
  }, [props.fontSize, fitTerminal]);

  // 4) ResizeObserver：容器尺寸变化（窗口、侧边栏、抽屉）触发 fit。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (!activeRef.current) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        fitTerminal();
      }, 80);
    });
    observer.observe(host);
    return () => {
      if (timer !== null) clearTimeout(timer);
      observer.disconnect();
    };
  }, [fitTerminal]);

  // 5) 激活标签时 fit + focus（隐藏标签无法测量尺寸）。
  useEffect(() => {
    if (!props.active) return;
    const raf = requestAnimationFrame(() => {
      fitTerminal();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [props.active, fitTerminal]);

  // 6) 上报连接状态给页面（标签圆点）。
  useEffect(() => {
    onStatusChangeRef.current?.(connection);
  }, [connection]);

  // 7) WS：先取 ticket 再建连；断开自动重连；退出/致命错误不重连。
  useEffect(() => {
    let disposed = false;
    let socket: WsSession | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attemptCount = 0;
    exitedRef.current = false;
    ptyRef.current = props.session?.pty ?? null;

    setConnection('connecting');
    setConnectError(null);
    setServerError(null);
    setExitInfo(null);
    setAttempt(0);

    const clearRetry = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const handleMessage = (raw: string): void => {
      let message: TerminalServerMessage;
      try {
        message = JSON.parse(raw) as TerminalServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'ready': {
          ptyRef.current = message.session.pty;
          setSize({ cols: message.session.cols, rows: message.session.rows });
          onSessionUpdateRef.current?.(message.session);
          sendCurrentSize();
          break;
        }
        case 'output': {
          terminalRef.current?.write(message.data);
          break;
        }
        case 'exit': {
          exitedRef.current = true;
          setExitInfo({ code: message.code, signal: message.signal ?? null });
          setConnection('closed');
          onExitRef.current?.(message.code);
          break;
        }
        case 'error': {
          setServerError({ code: message.code, message: message.message });
          break;
        }
        case 'pong':
          break;
        default:
          break;
      }
    };

    const failFatal = (error: unknown): void => {
      clearRetry();
      setConnectError(error);
      setConnection('error');
    };

    const scheduleRetry = (reason: string): void => {
      if (disposed || exitedRef.current) return;
      if (!autoReconnectRef.current) {
        setConnection('closed');
        return;
      }
      attemptCount += 1;
      if (attemptCount > MAX_AUTO_RETRIES) {
        setConnection('error');
        setConnectError(
          new AppError('UNAVAILABLE', `自动重连失败（已尝试 ${MAX_AUTO_RETRIES} 次）`, 0, {
            hint: '请确认机器在线、后端可访问，然后点击“重新连接”。',
            ...(reason.length > 0 ? { reason } : {}),
          }),
        );
        return;
      }
      setAttempt(attemptCount);
      setConnection('reconnecting');
      const delay = Math.min(1000 * 2 ** (attemptCount - 1), 10_000);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect(true);
      }, delay);
    };

    const connect = async (isRetry: boolean): Promise<void> => {
      clearRetry();
      if (disposed) return;
      if (!isRetry) setConnection('connecting');
      try {
        const created = await connectWs(`/terminal/${encodeURIComponent(props.sessionId)}`, {
          onMessage: (data) => {
            if (typeof data === 'string') handleMessage(data);
          },
          onClose: (event) => {
            socket = null;
            wsRef.current = null;
            if (disposed) return;
            if (exitedRef.current) {
              setConnection('closed');
              return;
            }
            if (FATAL_CLOSE_CODES.has(event.code)) {
              failFatal(closeError(event.code, event.reason));
              return;
            }
            scheduleRetry(event.reason);
          },
          onError: () => {
            // onclose 随后触发并进入统一的重连流程。
          },
        });
        if (disposed) {
          created.close(1000, 'terminal view unmounted');
          return;
        }
        socket = created;
        wsRef.current = created;
        attemptCount = 0;
        setAttempt(0);
        setConnectError(null);
        setConnection('open');
        sendCurrentSize();
      } catch (error) {
        if (disposed) return;
        setConnectError(error);
        if (
          isAppError(error) &&
          (error.code === 'NOT_FOUND' ||
            error.code === 'UNAUTHORIZED' ||
            error.code === 'FORBIDDEN')
        ) {
          failFatal(error);
          return;
        }
        // 网络/超时/机器暂不可用时自动重试；错误详情保留给横幅展示。
        scheduleRetry('');
      }
    };

    const cancel = (): void => {
      clearRetry();
      setConnection('closed');
    };
    cancelRetryRef.current = cancel;

    void connect(false);

    return () => {
      disposed = true;
      clearRetry();
      if (cancelRetryRef.current === cancel) cancelRetryRef.current = () => undefined;
      if (socket !== null) {
        socket.close(1000, 'terminal view unmounted');
        socket = null;
      }
      wsRef.current = null;
    };
    // 手动重连通过 reconnectNonce 触发；服务端消息处理全部走 ref，避免闭包过期。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId, reconnectNonce, sendCurrentSize]);

  const openContextMenu = (event: ReactMouseEvent): void => {
    event.preventDefault();
    const term = terminalRef.current;
    const width = 184;
    const height = 228;
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
      hasSelection: term?.hasSelection() ?? false,
    });
  };

  useEffect(() => {
    if (menu === null) return;
    const close = (): void => setMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const reconnect = (): void => {
    autoReconnectRef.current = true;
    setAutoReconnect(true);
    setConnectError(null);
    setReconnectNonce((value) => value + 1);
  };

  const stopReconnect = (): void => {
    autoReconnectRef.current = false;
    setAutoReconnect(false);
    if (connection === 'reconnecting' || connection === 'error') cancelRetryRef.current();
    toast.info('已停止自动重连', '远端会话仍在运行，可随时点击“重新连接”。');
  };

  const errorInfo = connectError === null ? null : describeError(connectError, '终端连接失败');
  const rawReason = isAppError(connectError) ? connectError.detail?.reason : undefined;
  const errorReason = typeof rawReason === 'string' && rawReason.length > 0 ? rawReason : undefined;
  const pty = ptyRef.current;
  const showReconnectBanner = connection === 'reconnecting';
  const showErrorBanner = connection === 'error' && errorInfo !== null;

  return (
    <div
      className={cn('relative flex h-full min-h-0 w-full flex-col bg-app-surface', props.className)}
      onContextMenu={openContextMenu}
    >
      <div className="flex flex-col gap-1 px-2 pt-2 empty:hidden">
        {connection === 'connecting' ? (
          <div className="flex items-center gap-2 rounded-lg border border-app-info/30 bg-app-info/10 px-3 py-1.5 text-xs text-app-text">
            <Spinner size="xs" />
            <span>正在获取 WS ticket 并连接终端会话…</span>
          </div>
        ) : null}
        {showReconnectBanner ? (
          <Alert
            tone="warning"
            title={`连接已断开，正在自动重连（第 ${attempt} 次，最多 ${MAX_AUTO_RETRIES} 次）`}
            action={
              <div className="flex gap-1.5">
                <Button variant="secondary" size="xs" onClick={reconnect}>
                  立即重连
                </Button>
                <Button variant="ghost" size="xs" onClick={stopReconnect}>
                  停止重连
                </Button>
              </div>
            }
          >
            远端 shell 仍可能继续运行；重连后只能看到断开之后产生的新输出。
            {errorInfo === null ? null : (
              <span className="mt-0.5 block">
                最近错误：{errorInfo.title} · {errorInfo.description}
              </span>
            )}
          </Alert>
        ) : null}
        {showErrorBanner && errorInfo !== null ? (
          <Alert
            tone="danger"
            title={`终端连接失败 · ${errorInfo.title}`}
            hint={errorInfo.hint}
            action={
              <Button
                variant="secondary"
                size="xs"
                icon={<RotateCw className="h-3 w-3" />}
                onClick={reconnect}
              >
                重新连接
              </Button>
            }
          >
            <p>{errorInfo.description}</p>
            {errorReason === undefined ? null : <p className="mt-0.5">关闭原因：{errorReason}</p>}
            {errorInfo.status > 0 ? <p className="mt-0.5">HTTP 状态：{errorInfo.status}</p> : null}
          </Alert>
        ) : null}
        {connection === 'closed' && exitInfo === null && connectError === null && !autoReconnect ? (
          <Alert
            tone="neutral"
            title="WebSocket 已断开（自动重连已停止）"
            action={
              <Button
                variant="secondary"
                size="xs"
                icon={<PlugZap className="h-3 w-3" />}
                onClick={reconnect}
              >
                重新连接
              </Button>
            }
          >
            远端会话可能仍在运行；重新连接后可继续交互。
          </Alert>
        ) : null}
        {exitInfo !== null ? (
          <Alert
            tone="neutral"
            title="会话已退出"
            hint="进程已结束，可以关闭此标签；会话记录会保留在会话列表中。"
          >
            退出码：{exitInfo.code === null ? '无' : exitInfo.code}
            {exitInfo.signal === null ? '' : ` · 信号：${exitInfo.signal}`}
          </Alert>
        ) : null}
        {serverError !== null ? (
          <Alert
            tone="danger"
            title={`服务端返回错误（${serverError.code}）`}
            action={
              <Button
                variant="ghost"
                size="xs"
                icon={<X className="h-3 w-3" />}
                onClick={() => setServerError(null)}
              >
                忽略
              </Button>
            }
          >
            {serverError.message}
          </Alert>
        ) : null}
        {pty === false ? (
          <Alert
            tone="warning"
            title="PTY 不可用：当前为无 PTY 的降级会话"
            hint={props.ptyHint ?? '服务器未能加载 node-pty，已改用管道模式启动 shell。'}
          >
            管道模式下 resize 不生效，交互式提示符、颜色与行编辑可能缺失。如需完整终端体验，请在服务器安装 node-pty 后重启 worker。
          </Alert>
        ) : null}
      </div>

      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden p-1.5"
        data-testid="terminal-host"
      />

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border px-2 py-1 text-[11px] text-app-muted">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-app-text">{props.sessionId.slice(0, 8)}</span>
          <Badge
            tone={
              connection === 'open'
                ? 'success'
                : connection === 'connecting' || connection === 'reconnecting'
                  ? 'warning'
                  : connection === 'error'
                    ? 'danger'
                    : 'neutral'
            }
            dot
          >
            {TERMINAL_CONNECTION_LABEL[connection]}
          </Badge>
          <span>{pty === false ? '管道模式（无 PTY）' : 'PTY'}</span>
          <span className="tabular-nums">
            {size.cols} × {size.rows}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            icon={<Copy className="h-3 w-3" />}
            onClick={() => {
              void copySelection();
            }}
            title="复制当前终端选区（Ctrl+Shift+C）"
          >
            复制选区
          </Button>
          <Button variant="ghost" size="xs" icon={<Eraser className="h-3 w-3" />} onClick={clearTerminal}>
            清屏
          </Button>
          <span className="text-app-muted">字号 {props.fontSize ?? DEFAULT_FONT_SIZE}px</span>
        </div>
      </footer>

      {menu === null
        ? null
        : createPortal(
            <div
              role="menu"
              className="fixed z-[80] w-[184px] overflow-hidden rounded-lg border border-app-border bg-app-surface py-1 text-xs shadow-panel"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <MenuItem
                icon={<Copy className="h-3.5 w-3.5" />}
                disabled={!menu.hasSelection}
                onClick={() => {
                  setMenu(null);
                  void copySelection();
                }}
              >
                复制选区
              </MenuItem>
              <MenuItem
                icon={<ClipboardPaste className="h-3.5 w-3.5" />}
                onClick={() => {
                  setMenu(null);
                  void pasteFromClipboard();
                }}
              >
                粘贴
              </MenuItem>
              <MenuItem
                icon={<TextSelect className="h-3.5 w-3.5" />}
                onClick={() => {
                  setMenu(null);
                  terminalRef.current?.selectAll();
                }}
              >
                全选
              </MenuItem>
              <MenuItem
                icon={<Eraser className="h-3.5 w-3.5" />}
                onClick={() => {
                  setMenu(null);
                  clearTerminal();
                }}
              >
                清屏
              </MenuItem>
              <div className="my-1 border-t border-app-border" />
              <MenuItem
                icon={<RotateCw className="h-3.5 w-3.5" />}
                disabled={connection === 'open' || connection === 'connecting'}
                onClick={() => {
                  setMenu(null);
                  reconnect();
                }}
              >
                重新连接
              </MenuItem>
              <MenuItem
                icon={<Square className="h-3.5 w-3.5" />}
                disabled={!autoReconnect}
                onClick={() => {
                  setMenu(null);
                  stopReconnect();
                }}
              >
                停止自动重连
              </MenuItem>
            </div>,
            document.body,
          )}
    </div>
  );
}

function MenuItem(props: {
  icon: ReactNode;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled === true}
      onClick={props.onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-app-text hover:bg-app-elevated disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="text-app-muted">{props.icon}</span>
      {props.children}
    </button>
  );
}

/** xterm 5.3 的 cell 尺寸在 core 渲染服务上；读取只读维度用于 addon 失败时的 fallback。 */
interface XtermCellMetricsSource {
  _renderService?: {
    dimensions?: {
      css?: { cell?: { width?: number; height?: number } };
    };
  };
  _core?: {
    _renderService?: {
      dimensions?: {
        css?: { cell?: { width?: number; height?: number } };
      };
    };
  };
}

function readCellSize(term: Terminal): { width: number; height: number } | null {
  const source = term as unknown as XtermCellMetricsSource;
  const cell =
    source._core?._renderService?.dimensions?.css?.cell ??
    source._renderService?.dimensions?.css?.cell;
  if (cell === undefined) return null;
  const width = cell.width ?? 0;
  const height = cell.height ?? 0;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

/** 关闭码 → 可读错误（与 api/ws.ts 的 closeError 语义一致）。 */
function closeError(code: number, reason: string): AppError {
  const extra = reason.length > 0 ? { reason } : {};
  if (code === 4401) {
    return new AppError('UNAUTHORIZED', 'WebSocket ticket 无效或已过期', 0, {
      hint: '请重新登录或刷新页面后再打开终端。',
      ...extra,
    });
  }
  if (code === 4404) {
    return new AppError('NOT_FOUND', '终端会话不存在或已被关闭', 0, {
      hint: '会话可能已被删除或空闲回收；请新建会话。',
      ...extra,
    });
  }
  return new AppError('UPSTREAM_ERROR', `终端 WebSocket 已关闭（${code}）`, 0, {
    hint: '请检查后端与机器状态后重试。',
    ...extra,
  });
}
