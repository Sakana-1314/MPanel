import type { ErrorCode } from './types';

/** 契约错误码 + 前端本地产生的传输层错误。 */
export type AppErrorCode = ErrorCode | 'NETWORK' | 'TIMEOUT' | 'ABORTED';

export interface AppErrorIssue {
  path?: string;
  code?: string;
  message?: string;
}

/** `details` 的已知字段（契约允许其它键，统一用 unknown 兜底）。 */
export interface AppErrorDetails {
  hint?: string;
  capability?: string;
  reason?: string;
  machineId?: string;
  machineStatus?: string;
  retryAfterSec?: number;
  retryAfterMs?: number;
  stage?: string;
  output?: string;
  issues?: AppErrorIssue[];
  [key: string]: unknown;
}

const CODE_LABEL: Record<AppErrorCode, string> = {
  BAD_REQUEST: '请求不合法',
  UNAUTHORIZED: '未认证',
  FORBIDDEN: '无权限',
  NOT_FOUND: '资源不存在',
  CONFLICT: '状态冲突',
  UNAVAILABLE: '能力不可用',
  UPSTREAM_ERROR: '上游执行失败',
  INTERNAL: '服务器内部错误',
  NETWORK: '网络错误',
  TIMEOUT: '请求超时',
  ABORTED: '请求已取消',
};

const DEFAULT_HINT: Record<AppErrorCode, string> = {
  BAD_REQUEST: '请检查表单内容与参数格式后重试。',
  UNAUTHORIZED: '登录凭据无效或已过期，请重新登录或重新填写 token。',
  FORBIDDEN: '当前账号没有执行该操作的权限，请联系管理员。',
  NOT_FOUND: '资源不存在或已被删除，请刷新列表。',
  CONFLICT: '后端状态已变化，请刷新后重试；若有并发操作请稍候。',
  UNAVAILABLE: '该能力当前不可用：请确认服务器上对应的工具/服务已安装并可用，然后重试。',
  UPSTREAM_ERROR: '上游服务执行失败，请查看服务器日志后重试。',
  INTERNAL: '服务器内部错误，请稍后重试并查看服务端日志。',
  NETWORK: '无法连接后端，请确认地址、网络与跨域（CORS）配置。',
  TIMEOUT: '请求超时，请确认后端状态后重试。',
  ABORTED: '请求已被取消。',
};

/**
 * 统一的 API 错误：错误码 + 人类可读消息 + 可执行 hint。
 * hint 优先取 details.hint（UNAVAILABLE 契约要求必填），否则按错误码给默认提示。
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: AppErrorCode, message: string, status = 0, details?: unknown) {
    super(message.length > 0 ? message : CODE_LABEL[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  get label(): string {
    return CODE_LABEL[this.code];
  }

  get detail(): AppErrorDetails | null {
    if (typeof this.details === 'object' && this.details !== null) {
      return this.details as AppErrorDetails;
    }
    return null;
  }

  get hint(): string {
    const detail = this.detail;
    if (detail !== null && typeof detail.hint === 'string' && detail.hint.length > 0) {
      return detail.hint;
    }
    return DEFAULT_HINT[this.code];
  }

  get reason(): string | undefined {
    const value = this.detail?.reason;
    return typeof value === 'string' ? value : undefined;
  }

  get retryAfterSec(): number | undefined {
    const value = this.detail?.retryAfterSec;
    return typeof value === 'number' ? value : undefined;
  }

  get retryAfterMs(): number | undefined {
    const value = this.detail?.retryAfterMs;
    return typeof value === 'number' ? value : undefined;
  }

  get isUnavailable(): boolean {
    return this.code === 'UNAVAILABLE';
  }

  get isAuthError(): boolean {
    return this.code === 'UNAUTHORIZED' || this.code === 'FORBIDDEN';
  }

  /** UI 单行文案：消息 + hint（hint 与消息相同则去重）。 */
  toUserMessage(): string {
    const hint = this.hint;
    return hint === this.message ? hint : `${this.message} ${hint}`;
  }
}

/** 文件布局约定名（api/client.ts 必须导出 ApiError）。 */
export { AppError as ApiError };

export function errorFromStatus(
  status: number,
  message?: string,
  details?: AppErrorDetails,
): AppError {
  const code: AppErrorCode =
    status === 400
      ? 'BAD_REQUEST'
      : status === 401
        ? 'UNAUTHORIZED'
        : status === 403
          ? 'FORBIDDEN'
          : status === 404
            ? 'NOT_FOUND'
            : status === 409
              ? 'CONFLICT'
              : status === 502
                ? 'UPSTREAM_ERROR'
                : status === 503
                  ? 'UNAVAILABLE'
                  : status === 504
                    ? 'TIMEOUT'
                    : status >= 500
                      ? 'INTERNAL'
                      : 'BAD_REQUEST';
  return new AppError(
    code,
    message !== undefined && message.trim().length > 0 ? message : `${CODE_LABEL[code]}（HTTP ${status}）`,
    status,
    details,
  );
}

export interface ErrorDescription {
  title: string;
  description: string;
  hint: string;
  code: string;
  status: number;
}

/** 供 Alert / Toast / ErrorState 复用的错误描述。 */
export function describeError(error: unknown, fallbackTitle = '操作失败'): ErrorDescription {
  if (error instanceof AppError) {
    return {
      title: `${error.label}（${error.code}）`,
      description: error.message,
      hint: error.hint,
      code: error.code,
      status: error.status,
    };
  }
  if (error instanceof Error) {
    return {
      title: fallbackTitle,
      description: error.message,
      hint: '请重试；若持续失败请查看浏览器控制台与服务端日志。',
      code: 'UNKNOWN',
      status: 0,
    };
  }
  return {
    title: fallbackTitle,
    description: typeof error === 'string' ? error : '未知错误',
    hint: '请重试；若持续失败请查看浏览器控制台与服务端日志。',
    code: 'UNKNOWN',
    status: 0,
  };
}

export function isAppError(error: unknown, code?: AppErrorCode): error is AppError {
  return error instanceof AppError && (code === undefined || error.code === code);
}
