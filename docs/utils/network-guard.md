# network-guard — SSRF 安全的出口校验

> 包名 **`@aalis/util-network-guard`**（纯 util，零服务、零 DI、无 `ctx`）。

把「fetch 一个**由用户 / LLM / 入站消息影响到的 URL**」这件危险事收口成安全操作：协议白名单 + 私网/回环/元数据段封锁 + DNS 全解析 + 逐跳重定向重校验。这是 Aalis 里**唯一**的「安全拉取外部 URL」助手——所有插件的外部 fetch 都**应该**走它，而不是裸 `fetch`。

它是一个 util 库：你在 `package.json` 里依赖 `@aalis/util-network-guard`，然后直接 `import` 函数调用，不经过服务注册/DI。包本身只做**校验**，不下载、不缓存、不限体积——体积上限/超时/缓存留给调用方按自己架构（流式代理 / 全 buffer 下载 / 内联 fetch）决定（`packages/util-network-guard/src/index.ts:5`、`packages/plugin-adapter-onebot/src/attachment-cache.ts:65`）。

威胁模型背景（为什么要防、防的是谁）见 [安全模型 §3 safeFetch](../concepts/security-model.md)。

---

## 1. 导出 API

均在 `packages/util-network-guard/src/index.ts`。

### `safeFetch(url, init?, maxRedirects?)` — 首选

```typescript
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects = MAX_REDIRECTS, // = 5
): Promise<Response>
```

（`index.ts:163`）SSRF 安全的 `fetch` 替代品。逐跳 `redirect:'manual'`，每跳重新跑 `assertSafeUrl`，杜绝「初始 host 受信但 30x 跳到内网」的重定向绕过。命中 30x（301/302/303/307/308）且有 `Location` 时，把 `Location` 解析成相对于当前 URL 的绝对地址再校验后续跳；非 30x 或无 `Location` 即返回该 `Response`。跳数超过 `maxRedirects` 抛 `重定向次数超过上限`。除「手动重定向 + 每跳校验」外，其余行为同原生 `fetch`——`init` 原样透传（`index.ts:166`）。

> ⚠️ **`init` 每跳原样重发**，含凭证泄漏风险，见 §5。

### `assertSafeUrl(rawUrl)` — 只校验 URL，不发请求

```typescript
export async function assertSafeUrl(rawUrl: string): Promise<URL>
```

（`index.ts:137`）校验单条 URL：必须能 `new URL()` 解析（否则抛 `非法 URL`）、协议只能 `http:`/`https:`（否则抛 `仅支持 http/https`）、命中 `allowedPorts` 策略（不在列表抛 `拒绝访问端口 N`）、host 过 `assertSafeHost`。通过返回解析后的 `URL` 对象。适合「自己管连接/流式代理，只想拿到校验过的 URL」的场景。

### `assertSafeHost(hostname)` — 只校验主机名

```typescript
export async function assertSafeHost(hostname: string): Promise<void>
```

（`index.ts:115`）校验单个 hostname 是否可安全连接，失败抛 `Error`，调用方负责转 HTTP 状态或日志。判定：

- IPv6 字面量带方括号（`[::1]`）会先剥壳再判（`index.ts:117`）。
- **字面 IP**：`blockPrivate` 开时命中私网/回环/元数据即拒；命中 `denyCidrs` 即拒（`index.ts:118-122`）。
- **`localhost` / `*.localhost` / `*.local` 主机名**：`blockPrivate` 开时直接拒（`index.ts:124`）。
- **其它域名**：`dns.lookup(host, { all: true })` 解析出**全部** A/AAAA 记录，**任意一条**命中私网或 `denyCidrs` 即拒（`index.ts:127-133`）——堵 DNS rebinding（攻击者把一个公网域名解析到内网 IP）。

### `isPrivateAddress(addr)` — 同步纯判定

```typescript
export function isPrivateAddress(addr: string): boolean
```

（`index.ts:16`）判断一个**字面 IP** 是否落在私网/回环/链路本地/元数据/多播保留段。无 DNS、无副作用、同步。命中段：

