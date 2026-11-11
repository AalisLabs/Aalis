# plugin-draw — 让纯文本模型画图

**包名**: `@aalis/plugin-draw`  
**源码**: `packages/plugin-draw/src/index.ts`

## 概述

让纯文本模型画图：模型编写 SVG 或 HTML+内联 CSS 标记，插件用硬化的无头浏览器渲染为 PNG；调用 `draw_animation` 时，带声明式动画（SMIL / CSS `@keyframes`）的标记会被逐帧截图，再由 ffmpeg 合成 GIF。产物落盘到本插件在会话媒体目录里的子目录 `data:/images/<会话目录>/draw/`（[会话媒体的目录约定](../services/media.md#会话媒体的目录约定)），由 `send_attachment` 投递进聊天；会话 id 为空的调用回工具错误。`/clear` 与删除会话经 `memory:clear` 清这个子目录（登记清理类型 `image`，所选类型含它时，会话级清这个会话的，`/clear all` 清各会话的），存储不在时不清、不出结果行。格式分工：图形、图标、梗图、动画用 SVG；图文卡片、表格、海报用 HTML+内联 CSS。渲染引擎由 [util-chromium](../utils/util-chromium.md) 的离线渲染提供，使用独立 Chromium 实例（懒启动、空闲关停），每次渲染开独立浏览器上下文，禁用页面 JavaScript。资源只从调用者提供的内存映射读取，`data:` / `blob:` 可用；其余请求被拦截，解析规则与代理再把漏过的连接送往本机死端口。是否带 Chromium 沙箱由 `sandbox` 决定：默认不带（以 `--no-sandbox --disable-setuid-sandbox` 启动）；打开后带沙箱启动失败时，工具返回错误并写明可以在配置里关掉 `sandbox`，不回落到不带沙箱，下次渲染照样带沙箱启动。

加载、等字体、量内容高与截图各限时 15 秒，超时会关闭这一代 Chromium，同一代其他在飞任务也会失败，下次渲染重新启动；其余单条浏览器协议调用上限 30 秒。这是卡住检测，与等多久无关。浏览器随插件生命周期关闭，不接管宿主的 SIGINT 退出。注册工具组 `draw`，含 `draw_image`（PNG）与 `draw_animation`（GIF）两个工具。

两个工具都声明可转后台（让出时限用执行器的默认 30 秒）：排队与渲染久时，在前台等满让出时限还没结束就由 [plugin-tools](plugin-tools.md#转后台与后台任务) 的执行器转到后台，正常结束时通知发起它的会话。渲染请求与动图的两遍 ffmpeg 编码都带上执行器给这次调用的中止信号，编码不另设超时；中止时渲染与编码停住，结果带 `error`。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-draw',
  displayName: '绘图',
  subsystem: 'tools',
  uses: {
    tools: optional(tools),
    storage: optional(storage),
    processService: optional(processService),
    logger,
    lifecycle,
    config,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultWidth` | number | `800` | 默认画布宽 (px)：HTML 模式与未声明宽度的 SVG 使用的画布宽度 |
| `maxWidth` | number | `1600` | 画布宽上限 (px)：请求宽与标记声明宽都会被收口到该值 |
| `maxPixels` | number | `4000000` | 画布像素上限：输出图片（动图按每帧）宽×高的像素上限，默认 4MP。静态图按截图缩放倍率缩小画布，放大后仍不超过它。 |
| `maxSourceKB` | number | `256` | 输入标记上限 (KB)：source 参数的大小上限 |
| `scale` | number | `2` | 截图缩放倍率：静态图的截图倍率，2 为高清（宽高各翻倍，文件更大） |
| `headless` | boolean | `true` | 无头模式：调试时可关闭以观察渲染页面 |
| `executablePath` | string | `''` | Chrome 路径：Chrome 的绝对路径。留空时用 puppeteer 配置里的可执行文件，没配置时用 puppeteer 自带的 Chrome。 |
| `sandbox` | boolean | `false` | Chromium 沙箱：打开后 Chromium 带沙箱启动，所画标记即使攻破渲染进程也出不了沙箱。Linux 上以 root 运行或容器里没有可用的沙箱时，打开后 Chromium 无法启动。 |
| `idleShutdownSec` | number | `300` | 空闲关停（秒）：渲染引擎空闲该时长后关停 Chromium 释放内存；0 = 常驻 |
| `maxConcurrency` | number | `2` | 渲染并发上限：同时进行的渲染任务数上限，超出的排队 |
| `animMaxDurationSec` | number | `8` | 动图时长上限（秒）：draw_animation 的动画时长硬上限 |
| `animDefaultFps` | number | `15` | 动图默认帧率：未显式指定 fps 时使用；上限 25 |
| `animMaxFrames` | number | `160` | 动图帧数上限：时长×帧率超出时按帧数反推有效时长 |
| `animMaxOutputMB` | number | `9` | GIF 体积上限 (MB)：生成的 GIF 超过这个大小即报错，最大 9 |

`maxPixels` 限的是输出图片的像素数：`draw_image` 按 `scale`（即截图的 `deviceScaleFactor`）截图，画布的 CSS 像素预算为 `maxPixels ÷ scale²`，截出的 PNG 不超过 `maxPixels`；`draw_animation` 按 1 倍截帧，每帧不超过 `maxPixels`。渲染时的内存随它增长，调高前先估算内存。

`executablePath` 留空时读的 puppeteer 配置来自环境变量 `PUPPETEER_EXECUTABLE_PATH` 或 `.puppeteerrc`。

`maxConcurrency` 超出的排队、不拒绝，避免群里多人同时画图时页面无限增多拖垮机器。`animMaxOutputMB` 最大 9：OneBot 内联投递的上限是 10MB，留出余量。

显式给出无效的 `executablePath`、`headless` 或 `sandbox` 时，插件拒绝激活，不会启动浏览器。画布与动画数值仍按既有规则取整、夹到上限；低于有效下限时取字段默认值。

## 系统依赖

- **中文与 emoji 字体**：外壳文档的字体栈为 PingFang SC / Hiragino Sans GB / Noto Sans CJK SC / Apple Color Emoji，macOS 自带前两者与 Apple Color Emoji。Linux 需自行安装 Noto CJK 与 Noto Color Emoji，否则中文与 emoji 会渲染成方块。Debian / Ubuntu：`apt install fonts-noto-cjk fonts-noto-color-emoji`。
- **ffmpeg**：`draw_animation` 用 ffmpeg 把逐帧截图编码为 GIF，需在 `PATH` 中可用（Debian / Ubuntu：`apt install ffmpeg`）。只用 `draw_image` 时不需要。

## 相关

- 工具服务契约：[api/api-tools.md](../api/api-tools.md)
- 存储服务契约：[api/api-storage.md](../api/api-storage.md)
- 浏览器自动化工具（与本插件共用同一份 Chrome 二进制，进程独立）：[plugin-tool-browser.md](./plugin-tool-browser.md)
