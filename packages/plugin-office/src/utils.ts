import type { StorageService } from '@aalis/plugin-storage-api';

/**
 * 从 URL 或 storage URI 加载图片为 Buffer。
 * - http/https URL：直接 fetch
 * - storage URI（含 `:/`）：通过 storage.readFile
 * - 其它（裸路径/相对路径）：若给了 baseUri，按 baseUri 拼接（不带尾部斜杠时自动补）
 */
export async function loadImage(
  storage: StorageService,
  source: string,
  baseUri?: string,
): Promise<{ buffer: Buffer; mime: string }> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const resp = await fetch(source);
    if (!resp.ok) throw new Error(`图片下载失败: ${resp.status} ${source}`);
    const arrayBuf = await resp.arrayBuffer();
    const mime = resp.headers.get('content-type') || guessMime(source);
    return { buffer: Buffer.from(arrayBuf), mime };
  }

  const uri = source.includes(':/') ? source : joinUri(baseUri ?? 'workspace:/', source);
  const data = (await storage.readFile(uri)) as Uint8Array;
  return { buffer: Buffer.from(data), mime: guessMime(uri) };
}

function joinUri(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${rel.replace(/^\/+/, '')}`;
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
