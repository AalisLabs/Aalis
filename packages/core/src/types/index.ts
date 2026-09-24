// ============================================================
// index.ts — types 目录统一导出
//
// 扩展点只有 types/events.ts 的 AalisEvents（事件名 → 参数元组，declaration merging 靶子）。
// 服务没有类型表：类型随服务描述符走（见 composition/descriptors.ts）。钩子与贡献点的扩展点
// 随它们的契约包（@aalis/api-hooks / @aalis/api-contributions）走。
// 另：types/app.ts（App 服务接口）、types/plugin.ts（插件注册表词汇）。
//
// 业务/领域类型一律由 @aalis/api-* 与 @aalis/schema-* 包导出，core 不认识任何业务类型。
// ============================================================

// App 生命周期接口
export type { AppService, PluginManagerService, PluginStatusEntry } from './app.js';
// 事件扩展点
export type { AalisEvents } from './events.js';
