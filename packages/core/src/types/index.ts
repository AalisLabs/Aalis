// ============================================================
// index.ts — types 子模块统一导出
//
// 三个原语各有一个扩展点文件（declaration merging 靶子 + 域词汇）：
//   - types/events.ts        AalisEvents（事件名 → 参数元组）
//   - types/hooks.ts         HookContextMap（钩子名 → 中间件上下文）+ Middleware 签名
//   - types/contributions.ts ContributionPointMap（贡献点名 → spec 类型）
// 服务没有类型表：类型随服务描述符走（见 composition/descriptors.ts）。
// 另：types/app.ts（App 服务接口）、types/plugin.ts（插件注册表词汇）。
//
// 业务/领域类型一律由 @aalis/api-* 与 @aalis/schema-* 包导出，core 不认识任何业务类型。
// ============================================================

// App 生命周期接口
export type { AppService, PluginManagerService, PluginStatusEntry } from './app.js';
// 贡献点扩展点
export type { ContributionPointMap } from './contributions.js';
// 事件扩展点
export type { AalisEvents } from './events.js';
// 钩子扩展点 + 中间件签名
export type { HookContextMap, MiddlewareFn, MiddlewareNext } from './hooks.js';
