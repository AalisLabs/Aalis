// ============================================================
// safe-fetch.ts — 带 SSRF 防护、体积上限、超时的下载工具
//
// 设计目标：任何由 LLM / 用户输入触发的远程下载都必须走这里，
// 杜绝把 169.254.169.254 / 127.0.0.1 / 10.0.0.0/8 等内网地址打成
// vision 输入。SSRF 检查走 @aalis/util-network-guard，与
// plugin-webui-server 的 image proxy 共用同一套规则。
// ============================================================

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { assertSafeHost } from '@aalis/util-network-guard';

/** 单次下载上限，避免 LLM 触发把巨型文件灌进显存。 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 上游连接 + 完整下载总超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface SafeFetchOptions {
  /** 单次下载字节上限，默认 20 MiB */
  maxBytes?: number;
  /** 总超时（毫秒），默认 15s */
  timeoutMs?: number;
  /** 自定义 User-Agent */
  userAgent?: string;
  /** 仅接受 image/* Content-Type；默认 false */
  imageOnly?: boolean;
}

interface SafeFetchResult {
  buffer: Buffer;
  contentType: string;
  /** 经过重定向后的最终 URL */
  finalUrl: string;
}

/**
 * 带 SSRF 防护、体积上限和超时的 HTTP(S) 下载。
 * 仅支持 http/https；其他 scheme 抛错。
 */
async function safeFetchBuffer(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ua = opts.userAgent ?? 'Mozilla/5.0 (Aalis safe-fetch)';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`非法 URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，收到 ${parsed.protocol}`);
  }
  await assertSafeHost(parsed.hostname);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(parsed.toString(), {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'user-agent': ua,
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
      if (Number.isFinite(len) && len > maxBytes) {
        throw new Error(`资源过大 (${len} > ${maxBytes})`);
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
        if (received > maxBytes) {
          ac.abort();
          throw new Error(`资源过大 (流式累计 > ${maxBytes})`);
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { buffer: Buffer.concat(chunks), contentType: ctype, finalUrl: res.url || parsed.toString() };
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
 * 安全版本的 downloadToTemp：带 SSRF 防护、20 MiB cap、15s 超时。
 * 失败返回 null（与旧 downloadToTemp 行为一致，调用方按 null 降级）。
 */
export async function safeDownloadToTemp(
  url: string,
  opts: SafeFetchOptions = {},
): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
  if (!url.startsWith('http://') && !url.startsWith('https://')) return null;
  const tmpDir = await mkdtemp(join(tmpdir(), 'aalis-media-dl-'));
  const cleanup = async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    const { buffer, contentType } = await safeFetchBuffer(url, opts);
    const clean = url.split('?')[0].split('#')[0];
    const ext = extname(clean).toLowerCase() || guessExtFromMime(contentType) || '.bin';
    const filePath = join(tmpDir, `download${ext}`);
    await writeFile(filePath, buffer);
    return { path: filePath, cleanup };
  } catch {
    await cleanup();
    return null;
  }
}
