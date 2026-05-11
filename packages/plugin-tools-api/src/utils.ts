// ===== 工具实现侧的可复用 runtime 工具函数 =====
//
// 本文件提供少量被多个工具插件（plugin-tools / plugin-tool-browser /
// plugin-tool-code-runner 等）共享的纯函数，避免在各插件重复造轮子。
//
// 设计原则：
// - 仅放语义稳定、跨插件确实重复出现过的小工具
// - 无副作用、无 I/O（DNS 解析等留给调用方）
// - 不引入新的运行时依赖（仅 node:net / node:path）

import { isIP } from 'node:net';
import path from 'node:path';

// ----- storage URI 规范化 -----

export interface ToStorageUriOptions {
  /** 输入为空时使用的回退值（默认 'workspace:/'） */
  fallback?: string;
  /** 输入为空时抛错（默认 false） */
  requireValue?: boolean;
  /** 错误信息中用于指代该字段的名称（默认 '路径'） */
  errorContext?: string;
}

/**
 * 把用户输入规范成 storage URI。
 *
 * 规则：
 * - 已是 storage URI（形如 `workspace:/foo`、`host:/bar`）→ 原样返回
 * - 空输入 → `requireValue=true` 时抛错；否则返回 `fallback`（再为空则 `workspace:/`）
 * - 宿主机绝对路径（`C:\path` 或 `/abs`）→ 抛错（避免越界访问）
 * - 相对路径 → 拼到 `workspace:/` 之下
 */
export function toStorageUri(input: string | undefined, options: ToStorageUriOptions = {}): string {
  const { fallback = 'workspace:/', requireValue = false, errorContext = '路径' } = options;
  const raw = (input ?? '').trim();
  if (!raw) {
    if (requireValue) throw new Error(`${errorContext}不能为空`);
    const fb = fallback.trim();
    return fb || 'workspace:/';
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw)) {
    throw new Error(`${errorContext}必须使用 storage URI 或相对 workspace 的路径，不能使用宿主机绝对路径`);
  }
  if (/^[a-zA-Z][a-zA-Z0-9_-]*:\//.test(raw)) return raw;
  if (path.isAbsolute(raw)) {
    throw new Error(`${errorContext}必须使用 storage URI 或相对 workspace 的路径，不能使用宿主机绝对路径`);
  }
  return `workspace:/${raw.replace(/^\/+/, '')}`;
}

// ----- 私有 IP / 内网 host 判定 -----
//
// 用于 SSRF 防护。所有判定都是字符串级，不做 DNS 解析（解析交给调用方，
// 之后把解析得到的每个 address 喂给 isPrivateIp 即可）。

/** 判定 IPv4 地址是否落在私有/保留/不可公开访问范围。 */
export function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(p => Number(p));
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** 判定 IPv6 地址是否落在私有/保留范围（含 ::1、fc00::/7、fe80::/10、::ffff:IPv4 映射）。 */
export function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

/** 判定 IP（v4/v6）是否为私有/保留。非合法 IP 字符串返回 false（调用方应另外判断 host 类型）。 */
export function isPrivateIp(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return isPrivateIpv4(address);
  if (v === 6) return isPrivateIpv6(address);
  return false;
}

/**
 * 判定 host（域名或 IP 字面量）是否指向本地/内网。
 *
 * - 仅做字符串级判定，不做 DNS 解析
 * - IPv6 字面量允许带 `[]`
 * - 非 IP 且不是 localhost 后缀 → 返回 false（调用方若需更严格的 SSRF
 *   防护，应再解析 DNS 并对每个 address 调用 `isPrivateIp`）
 */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0') return true;
  const v = isIP(h);
  if (v === 4) return isPrivateIpv4(h);
  if (v === 6) return isPrivateIpv6(h);
  return false;
}
