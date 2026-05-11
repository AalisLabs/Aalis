import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 从 URL 或本地路径加载图片为 Buffer。
 * 支持 http/https URL 和本地绝对/相对路径。
 */
export async function loadImage(source: string, basePath?: string): Promise<{ buffer: Buffer; mime: string }> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error(`图片下载失败: ${resp.status} ${source}`);
    const arrayBuf = await resp.arrayBuffer();
    const mime = resp.headers.get('content-type') || guessMime(source);
    return { buffer: Buffer.from(arrayBuf), mime };
  }

  // 本地路径
  const absPath = basePath ? resolve(basePath, source) : resolve(source);
  if (!existsSync(absPath)) throw new Error(`图片文件不存在: ${absPath}`);
  const buffer = readFileSync(absPath);
  return { buffer, mime: guessMime(absPath) };
}

function guessMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'image/png';
  }
}
