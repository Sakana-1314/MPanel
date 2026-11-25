import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CirclePlay, Pause, RefreshCw } from 'lucide-react';
import type { ContainerSummary, StackDetail } from '../../api/types';
import type { LogLine } from '../../components/ui/LogViewer';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { LogViewer } from '../../components/ui/LogViewer';
import { Switch } from '../../components/ui/Switch';
import { useTicketWs, type TicketWsStatus } from '../../lib/use-ws';
import {
  appendLogLines,
  isFatalCloseCode,
  parseLogMessage,
  toLogLine,
  wsCloseHint,
} from './log-utils';
import { containerName, containerStateLabel } from './container-utils';
import { stackServiceName } from './stack-utils';

/** 一个编排最多同时聚合的连接数，防止一次打开几十个 WebSocket。 */
const MAX_AGGREGATED_CONTAINERS = 8;

interface AggregateLine extends LogLine {
  service: string;
}

export interface StackLogsPanelProps {
  stack: StackDetail;
  enabled?: boolean;
  height?: string;
}

/**
 * 编排日志聚合：为项目内每个容器建立日志 WS，按到达顺序合并并加服务前缀。
 * 超过上限的容器不再建立连接，提示用户前往容器页单独查看。
 */
export function StackLogsPanel(props: StackLogsPanelProps): JSX.Element {
  const [lines, setLines] = useState<AggregateLine[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TicketWsStatus>>({});
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const pausedRef = useRef(false);
  const bufferRef = useRef<AggregateLine[]>([]);

  const feeds = props.stack.containers.slice(0, MAX_AGGREGATED_CONTAINERS);

  const append = useCallback((line: AggregateLine) => {
    if (pausedRef.current) {
      bufferRef.current = appendLogLines(bufferRef.current, [line]) as AggregateLine[];
      setBuffered(bufferRef.current.length);
      return;
    }
    setLines((previous) => appendLogLines(previous, [line]) as AggregateLine[]);
  }, []);

  const reportStatus = useCallback((containerId: string, status: TicketWsStatus) => {
    setStatuses((previous) =>
      previous[containerId] === status ? previous : { ...previous, [containerId]: status },
    );
  }, []);

  const reportError = useCallback((message: string) => {
    setStreamError(message);
  }, []);

  const togglePause = (): void => {
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      const pending = bufferRef.current;
      bufferRef.current = [];
      setBuffered(0);
      if (pending.length > 0) setLines((previous) => appendLogLines(previous, pending) as AggregateLine[]);
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
    clear();
    setStreamError(null);
    setStatuses({});
    setGeneration((value) => value + 1);
  };

  const displayLines: LogLine[] = useMemo(
    () =>
      lines.map((line) => ({
        ts: line.ts,
        stream: line.stream,
        text: `[${line.service}] ${line.text}`,
      })),
    [lines],
  );

  const openCount = feeds.filter((container) => statuses[container.id] === 'open').length;
  const connecting = feeds.some((container) => statuses[container.id] === 'connecting');
  const statusTone =
    feeds.length > 0 && openCount === feeds.length ? 'success' : connecting ? 'info' : 'warning';

  if (props.stack.containers.length === 0) {
    return (
      <EmptyState
        compact
        title="没有可聚合的容器"
        description="该编排尚未创建容器，执行「启动」后再查看日志聚合。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
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
          >
            重新聚合
          </Button>
          <Badge tone={statusTone} dot>
            已连接 {openCount}/{feeds.length}
          </Badge>
          {paused ? <Badge tone="warning">显示已暂停</Badge> : null}
        </div>
        <Switch checked={autoScroll} onChange={setAutoScroll} label="自动滚动到底部" disabled={paused} />
      </div>

      {props.stack.containers.length > MAX_AGGREGATED_CONTAINERS ? (
        <Alert tone="warning" title="聚合连接数已达上限">
          仅聚合前 {MAX_AGGREGATED_CONTAINERS} 个容器的日志，其余{' '}
          {props.stack.containers.length - MAX_AGGREGATED_CONTAINERS} 个请到「容器」页单独查看。
        </Alert>
      ) : null}

      {streamError === null ? null : (
        <Alert tone="danger" title="部分日志流中断" hint="可点击“重新聚合”重建全部连接。">
          {streamError}
        </Alert>
      )}

      <div className="flex flex-wrap gap-1.5">
        {feeds.map((container) => {
          const status = statuses[container.id];
          return (
            <Badge
              key={container.id}
              tone={
                status === 'open'
                  ? 'success'
                  : status === 'connecting'
                    ? 'info'
                    : status === 'closed'
                      ? 'danger'
                      : 'neutral'
              }
              title={`${containerName(container)} · ${containerStateLabel(container.state)}`}
            >
              {stackServiceName(container)}
            </Badge>
          );
        })}
      </div>

      <LogViewer
        lines={displayLines}
        follow={autoScroll && !paused}
        onClear={clear}
        height={props.height ?? '420px'}
        emptyText="正在等待容器日志…"
      />
      <p className="text-[10px] text-app-muted">
        每个容器建立一条独立的 WebSocket 日志流，按到达顺序合并；关闭抽屉/切换标签页会自动断开全部连接。
      </p>

      {feeds.map((container) => (
        <StackLogFeed
          key={`${container.id}-${generation}`}
          container={container}
          enabled={props.enabled !== false}
          onLine={(line) =>
            append({ ...line, service: stackServiceName(container) })
          }
          onStatus={(status) => reportStatus(container.id, status)}
          onError={(message) => reportError(`${stackServiceName(container)}：${message}`)}
        />
      ))}
    </div>
  );
}

interface StackLogFeedProps {
  container: ContainerSummary;
  enabled: boolean;
  onLine: (line: LogLine) => void;
  onStatus: (status: TicketWsStatus) => void;
  onError: (message: string) => void;
}

/** 无渲染的日志连接器：为单个容器维护 WS 生命周期。 */
function StackLogFeed(props: StackLogFeedProps): null {
  const featurePath = useMemo(
    () =>
      `/containers/${encodeURIComponent(props.container.id)}/logs?tail=100&follow=1&timestamps=1&stdout=1&stderr=1`,
    [props.container.id],
  );

  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  const { status } = useTicketWs(featurePath, {
    enabled: props.enabled,
    onMessage: (raw) => {
      const message = parseLogMessage(raw);
      if (message === null) return;
      if (message.type === 'log') {
        const line = toLogLine(message);
        if (line !== null) callbacksRef.current.onLine(line);
        return;
      }
      if (message.type === 'error') {
        callbacksRef.current.onError(`${message.code}：${message.message}`);
      }
    },
    onClose: (event) => {
      if (isFatalCloseCode(event.code)) {
        callbacksRef.current.onError(wsCloseHint(event.code));
      }
    },
  });

  useEffect(() => {
    callbacksRef.current.onStatus(status);
  }, [status]);

  return null;
}
