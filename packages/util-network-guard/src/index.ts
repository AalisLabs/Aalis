// ============================================================
// @aalis/util-network-guard — SSRF / 私网地址防护纯函数
//
// 由 LLM / 用户 / 入站消息触发的远程下载应走 safeFetch（逐跳复核 + pin 已校验 IP）；
// assertSafeUrl / assertSafeHost 只用于自管连接的预检；自管连接要让判定与连接用同一次解析，把 pinnedLookup
// 作为 lookup 传给 net.connect。
// 除 safeFetch 外不做下载、不做缓存，其余只提供同步/异步校验，方便不同子系统按各自架构
// （流式代理 / 全 buffer 下载 / 内联 fetch）复用。
// ============================================================

import { promises as dns } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

type Cidr = readonly [address: string, prefix: number, family: 'ipv4' | 'ipv6'];

/**
 * 一条网段：「地址」或「地址/前缀长度」，IPv4 或 IPv6，前缀长度是十进制数字、不超过本族位数；写错的为 null，
 * 带 zone id 的也算写错（网段不带 zone）。IPv6 地址换成规范写法
 */
function parseCidr(entry: unknown): Cidr | null {
  const [address, bits, ...rest] = typeof entry === 'string' ? entry.split('/') : [];
  const family = address === undefined || address.includes('%') ? 0 : isIP(address);
  const max = family === 6 ? 128 : 32;
  const prefix = bits === undefined ? max : /^\d+$/.test(bits) ? Number(bits) : Number.NaN;
  if (family === 0 || rest.length > 0 || !(prefix <= max)) return null;
  return family === 6 ? [v6Text(v6Groups(address)), prefix, 'ipv6'] : [address, prefix, 'ipv4'];
}

interface CidrLists {
  readonly ipv4: BlockList;
  readonly ipv6: BlockList;
}

/** 网段按族分进两张 BlockList：IPv6 规则也会命中 IPv4 地址，故分开、各用本族的地址查。内置表与 denyCidrs 共用 */
function cidrLists(cidrs: readonly Cidr[]): CidrLists {
  const lists = { ipv4: new BlockList(), ipv6: new BlockList() };
  for (const [address, prefix, family] of cidrs) lists[family].addSubnet(address, prefix, family);
  return lists;
}

/**
 * 不是公网单播的地址。IPv4：IANA 特殊用途地址表里全网不可达的段，加组播与保留段（224.0.0.0/3）。
 * IPv6：2000::/3 之外全部，加它里面的 IETF 协议段（含 Teredo）、两个文档段与 6to4；IPv4 映射与 NAT64 写法不查 IPv6 这张
 */
const NON_PUBLIC = cidrLists(
  [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/3',
    '::/3',
    '4000::/2',
    '8000::/1',
    '2001::/23',
    '2001:db8::/32',
    '2002::/16',
    '3fff::/20',
  ].map(entry => parseCidr(entry)!),
);

