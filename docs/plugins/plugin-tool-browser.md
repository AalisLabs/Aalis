# plugin-tool-browser — 浏览器自动化

**包名**: `@aalis/plugin-tool-browser`  
**源码**: `packages/plugin-tool-browser/src/index.ts`

## 概述

基于 Puppeteer 的浏览器自动化工具（默认无头模式，可由 `headless` 关闭），为 AI 提供导航、获取页面文本与链接、截图、点击、输入等工具。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-tool-browser',
  displayName: '浏览器工具',
  subsystem: 'tools',
  uses: {
    config,
    logger,
    lifecycle,
    tools: optional(tools),
    webui: optional(webuiServer),
    proc: optional(processService),
    storage: optional(storage),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `headless` | boolean | `true` | 无头模式：是否以无头模式运行浏览器（无 GUI 窗口）。 |
| `defaultTimeout` | number | `30000` | 默认超时(ms)：页面导航和操作的默认超时时间。 |
| `viewportWidth` | number | `1280` | 视口宽度 |
| `viewportHeight` | number | `720` | 视口高度 |
| `maxPages` | number | `5` | 最大页面数：同时打开的最大页面数量。超出后关闭最早打开的页面。 |
| `executablePath` | string | `''` | Chrome 路径：自定义 Chrome/Chromium 可执行文件路径。留空则使用 Puppeteer 内置 Chromium。 |
| `maxContentLength` | number | `50000` | 最大内容长度：返回给 Agent 的页面文本最大字符数。 |
| `blockPrivate` | boolean | `true` | 封锁内网与本地：拒绝 localhost / 127.x / ::1 / 10.x / 172.16-31.x / 192.168.x / 169.254.x / 0.0.0.0，防止 SSRF。 |
| `allowedProtocols` | multiselect | `["http","https"]` | 允许的协议：浏览器只允许访问这些协议的 URL。 |
| `allowedHosts` | multiselect | `[]` | 主机白名单：允许访问的主机（含内网时需在此显式列出）。留空 = 仅按 blockPrivate 判定。 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `browser_navigate` | 打开指定 URL（可用 pageId 复用已有页面、用 waitFor 等待 CSS 选择器），返回 pageId、标题、URL 和截断后的页面文本 |
| `browser_get_text` | 获取页面文本，可按 CSS 选择器取特定元素 |
| `browser_click` | 点击页面元素 |
| `browser_type` | 在输入框中输入文本（默认先清空，可选回车提交） |
| `browser_screenshot` | 对指定页面截图（可截整页或指定元素）。PNG 一律先落在 `tmp` 根，文本结果恒带 `storage_uri`；调用方能把图交给主模型时，PNG 同时随工具结果的 `images` 交出。两种情况下文本结果都不含 base64（见下节） |
| `browser_get_links` | 获取页面上的链接（href 与文本，默认上限 50） |
| `browser_close_page` | 关闭指定页面 |

## SSRF 防护

`browser_navigate` 打开 URL 前先做校验：协议须在 `allowedProtocols` 内；`blockPrivate=true` 时再用 `isPrivateHost` 做字符串级私网判定，这一步不解析域名。

`blockPrivate=true` 时，插件在本进程的 `127.0.0.1` 随机端口起一道网络闸（只支持无认证 CONNECT 的 SOCKS5 服务），浏览器以 `--proxy-server` 把全部 TCP 连接交给它，并以 `--proxy-bypass-list=<-loopback>` 撤掉 Chrome 让 localhost、回环与链路本地地址默认绕过代理的规则。页面、页面用 `window.open` 打开的窗口，以及 dedicated / shared / service worker 发出的连接都经过它，包括导航、点击与表单提交、重定向的每一跳、子资源、`fetch` 与 WebSocket。每个连接先按进程级网络策略的 `allowedPorts` 判定目标端口（`allowedHosts` 里的主机也不例外），再按目标主机判定：

- `allowedHosts` 里的主机按名字直连，不做私网判定；
- IP 字面量须是规范写法（Chrome 交出的都是），含 zone id 或不是规范写法的 IPv6 字面量直接拒绝，其余经 `assertAddressesSafe` 判定；
- 域名经 `pinnedLookup` 解析，全部地址通过判定后，连接只用这次解析得到的地址。判定与连接之间不再解析第二次，DNS 重绑定（判定时解析到公网地址、连接时解析到内网地址）因此无效。

判定不过、解析失败或连接失败，浏览器侧的请求都以 `net::ERR_SOCKS_CONNECTION_FAILED` 失败；`browser_navigate` 遇到这个错误时在报错后附一句说明，指出目标可能被 `blockPrivate` 拦截。判定遵循进程级网络策略，即宿主配置文档 `network` 字段的 `blockPrivate`、`denyCidrs` 与 `allowedPorts` 三项。WebRTC 以 `--webrtc-ip-handling-policy=disable_non_proxied_udp` 启动，不发不经代理的 UDP（以随附的 Chrome 实测；`executablePath` 指向较旧的 Chrome 时未核实）。

闸在首次启动浏览器之前起好，此后一直监听到插件停用；起不来时报错、不启动浏览器，下次调用重试，浏览器不会在没有闸的情况下运行。闸不做认证，本机进程都可以连到它，经它连接的目标同样按上述规则判定；问候与请求 10 秒内没有收齐的连接会被断开。插件停用时先关闭闸并断开全部在途连接，再关闭页面与浏览器，闸的关闭不等浏览器关闭落定。浏览器的全部流量经插件所在进程转发，打开重页面、视频时会多占该进程的 CPU，闸解析域名用的 `dns.lookup` 占用 libuv 线程池，域名多的页面可能与同进程的文件 I/O 争用线程；走代理后 Chrome 不使用 QUIC，也不再使用系统代理设置，出站连接由插件所在进程直连目标。`blockPrivate=false` 时不做私网判定，也不起闸，进程级网络策略不作用于浏览器。

Chrome 自带的本地网络访问限制只对浏览器直连的请求起作用：经闸的连接由闸解析目标，浏览器无从判断目标属于内网还是公网。本插件的防护不以它为前提。

判定函数均来自 `@aalis/util-network-guard`，私网段清单见 [network-guard](../utils/network-guard.md)。

`allowedHosts` 的条目与小写化后的主机名（不含端口）做精确比较，不支持通配或网段；IPv6 字面量带方括号写（如 `[::1]`）。命中即跳过上述私网判定，仅在 `blockPrivate=true` 时生效。

## 截图的交付形态

`browser_screenshot` 的 PNG **一律先落盘**到 `tmp:/browser/{会话目录}/shot-{内容 sha256 前 16 位}.png`（会话 id 里的 `:` `/` `\` 替换为 `_`），文本结果里恒带 `storage_uri`，附带的说明按两条路分写：调用方能把图交给主模型时（agent 工具循环，`acceptsImages`），PNG 随结果的 `images` 一并交出，说明是「图已随结果附上；若你看不到图，可把 storage_uri 交给看图工具（如有）或 send_attachment」；接不住图的调用方拿不到 `images`，说明是「图未随结果附上，可把 storage_uri 交给看图工具（如有）查看或 send_attachment 发送」。

base64 任何情况下都不进文本结果：整张 PNG 的 base64 有几十万字符，主模型看不到图，还会灌满上下文并落进历史。落盘失败时才退回「只给 `images`」；若此时调用方也接不住图，工具直接返回错误。

文件名取内容哈希，同一张图反复截图落在同一个文件上（零增量）。**这些文件不会自动清理**：`tmp` 根下的 `browser/` 目录由使用者自行清理（或交给宿主对 `tmp` 根的清理策略），插件既不设 TTL 也不在拆卸时删。

## 浏览器实例

Chromium 按需启动，进程级共享一个实例与一张页面表；并发的首次调用共用同一次启动。取实例时检查连接是否存活：崩溃或被杀之后再调工具会重新启动浏览器，并清空页面表（此前的 `pageId` 随之失效，需重新 `browser_navigate`）。插件停用时若浏览器正在启动，启动完成后随即关闭，发起启动的调用返回错误。

每个页面（`pageId`）独占一个浏览器窗口，`headless=false` 时即各自一个系统窗口。`browser_click`、`browser_type` 与 `browser_screenshot` 操作前先把目标页切到前台：页面自己用 `window.open` 或 `target=_blank` 开出的窗口会把原页压到后台，而无头 Chrome 的后台页不做渲染，点击、默认先清空的输入与按选择器截图会一直等不到结果。
