// ============================================================
// safe-fetch.ts — 带 SSRF 防护、体积上限、超时的下载工具
//
// 设计目标：任何由 LLM / 用户输入触发的远程下载都必须走这里，
// 杜绝把 169.254.169.254 / 127.0.0.1 / 10.0.0.0/8 等内网地址打成
// vision 输入。SSRF 检查走 @aalis/util-network-guard，与
// plugin-webui-server 的 image proxy 共用同一套规则。
// ============================================================

import { Buffer } from 'node:buffer';
import { safeFetch } from '@aalis/util-network-guard';

/** 单次下载上限，避免 LLM 触发把巨型文件灌进显存。 */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 上游连接 + 完整下载总超时。 */
const DEFAULT_TIMEOUT_MS = 15_000;

interface SafeFetchOptions {
  /** 调用方的中止信号：中止时下载随之停下，不等满总超时 */
  signal?: AbortSignal;
}

/**
 * 带 SSRF 防护、体积上限和超时的 HTTP(S) 下载。
 * 仅支持 http/https；其他 scheme 抛错。
 */
export async function safeFetchBuffer(url: string, opts: SafeFetchOptions = {}): Promise<Buffer> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DEFAULT_TIMEOUT_MS);
  try {
    // safeFetch 内含协议/host/逐跳重定向校验（SSRF），杜绝 30x 跳内网。
    const res = await safeFetch(url, {
      signal: opts.signal ? AbortSignal.any([ac.signal, opts.signal]) : ac.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Aalis safe-fetch)',
        accept: '*/*',
      },
    });
    if (!res.ok) {
      throw new Error(`上游返回 ${res.status}`);
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
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
