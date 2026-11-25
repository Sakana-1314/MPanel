import { z } from 'zod';

/**
 * The complete, closed set of API error codes. Do not add codes without a
 * major API version bump: clients switch on this union.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'UNAVAILABLE',
  'UPSTREAM_ERROR',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status paired with each error code. One code maps to exactly one status. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAVAILABLE: 503,
  UPSTREAM_ERROR: 502,
  INTERNAL: 500,
};

export const errorCodeSchema = z.enum(ERROR_CODES);

export const apiErrorBodySchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.code !== 'UNAVAILABLE') return;
    const details = value.details;
    if (
      typeof details !== 'object' ||
      details === null ||
      typeof (details as Record<string, unknown>).hint !== 'string' ||
      ((details as Record<string, unknown>).hint as string).length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['details', 'hint'],
        message: 'UNAVAILABLE requires details.hint',
      });
    }
  });

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

/** Every JSON API response uses this envelope. Raw download/health responses are documented exceptions. */
export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export function apiEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.union([
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: apiErrorBodySchema }),
  ]);
}

export function okEnvelope<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

const DEFAULT_UNAVAILABLE_HINT =
  'Check GET /api/v1/system/info capabilities and server logs, then retry.';

function withUnavailableHint(details: unknown): Record<string, unknown> {
  const base =
    typeof details === 'object' && details !== null && !Array.isArray(details)
      ? { ...(details as Record<string, unknown>) }
      : {};
  if (typeof base.hint !== 'string' || base.hint.length === 0) {
    base.hint = DEFAULT_UNAVAILABLE_HINT;
  }
  return base;
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  details?: unknown,
): ApiFailure {
  const finalDetails = code === 'UNAVAILABLE' ? withUnavailableHint(details) : details;
  return finalDetails === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details: finalDetails } };
}

/**
 * Internal transport-neutral error. The Fastify error handler converts this to
 * an ApiFailure envelope; transports never leak stack traces to clients.
 */
export class PanelError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PanelError';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.details = code === 'UNAVAILABLE' ? withUnavailableHint(details) : details;
  }
}

export function isPanelError(value: unknown): value is PanelError {
  return value instanceof PanelError;
}

/** Helper used by zod validation boundaries. */
export function badRequest(message: string, details?: unknown): PanelError {
  return new PanelError('BAD_REQUEST', message, details);
}

/** Helper for degraded capabilities. `details.hint` is mandatory by contract. */
export function unavailable(message: string, hint: string, extra?: Record<string, unknown>): PanelError {
  return new PanelError('UNAVAILABLE', message, { ...(extra ?? {}), hint });
}