/** isIP 认过的 IPv6 文字（可带 zone id、末尾可写点分 IPv4）拆成 8 个 16 位段 */
function v6Groups(addr: string): number[] {
  const groups = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap(g => {
          if (!g.includes('.')) return [Number.parseInt(g, 16)];
          const [a, b, c, d] = g.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head, tail] = addr.split('%')[0].split('::');
  if (tail === undefined) return groups(head);
  const front = groups(head);
  const back = groups(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

/**
 * 8 个 16 位段的规范写法（小写、不补零，最长的一串零段压成 ::），不带 zone id、不超过 39 个字符。交给 node:net 的
 * IPv6 地址都换成它：% 之前超过 39 个字符的写法会被截短，判的就不是原来那个地址
 */
function v6Text(g: readonly number[]): string {
  let start = -1;
  let length = 1; // 只有一段零不压；一样长的取前面那串
  let run = 0;
  for (let i = 0; i < 8; i++) {
    run = g[i] === 0 ? run + 1 : 0;
    if (run > length) [start, length] = [i + 1 - run, run];
  }
  const hex = (part: readonly number[]) => part.map(n => n.toString(16)).join(':');
  return start < 0 ? hex(g) : `${hex(g.slice(0, start))}::${hex(g.slice(start + length))}`;
}

/** IPv6 里内嵌的 IPv4：IPv4 映射 ::ffff:0:0/96 与 NAT64 64:ff9b::/96 取末 32 位；别的为 null */
function embeddedV4(g: readonly number[]): string | null {
  const zeros = g[2] === 0 && g[3] === 0 && g[4] === 0;
  const mapped = g[0] === 0 && g[1] === 0 && zeros && g[5] === 0xffff;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && zeros && g[5] === 0;
  return mapped || nat64 ? `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}` : null;
}

/**
 * 判断 IP 是不是公网单播之外的地址（私网、回环、链路本地、元数据、组播、保留与文档段）：先按数值认（非规范写法、
 * 带 zone id 的照认），IPv4 映射与 NAT64 写法按那个 IPv4 判。解析失败按危险（true）处理，调用方按 SSRF 拒绝。
 */
export function isPrivateAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 0) return true; // 解析失败按危险处理
  if (family === 4) return NON_PUBLIC.ipv4.check(addr, 'ipv4');
  const groups = v6Groups(addr);
  const v4 = embeddedV4(groups);
  return v4 !== null ? NON_PUBLIC.ipv4.check(v4, 'ipv4') : NON_PUBLIC.ipv6.check(v6Text(groups), 'ipv6');
}

/**
 * IP 字面量的规范写法：IPv6 拼回压缩写法，zone id 原样接在后面；IPv4 与不是 IP 字面量的原样交回。自管连接判过之后
 * 按它连接：node:net 会截短 % 之前超过 39 个字符的写法，原样交过去，连到的就不是判的那个地址
 */
export function canonicalAddress(addr: string): string {
  if (isIP(addr) !== 6) return addr;
  const zone = addr.indexOf('%');
  return v6Text(v6Groups(addr)) + (zone < 0 ? '' : addr.slice(zone));
}

/**
 * 判定 host（域名或 IP 字面量）是否指向本地 / 内网（字符串级，不做 DNS 解析）。
 * - localhost / *.localhost → true
 * - IP 字面量（可带 `[]`）→ 交给 isPrivateAddress 判
 * - 非 IP 的域名 → false（字符串级判不出，调用方需 DNS 解析后对每个 address 再调 isPrivateAddress / assertSafeHost）
 */
export function isPrivateHost(host: string): boolean {
  if (!host) return true;
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h) === 0) return false; // 非 IP 字面量（域名）→ 留给 DNS 解析后再判
  return isPrivateAddress(h);
}

// ── 可配网络出口策略（进程级；由 setNetworkPolicy 注入，默认拦私网）──
// 网段预先建成 BlockList，加一个端口 Set。

interface NetworkPolicyState {
  blockPrivate: boolean;
  denyCidrs: CidrLists;
  allowedPorts: Set<number> | null;
}
/** 写错时只留那句报错 */
type PolicyState = NetworkPolicyState | { readonly invalid: string };
let policy: PolicyState = { blockPrivate: true, denyCidrs: cidrLists([]), allowedPorts: null };

/** 网络出口策略配置（宿主配置文档的 `network` 字段，由 api-authority 声明、plugin-authority 激活时与宿主文档变了时注入）。 */
export interface NetworkPolicyConfig {
  /** 是否拦私网/回环/链路本地/元数据段（默认 true）。本地自动化可显式关。 */
  blockPrivate?: boolean;
  /**
   * 额外拒绝的网段：IPv4 或 IPv6，写成「地址/前缀长度」或单个地址，如 ["100.64.0.0/10", "fd00::/8"]；
   * IPv4 网段同样管 IPv4 映射与 NAT64 写法。
   */
  denyCidrs?: string[];
  /** 仅允许这些目标端口（1 到 65535 的整数，非空时生效），如 [80, 443]；空/缺省=不限。 */
  allowedPorts?: number[];
}

/**
 * 注入进程级网络出口策略。network 段写错一处（不是对象、有不认的字段，或哪一项的值不对），整份策略就处于「配置有误」：
 * 不抛错、交回与读策略的断言同一句报错（点名字段与原值），此后读策略的断言一律抛它，直到注入一份写对的
 */
export function setNetworkPolicy(cfg: NetworkPolicyConfig): string | undefined {
  policy = parsePolicy(cfg);
  return 'invalid' in policy ? policy.invalid : undefined;
}

/** network 段认的字段，同 NetworkPolicyConfig */
const POLICY_FIELDS = ['blockPrivate', 'denyCidrs', 'allowedPorts'];

