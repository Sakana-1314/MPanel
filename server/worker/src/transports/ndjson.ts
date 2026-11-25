import { PanelError, TUNNEL_MAX_FRAME_BYTES } from '@mpanel/shared';
import type { TunnelFrame } from '@mpanel/shared';

export class NdjsonFrameTooLargeError extends Error {
  readonly code = 'NDJSON_FRAME_TOO_LARGE';

  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`NDJSON 帧超过上限：${bytes} > ${maxBytes} 字节`);
    this.name = 'NdjsonFrameTooLargeError';
  }
}

/**
 * stdio 隧道的增量 NDJSON 切分器：按 `\n` 切分，跨 chunk 的半行缓冲；
 * 忽略空行与 `\r`。单行超过上限时抛 NdjsonFrameTooLargeError（传输层关闭隧道）。
 */
export class NdjsonReader {
  private buffer = '';
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = TUNNEL_MAX_FRAME_BYTES) {
    this.maxFrameBytes = Math.max(1024, maxFrameBytes);
  }

  push(chunk: Buffer): string[] {
    this.buffer += chunk.toString('utf8');
    const rawLines = this.buffer.split('\n');
    const remainder = rawLines.pop() ?? '';
    const remainderBytes = Buffer.byteLength(remainder, 'utf8');
    if (remainderBytes > this.maxFrameBytes) {
      this.buffer = '';
      throw new NdjsonFrameTooLargeError(remainderBytes, this.maxFrameBytes);
    }
    this.buffer = remainder;
    const lines: string[] = [];
    for (const raw of rawLines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.trim().length === 0) continue;
      const bytes = Buffer.byteLength(line, 'utf8');
      if (bytes > this.maxFrameBytes) {
        throw new NdjsonFrameTooLargeError(bytes, this.maxFrameBytes);
      }
      lines.push(line);
    }
    return lines;
  }

  end(): string[] {
    const rest = this.buffer.replace(/\r$/, '').trim();
    this.buffer = '';
    if (rest.length === 0) return [];
    if (Buffer.byteLength(rest, 'utf8') > this.maxFrameBytes) {
      throw new NdjsonFrameTooLargeError(Buffer.byteLength(rest, 'utf8'), this.maxFrameBytes);
    }
    return [rest];
  }
}

export function encodeNdjson(frame: TunnelFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function writeNdjson(
  stream: NodeJS.WritableStream,
  frame: TunnelFrame,
): Promise<void> {
  const encoded = encodeNdjson(frame);
  if (Buffer.byteLength(encoded, 'utf8') > TUNNEL_MAX_FRAME_BYTES) {
    return Promise.reject(
      new PanelError('BAD_REQUEST', '待发送的隧道帧超过 16 MiB 上限', {
        frameKind: frame.kind,
      }),
    );
  }
  return new Promise((resolve, reject) => {
    stream.write(encoded, (error?: Error | null) => {
      if (error === null || error === undefined) resolve();
      else reject(error);
    });
  });
}
