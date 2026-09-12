# plugin-draw — 让纯文本模型画图

**包名**: `@aalis/plugin-draw`  
**源码**: `packages/plugin-draw/src/index.ts`

## 概述

让纯文本模型画图：模型编写 SVG 或 HTML+内联 CSS 标记，插件用硬化的无头浏览器渲染为 PNG；调用 `draw_animation` 时，带声明式动画（SMIL / CSS `@keyframes`）的标记会被逐帧截图，再由 ffmpeg 合成 GIF。产物落盘 `data:/images/`，由 `send_attachment` 投递进聊天。格式分工：图形、图标、梗图、动画用 SVG；图文卡片、表格、海报用 HTML+内联 CSS。渲染引擎使用独立的 Chromium 实例（懒启动、空闲关停），每次渲染开独立页面，禁用 JavaScript 并默认拦截全部网络请求，只放行 `about:blank` 与 `data:`；引擎与安全设计见 `packages/plugin-draw/src/engine.ts` 头注释。注册工具组 `draw`，含 `draw_image`（PNG）与 `draw_animation`（GIF）两个工具。

## 插件声明

```typescript
meta.name = '@aalis/plugin-draw'
meta.displayName = '绘图'
meta.subsystem = 'tools'
meta.inject = { optional: ['tools', 'storage', 'process'] }
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultWidth` | number | `800` | 默认画布宽 (px)：HTML 模式与未声明宽度的 SVG 使用的画布宽度 |
| `maxWidth` | number | `1600` | 画布宽上限 (px)：请求宽与标记声明宽都会被收口到该值 |
| `maxPixels` | number | `4000000` | 画布 CSS 像素上限：width×height（CSS 像素）上限，默认 4MP。注意实际光栅内存 = 本值 × scale²（scale 默认 2 即 4 倍）；静态图按 scale 截图，故设备像素天花板是本值的 scale² 倍——调高前算好内存 |
| `maxSourceKB` | number | `256` | 输入标记上限 (KB)：source 参数的大小上限 |
| `scale` | number | `2` | 截图缩放倍率：deviceScaleFactor：2 = 视网膜清晰度（像素翻倍，文件更大） |
| `headless` | boolean | `true` | 无头模式：调试时可关闭以观察渲染页面 |
| `executablePath` | string | `''` | Chrome 路径（留空自动探测）：留空使用 puppeteer 缓存的 Chrome（与浏览器工具共用同一份二进制，进程独立） |
| `idleShutdownSec` | number | `300` | 空闲关停 (秒)：渲染引擎空闲该时长后关停 Chromium 释放内存；0 = 常驻 |
| `maxConcurrency` | number | `2` | 渲染并发上限：同时进行的渲染任务数上限；群内多人并发画图时超出的排队，防无界 page + ffmpeg 拖垮机器 |
| `animMaxDurationSec` | number | `8` | 动图时长上限 (秒)：draw_animation 的动画时长硬上限 |
| `animDefaultFps` | number | `15` | 动图默认帧率：未显式指定 fps 时使用；上限 25 |
| `animMaxFrames` | number | `160` | 动图帧数上限：时长×帧率超出时按帧数反推有效时长 |
| `animMaxOutputMB` | number | `9` | GIF 体积上限 (MB)：超出即报错（OneBot 内联投递上限 10MB，留余量） |

## 相关

- 工具服务契约：[api/api-tools.md](../api/api-tools.md)
- 存储服务契约：[api/api-storage.md](../api/api-storage.md)
- 浏览器自动化工具（与本插件共用同一份 Chrome 二进制，进程独立）：[plugin-tool-browser.md](./plugin-tool-browser.md)