| 段 | 说明 |
|---|---|
| `10.0.0.0/8` · `172.16–31.x.x` · `192.168.0.0/16` | RFC1918 私网 |
| `127.0.0.0/8` · IPv6 `::1` | 回环 |
| `0.0.0.0/8` | 「本网络」 |
| `169.254.0.0/16` | 链路本地，**含 AWS/云元数据 `169.254.169.254`** |
| `>= 224.0.0.0` | 组播/保留 |
| IPv6 `::` · `fe80:` · `fc`/`fd`（ULA）· `::ffff:` 映射（剥壳后按 v4 再判） | IPv6 私网/链路本地 |

**关键约定：解析失败按危险处理**——`isIP(addr) === 0`（不是合法 IP 字面量）直接返回 `true`（`index.ts:18`）。所以传非 IP 字符串（域名、空串）一律得 `true`，不要拿它当域名判定器，域名要用 `assertSafeHost`。

### `setNetworkPolicy(cfg)` — 进程级策略注入（启动时一次）

```typescript
export function setNetworkPolicy(cfg: NetworkPolicyConfig): void

export interface NetworkPolicyConfig {
  blockPrivate?: boolean;   // 默认 true；本地自动化可显式 false 关私网拦截
  denyCidrs?: string[];     // 额外拒绝的 IPv4 CIDR，如 ["100.64.0.0/10"]
  allowedPorts?: number[];  // 非空时仅允许这些目标端口，如 [80, 443]；空/缺省=不限
}
```

（`index.ts:91`、`NetworkPolicyConfig` 见 `index.ts:58`）注入进程级出口策略。CIDR 在注入时**预解析**成整数 base/mask，每请求只做几条整数比对，不在热路径重复解析。默认策略 `{ blockPrivate: true, denyCidrs: [], allowedPorts: null }`（`index.ts:55`）——即**未注入时也默认拦私网**。`blockPrivate` 只有显式 `false` 才关（`cfg.blockPrivate !== false`，`index.ts:93`），`allowedPorts` 为空数组等同不限（`index.ts:95`）。无效 CIDR 会被静默过滤掉（`index.ts:94`）。

> **由谁调**：owner 在 core 配置 `network`，由 `plugin-authority` 在启动时注入一次（`packages/plugin-authority/src/index.ts:51`）。普通插件作者**不要**调它——它是进程级单例，会覆盖全局策略。配置字段语义见 `packages/plugin-authority-api/src/index.ts:300-311`。

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

只想拿校验过的 `URL`（自己管连接，例如流式代理）：

```typescript
import { assertSafeUrl, assertSafeHost } from '@aalis/util-network-guard';

const safe = await assertSafeUrl(rawUrl); // 抛错即拒绝；通过返回 URL
// 或只校验主机名：
await assertSafeHost(parsedUrl.hostname);
```

`package.json` 里声明依赖（util 用 `latest`，不是 workspace 协议，外部作者也装得上）：

```json
{ "dependencies": { "@aalis/util-network-guard": "latest" } }
```

---

## 3. 谁在用（真实消费点）

`safeFetch` 已是全仓「拉外部 URL」的标准出口，范例：

| 消费点 | 场景 | file:line |
|---|---|---|
| OneBot 附件下载 | 入站 `http(s)://` 附件下载后 base64 内联 | `packages/plugin-adapter-onebot/src/attachments.ts:60` |
| OneBot 附件缓存 | 带 30s 超时的附件缓存拉取 | `packages/plugin-adapter-onebot/src/attachment-cache.ts:112` |
| media 安全下载 | vision 输入下载，叠加体积上限/超时/imageOnly | `packages/plugin-media/src/safe-fetch.ts:51` |
| WebUI 图片代理 | 浏览器侧代理第三方图片（**带凭证规避范例**，见 §5） | `packages/plugin-webui-server/src/routes/proxy.ts:31` |
| http 工具 | LLM 可调的 `http_request` / `http_download` 工具 | `packages/plugin-tool-system/src/tools/http.ts:101`、`:194` |
| ASR（openai / whisper-cpp） | 拉远程音频转写 | `packages/plugin-asr-openai/src/index.ts:65`、`packages/plugin-asr-whisper-cpp/src/index.ts:73` |
| office | 拉远程文档解析 | `packages/plugin-office/src/utils.ts:16` |
| ollama | 探测/拉取 ollama 端点（带 30s 超时） | `packages/plugin-ollama/src/index.ts:615` |
| 策略注入方 | `setNetworkPolicy(ctx.config.get('network') ?? {})` 启动一次 | `packages/plugin-authority/src/index.ts:51` |

