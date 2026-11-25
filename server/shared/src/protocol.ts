import { z } from 'zod';
import { PanelError, errorCodeSchema } from './errors.js';

/**
 * Version of the core<->worker tunnel frame protocol. Additive changes keep
 * this value; breaking changes bump it and require a core/worker major upgrade.
 */
export const TUNNEL_PROTOCOL_VERSION = 1 as const;

/** WebSocket subprotocol negotiated on the reverse-ws registration socket. */
export const TUNNEL_SUBPROTOCOL = 'mpanel.tunnel.v1' as const;

/** Hard frame limits. Transports must reject an encoded frame larger than this. */
export const TUNNEL_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const TUNNEL_CHUNK_BYTES = 512 * 1024;
export const TUNNEL_HEARTBEAT_INTERVAL_MS = 10_000;
export const TUNNEL_HEARTBEAT_TIMEOUT_MS = 30_000;
export const TUNNEL_REQUEST_TIMEOUT_MS = 120_000;
export const TUNNEL_MAX_INFLIGHT_REQUESTS = 128;
export const TUNNEL_MAX_WS_STREAMS = 64;
export const WS_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

export const WS_CLOSE_CODES = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  ABNORMAL: 1006,
  BACKPRESSURE: 1013,
  INTERNAL: 1011,
  REPLACED: 4001,
  VERSION_MISMATCH: 4002,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  NOT_FOUND: 4404,
  UPSTREAM_UNAVAILABLE: 4502,
} as const;

export type WsCloseCode = (typeof WS_CLOSE_CODES)[keyof typeof WS_CLOSE_CODES];

export const TUNNEL_FRAME_KINDS = [
  'hello',
  'ping',
  'pong',
  'http-request',
  'http-response',
  'ws-open',
  'ws-frame',
  'ws-close',
] as const;

export type TunnelFrameKind = (typeof TUNNEL_FRAME_KINDS)[number];

export const tunnelHeaderValueSchema = z.union([
  z.string().refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Header value contains control characters'),
  z.array(z.string().refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Header value contains control characters')),
]);
export const tunnelHeadersSchema = z.record(z.string(), tunnelHeaderValueSchema);

export type TunnelHeaders = z.infer<typeof tunnelHeadersSchema>;

export const workerDescriptorSchema = z.object({
  name: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  apiVersion: z.number().int().positive(),
  protocolVersion: z.number().int().positive(),
  nodeVersion: z.string().min(1).max(32),
  platform: z.string().min(1).max(32),
  arch: z.string().min(1).max(32),
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

const protocolLimitsSchema = z.object({
  maxFrameBytes: z.number().int().positive(),
  chunkBytes: z.number().int().positive(),
  maxInflightRequests: z.number().int().positive().optional(),
  maxWsStreams: z.number().int().positive().optional(),
});

/**
 * hello is bidirectional. The worker sends it first on stdio/reverse-ws; the
 * core replies with the same kind and accepted=true/false. On stdio the
 * worker's hello carries the static token for the core to validate.
 */
export const helloFrameSchema = z.object({
  kind: z.literal('hello'),
  v: z.number().int().positive(),
  role: z.enum(['core', 'worker']),
  machineId: z.string().min(1).max(128).optional(),
  accepted: z.boolean().optional(),
  reason: z.string().max(2048).optional(),
  token: z.string().min(1).max(512).optional(),
  worker: workerDescriptorSchema.optional(),
  core: z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
      apiVersion: z.number().int().positive(),
      protocolVersion: z.number().int().positive(),
    })
    .optional(),
  protocol: protocolLimitsSchema.optional(),
  sentAt: z.string().datetime().optional(),
});

export const pingFrameSchema = z.object({
  kind: z.literal('ping'),
  id: z.string().min(1).max(128),
  ts: z.number().int().nonnegative(),
});

export const pongFrameSchema = z.object({
  kind: z.literal('pong'),
  id: z.string().min(1).max(128),
  ts: z.number().int().nonnegative(),
});

export const httpRequestHeadFrameSchema = z.object({
  kind: z.literal('http-request'),
  phase: z.literal('head').optional(),
  id: z.string().min(1).max(128),
  method: z.string().min(1).max(16),
  url: z
    .string()
    .min(1)
    .max(8192)
    .refine(
      (value) =>
        value.startsWith('/') &&
        !value.startsWith('//') &&
        !value.includes('\\') &&
        !/[\u0000-\u001f\u007f]/.test(value),
      'url must be origin-form (/path?query) without backslashes or control characters',
    ),
  headers: tunnelHeadersSchema.default({}),
  bodyBase64: z.string().optional(),
  stream: z.boolean().optional(),
  remoteAddress: z.string().max(128).optional(),
});

export const httpRequestChunkFrameSchema = z.object({
  kind: z.literal('http-request'),
  phase: z.literal('chunk'),
  id: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  chunkBase64: z.string(),
  final: z.boolean().optional(),
});

export const httpRequestCancelFrameSchema = z.object({
  kind: z.literal('http-request'),
  phase: z.literal('cancel'),
  id: z.string().min(1).max(128),
  reason: z.string().max(512).optional(),
});

export const httpResponseHeadFrameSchema = z.object({
  kind: z.literal('http-response'),
  phase: z.literal('head').optional(),
  id: z.string().min(1).max(128),
  status: z.number().int().min(100).max(599),
  headers: tunnelHeadersSchema.default({}),
  bodyBase64: z.string().optional(),
  stream: z.boolean().optional(),
  error: z
    .object({
      code: errorCodeSchema,
      message: z.string().min(1),
      details: z.unknown().optional(),
    })
    .optional(),
});

export const httpResponseChunkFrameSchema = z.object({
  kind: z.literal('http-response'),
  phase: z.literal('chunk'),
  id: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  chunkBase64: z.string(),
  final: z.boolean().optional(),
});

/**
 * ws-open is sent by the core and echoed by the worker. The request carries
 * path/headers; the reply carries accepted and must echo the same id.
 */
export const wsOpenRequestFrameSchema = z.object({
  kind: z.literal('ws-open'),
  id: z.string().min(1).max(128),
  path: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^\/ws\//, 'ws-open path must start with /ws/')
    .refine(
      (value) => !value.includes('\\') && !/[\u0000-\u001f\u007f]/.test(value),
      'ws-open path contains forbidden characters',
    ),
  headers: tunnelHeadersSchema.default({}),
  protocols: z.array(z.string().min(1).max(128)).max(16).optional(),
});

export const wsOpenReplyFrameSchema = z.object({
  kind: z.literal('ws-open'),
  id: z.string().min(1).max(128),
  accepted: z.boolean(),
  status: z.number().int().min(100).max(599).optional(),
  reason: z.string().max(2048).optional(),
});

export const wsOpenFrameSchema = z.union([
  wsOpenRequestFrameSchema,
  wsOpenReplyFrameSchema,
]);

export const wsFrameSchema = z
  .object({
    kind: z.literal('ws-frame'),
    id: z.string().min(1).max(128),
    data: z.string(),
    dataEncoding: z.enum(['utf8', 'base64']),
    seq: z.number().int().nonnegative().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.dataEncoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: 'data is not valid standard base64' });
      return;
    }
    const bytes =
      value.dataEncoding === 'base64'
        ? base64DecodedByteLength(value.data)
        : utf8ByteLength(value.data);
    if (bytes > WS_MAX_MESSAGE_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['data'],
        message: `WebSocket payload exceeds ${WS_MAX_MESSAGE_BYTES} bytes`,
      });
    }
  });

