import { ERROR_HTTP_STATUS, type ErrorCode, type PanelError } from './errors.js';

/**
 * Transport-neutral WebSocket bridge used by worker modules. The HTTP
 * transport adapts @fastify/websocket sockets to this interface; stdio and
 * reverse-ws transports adapt tunnel ws-open/ws-frame/ws-close frames to the
 * same interface. Modules therefore never know which transport is active.
 */

export interface WsOpenRequest {
  /** Pathname only, always starts with "/ws/" (no query string). */
  path: string;
  /** Raw query string with leading "?" or empty; preserves duplicates/encoding. */
  rawQuery: string;
  /** Parsed convenience copy; last-value-wins, never use for ticket binding. */
  query: Record<string, string>;
  /** Path parameters extracted from the registered pattern. */
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  protocols: string[];
}

export interface WsSink {
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Best-effort transport backpressure indicator. */
  readonly bufferedBytes?: number;
  /** Resolves when the transport can accept more data; optional for simple adapters. */
  waitForDrain?(): Promise<void>;
}

export interface WsConnection {
  receive(data: string | Uint8Array, binary: boolean): void;
  close(code?: number, reason?: string): void;
}

export type WsHandler = (request: WsOpenRequest, sink: WsSink) => Promise<WsConnection>;

export interface WsBridge {
  register(pattern: string, handler: WsHandler): void;
  /**
   * Opens a registered route. Throws PanelError to reject:
   * NOT_FOUND -> direct 4404 / tunnel accepted:false 404
   * UNAVAILABLE -> direct 4502 / tunnel accepted:false 503
   * UNAUTHORIZED/FORBIDDEN -> 4401/4403
   * INTERNAL -> 1011 / accepted:false 500
   */
  open(request: WsOpenRequest, sink: WsSink): Promise<WsConnection>;
  hasRoute(path: string): boolean;
  listRoutes(): string[];
}

/** Close code used by browser/HTTP WS adapters for a PanelError. */
export function wsCloseCodeForError(error: unknown): number {
  if (isErrorCode(error, 'UNAUTHORIZED')) return 4401;
  if (isErrorCode(error, 'FORBIDDEN')) return 4403;
  if (isErrorCode(error, 'NOT_FOUND')) return 4404;
  if (isErrorCode(error, 'UNAVAILABLE')) return 4502;
  return 1011;
}

/** HTTP status used for tunnel ws-open rejection for a PanelError. */
export function wsHttpStatusForError(error: unknown): number {
  if (isErrorCode(error, 'UNAUTHORIZED')) return ERROR_HTTP_STATUS.UNAUTHORIZED;
  if (isErrorCode(error, 'FORBIDDEN')) return ERROR_HTTP_STATUS.FORBIDDEN;
  if (isErrorCode(error, 'NOT_FOUND')) return ERROR_HTTP_STATUS.NOT_FOUND;
  if (isErrorCode(error, 'UNAVAILABLE')) return ERROR_HTTP_STATUS.UNAVAILABLE;
  return ERROR_HTTP_STATUS.INTERNAL;
}

function isErrorCode(error: unknown, code: ErrorCode): error is PanelError {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * Match a registered pattern against a concrete path. Patterns support
 * `:param` segments only (e.g. "/ws/terminal/:sessionId"). Returns null when
 * the path does not match. Pure function; no I/O.
 */
export function matchWsPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter((part) => part.length > 0);
  const pathParts = pathname.split('/').filter((part) => part.length > 0);
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected === undefined || actual === undefined) {
      return null;
    }
    if (expected.startsWith(':')) {
      if (actual.length === 0) {
        return null;
      }
      try {
        params[expected.slice(1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
      continue;
    }
    if (expected !== actual) {
      return null;
    }
  }
  return params;
}
