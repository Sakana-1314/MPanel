import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DatabaseZap, Send, ShieldCheck, X } from 'lucide-react';
import type { HandoffTicket } from '../../api/types';
import type { StatusTone } from '../../components/ui/tones';
import { buildHandoffFrameUrl, resolveRedeemUrl } from '../../lib/paths';
import { getBasePath } from '../../lib/connection-store';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { RelativeTime } from '../../components/ui/RelativeTime';

export interface DbxFrameProps {
  /** 相对 API feature base 的兑换路径（票据响应里的 redeemUrl 优先）。 */
  redeemUrl: string;
  dbxUrl?: string;
  ticket?: HandoffTicket | null;
  profileName?: string;
  /** 由父级触发生成新票据；不提供时只展示提示。 */
  onRequestTicket?(): void;
  /** 关闭内嵌窗口（父级清空票据即可卸载 iframe）。 */
  onClose?(): void;
}

type HandshakeState = 'idle' | 'hello-sent' | 'ticket-sent' | 'redeemed' | 'error';

const STATE_META: Record<HandshakeState, { label: string; tone: StatusTone }> = {
  idle: { label: '等待 dbx 加载', tone: 'neutral' },
  'hello-sent': { label: '已发送握手', tone: 'info' },
  'ticket-sent': { label: '已通过 postMessage 发送票据', tone: 'info' },
  redeemed: { label: 'dbx 已兑换票据', tone: 'success' },
  error: { label: 'dbx 报告错误', tone: 'danger' },
};

/**
 * dbx 查询控制台 iframe。
 *
 * - dbxUrl 未配置/非法时展示配置说明，绝不让数据库页崩溃。
 * - 票据优先放在 URL fragment（#handoff=...&endpoint=...），不进入服务器访问日志；
 *   onLoad 只发送不含票据的握手消息，dbx 明确请求（dbx:ready + requestHandoff=true）
 *   时才通过 postMessage 补发票据，避免与 fragment 路径重复兑换。
 * - 所有 postMessage 都校验目标 origin；接收消息同时校验 event.origin 与 event.source。
 */
