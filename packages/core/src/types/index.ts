// ============================================================
// @aalis/core - types 子模块统一导出
//
// 四原语一人一个扩展点文件（均为 declaration merging 靶子 + 域词汇）：
//   - types/events.ts        AalisEvents（事件名 → 参数元组）
//   - types/hooks.ts         HookContextMap（钩子名 → 中间件上下文）+ Middleware 签名
//   - types/services.ts      ServiceTypeMap（服务名 → 实例接口）+ 服务依赖声明
//   - types/contributions.ts ContributionPointMap（贡献点名 → spec 类型）
// 另：types/app.ts（App 服务接口）、types/plugin.ts（插件模块词汇）、
//     types/disposable-service.ts（服务自清理协议）。
//
// 业务/领域类型一律由 plugin-*-api 包导出：
//   - Message / ContentSegment           → @aalis/schema-message
//   - ToolCall / ToolDefinition / ToolFunction → @aalis/plugin-tools-api
//   - LLM / Memory / Storage / Embedding / VectorStore / Tools / Commands / Gateway /
//     WebUI / Authority / Agent / Platform 等服务接口同样在各自的 plugin-*-api。
// ============================================================

// App 生命周期接口
export type { AppService, PluginManagerService, PluginStatusEntry } from './app.js';
// 贡献点扩展点
export type { ContributionPointMap } from './contributions.js';
// 服务自清理协议
export type { DisposableService } from './disposable-service.js';
// 事件扩展点
export type { AalisEvents } from './events.js';
// 钩子扩展点 + 中间件签名
export type { HookContextMap, MiddlewareFn, MiddlewareNext } from './hooks.js';
// 插件模块词汇
export type { InjectDeclaration } from './plugin.js';
// 服务类型注册表 + 服务依赖声明
export type { DependencyDeclaration, ServiceDependency, ServiceOf, ServiceTypeMap } from './services.js';
