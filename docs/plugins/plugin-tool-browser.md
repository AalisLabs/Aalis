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
| `maxPages` | number | `5` | 最大页面数：同时打开的最大标签页数量。超出后关闭最早打开的页面。 |
| `executablePath` | string | `''` | Chrome 路径：自定义 Chrome/Chromium 可执行文件路径。留空则使用 Puppeteer 内置 Chromium。 |
| `maxContentLength` | number | `50000` | 最大内容长度：返回给 Agent 的页面文本最大字符数。 |
| `blockPrivate` | boolean | `true` | 封锁内网与本地：拒绝 localhost / 127.x / ::1 / 10.x / 172.16-31.x / 192.168.x / 169.254.x / 0.0.0.0，防止 SSRF。 |
| `allowedProtocols` | multiselect | `["http","https"]` | 允许的协议：浏览器只允许访问这些协议的 URL。 |
| `allowedHosts` | multiselect | `[]` | 主机白名单：允许访问的主机（含内网时需在此显式列出）。留空 = 仅按 blockPrivate 判定。 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `browser_navigate` | 打开指定 URL（可用 pageId 复用标签页、用 waitFor 等待 CSS 选择器），返回 pageId、标题、URL 和截断后的页面文本 |
| `browser_get_text` | 获取页面文本，可按 CSS 选择器取特定元素 |
| `browser_click` | 点击页面元素 |
| `browser_type` | 在输入框中输入文本（默认先清空，可选回车提交） |
| `browser_screenshot` | 对指定页面截图（可截整页或指定元素）。PNG 一律先落在 `tmp` 根，文本结果恒带 `storage_uri`；调用方能把图交给主模型时，PNG 同时随工具结果的 `images` 交出。两种情况下文本结果都不含 base64（见下节） |
| `browser_get_links` | 获取页面上的链接（href 与文本，默认上限 50） |
| `browser_close_page` | 关闭指定页面 |

## SSRF 防护

`browser_navigate` 打开 URL 前先做校验：协议须在 `allowedProtocols` 内；`blockPrivate=true` 时再用 `isPrivateHost` 做字符串级私网判定，这一步不解析域名。

`blockPrivate=true` 时，每个新建页面还开启请求拦截，覆盖点击、表单提交、重定向和子资源：每个 http(s) 请求都经 `assertSafeHost` 做 DNS 级判定，未通过的请求被中止；非 http(s) 请求（`data:`、`blob:`、`about:` 等）直接放行。拦截内的判定遵循进程级网络策略（core 配置 `network` 的 `blockPrivate` / `denyCidrs`）。`blockPrivate=false` 时不做私网判定，也不开启请求拦截。

两个判定函数均来自 `@aalis/util-network-guard`，私网段清单见 [network-guard](../utils/network-guard.md)。

`allowedHosts` 的条目与小写化后的主机名（不含端口）做精确比较，不支持通配或网段；命中即跳过上述私网判定，仅在 `blockPrivate=true` 时生效。

## 截图的交付形态

`browser_screenshot` 的 PNG **一律先落盘**到 `tmp:/browser/{会话目录}/shot-{内容 sha256 前 16 位}.png`（会话 id 里的 `:` `/` `\` 替换为 `_`），文本结果里恒带 `storage_uri`，附带的说明按两条路分写：调用方能把图交给主模型时（agent 工具循环，`acceptsImages`），PNG 随结果的 `images` 一并交出，说明是「图已随结果附上；若你看不到图，用 storage_uri 走 analyze_image / send_attachment」；接不住图的调用方拿不到 `images`，说明是「图未随结果附上，用 storage_uri 走 analyze_image / send_attachment 查看」。

base64 任何情况下都不进文本结果：整张 PNG 的 base64 有几十万字符，主模型看不到图，还会灌满上下文并落进历史。落盘失败时才退回「只给 `images`」；若此时调用方也接不住图，工具直接返回错误。

文件名取内容哈希，同一张图反复截图落在同一个文件上（零增量）。**这些文件不会自动清理**：`tmp` 根下的 `browser/` 目录由使用者自行清理（或交给宿主对 `tmp` 根的清理策略），插件既不设 TTL 也不在拆卸时删。

## 浏览器实例

Chromium 按需启动，进程级共享一个实例与一张页面表。取实例时检查连接是否存活：崩溃或被杀之后再调工具会重新启动浏览器，并清空页面表（此前的 `pageId` 随之失效，需重新 `browser_navigate`）。
