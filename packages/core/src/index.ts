// ============================================================
// @aalis/core — 公共 API 导出
//
// core 仅提供：
//   - 运行时基础设施（App / Context / EventBus / ServiceContainer / HookRegistry / ConfigManager / Logger / PluginManager 等）
//   - 通用 IoC 数据契约（Schema / AalisEvents / Middleware / Dependency 声明 等）
//   - 扩展点（AalisEvents / HookContextMap / ServiceTypeMap / ContributionPointMap）+ PluginModule augmentation
//
// 所有业务/领域类型均由各 @aalis/plugin-*-api 包导出：
//   - Message / ContentSegment           → @aalis/schema-message
//   - ToolCall / ToolDefinition / ToolFunction → @aalis/api-tools
//   - LLM / Memory / Storage / Embedding / VectorStore / Tools / Commands / Gateway /
//     WebUI / Authority / Agent / Platform 等服务接口及关联业务类型同样在各自的 plugin-*-api。
// ============================================================

// ----- Context 基础：门面、配置、日志 -----
export type { AalisConfig, ConfigManagerOptions, ConfigProvider } from './context/config.js';
export { ConfigManager } from './context/config.js';
// 注：Lifecycle / DisposableChain 是 Context 内部的资源生命周期实现，不从包根导出（零外部消费，
// 无 semver 承诺）；dist 里的深路径同样不在承诺面。
export { Context, type ModuleHandle } from './context/context.js';
export type { LogEntry, LogLevel } from './context/logger.js';
export { DefaultLogger, formatLogLine, type Logger, LogHub, parseLogLine } from './context/logger.js';
// ----- 编排层：应用骨架与插件管理 -----
export type { AppOptions } from './orchestration/app.js';
export { App, createApp } from './orchestration/app.js';
export type { PluginEntry, PluginModule, PluginState } from './orchestration/plugin.js';
export { PluginManager, parseInstanceId } from './orchestration/plugin.js';
// 宿主 SPI：插件加载器与重启策略（ConfigProvider 随 ConfigManager 在上一节）
export type { PluginDescriptor, PluginLoader, RestartStrategy } from './orchestration/providers.js';
// ----- 四原语 -----
export { type ContributionHandle, ContributionRegistry, type ContributionSpec } from './primitives/contributions.js';
export { EventBus } from './primitives/events.js';
export { HookRegistry } from './primitives/hooks.js';
export type { NormalizedDependency, ServiceEntry, ServiceView } from './primitives/services.js';
export { ServiceContainer } from './primitives/services.js';
// ----- 通用 IoC 数据契约 + 扩展点 -----
export type {
  AalisEvents,
  AppService,
  ContributionPointMap,
  DependencyDeclaration,
  DisposableService,
  HookContextMap,
  InjectDeclaration,
  MiddlewareFn,
  MiddlewareNext,
  PluginManagerService,
  PluginStatusEntry,
  ServiceDependency,
  ServiceOf,
  ServiceTypeMap,
} from './types/index.js';
