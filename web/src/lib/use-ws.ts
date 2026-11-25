import { useEffect, useRef, useState } from 'react';
import type { WsSession, WsStatus } from '../api/ws';
import { connectWs } from '../api/ws';

export type TicketWsStatus = 'idle' | WsStatus;

export interface UseTicketWsOptions {
  enabled?: boolean;
  onMessage(data: string): void;
  onClose?(event: { code: number; reason: string }): void;
}

/** Takes a one-shot ticket, connects, and reconnects with backoff while enabled. */
export function useTicketWs(
  path: string | null,
  opts: UseTicketWsOptions,
): { status: TicketWsStatus; send(data: string): void; close(): void } {
  const [status, setStatus] = useState<TicketWsStatus>('idle');
  const sessionRef = useRef<WsSession | null>(null);
  const handlersRef = useRef(opts);
  handlersRef.current = opts;
  const enabled = opts.enabled !== false;

  useEffect(() => {
    if (path === null || !enabled) {
      setStatus('idle');
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    setStatus('connecting');

    const open = (): void => {
      connectWs(path, {
        onMessage: (data) => {
          attempt = 0;
          if (typeof data === 'string') handlersRef.current.onMessage(data);
        },
        onOpen: () => setStatus('open'),
        onClose: (event) => {
          if (cancelled) return;
          setStatus('closed');
          handlersRef.current.onClose?.(event);
          attempt += 1;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
          retryTimer = setTimeout(open, delay);
        },
        onError: () => undefined,
      })
        .then((session) => {
          if (cancelled) {
            session.close();
            return;
          }
          sessionRef.current = session;
          setStatus('open');
        })
        .catch(() => {
          if (cancelled) return;
          setStatus('closed');
          attempt += 1;
          retryTimer = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
        });
    };
    open();

    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, [path, enabled]);

  return {
    status,
    send: (data: string) => sessionRef.current?.sendText(data),
    close: () => sessionRef.current?.close(),
  };
}