> 范例值得抄的两处模式：图片代理 `proxy.ts:33` 显式**不带 cookie、只给伪 UA**；media 与 http 工具在 `safeFetch` 之外**自行做体积上限 + 流式累计**（util 只校验、不限体积，见 §5）。

---

## 4. 不是 storage URI

`http:` / `https:` / `file:` 都是 storage URI 文法的**保留 scheme**：它们走 `safeFetch` / `readExternalFile` 的专门读取路径，不当 storage URI 解析（`packages/plugin-storage-api/src/index.ts:269`）。容易踩的坑：`data:` 开头时 `data[5] === '/'`（`data:/images/...`）是 **storage URI**，而 `data:image/...;base64,...` 才是 data URI——OneBot 附件处理对此显式区分（`packages/plugin-adapter-onebot/src/attachments.ts:46`）。storage URI 文法见 [storage-uri-grammar](../concepts/storage-uri-grammar.md)。

---

## 5. 边界与坑

**只校验，不限体积/不超时/不缓存。** util 故意不做下载侧防护（`index.ts:5`）。`safeFetch` 返回的是普通 `Response`，**无 Content-Length 时全量缓冲会撑爆内存**——调用方必须自己加：

- 超时：`signal: AbortSignal.timeout(ms)`（见 onebot/ollama 消费点）。
- 体积上限：读 `content-length` + **流式累计中断**（见 `proxy.ts:71-89`、`tools/http.ts` 的 `readBodyCapped`、`media/safe-fetch.ts:74-88`）。

**⚠️ 跨域重定向凭证泄漏（审计点）。** `safeFetch` 每一跳都把**同一个 `init` 原样重发**（`index.ts:166`：`fetch(current.href, { ...init, redirect:'manual' })`）。若 `init.headers` 带了 `Authorization` / cookie，而上游 302 跳到**另一个 origin**，**凭证会被原样发到新 origin**。`safeFetch` 只保证「跳到的地方不是内网」，**不保证「跳到的地方该不该看到你的 token」**。对策：

- 对**用户/LLM 影响的 URL** 调 `safeFetch` 时**不带任何凭证/cookie/用户 referer**——图片代理就显式只给一个伪 UA（`proxy.ts:33`）。
- 真要带凭证，那个 URL 不应来自用户输入；或自行禁用重定向（`maxRedirects = 0`）/ 比对最终 origin。

**`isPrivateAddress` 失败即危险，且只吃字面 IP。** 传域名/空串/非法字符串一律返回 `true`（`index.ts:18`）——它不是域名判定器，域名/混合输入用 `assertSafeHost`（带 DNS 解析）。

**只挡 SSRF，不是全能网络闸。** 协议只放 `http`/`https`（`file:`/`gopher:` 等被拒，`index.ts:144`）。它不防：数据外泄到**公网**受信域名、上游返回的恶意内容（如 SVG XSS——那要 CSP/Content-Type 校验，见 `proxy.ts:60-63`）、应用层鉴权。它解决的就一件事：**别让用户/LLM 把请求打到内网/元数据/回环**。

**`blockPrivate:false` 是 owner 的本地自动化逃生门，不是默认。** 关掉后私网/回环/元数据全部放行——只在 owner 明确需要访问本机服务且清楚风险时由 core 配置开启。本地固定服务（ollama / onebot daemon）本就走裸 `fetch` 不过 `safeFetch`，不受策略影响（`packages/plugin-authority/src/index.ts:50`、`packages/plugin-authority-api/src/index.ts:302`）。

**`allowedPorts` 只对 IPv4/IPv6 默认端口推断生效**：URL 无显式端口时按协议推断（https→443，http→80），有显式端口按显式值（`index.ts:148`）。`denyCidrs` 当前**仅 IPv4**（`inDenyCidrs` 在非 v4 时直接放行，`index.ts:101`）。

---

## 6. 交叉链接

- 威胁模型 / 为什么要走 safeFetch：[concepts/security-model](../concepts/security-model.md)（§3 safeFetch、§1 单 owner 威胁模型）
- 保留 scheme 与 storage URI 文法：[concepts/storage-uri-grammar](../concepts/storage-uri-grammar.md)
- 策略注入方与 `network` 配置：[services/authority](../services/authority.md) · `plugin-authority`（`packages/plugin-authority/src/index.ts:49`）
- 下载侧叠加体积/超时的范例消费者：[services/media](../services/media.md) · `plugin-tool-system` 的 http 工具
