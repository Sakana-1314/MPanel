import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CirclePlay, Pause, RefreshCw } from 'lucide-react';
import type { LogLine } from '../../components/ui/LogViewer';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { LogViewer } from '../../components/ui/LogViewer';
import { Select } from '../../components/ui/Select';
import type { SelectOption } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { useTicketWs } from '../../lib/use-ws';
import {
  appendLogLines,
  isFatalCloseCode,
  parseLogMessage,
  toLogLine,
  wsCloseHint,
} from './log-utils';

export interface ContainerLogsPanelProps {
  id: string;
  /** 日志区域高度，默认 420px。 */
  height?: string;
}

const TAIL_OPTIONS: readonly SelectOption[] = [
  { value: '100', label: '尾部 100 行' },
  { value: '200', label: '尾部 200 行' },
  { value: '500', label: '尾部 500 行' },
  { value: '1000', label: '尾部 1000 行' },
];

/**
 * 容器实时日志：GET ticket 后通过 /ws/containers/:id/logs 跟随。
 * 组件卸载（关闭抽屉/切换标签页）时 useTicketWs 会关闭连接；暂停只冻结显示，
 * 后台收到的行进入内存缓冲，继续后一次性追加。
 */
export function ContainerLogsPanel(props: ContainerLogsPanelProps): JSX.Element {
  const [tail, setTail] = useState(200);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [buffered, setBuffered] = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [active, setActive] = useState(true);
  const [sessionKey, setSessionKey] = useState(0);

  const pausedRef = useRef(false);
  const bufferRef = useRef<LogLine[]>([]);

  const featurePath = useMemo(
    () =>
      `/containers/${encodeURIComponent(props.id)}/logs?tail=${tail}&follow=1&timestamps=1&stdout=1&stderr=1&session=${sessionKey}`,
    [props.id, tail, sessionKey],
  );

  const resetStream = useCallback(() => {
    setLines([]);
    setBuffered(0);
    bufferRef.current = [];
    setStreamError(null);
    setEnded(false);
    setActive(true);
  }, []);

  const { status } = useTicketWs(featurePath, {
    enabled: active,
    onMessage: (raw) => {
      const message = parseLogMessage(raw);
      if (message === null) return;
      if (message.type === 'log') {
        const line = toLogLine(message);
        if (line === null) return;
        if (pausedRef.current) {
          bufferRef.current = appendLogLines(bufferRef.current, [line]);
          setBuffered(bufferRef.current.length);
          return;
        }
        setLines((previous) => appendLogLines(previous, [line]));
        return;
      }
      if (message.type === 'end') {
        setEnded(true);
        setActive(false);
        return;
      }
      setStreamError(`${message.code}：${message.message}`);
      setActive(false);
    },
    onClose: (event) => {
      if (isFatalCloseCode(event.code)) {
        setStreamError(wsCloseHint(event.code));
        setActive(false);
      }
    },
  });

  // 新建连接（切换 tail 或手动重连）时清空旧日志。
  useEffect(() => {
    resetStream();
  }, [props.id, tail, sessionKey, resetStream]);

  const togglePause = (): void => {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      const pending = bufferRef.current;
      bufferRef.current = [];
      setBuffered(0);
      if (pending.length > 0) {
        setLines((previous) => appendLogLines(previous, pending));
      }
      return;
    }
    pausedRef.current = true;
    setPaused(true);
  };

  const clear = (): void => {
    bufferRef.current = [];
    setBuffered(0);
    setLines([]);
  };

  const reconnect = (): void => {
    setActive(true);
    setSessionKey((value) => value + 1);
  };

  const connectionLabel =
    status === 'open'
      ? '已连接'
      : status === 'connecting'
        ? '连接中…'
        : active
          ? '重连中…'
          : '已断开';
  const connectionTone =
    status === 'open' ? 'success' : status === 'connecting' || active ? 'info' : 'warning';

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="日志尾部行数"
            className="w-36"
            options={TAIL_OPTIONS}
            value={String(tail)}
            onChange={(event) => {
              setTail(Number(event.target.value));
              setSessionKey((value) => value + 1);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            icon={paused ? <CirclePlay className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            onClick={togglePause}
          >
            {paused ? `继续${buffered > 0 ? `（${buffered} 行缓冲）` : ''}` : '暂停'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={reconnect}
            loading={status === 'connecting'}
          >
            重新连接
          </Button>
          <Badge tone={connectionTone} dot>
            {connectionLabel}
          </Badge>
          {paused ? <Badge tone="warning">显示已暂停</Badge> : null}
        </div>
        <Switch
          checked={autoScroll}
          onChange={setAutoScroll}
          label="自动滚动到底部"
          disabled={paused}
        />
      </div>

      {streamError === null ? null : (
        <Alert tone="danger" title="日志流错误" hint="可点击“重新连接”重新获取 ticket 并建立日志流。">
          {streamError}
        </Alert>
      )}
      {ended && streamError === null ? (
        <Alert tone="neutral" title="日志流已结束">
          容器可能已退出。需要继续查看时可点击“重新连接”。
        </Alert>
      ) : null}

      <LogViewer
        lines={lines}
        follow={autoScroll && !paused}
        onClear={clear}
        height={props.height ?? '420px'}
        emptyText={status === 'connecting' ? '正在连接日志流…' : '暂无日志输出。'}
      />
      <p className="text-[10px] text-app-muted">
        日志通过 WebSocket 实时推送，最多保留最近 5000 行；关闭抽屉或切换标签页会自动断开。
      </p>
    </div>
  );
}