export function DbxFrame(props: DbxFrameProps): JSX.Element {
  const trimmed = (props.dbxUrl ?? '').trim();
  const parsed = useMemo<URL | null | undefined>(() => {
    if (trimmed.length === 0) return null;
    try {
      // 同时支持绝对地址与同源反代路径（如 /dbx）。
      const url =
        typeof window === 'undefined'
          ? new URL(trimmed)
          : new URL(trimmed, window.location.origin);
      // 只允许 http(s)，避免 javascript:/data: 等危险 iframe 源。
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
      return url;
    } catch {
      return undefined;
    }
  }, [trimmed]);

  const ticket = props.ticket ?? null;
  const source = ticket?.redeemUrl !== undefined && ticket.redeemUrl.length > 0
    ? ticket.redeemUrl
    : props.redeemUrl;
  const endpoint = resolveRedeemUrl(source, getBasePath());

  const frameUrl = useMemo(() => {
    if (parsed === null || parsed === undefined || ticket === null) return undefined;
    return buildHandoffFrameUrl(trimmed, endpoint, ticket.ticket);
  }, [parsed, trimmed, endpoint, ticket]);

  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [handshake, setHandshake] = useState<HandshakeState>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setHandshake('idle');
    setNote(null);
    setNowMs(Date.now());
  }, [ticket?.ticket, trimmed]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const postToFrame = useCallback(
    (payload: Record<string, unknown>): boolean => {
      const frame = frameRef.current;
      if (parsed === null || parsed === undefined || frame === null) return false;
      const target = frame.contentWindow;
      if (target === null) return false;
      target.postMessage({ protocol: 1, source: 'mpanel', ...payload }, parsed.origin);
      return true;
    },
    [parsed],
  );

  const sendHello = useCallback((): void => {
    if (ticket === null) return;
    const sent = postToFrame({
      type: 'mpanel:handshake',
      ticketInFragment: true,
      kind: ticket.kind,
      endpoint,
      expiresAt: ticket.expiresAt,
      profileName: props.profileName ?? null,
    });
    if (sent) setHandshake((current) => (current === 'redeemed' ? current : 'hello-sent'));
  }, [postToFrame, ticket, endpoint, props.profileName]);

  const sendTicket = useCallback((): void => {
    if (ticket === null) return;
    const sent = postToFrame({
      type: 'mpanel:handoff',
      ticket: ticket.ticket,
      kind: ticket.kind,
      endpoint,
      expiresAt: ticket.expiresAt,
    });
    if (sent) setHandshake((current) => (current === 'redeemed' ? current : 'ticket-sent'));
  }, [postToFrame, ticket, endpoint]);

  useEffect(() => {
    if (parsed === null || parsed === undefined) return;
    const expectedOrigin = parsed.origin;
    const onMessage = (event: MessageEvent): void => {
      // 双向 origin + source 校验：忽略其它窗口/站点发来的伪造消息。
      if (event.origin !== expectedOrigin) return;
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const record = data as Record<string, unknown>;
      const type = typeof record.type === 'string' ? record.type : '';
      if (type === 'dbx:ready') {
        if (record.requestHandoff === true) sendTicket();
        return;
      }
      if (type === 'dbx:handoff-accepted') {
        setHandshake((current) => (current === 'redeemed' ? current : 'ticket-sent'));
        return;
      }
      if (type === 'dbx:redeemed' || type === 'dbx:handoff-redeemed') {
        setHandshake('redeemed');
        setNote('dbx 已兑换票据并建立数据库连接。票据已被消费，如需重连请重新生成。');
        return;
      }
      if (type === 'dbx:error') {
        setHandshake('error');
        setNote(
          typeof record.message === 'string' && record.message.length > 0
            ? record.message.slice(0, 300)
            : 'dbx 报告了未命名的错误；请查看 dbx 控制台日志。',
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [parsed, sendTicket]);

  if (parsed === null) {
    return (
      <div className="flex flex-col gap-3">
        <Alert
          tone="warning"
          title="dbx 未配置：查询控制台不可用"
          hint="档案、统计与备份不受影响；仍可使用“复制连接信息”或“查看一次性密码”降级连接。"
        >
          未找到 dbx 地址。请设置构建期环境变量 <code className="font-mono">VITE_DBX_URL</code>，或在部署目录的{' '}
          <code className="font-mono">config.json</code> 中添加 <code className="font-mono">dbxUrl</code>，
          然后重新构建（Vite）或刷新页面（config.json）。
        </Alert>
        <CodeBlock
          language="text"
          maxHeight={220}
          code={`# web/.env.local（构建期）
VITE_DBX_URL=https://dbx.example.com

# web/dist/config.json（运行时，推荐）
{
  "dbxUrl": "https://dbx.example.com"
}`}
        />
        <p className="text-xs leading-relaxed text-app-muted">
          还需要让托管前端的静态站点在 CSP <code className="font-mono">frame-src</code>{' '}
          中允许该地址，并在 worker/core 设置{' '}
          <code className="font-mono">MPANEL_DBX_ORIGIN</code>，否则 dbx 兑换票据会被 CORS 拒绝。
        </p>
      </div>
    );
  }

  if (parsed === undefined) {
    return (
      <Alert tone="danger" title="dbxUrl 配置无效" hint="示例：https://dbx.example.com（必须使用 http/https 且包含主机）。">
        当前 dbx 地址 <code className="font-mono">{trimmed}</code> 不是合法 URL，已禁用内嵌查询窗口。
        请修正 <code className="font-mono">VITE_DBX_URL</code> 或 <code className="font-mono">config.json</code> 的{' '}
        <code className="font-mono">dbxUrl</code>。
      </Alert>
    );
  }

  if (ticket === null) {
    return (
      <EmptyState
        icon={<DatabaseZap className="h-5 w-5" />}
        title="尚未生成 dbx 票据"
        description="点击上方“打开 dbx”会先向后端申请一次性 handoff 票据，然后在这里内嵌加载 dbx。票据默认 60 秒内有效且只能使用一次。"
        action={
          props.onRequestTicket === undefined ? undefined : (
            <Button size="sm" variant="secondary" onClick={props.onRequestTicket}>
              打开 dbx
            </Button>
          )
        }
      />
    );
  }

  const expiryMs = Date.parse(ticket.expiresAt);
  const expired = Number.isFinite(expiryMs) && expiryMs <= nowMs;
  const stateMeta = STATE_META[handshake];
  const profileLabel = props.profileName ?? ticket.kind;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-app-border bg-app-elevated/60 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge tone={stateMeta.tone} dot>
            {stateMeta.label}
          </Badge>
          {expired ? <Badge tone="danger">票据已过期</Badge> : null}
          <span className="text-[11px] text-app-muted">
            {profileLabel} · 票据到期 <RelativeTime value={ticket.expiresAt} />
          </span>
          <span
            className="hidden max-w-[22rem] truncate font-mono text-[10px] text-app-muted xl:inline"
            title={endpoint}
          >
            {endpoint}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <CopyButton
            value={endpoint}
            title="复制兑换端点（不含票据）"
            size="xs"
            variant="ghost"
          />
          <Button
            size="xs"
            variant="ghost"
            icon={<Send className="h-3 w-3" />}
            title="通过 postMessage 手动发送票据（用于不读取 URL fragment 的 dbx）"
            disabled={expired || handshake === 'redeemed'}
            onClick={sendTicket}
          >
            发送票据
          </Button>
          {props.onRequestTicket === undefined ? null : (
            <Button size="xs" variant="ghost" onClick={props.onRequestTicket}>
              重新生成
            </Button>
          )}
          {props.onClose === undefined ? null : (
            <Button
              size="xs"
              variant="ghost"
              icon={<X className="h-3 w-3" />}
              onClick={props.onClose}
            >
              关闭
            </Button>
          )}
        </div>
      </div>

      {note === null ? null : (
        <Alert tone={handshake === 'error' ? 'danger' : handshake === 'redeemed' ? 'success' : 'info'}>
          {note}
        </Alert>
      )}

      {expired && handshake !== 'redeemed' ? (
        <Alert
          tone="warning"
          title="一次性票据已过期"
          hint="过期票据兑换会返回 404；请使用上方“重新生成票据”获取新票据。"
        >
          dbx 尚未确认兑换。票据只在生成后的短时间内有效，且只能使用一次。
        </Alert>
      ) : null}

      {/* dbx 需要保留自身 origin 才能携带 CORS Origin 兑换票据；iframe 与父页面仍是不同 origin。 */}
      <iframe
        ref={frameRef}
        title={`dbx 数据库控制台（${profileLabel}）`}
        src={frameUrl}
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        allow="clipboard-read; clipboard-write"
        referrerPolicy="no-referrer"
        onLoad={sendHello}
        className="h-[70vh] min-h-[26rem] w-full rounded-xl border border-app-border bg-app-surface"
      />

      <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-app-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        票据只放在 iframe URL fragment 与 postMessage 中，不进入服务器访问日志；密码永不出现在 URL。
        所有 postMessage 均按 dbx origin 双向校验。
      </p>
    </div>
  );
}
