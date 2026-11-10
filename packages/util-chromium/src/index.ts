// ============================================================
// @aalis/util-chromium — 启动 Chromium
//
// 浏览器工具与绘图共用：
// - launchChromium：两边相同的启动参数（沙箱、信号、管道等）只写在这里，调用方只加自己的参数，见 launch.ts 头注释；
//   bundledChromePath 给出 puppeteer 自带的 Chrome 在哪，供调用方判断装没装；puppeteerCliPath 给出包里的命令行脚本在哪，
//   安装时跑它，手动安装的提示里也写它。
// - installBundledChrome：下载自带的 Chrome，先装进缓存里的临时目录、装完整体改名到位，见 install.ts 头注释；命令行由调用方
//   经自己的进程服务跑。
// - OfflineRenderer：离线渲染。无头浏览器只响应调用方列出的资源、不连网，每次渲染新建并关闭浏览器上下文，
//   产出截图或逐帧定格。引擎与封网设计见 engine.ts 头注释。
// ============================================================

export type { Browser, BrowserContext, Page } from 'puppeteer';
export type { AnimationOptions, FramesResult } from './animation.js';
export {
  OfflineRenderer,
  type OfflineRendererOptions,
  type RenderClip,
  type RenderRequest,
  type RenderResource,
  RenderUnavailableError,
  StepTimeoutError,
} from './engine.js';
export { type ChromeInstallRun, installBundledChrome } from './install.js';
export {
  bundledChromePath,
  ChromiumLaunchError,
  type ChromiumLaunchOptions,
  launchChromium,
  puppeteerCliPath,
} from './launch.js';