/** 报错里的原值：数字（含 NaN、Infinity）与 BigInt 照写，其余按 JSON 写出（字符串带引号，与数字分得开） */
function shown(value: unknown): string {
  return typeof value === 'number' || typeof value === 'bigint' ? String(value) : JSON.stringify(value);
}

/** network 段解析成策略。各项为 null 与没写一样 */
function parsePolicy(cfg: unknown): PolicyState {
  const wrong = (field: string, value: unknown, hint: string) => ({
    invalid: `网络策略配置有误：${field} 的 ${shown(value)} ${hint}。改对宿主配置文档的 network 段之前，经出网闸的请求一律拒绝`,
  });
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) return wrong('network', cfg, '不是对象');
  const fields = cfg as Record<string, unknown>;
  const extra = Object.keys(fields).find(key => !POLICY_FIELDS.includes(key));
  if (extra !== undefined) return wrong(extra, fields[extra], `不起作用：network 只认 ${POLICY_FIELDS.join('、')}`);
  const blockPrivate = fields.blockPrivate ?? true;
  const denyCidrs = fields.denyCidrs ?? [];
  const allowedPorts = fields.allowedPorts ?? [];
  if (typeof blockPrivate !== 'boolean') return wrong('blockPrivate', blockPrivate, '不是布尔：写成 true 或 false');
  if (!Array.isArray(denyCidrs)) return wrong('denyCidrs', denyCidrs, '不是列表');
  if (!Array.isArray(allowedPorts)) return wrong('allowedPorts', allowedPorts, '不是列表');
  const cidrs = denyCidrs.map(parseCidr);
  const badCidr = cidrs.indexOf(null);
  if (badCidr >= 0) {
    return wrong(
      'denyCidrs',
      denyCidrs[badCidr],
      '不是网段：写成「地址/前缀长度」或单个地址，IPv4 或 IPv6，如 100.64.0.0/10、fd00::/8',
    );
  }
  const badPort = allowedPorts.findIndex(port => !(Number.isInteger(port) && port >= 1 && port <= 65535));
  if (badPort >= 0) return wrong('allowedPorts', allowedPorts[badPort], '不是端口：写成 1 到 65535 的整数，如 443');
  return {
    blockPrivate,
    denyCidrs: cidrLists(cidrs.filter(cidr => cidr !== null)),
    allowedPorts: allowedPorts.length > 0 ? new Set(allowedPorts) : null,
  };
}

/** 当前策略；配置有误时抛错，经出网闸的请求一律失败 */
function activePolicy(): NetworkPolicyState {
  if ('invalid' in policy) throw new Error(policy.invalid);
  return policy;
}

/** 地址命中 denyCidrs：查本族那张；IPv6 地址内嵌 IPv4（映射、NAT64）时再拿那个 IPv4 查 IPv4 那张 */
function inDenyCidrs(lists: CidrLists, addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) return lists.ipv4.check(addr, 'ipv4');
  if (family !== 6) return false;
  const groups = v6Groups(addr);
  const v4 = embeddedV4(groups);
  return lists.ipv6.check(v6Text(groups), 'ipv6') || (v4 !== null && lists.ipv4.check(v4, 'ipv4'));
}

/**
 * 校验一组已解析地址：任一命中私网[可配] / denyCidrs 即抛错。host 仅用于错误信息。
 * assertSafeHost（预校验）与 safeFetch 的 pin dispatcher（连接时）共用此判定，避免重复。
 */
export function assertAddressesSafe(host: string, addresses: readonly string[]): void {
  const { blockPrivate, denyCidrs } = activePolicy();
  for (const addr of addresses) {
    if (blockPrivate && isPrivateAddress(addr)) {
      throw new Error(`拒绝访问：${host} 解析得到私网地址 ${addr}`);
    }
    if (inDenyCidrs(denyCidrs, addr)) throw new Error(`拒绝访问：${host} 命中受限网段 ${addr}`);
  }
}

/**
 * 校验目标端口：配置了 allowedPorts 时不在其中即抛错，未配置时不限。
 * assertSafeUrl 与自管连接（如浏览器网络闸）共用此判定。
 */
