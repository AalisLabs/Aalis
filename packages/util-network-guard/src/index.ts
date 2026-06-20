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

// ── 可配网络出口策略（进程级；启动时由 setNetworkPolicy 注入一次，默认拦私网）──
// 粗粒度、高效：几条预解析 CIDR + 一个端口 Set，每请求 O(几条) 整数比对，不碎。

interface V4Cidr {
  base: number;
  mask: number;
}
interface NetworkPolicyState {
  blockPrivate: boolean;
  denyCidrs: V4Cidr[];
  allowedPorts: Set<number> | null;
}
let policy: NetworkPolicyState = { blockPrivate: true, denyCidrs: [], allowedPorts: null };

/** 网络出口策略配置（core 配置 `network`，启动时注入）。 */
export interface NetworkPolicyConfig {
  /** 是否拦私网/回环/链路本地/元数据段（默认 true）。本地自动化可显式关。 */
  blockPrivate?: boolean;
  /** 额外拒绝的 IPv4 CIDR 段（私网默认已拦），如 ["100.64.0.0/10"]。 */
  denyCidrs?: string[];
  /** 仅允许这些目标端口（非空时生效），如 [80, 443]；空/缺省=不限。 */
  allowedPorts?: number[];
}

function v4ToInt(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const seg of p) {
    const x = Number(seg);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) | x;
  }
  return n >>> 0;
}

function parseV4Cidr(s: string): V4Cidr | null {
  const slash = s.indexOf('/');
  const ip = slash < 0 ? s : s.slice(0, slash);
  const bits = slash < 0 ? 32 : Number(s.slice(slash + 1));
  if (isIP(ip) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const n = v4ToInt(ip);
  if (n === null) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (n & mask) >>> 0, mask };
}

/** 注入进程级网络出口策略（启动时一次；CIDR 预解析，避免每请求重复解析）。 */
export function setNetworkPolicy(cfg: NetworkPolicyConfig): void {
  policy = {
    blockPrivate: cfg.blockPrivate !== false,
    denyCidrs: (cfg.denyCidrs ?? []).map(parseV4Cidr).filter((c): c is V4Cidr => c !== null),
    allowedPorts: cfg.allowedPorts && cfg.allowedPorts.length > 0 ? new Set(cfg.allowedPorts) : null,
  };
}

/** 解析出的 IPv4 地址是否命中配置的 denyCidrs。 */
function inDenyCidrs(addr: string): boolean {
  if (policy.denyCidrs.length === 0 || isIP(addr) !== 4) return false;
  const n = v4ToInt(addr);
  if (n === null) return false;
  return policy.denyCidrs.some(c => (n & c.mask) >>> 0 === c.base);
}

/**
 * 校验 hostname 是否安全可下载。
 *  - 字面 IP：判私网[可配] + denyCidrs。
 *  - 'localhost' / '*.localhost' / '*.local'：拦（受 blockPrivate 控）。
 *  - 其它域名：DNS 解析全部 A/AAAA，任意一条命中私网/denyCidrs 即拒。
 *
 * 失败抛 Error，调用方负责转 HTTP 状态或日志。
 */
export async function assertSafeHost(hostname: string): Promise<void> {
  // URL.hostname 对 IPv6 字面量带方括号（如 [::1]），剥壳后才能被 isIP 识别。
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (policy.blockPrivate && isPrivateAddress(host)) throw new Error(`拒绝访问私网/回环地址: ${host}`);
    if (inDenyCidrs(host)) throw new Error(`拒绝访问受限网段: ${host}`);
    return;
  }
  const lc = host.toLowerCase();
  if (policy.blockPrivate && (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local'))) {
    throw new Error(`拒绝访问本地主机名: ${host}`);
  }
  const records = await dns.lookup(host, { all: true });
  for (const r of records) {
    if (policy.blockPrivate && isPrivateAddress(r.address)) {
      throw new Error(`拒绝访问：${host} 解析得到私网地址 ${r.address}`);
    }
    if (inDenyCidrs(r.address)) throw new Error(`拒绝访问：${host} 命中受限网段 ${r.address}`);
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
  if (policy.allowedPorts) {
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    if (!policy.allowedPorts.has(port)) throw new Error(`拒绝访问端口 ${port}（不在允许列表）`);
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
