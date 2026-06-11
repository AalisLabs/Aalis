// ============================================================
// @aalis/core — 公共 API 导出
//
// core 仅提供：
//   - 运行时基础设施（App / Context / EventBus / ServiceContainer / HookRegistry / ConfigManager / Logger / PluginManager 等）
//   - 通用 IoC 数据契约（Schema / AalisEvents / Middleware / Dependency 声明 等）
//   - 三个扩展点（ServiceCapabilityMap / AalisEvents / HookContextMap）+ PluginModule augmentation
//   - 服务能力声明框架（ServiceCapabilityMap + Probe）
//
// 所有业务/领域类型均由各 @aalis/plugin-*-api 包导出：
//   - Message / ContentSegment           → @aalis/plugin-agent-api
//   - ToolCall / ToolDefinition / ToolFunction → @aalis/plugin-tools-api
//   - LLM / Memory / Storage / Embedding / VectorStore / Tools / Commands / Gateway /
//     WebUI / Authority / Agent / Platform 等服务接口及关联业务类型同样在各自的 plugin-*-api。
// ============================================================

export type { AppOptions } from './app.js';
// ----- 运行时基础设施 -----
export { App, createApp } from './app.js';
export type { AalisConfig, ConfigManagerOptions } from './config.js';
export { CORE_CONFIG_SCHEMA, ConfigManager, ScopedConfigManager } from './config.js';
export { Context } from './context.js';
export { DisposableChain } from './disposable-chain.js';
export { EventBus } from './events.js';
export { HookRegistry } from './hooks.js';
// ----- 运行时基础类型 -----
export type { LogEntry, LogLevel } from './logger.js';
export { formatLogLine, Logger, LogHub, parseLogLine } from './logger.js';
// ----- 插件系统类型 -----
export type { ActionCaller, PluginEntry, PluginModule, PluginState } from './plugin.js';
export { PluginManager, parseInstanceId } from './plugin.js';
export type { ConfigProvider, PluginDescriptor, PluginLoader, RestartStrategy } from './providers.js';
export type { NormalizedDependency, ServiceEntry, ServicePriorityValue } from './service.js';
export { ScopedServiceContainer, ServiceContainer, ServicePriority } from './service.js';
// ----- 通用 IoC 数据契约 + 扩展点 -----
export type {
  AalisEvents,
  AppService,
  CapabilityList,
  CapabilityOf,
  ConfigSchema,
  DependencyDeclaration,
  DisposableService,
  HookContextMap,
  InjectDeclaration,
  MiddlewareFn,
  MiddlewareNext,
  PermissionId,
  PluginManagerService,
  PluginStatusEntry,
  SafetyLevel,
  SchemaArray,
  SchemaField,
  SchemaFieldType,
  SchemaGroup,
  ServiceCapabilityMap,
  ServiceDependency,
  ServiceOf,
  ServiceTypeMap,
} from './types/index.js';
// ----- 服务能力声明框架 -----
export { probeCapability, registerCapabilityProbe } from './types/index.js';
