import { PanelError, TUNNEL_MAX_FRAME_BYTES, type TunnelFrame } from '@mpanel/shared';

/**
 * NDJSON 分帧读取器：按 `\n` 切分，跨 chunk 缓冲半行，忽略空行。
 * 单行超过 16 MiB 时抛 BAD_REQUEST，由通道关闭隧道（防止内存炸弹）。
 */
export class NdjsonReader {
  private buffer = '';

  constructor(private readonly maxLineBytes: number = TUNNEL_MAX_FRAME_BYTES) {}

  push(chunk: Buffer): string[] {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > this.maxLineBytes && !this.buffer.includes('\n')) {
      throw new PanelError('BAD_REQUEST', '隧道帧超过上限', {
        maxBytes: this.maxLineBytes,
        pendingBytes: this.buffer.length,
      });
    }
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    const output: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (Buffer.byteLength(trimmed, 'utf8') > this.maxLineBytes) {
        throw new PanelError('BAD_REQUEST', '隧道帧超过上限', { maxBytes: this.maxLineBytes });
      }
      output.push(trimmed);
    }
    return output;
  }

  end(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest.length === 0) return [];
    if (Buffer.byteLength(rest, 'utf8') > this.maxLineBytes) {
      throw new PanelError('BAD_REQUEST', '隧道帧超过上限', { maxBytes: this.maxLineBytes });
    }
    return [rest];
  }
}

export function encodeNdjson(frame: TunnelFrame): string {
  return `${JSON.stringify(frame)}\n`;
}
