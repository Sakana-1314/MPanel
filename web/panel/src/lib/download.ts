import { apiRaw } from '../api/client';

/** 用 Blob 触发浏览器下载（cookie / Bearer 已由 apiRaw 携带）。 */
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

export async function downloadRaw(path: string, filename?: string): Promise<void> {
  const response = await apiRaw(path);
  const blob = await response.blob();
  saveBlob(blob, filename ?? path.split('/').pop() ?? 'download');
}

/** 前端生成文本文件（导出站点包等）。 */
export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  saveBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}
