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
