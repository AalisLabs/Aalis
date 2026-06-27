import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeUrl,
  isPrivateAddress,
  isPrivateHost,
  safeFetch,
  setNetworkPolicy,
} from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// util-network-guard：SSRF 安全 fetch（统一原语）
//   字面 IP 用例不触 DNS，确定性。重定向用 stub fetch 验证逐跳校验。
// ════════════════════════════════════════════════════════════

const mkRes = (status: number, location?: string): Response =>
  ({
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (location ?? null) : null) },
  }) as unknown as Response;

// 策略是进程级单例：每例后复位到默认（拦私网、无 CIDR、不限端口），防跨用例污染。
afterEach(() => {
  vi.restoreAllMocks();
  setNetworkPolicy({});
});

describe('isPrivateAddress（含从 tools-api 并入的 CGNAT / benchmark 段）', () => {
  it('私网 / 回环 / 链路本地 / 元数据 → true', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '0.0.0.0',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      'fc00::1',
      'fe80::1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });
  it('CGNAT 100.64/10 与 benchmark 198.18/15 → true（并入的新段）', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('100.127.255.255')).toBe(true);
    expect(isPrivateAddress('198.18.0.1')).toBe(true);
    expect(isPrivateAddress('198.19.255.255')).toBe(true);
    expect(isPrivateAddress('100.63.0.1')).toBe(false); // 100.63 不在 CGNAT
    expect(isPrivateAddress('198.20.0.1')).toBe(false);
  });
  it('公网 IP → false；解析失败 → true（按危险处理）', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('isPrivateHost（字符串级 host 判定）', () => {
  it('localhost / *.localhost / 0.0.0.0 → true', () => {
    expect(isPrivateHost('localhost')).toBe(true);
    expect(isPrivateHost('foo.localhost')).toBe(true);
    expect(isPrivateHost('0.0.0.0')).toBe(true);
    expect(isPrivateHost('')).toBe(true);
  });
  it('私网 IP 字面量（含 [] 包裹的 IPv6）→ true', () => {
    expect(isPrivateHost('192.168.1.1')).toBe(true);
    expect(isPrivateHost('[::1]')).toBe(true);
  });
  it('公网域名 / 公网 IP → false（域名留给 DNS 解析后再判）', () => {
    expect(isPrivateHost('example.com')).toBe(false);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('拒绝非 http(s) 协议', async () => {
    await expect(assertSafeUrl('ftp://example.com/')).rejects.toThrow(/http\/https/);
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertSafeUrl('not a url')).rejects.toThrow(/非法 URL/);
  });

  it('拒绝私网/回环/元数据字面 IP（含 IPv6 字面量）', async () => {
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toThrow(/私网|回环/);
    await expect(assertSafeUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(assertSafeUrl('http://10.0.0.5/')).rejects.toThrow();
    await expect(assertSafeUrl('http://[::1]/')).rejects.toThrow();
  });

  it('放行公网字面 IP', async () => {
    await expect(assertSafeUrl('http://1.1.1.1/x')).resolves.toBeInstanceOf(URL);
  });
});

describe('可配网络出口策略（setNetworkPolicy）', () => {
  it('denyCidrs：命中配置网段的公网 IP 被拒（私网默认仍拦）', async () => {
    setNetworkPolicy({ denyCidrs: ['1.1.1.0/24'] });
    await expect(assertSafeUrl('http://1.1.1.1/')).rejects.toThrow(/受限网段/);
    await expect(assertSafeUrl('http://8.8.8.8/')).resolves.toBeInstanceOf(URL); // 不在网段，放行
  });

  it('allowedPorts：仅放行白名单端口，其余拒（默认端口按协议推断）', async () => {
    setNetworkPolicy({ allowedPorts: [80, 443] });
    await expect(assertSafeUrl('https://1.1.1.1/')).resolves.toBeInstanceOf(URL); // 默认 443
    await expect(assertSafeUrl('http://1.1.1.1/')).resolves.toBeInstanceOf(URL); // 默认 80
    await expect(assertSafeUrl('http://1.1.1.1:6379/')).rejects.toThrow(/端口/); // 内网常见 Redis 口被拦
  });

  it('blockPrivate:false：放行私网/localhost（本地自动化场景的总开关）', async () => {
    setNetworkPolicy({ blockPrivate: false });
    await expect(assertSafeUrl('http://127.0.0.1/')).resolves.toBeInstanceOf(URL);
    // 但 denyCidrs 仍可单独点名拦截
    setNetworkPolicy({ blockPrivate: false, denyCidrs: ['127.0.0.0/8'] });
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toThrow(/受限网段/);
  });
});

describe('safeFetch 逐跳重定向校验', () => {
  it('2xx 直接返回', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(200)));
    const res = await safeFetch('http://1.1.1.1/');
    expect(res.status).toBe(200);
  });

  it('30x 跳到内网 → 拦截（堵住重定向绕过）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mkRes(302, 'http://169.254.169.254/latest/meta-data/')));
    await expect(safeFetch('http://1.1.1.1/')).rejects.toThrow(/私网|回环|拒绝/);
  });

  it('强制 redirect:manual 传给底层 fetch，并透传 init', async () => {
    const f = vi.fn().mockResolvedValue(mkRes(200));
    vi.stubGlobal('fetch', f);
    await safeFetch('http://1.1.1.1/', { headers: { 'x-test': '1' } });
    expect(f).toHaveBeenCalledWith(
      'http://1.1.1.1/',
      expect.objectContaining({ redirect: 'manual', headers: { 'x-test': '1' } }),
    );
  });
});
