# network-guard — SSRF 安全的出口校验

`@aalis/util-network-guard` 把「fetch 一个由用户、LLM 或入站消息影响到的 URL」这件危险操作收口成安全操作：协议白名单、私网/回环/元数据段封锁、DNS 全解析、逐跳重定向重校验。它是 Aalis 里唯一的「安全拉取外部 URL」助手——所有插件的外部 fetch 都应该走它，而不是裸 `fetch`。

它是一个纯 util 库，不涉及服务注册与 DI，也不经服务容器。你在 `package.json` 里依赖 `@aalis/util-network-guard`，然后直接 `import` 函数调用即可。

包本身只做校验，不下载、不缓存、不限制体积。体积上限、超时、缓存留给调用方按自己的架构（流式代理、全 buffer 下载、内联 fetch）决定。

威胁模型背景（为什么要防、防的是谁）见 [安全模型 §3 safeFetch](../concepts/security-model.md)。

---

## 1. 导出 API

### `safeFetch(url, init?, maxRedirects?)` — 首选

```typescript
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS, // = 5
): Promise<Response>
```

SSRF 安全的 `fetch` 替代品。它逐跳使用 `redirect:'manual'`，每一跳都重新运行 `assertSafeUrl`，以此杜绝「初始 host 受信、但 30x 重定向跳到内网」的绕过。

命中 30x（301/302/303/307/308）且带有 `Location` 时，它把 `Location` 解析成相对于当前 URL 的绝对地址，校验通过后再跟随后续跳转；非 30x 或没有 `Location` 时，直接返回该 `Response`。跳数超过 `maxRedirects` 时抛出 `重定向次数超过上限`。

除了「手动重定向 + 每跳校验」，其余行为与原生 `fetch` 一致——`init` 原样透传。

::: warning
`init` 每一跳都会原样重发，存在凭证泄漏风险，详见 §5。
:::

### `assertSafeUrl(rawUrl)` — 只校验 URL，不发请求

```typescript
export async function assertSafeUrl(rawUrl: string): Promise<URL>
```

校验单条 URL，不发起请求。它要求 URL 能被 `new URL()` 解析（否则抛 `非法 URL`）、协议只能是 `http:` 或 `https:`（否则抛 `仅支持 http/https`）、目标端口通过 `assertPortAllowed`（不在 `allowedPorts` 列表时抛 `拒绝访问端口 N`）、host 通过 `assertSafeHost`。全部通过后返回解析出的 `URL` 对象。

当你自己管理连接（例如流式代理），只想拿到一个校验过的 URL 时，用它。

### `assertSafeHost(hostname)` — 只校验主机名

```typescript
export async function assertSafeHost(hostname: string): Promise<void>
```

校验单个 hostname 是否可安全连接。失败时抛 `Error`，由调用方负责转成 HTTP 状态或写日志。判定规则如下：

- IPv6 字面量带方括号（如 `[::1]`）时，先剥掉方括号再判定。
- **字面 IP**：`blockPrivate` 开启时，命中私网、回环或元数据段即拒绝；命中 `denyCidrs` 即拒绝。
- **`localhost` / `*.localhost` / `*.local` 主机名**：`blockPrivate` 开启时直接拒绝。
- **其它域名**：用 `dns.lookup(host, { all: true })` 解析出全部 A/AAAA 记录，只要任意一条命中私网或 `denyCidrs` 即拒绝，挡住解析到内网 IP 的域名。它只预检、不连接：之后按名字连接会再解析一次，要封堵 DNS rebinding，连接时用 `pinnedLookup`。

### `pinnedLookup(hostname, options, callback)` — 判定与连接用同一次解析

```typescript
export const pinnedLookup: LookupFunction // node:net 的 LookupFunction
```

自管连接时作为 `net.connect` / `tls.connect`（或 undici `Agent` 的 `connect`）的 `lookup` 传入。它用 `dns.lookup(host, { all: true })` 解析出全部地址，经 `assertAddressesSafe` 判定后，把这次解析的结果交给连接使用；任一地址不过判定时以错误回调，连接失败。判定与连接之间不再解析第二次，因此能封堵 DNS rebinding：先 `assertSafeHost` 再按名字连接会解析两次，低 TTL 的域名可以在两次之间从公网地址换成内网地址。

回调形状跟随 `options.all`：带 `all: true`（Node 20+ 默认开启的 happy-eyeballs）时交回 `{ address, family }[]`，不带时交回单个地址与 family。

它只管域名：目标是 IP 字面量时 Node 不调用 `lookup`，调用方须自行用 `assertAddressesSafe` 判定。`safeFetch` 的 dispatcher 即用它连接。

### `assertAddressesSafe(host, addresses)` — 校验一组已解析地址

```typescript
export function assertAddressesSafe(host: string, addresses: readonly string[]): void
```