export function assertPortAllowed(port: number): void {
  const { allowedPorts } = activePolicy();
  if (allowedPorts && !allowedPorts.has(port)) {
    throw new Error(`拒绝访问端口 ${port}（不在允许列表）`);
  }
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
  const { blockPrivate, denyCidrs } = activePolicy();
  if (isIP(host)) {
    if (blockPrivate && isPrivateAddress(host)) throw new Error(`拒绝访问私网/回环地址: ${host}`);
    if (inDenyCidrs(denyCidrs, host)) throw new Error(`拒绝访问受限网段: ${host}`);
    return;
  }
  const lc = host.toLowerCase();
  if (blockPrivate && (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local'))) {
    throw new Error(`拒绝访问本地主机名: ${host}`);
  }
  const records = await dns.lookup(host, { all: true });
  assertAddressesSafe(
    host,
    records.map(r => r.address),
  );
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
  assertPortAllowed(parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80);
  await assertSafeHost(parsed.hostname);
  return parsed;
}

/** 重定向跳数上限。 */
const MAX_REDIRECTS = 5;
const REQUEST_BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * 跟随一跳重定向时发往下一跳的请求，照 fetch 规范的 HTTP-redirect fetch：301、302 的 POST 与 303 的非 GET、HEAD
 * 改成不带正文的 GET，去掉描述正文的头；跳到别的源（协议、主机、端口任一不同）时去掉凭据头。其余照原样
 */
function redirectInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const toGet =
    ((status === 301 || status === 302) && method === 'POST') ||
    (status === 303 && method !== 'GET' && method !== 'HEAD');
  if (toGet) for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
  if (from.origin !== to.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return toGet ? { ...init, method: 'GET', body: null, headers } : { ...init, headers };
}

/**
 * pin 已校验 IP 的 DNS 查询：在同一次解析里校验并交回该结果，使「校验」与「连接」
 * 用同一份地址，杜绝 DNS-rebinding（低 TTL 域名先返公网 IP 过校验、连接时再解析到
 * 内网/元数据）。校验判定复用 assertAddressesSafe；命中即抛，连接失败。
 *
 * 回调形状必须跟着 `options.all` 走，两种都要给：Node 的 net 在 happy-eyeballs
 * （autoSelectFamily，Node 20+ 默认开）下带 `all: true` 并期望 `{address,family}[]`，
 * 关掉时（Node 18 默认、`--no-network-family-autoselection`、
 * `net.setDefaultAutoSelectFamily(false)`）不带 all、仍期望旧的三参形式。
 * 押注单一形状会让另一档位下的 safeFetch 对**任何** URL 抛
 * ERR_INVALID_IP_ADDRESS，且上层只看到笼统的 `TypeError: fetch failed`。
 *
 * 全部地址都过同一道校验，故 all 模式整份交回既安全又保住多 IP 容错。
 *
 * 自管连接时作为 `net.connect` / `tls.connect` 的 `lookup` 传入（safeFetch 的 dispatcher 即如此）。
 * 只管域名：目标是 IP 字面量时 Node 不调 lookup，调用方须自行用 assertAddressesSafe 判定。
 */
export const pinnedLookup: LookupFunction = (hostname, options, callback) => {
  dns
    .lookup(hostname, { ...options, all: true })
    .then(records => {
      assertAddressesSafe(
        hostname,
        records.map(r => r.address),
      );
      if (options.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, '', 0));
};

const pinnedSafeDispatcher = new Agent({
  connect: { lookup: pinnedLookup },
});

/**
 * SSRF 安全的 fetch：逐跳 `redirect:'manual'` + 每跳重新校验协议与 host（堵重定向绕过），
 * 并用 pin dispatcher 让校验与连接用同一次 DNS 解析（堵 rebinding）。跟随时按 fetch 规范改写下一跳（见 redirectInit），
 * 其余行为同原生 fetch。init 的正文须可重放（字符串、ArrayBuffer、视图、Blob、URLSearchParams、FormData）：307、308
 * 跟随时原样重发。任何由 LLM / 用户 / 入站消息触发的远程下载都应改走此函数。
 */
export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = MAX_REDIRECTS): Promise<Response> {
  let current = await assertSafeUrl(url);
  let request = init;
  for (let i = 0; i <= maxRedirects; i++) {
    const fetchInit: RequestInit & { dispatcher?: Agent } = {
      ...request,
      redirect: 'manual',
      dispatcher: pinnedSafeDispatcher,
    };
    const res = await fetch(current.href, fetchInit as RequestInit);
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    await res.body?.cancel(); // 跳转的正文不读：取消掉，不占着连接
    const next = await assertSafeUrl(new URL(location, current).href);
    request = redirectInit(request, res.status, current, next);
    current = next;
  }
  throw new Error(`重定向次数超过上限 (${maxRedirects})`);
}
