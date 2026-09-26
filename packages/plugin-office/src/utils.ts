import type { StorageService } from '@aalis/api-storage';
import { safeFetch } from '@aalis/util-network-guard';

/** 远程图片下载与 plugin-media、ASR 同口径：20 MiB 上限，连接加读完响应体共 15 秒。 */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * 从 URL 或 storage URI 加载图片为 Buffer。
 * - http/https URL：safeFetch 下载，带超时，按流式累计限额读取响应体
 * - storage URI（含 `:/`）：通过 storage.readFile
 * - 其它（裸路径/相对路径）：按 baseUri 拼接（不带尾部斜杠时自动补）
 */
export async function loadImage(
  storage: StorageService,
  source: string,
  baseUri: string,
): Promise<{ buffer: Buffer; mime: string }> {
  if (source.startsWith('http://') || source.startsWith('https://')) {
    // safeFetch 只管 SSRF 与重定向，不带超时也不限体积：源地址来自模型或用户，
    // 慢速对端会挂住整轮工具调用，超大响应整块读进内存。体积按流式累计判定——
    // 无 Content-Length 的响应要全部读完才看得到大小。
    const resp = await safeFetch(source, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!resp.ok) {
      // 响应体不读也要取消，释放底层连接
      await resp.body?.cancel().catch(() => {});
      throw new Error(`图片下载失败: ${resp.status} ${source}`);
    }
    const declared = Number(resp.headers.get('content-length'));
    if (declared > DOWNLOAD_MAX_BYTES) {
      await resp.body?.cancel().catch(() => {});
      throw new Error(`图片过大 (${declared} > ${DOWNLOAD_MAX_BYTES}): ${source}`);
    }
    if (!resp.body) throw new Error(`图片下载失败：上游无响应体 ${source}`);
    const reader = resp.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > DOWNLOAD_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`图片过大 (流式累计 > ${DOWNLOAD_MAX_BYTES}): ${source}`);
      }
      chunks.push(Buffer.from(value));
    }
    const mime = resp.headers.get('content-type') || guessMime(source);
    return { buffer: Buffer.concat(chunks), mime };
  }

  const uri = source.includes(':/') ? source : joinUri(baseUri, source);
  const data = (await storage.readFile(uri)) as Uint8Array;
  return { buffer: Buffer.from(data), mime: guessMime(uri) };
}

export function joinUri(base: string, rel: string): string {
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