逐个校验地址：`blockPrivate` 开启时命中私网、回环或元数据段即抛错，命中 `denyCidrs` 即抛错。`host` 只用于错误信息。`assertSafeHost` 与 `pinnedLookup` 共用这一判定。自管连接的目标是 IP 字面量时传 `assertAddressesSafe(ip, [ip])`，传入前须是规范形式：判定按规范写法认段，`0::1`、带 zone id 的 `::1%lo0` 这类写法会被判成公网，连接却照样到达回环。浏览器网络闸的做法是：含 `%`、或与 URL 解析器规范化后的写法不同的 IPv6 字面量一律拒绝。

### `assertPortAllowed(port)` — 校验目标端口

```typescript
export function assertPortAllowed(port: number): void
```

策略配置了 `allowedPorts` 时，端口不在列表中即抛 `拒绝访问端口 N（不在允许列表）`；未配置时不限。`assertSafeUrl` 用它判定 URL 的端口。自管连接拿到目标端口后直接调用它，浏览器网络闸即如此。

### `isPrivateAddress(addr)` — 同步纯判定

```typescript
export function isPrivateAddress(addr: string): boolean
```

判断一个**字面 IP** 是否落在私网、回环、链路本地、元数据、多播保留段。它不做 DNS 查询、无副作用、同步返回。命中的段如下：

| 段 | 说明 |
|---|---|
| `10.0.0.0/8` · `172.16–31.x.x` · `192.168.0.0/16` | RFC1918 私网 |
| `127.0.0.0/8` · IPv6 `::1` | 回环 |
| `0.0.0.0/8` | 「本网络」 |
| `169.254.0.0/16` | 链路本地，**含 AWS/云元数据 `169.254.169.254`** |
| `>= 224.0.0.0` | 组播/保留 |
| IPv6 `::` · `fe80:` · `fc`/`fd`（ULA）· `::ffff:` 映射（剥壳后按 v4 再判） | IPv6 私网/链路本地 |

关键约定是**解析失败按危险处理**：当 `isIP(addr) === 0`（即传入的不是合法 IP 字面量）时，直接返回 `true`。因此传入非 IP 字符串（域名、空串）一律得到 `true`。不要拿它当域名判定器，域名请用 `assertSafeHost`。

### `setNetworkPolicy(cfg)` — 进程级策略注入（启动时一次）

```typescript
export function setNetworkPolicy(cfg: NetworkPolicyConfig): void

export interface NetworkPolicyConfig {
  blockPrivate?: boolean;   // 默认 true；本地自动化可显式 false 关私网拦截
  denyCidrs?: string[];     // 额外拒绝的 IPv4 CIDR，如 ["100.64.0.0/10"]
  allowedPorts?: number[];  // 非空时仅允许这些目标端口，如 [80, 443]；空/缺省=不限
}
```

注入进程级出口策略。CIDR 在注入时会预解析成整数 base/mask，每次请求只做几条整数比对，不在热路径重复解析。

默认策略是 `{ blockPrivate: true, denyCidrs: [], allowedPorts: null }`——也就是说，即使未注入，也默认拦截私网。`blockPrivate` 只有在显式传 `false` 时才关闭（判定条件是 `cfg.blockPrivate !== false`），`allowedPorts` 为空数组等同于不限，无效的 CIDR 会被静默过滤掉。

::: warning 由谁调用
策略来自宿主配置文档的 `network` 字段（由 `api-authority` 声明），由 `plugin-authority` 在启动时注入一次。普通插件作者不要调用它——它是进程级单例，会覆盖全局策略。配置字段语义见 `api-authority`。
:::

---

## 2. 用法示例

最小可运行片段（一行替换裸 `fetch`，SSRF 校验已内置）：

```typescript
import { safeFetch } from '@aalis/util-network-guard';

// url 来自用户 / LLM / 入站消息——直接当 fetch 用
const res = await safeFetch(url, {
  signal: AbortSignal.timeout(15_000),
  // 跨域重定向凭证泄漏：用户影响的 URL 不要带 cookie/Authorization（见 §5）
  headers: { 'user-agent': 'Mozilla/5.0 (MyPlugin)' },
});
if (!res.ok) throw new Error(`上游返回 ${res.status}`);
const text = await res.text();
```

只想拿到校验过的 `URL`（自己管理连接，例如流式代理）：

```typescript
import { assertSafeUrl, assertSafeHost } from '@aalis/util-network-guard';

const safe = await assertSafeUrl(rawUrl); // 抛错即拒绝；通过返回 URL
// 或只校验主机名：
await assertSafeHost(parsedUrl.hostname);
```

在 `package.json` 里声明依赖。util 用 `latest` 而非 workspace 协议，外部作者也能安装：

```json
{ "dependencies": { "@aalis/util-network-guard": "latest" } }
```

---

## 3. 谁在用（真实消费点）

`safeFetch` 已经是全仓「拉取外部 URL」的标准出口，以下是真实消费点：

