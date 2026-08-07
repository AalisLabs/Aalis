import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import { type AddressInfo, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAddressesSafe,
  assertSafeUrl,
  isPrivateAddress,
  isPrivateHost,
  pinnedLookup,
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
// stubGlobal 装的 fetch 只有 unstubAllGlobals 收得掉，restoreAllMocks 收不掉——
// 漏收会让后面真连接的用例拿到上一例的假 fetch。
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it('强制 redirect:manual 与 pin dispatcher 传给底层 fetch，并透传 init', async () => {
    const f = vi.fn().mockResolvedValue(mkRes(200));
    vi.stubGlobal('fetch', f);
    await safeFetch('http://1.1.1.1/', { headers: { 'x-test': '1' } });
    expect(f).toHaveBeenCalledWith(
      'http://1.1.1.1/',
      expect.objectContaining({ redirect: 'manual', headers: { 'x-test': '1' }, dispatcher: expect.anything() }),
    );
  });
});

describe('assertAddressesSafe（pin dispatcher 与 assertSafeHost 共用的地址校验，堵 rebinding）', () => {
  it('全公网地址 → 不抛', () => {
    expect(() => assertAddressesSafe('x.com', ['1.1.1.1', '8.8.8.8'])).not.toThrow();
  });
  it('含私网/回环/元数据 → 抛（rebinding 到内网会在连接前被此判定拦下）', () => {
    expect(() => assertAddressesSafe('x.com', ['127.0.0.1'])).toThrow(/私网/);
    expect(() => assertAddressesSafe('x.com', ['1.1.1.1', '169.254.169.254'])).toThrow(/私网/);
    expect(() => assertAddressesSafe('x.com', ['10.0.0.1'])).toThrow();
  });
  it('denyCidrs 命中 → 抛；blockPrivate:false 时私网放行、denyCidrs 仍拦', () => {
    setNetworkPolicy({ denyCidrs: ['1.1.1.0/24'] });
    expect(() => assertAddressesSafe('x.com', ['1.1.1.1'])).toThrow(/受限网段/);
    setNetworkPolicy({ blockPrivate: false });
    expect(() => assertAddressesSafe('x.com', ['127.0.0.1'])).not.toThrow();
    setNetworkPolicy({ blockPrivate: false, denyCidrs: ['127.0.0.0/8'] });
    expect(() => assertAddressesSafe('x.com', ['127.0.0.1'])).toThrow(/受限网段/);
  });
});

// ════════════════════════════════════════════════════════════
// pinnedLookup 的回调契约 + 真实 dispatcher 端到端
//
// 回调形状由 Node 的 net 按 `options.all` 决定，不是固定的：happy-eyeballs
// （autoSelectFamily，Node 20+ 默认开）下带 all、要 `{address,family}[]`；关掉时
// 不带 all、要旧的三参形式。押注单一形状 → safeFetch 对**任何** URL 抛
// ERR_INVALID_IP_ADDRESS，而上层只看到笼统的 `TypeError: fetch failed`。
// 两个档位各有一条端到端用例守着。
//
// 本文件其余用例都 stub 掉 global fetch，dispatcher 从来没被走过，
// 这正是上面那个缺陷得以逃逸的口子。下面这条起本地服务真连一次堵住它。
// ════════════════════════════════════════════════════════════
describe('pinnedLookup 与真实连接', () => {
  const UNDICI_OPTIONS = { hints: 1024, all: true } as const;

  it('options.all 时交回 { address, family } 数组，而非裸地址串', async () => {
    setNetworkPolicy({ blockPrivate: false }); // localhost 走 /etc/hosts，不出网；afterEach 复位
    const got = await new Promise<string | LookupAddress[]>((resolve, reject) => {
      pinnedLookup('localhost', UNDICI_OPTIONS, (err, list) => {
        if (err) reject(err);
        else resolve(list);
      });
      setTimeout(() => reject(new Error('lookup 回调未触发')), 5000);
    });
    expect(Array.isArray(got)).toBe(true);
    const addresses = got as LookupAddress[];
    expect(addresses.length).toBeGreaterThan(0);
    for (const a of addresses) {
      expect(typeof a.address).toBe('string');
      expect(a.address.length).toBeGreaterThan(0);
      expect([4, 6]).toContain(a.family);
    }
  });

  it('safeFetch 真的连得上（走 undici dispatcher，不 stub fetch）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
    });
    // 不绑定 host：localhost 首个解析是 ::1，只听 127.0.0.1 会让关掉 happy-eyeballs 的那档连不上
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    // 用 localhost 而非字面 IP：字面 IP 不触发 DNS，就绕开了 pinnedLookup
    setNetworkPolicy({ blockPrivate: false });
    try {
      const res = await safeFetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('pong');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('关掉 happy-eyeballs 时也连得上（另一种回调形状）', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
    });
    // 不绑定 host：localhost 首个解析是 ::1，只听 127.0.0.1 会让关掉 happy-eyeballs 的那档连不上
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const prev = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(false);
    setNetworkPolicy({ blockPrivate: false });
    try {
      const res = await safeFetch(`http://localhost:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('pong');
    } finally {
      setDefaultAutoSelectFamily(prev);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('无 options.all 时交回裸地址串 + family（Node 的旧三参形式）', async () => {
    setNetworkPolicy({ blockPrivate: false });
    const { address, family } = await new Promise<{ address: unknown; family: unknown }>((resolve, reject) => {
      pinnedLookup('localhost', { hints: 1024 }, (err, addr, fam) => {
        if (err) reject(err);
        else resolve({ address: addr, family: fam });
      });
      setTimeout(() => reject(new Error('lookup 回调未触发')), 5000);
    });
    expect(typeof address).toBe('string');
    expect([4, 6]).toContain(family);
  });

  it('出口闸拒绝时以 Error 回调，不静默交回地址', async () => {
    const err = await new Promise<Error | null>((resolve, reject) => {
      pinnedLookup('localhost', UNDICI_OPTIONS, e => resolve(e));
      setTimeout(() => reject(new Error('lookup 回调未触发')), 5000);
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/私网|回环|拒绝/);
  });
});
