import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertSafeUrl, safeFetch } from '../../packages/util-network-guard/src/index.js';

// ════════════════════════════════════════════════════════════
// util-network-guard：SSRF 安全 fetch（统一原语）
//   字面 IP 用例不触 DNS，确定性。重定向用 stub fetch 验证逐跳校验。
// ════════════════════════════════════════════════════════════

const mkRes = (status: number, location?: string): Response =>
  ({
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'location' ? (location ?? null) : null) },
  }) as unknown as Response;

afterEach(() => vi.restoreAllMocks());

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