| 消费点 | 场景 |
|---|---|
| OneBot 附件下载 | 入站 `http(s)://` 附件下载后 base64 内联 |
| OneBot 附件缓存 | 带 30s 超时的附件缓存拉取 |
| media 安全下载 | vision 输入下载，叠加体积上限/超时/imageOnly |
| WebUI 图片代理 | 浏览器侧代理第三方图片（带凭证规避范例，见 §5） |
| http 工具 | LLM 可调的 `http_request` / `http_download` 工具 |
| ASR（openai / whisper-cpp） | 拉远程音频转写 |
| office | 拉远程文档解析 |
| ollama | 探测/拉取 ollama 端点（带 30s 超时） |
| 策略注入方 | `plugin-authority` 读宿主配置文档：`setNetworkPolicy(config.get('network') ?? {})`，启动时注入一次 |

其中两处做法值得参考：图片代理显式不带 cookie、只给一个伪 UA；media 与 http 工具在 `safeFetch` 之外自行做体积上限与流式累计——util 只负责校验、不限制体积，详见 §5。

`pinnedLookup`、`assertAddressesSafe` 与 `assertPortAllowed` 另有一个自管连接的消费点：plugin-tool-browser 的浏览器网络闸（本进程内的 SOCKS5 服务，浏览器的全部连接经它判定后转发），见 [plugin-tool-browser](../plugins/plugin-tool-browser.md)。

---

## 4. 不是 storage URI

`http:`、`https:`、`file:` 都是 storage URI 文法的**保留 scheme**：它们走 `safeFetch` / `readExternalFile` 的专门读取路径，不当作 storage URI 解析。

这里有一个需要注意的区分：`data:` 开头时，若 `data[5] === '/'`（如 `data:/images/...`）是 **storage URI**，而 `data:image/...;base64,...` 才是 **data URI**。OneBot 附件处理对此有显式区分。storage URI 文法见 [storage-uri-grammar](../concepts/storage-uri-grammar.md)。

---

## 5. 边界情形与注意事项

**只校验，不限体积、不超时、不缓存。** util 故意不做下载侧防护。`safeFetch` 返回的是普通 `Response`，在没有 Content-Length 时全量缓冲会撑爆内存，调用方必须自己加上：

- 超时：`signal: AbortSignal.timeout(ms)`（参考 onebot、ollama 消费点）。
- 体积上限：读 `content-length` 并做流式累计中断（可参考图片代理、http 工具的 `readBodyCapped`、media 安全下载的做法）。

**跨域重定向的凭证泄漏。** `safeFetch` 每一跳都把同一个 `init` 原样重发（即 `fetch(current.href, { ...init, redirect:'manual' })`）。如果 `init.headers` 带了 `Authorization` 或 cookie，而上游 302 跳到另一个 origin，凭证会被原样发到新 origin。`safeFetch` 只保证「跳到的地方不是内网」，不保证「跳到的地方该不该看到你的 token」。对策：

- 对用户或 LLM 影响的 URL 调用 `safeFetch` 时，不要带任何凭证、cookie 或用户 referer——图片代理就显式只给一个伪 UA。
- 若确实需要带凭证，那个 URL 不应来自用户输入；或者自行禁用重定向（`maxRedirects = 0`）、比对最终 origin。

**`isPrivateAddress` 失败即危险，且只接受字面 IP。** 传入域名、空串或非法字符串一律返回 `true`。它不是域名判定器，域名或混合输入请用 `assertSafeHost`（带 DNS 解析）。

**只挡 SSRF，不是全能网络闸。** 协议只放行 `http` 和 `https`（`file:`、`gopher:` 等被拒）。它不防范：数据外泄到公网上的受信域名、上游返回的恶意内容（例如 SVG XSS，那需要 CSP 与 Content-Type 校验）、应用层鉴权。它解决的只有一件事：别让用户或 LLM 把请求打到内网、元数据或回环。

**`blockPrivate: false` 是 owner 的本地自动化逃生门，不是默认。** 关掉后，私网、回环、元数据全部放行——只在 owner 明确需要访问本机服务、且清楚风险时，在宿主配置文档（`aalis.config.yaml` 顶层 `network`，由 `api-authority` 声明）中开启。本地固定服务（ollama、onebot daemon）本就走裸 `fetch`、不过 `safeFetch`，不受策略影响。

**`allowedPorts` 只对 IPv4/IPv6 默认端口推断生效：** URL 无显式端口时按协议推断（https → 443，http → 80），有显式端口时按显式值。`denyCidrs` 当前仅支持 IPv4（`inDenyCidrs` 在非 v4 时直接放行）。

---

## 6. 交叉链接

- 威胁模型 / 为什么要走 safeFetch：[concepts/security-model](../concepts/security-model.md)（§3 safeFetch、§1 单 owner 威胁模型）
- 保留 scheme 与 storage URI 文法：[concepts/storage-uri-grammar](../concepts/storage-uri-grammar.md)
- 策略注入方与 `network` 配置：[services/authority](../services/authority.md) · `plugin-authority`
- 下载侧叠加体积/超时的范例消费者：[services/media](../services/media.md) · `plugin-tool-system` 的 http 工具
