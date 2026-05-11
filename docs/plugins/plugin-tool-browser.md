# plugin-tool-browser — 浏览器自动化

**包名**: `@aalis/plugin-tool-browser`  
**源码**: `packages/plugin-tool-browser/src/index.ts`

## 概述

基于 Puppeteer 的无头浏览器自动化工具，AI 可导航网页、截图、点击、输入等。

## 插件声明

```typescript
meta.name = '@aalis/plugin-tool-browser'
meta.inject = {}
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `headless` | boolean | `true` | 是否无头模式 |
| `viewport` | object | `{width:1280, height:720}` | 浏览器视口尺寸 |
| `maxPages` | number | `5` | 最大并发页面数 |

## 注册工具

| 工具 | 说明 |
|---|---|
| `browser_navigate` | 导航到指定 URL |
| `browser_screenshot` | 截取当前页面截图 |
| `browser_click` | 点击页面元素 |
| `browser_input` | 在输入框中输入文本 |
| `browser_evaluate` | 在页面上下文中执行 JavaScript |
| `browser_close` | 关闭浏览器页面 |

## SSRF 防护

`blockPrivate=true` 时拒绝访问内网/本地地址。判定逻辑通过共享工具 [`isPrivateHost`](../api/plugin-tools-api.md#共享-runtime-工具utilsts) 实现，与 `plugin-tools` 的 `http` 工具组使用同一套规则（localhost、`0.0.0.0`、`::1`、`fe80::/10`、`fc00::/7`、`127/8`、`10/8`、`172.16-31/12`、`192.168/16` 等）。

`allowedHosts` 白名单优先于私网判定。
