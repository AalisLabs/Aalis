// ============================================================
// @aalis/util-offline-render — 离线渲染
//
// 作品审核与 plugin-draw 共用：无头浏览器只响应调用方列出的资源、不连网，每次渲染新建并关闭浏览器上下文，
// 产出截图或逐帧定格。引擎与封网设计见 engine.ts、launch.ts 头注释。
// ============================================================

export type { AnimationOptions, FramesResult } from './animation.js';
export {
  OfflineRenderer,
  type OfflineRendererOptions,
  type RenderClip,
  type RenderRequest,
  type RenderResource,
  StepTimeoutError,
} from './engine.js';
export { RenderUnavailableError, type SandboxPolicy } from './launch.js';
