import type { ApiClient } from '../api/client';

/** 用 Blob 触发浏览器下载（cookie / Bearer 已由 API 客户端携带）。 */
export function saveBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

/** 从机器代理路径下载裸流（文件、备份）。 */
export async function downloadFrom(
  client: ApiClient,
  path: string,
  filename?: string,
): Promise<void> {
  const response = await client.raw(path);
  const blob = await response.blob();
  saveBlob(blob, filename ?? path.split('?')[0]?.split('/').pop() ?? 'download');
}

/** 前端生成文本文件（导出站点包等）。 */
export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  saveBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}
