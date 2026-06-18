// ============================================================
// @aalis/util-network-guard — SSRF / 私网地址防护纯函数
//
// 任何由 LLM / 用户输入触发的远程 fetch 都应在执行前调用 assertSafeHost()。
// 该包不做下载、不做缓存，只提供同步/异步校验，方便不同子系统按各自架构
// （流式代理 / 全 buffer 下载 / 内联 fetch）复用。
// ============================================================

import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

/**
 * 判断 IP 是否落在私网 / 回环 / 链路本地 / 元数据 / 多播保留段。
 * 解析失败按危险（true）处理，调用方按 SSRF 拒绝。
 */
export function isPrivateAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 0) return true; // 解析失败按危险处理
  if (fam === 4) {
    const parts = addr.split('.').map(Number);
    if (parts.some(p => Number.isNaN(p))) return true;
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  // IPv6
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    // IPv4-mapped IPv6：剥壳后按 v4 再判一次
    return isPrivateAddress(lower.slice('::ffff:'.length));
  }
  return false;
}

/**
 * 校验 hostname 是否安全可下载。
 *  - 字面 IP：直接判私网。
 *  - 'localhost' / '*.localhost' / '*.local'：拒绝。
 *  - 其它域名：DNS 解析全部 A/AAAA，任意一条命中私网即拒。
 *
 * 失败抛 Error，调用方负责转 HTTP 状态或日志。
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  // URL.hostname 对 IPv6 字面量带方括号（如 [::1]），剥壳后才能被 isIP 识别。
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`拒绝访问私网/回环地址: ${host}`);
    return;
  }
  const lc = host.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local')) {
    throw new Error(`拒绝访问本地主机名: ${host}`);
  }
  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new Error(`拒绝访问：${host} 解析得到私网地址 ${r.address}`);
    }
  }
}

/** 校验 URL：仅 http/https，且 host 非私网/回环/元数据。通过则返回解析后的 URL。 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`非法 URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持 http/https，收到 ${parsed.protocol}`);
  }
  await assertSafeHost(parsed.hostname);
  return parsed;
}

/** 重定向跳数上限。 */
const MAX_REDIRECTS = 5;

/**
 * SSRF 安全的 fetch：逐跳 `redirect:'manual'` + 每跳重新校验协议与 host，
 * 杜绝「初始 host 受信但 30x 跳到内网」的重定向绕过。其余行为同原生 fetch。
 * 任何由 LLM / 用户 / 入站消息触发的远程下载都应改走此函数。
 */
export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = MAX_REDIRECTS): Promise<Response> {
  let current = await assertSafeUrl(url);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(current.href, { ...init, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    current = await assertSafeUrl(new URL(location, current).href);
  }
  throw new Error(`重定向次数超过上限 (${maxRedirects})`);
}