export const wsCloseFrameSchema = z.object({
  kind: z.literal('ws-close'),
  id: z.string().min(1).max(128),
  code: z.number().int().min(1000).max(4999).optional(),
  reason: z.string().max(123).optional(),
  initiator: z.enum(['core', 'worker']).optional(),
});

export const tunnelFrameSchema = z.union([
  helloFrameSchema,
  pingFrameSchema,
  pongFrameSchema,
  httpRequestHeadFrameSchema,
  httpRequestChunkFrameSchema,
  httpRequestCancelFrameSchema,
  httpResponseHeadFrameSchema,
  httpResponseChunkFrameSchema,
  wsOpenFrameSchema,
  wsFrameSchema,
  wsCloseFrameSchema,
]);

export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type PingFrame = z.infer<typeof pingFrameSchema>;
export type PongFrame = z.infer<typeof pongFrameSchema>;
export type HttpRequestHeadFrame = z.infer<typeof httpRequestHeadFrameSchema>;
export type HttpRequestChunkFrame = z.infer<typeof httpRequestChunkFrameSchema>;
export type HttpRequestCancelFrame = z.infer<typeof httpRequestCancelFrameSchema>;
export type HttpResponseHeadFrame = z.infer<typeof httpResponseHeadFrameSchema>;
export type HttpResponseChunkFrame = z.infer<typeof httpResponseChunkFrameSchema>;
export type HttpRequestFrame =
  | HttpRequestHeadFrame
  | HttpRequestChunkFrame
  | HttpRequestCancelFrame;
export type HttpResponseFrame = HttpResponseHeadFrame | HttpResponseChunkFrame;
export type WsOpenRequestFrame = z.infer<typeof wsOpenRequestFrameSchema>;
export type WsOpenReplyFrame = z.infer<typeof wsOpenReplyFrameSchema>;
export type WsOpenFrame = z.infer<typeof wsOpenFrameSchema>;
export type WsFrame = z.infer<typeof wsFrameSchema>;
export type WsCloseFrame = z.infer<typeof wsCloseFrameSchema>;
export type TunnelFrame = z.infer<typeof tunnelFrameSchema>;

export type WorkerDescriptor = z.infer<typeof workerDescriptorSchema>;
export type ProtocolLimits = z.infer<typeof protocolLimitsSchema>;

/** Serialize a frame for either NDJSON (stdio) or one WebSocket text message. */
export function encodeTunnelFrame(frame: TunnelFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse one frame. Callers are responsible for line splitting (stdio) or
 * receiving one complete text message (reverse-ws) and for enforcing
 * TUNNEL_MAX_FRAME_BYTES before calling this function.
 */
export function decodeTunnelFrame(text: string): TunnelFrame {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new PanelError('BAD_REQUEST', 'Tunnel frame is not valid JSON', undefined, { cause });
  }
  const result = tunnelFrameSchema.safeParse(value);
  if (!result.success) {
    throw new PanelError('BAD_REQUEST', 'Tunnel frame failed validation', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

export function isTunnelFrame(value: unknown): value is TunnelFrame {
  return tunnelFrameSchema.safeParse(value).success;
}

export function isHttpRequestHead(frame: TunnelFrame): frame is HttpRequestHeadFrame {
  return frame.kind === 'http-request' && frame.phase !== 'chunk' && frame.phase !== 'cancel';
}

export function isHttpResponseHead(frame: TunnelFrame): frame is HttpResponseHeadFrame {
  return frame.kind === 'http-response' && frame.phase !== 'chunk';
}

/** Base64 helpers live in transports (Node Buffer) so this package stays platform-neutral. */

/** UTF-8 byte length without Node/DOM globals. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** Decoded byte length of standard padded base64. */
export function base64DecodedByteLength(value: string): number {
  if (value.length === 0) return 0;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

export const BASE64_ENCODING = 'base64' as const;
