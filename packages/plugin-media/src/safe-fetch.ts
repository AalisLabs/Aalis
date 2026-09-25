// ============================================================
// safe-fetch.ts — 带 SSRF 防护、体积上限、超时的下载工具
//
// 设计目标：任何由 LLM / 用户输入触发的远程下载都必须走这里，
// 杜绝把 169.254.169.254 / 127.0.0.1 / 10.0.0.0/8 等内网地址打成
// vision 输入。SSRF 检查走 @aalis/util-network-guard，与
// plugin-webui-server 的 image proxy 共用同一套规则。
// ============================================================

import { Buffer } from 'node:buffer';
import { extname } from 'node:path';
import { safeFetch } from '@aalis/util-network-guard';
import { getMediaRuntime } from './runtime.js';

/** 单次下载上限，避免 LLM 触发把巨型文件灌进显存。 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 上游连接 + 完整下载总超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface SafeFetchOptions {
  /** 仅接受 image/* Content-Type；默认 false */
  imageOnly?: boolean;
}

interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
}

/**
 * 带 SSRF 防护、体积上限和超时的 HTTP(S) 下载。
 * 仅支持 http/https；其他 scheme 抛错。
 */
async function safeFetchBuffer(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  try {
    // safeFetch 内含协议/host/逐跳重定向校验（SSRF），杜绝 30x 跳内网。
    const res = await safeFetch(url, {
      signal: ac.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Aalis safe-fetch)',
        accept: opts.imageOnly ? 'image/*,*/*;q=0.8' : '*/*',
      },
    });
    if (!res.ok) {
      throw new Error(`上游返回 ${res.status}`);
    }
    const ctype = res.headers.get('content-type') ?? 'application/octet-stream';
    if (opts.imageOnly && !ctype.startsWith('image/')) {
      throw new Error(`非图片 Content-Type: ${ctype}`);
    }
    const lenHeader = res.headers.get('content-length');
    if (lenHeader) {
      const len = Number(lenHeader);
      if (Number.isFinite(len) && len > DEFAULT_MAX_BYTES) {
        throw new Error(`资源过大 (${len} > ${DEFAULT_MAX_BYTES})`);
      }
    }
    if (!res.body) throw new Error('上游无响应体');

    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > DEFAULT_MAX_BYTES) {
          ac.abort();
          throw new Error(`资源过大 (流式累计 > ${DEFAULT_MAX_BYTES})`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { buffer: Buffer.concat(chunks), contentType: ctype };
  } finally {
    clearTimeout(timer);
  }
}

/** 从 MIME 猜文件扩展名。 */
function guessExtFromMime(mime: string | null): string | undefined {
  if (!mime) return undefined;
  const m = mime.split(';')[0].trim();
  if (m === 'image/jpeg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/gif') return '.gif';
  if (m === 'image/webp') return '.webp';
  if (m === 'video/mp4') return '.mp4';
  if (m === 'video/webm') return '.webm';
  return undefined;
}

/**
 * 下载远程 URL 到临时文件：带 SSRF 防护、20 MiB cap、15s 超时。
 * 返回本地路径、storage URI 与清理函数；失败返回 null，调用方按 null 降级。
 */
export async function safeDownloadToTemp(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<{ path: string; uri: string; cleanup: () => Promise<void> } | null> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  const { proc, storage } = getMediaRuntime();
  const tmp = await proc.makeTempDir('media-dl');
  try {
    const { buffer, contentType } = await safeFetchBuffer(url, opts);
    const clean = url.split('?')[0].split('#')[0];
    const ext = extname(clean).toLowerCase() || guessExtFromMime(contentType) || '.bin';
    const fileName = `download${ext}`;
    const uri = `${tmp.uri}/${fileName}`;
    await storage.writeFile(uri, buffer);
    // uri 必须一并返回：下游（materializeAttachment → audioToBase64）按 uri 判「是否落入
    // storage 根」，丢掉它会让所有 http 音频附件必抛。
    return { path: `${tmp.path}/${fileName}`, uri, cleanup: tmp.cleanup };
  } catch {
    await tmp.cleanup();
    return null;
  }
}
