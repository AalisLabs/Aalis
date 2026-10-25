import { resolveAgainstCwd, type StorageService } from '@aalis/api-storage';
import { detectMediaFormat, FILE_HEAD_BYTES, type MediaFormat } from '@aalis/util-file-signature';
import { safeFetch } from '@aalis/util-network-guard';

/** 远程图片下载与 plugin-media、ASR 同口径：20 MiB 上限，连接加读完响应体共 15 秒。 */
const DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * 从 URL 或存储地址加载图片，格式按文件头认（不看扩展名与 Content-Type），内容不是图片的抛错。
 * - http/https URL：safeFetch 下载，带超时，按流式累计限额读取响应体
 * - 其它：与文件工具同一判定求值（resolveAgainstCwd：存储地址原样，相对路径落在 baseUri 下，宿主机绝对路径拒绝），
 *   经 storage.readFile 读
 */
export async function loadImage(
  storage: StorageService,
  source: string,
  baseUri: string,
): Promise<{ buffer: Buffer; format: MediaFormat }> {
  const buffer =
    source.startsWith('http://') || source.startsWith('https://')
      ? await downloadImage(source)
      : Buffer.from((await storage.readFile(resolveAgainstCwd(source, baseUri))) as Uint8Array);
  const format = detectMediaFormat(buffer.subarray(0, FILE_HEAD_BYTES));
  if (format?.kind !== 'image') throw new Error(`不是图片: ${source}`);
  return { buffer, format };
}

/**
 * safeFetch 只管 SSRF 与重定向，不带超时也不限体积：源地址来自模型或用户，慢速对端会挂住整轮工具调用，超大响应整块读进
 * 内存。体积按流式累计判定——无 Content-Length 的响应要全部读完才看得到大小。
 */
async function downloadImage(source: string): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

export function joinUri(base: string, rel: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}${rel.replace(/^\/+/, '')}`;
}
