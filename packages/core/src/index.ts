// ============================================================
// @aalis/core — 公共 API 导出
//
// core 仅提供：
//   - 运行时基础设施（App / Context / EventBus / ServiceContainer / HookRegistry / ConfigManager / Logger / PluginManager 等）
//   - 核心数据契约（Message / ToolDefinition / ToolCall / Schema / AalisEvents 等）
//   - 三个扩展点（ServiceCapabilityMap / AalisEvents / HookContextMap）+ Context.extend / PluginModule augmentation
//   - 服务能力声明框架（ServiceCapabilityMap + Probe）
//
// 所有业务服务接口（LLM / Memory / Storage / Embedding / VectorStore /
// Tools / Commands / Gateway / WebUI / Authority / Agent / Platform 等）以及它们的关联业务类型
//（RegisteredTool / ToolGroupInfo / CommandDefinition / CommandContext 等）由对应 `@aalis/plugin-*-api` 包导出。
// ============================================================

export type { AppOptions } from './app.js';
// ----- 运行时基础设施 -----
export { App, createApp } from './app.js';
export type { AalisConfig } from './config.js';
export { CORE_CONFIG_SCHEMA, ConfigManager, ScopedConfigManager } from './config.js';
export { Context } from './context.js';
export { DisposableChain } from './disposable-chain.js';
export { EventBus } from './events.js';
export { HookRegistry } from './hooks.js';
export { getMessageName, getSenderLabel, prefixSender } from './identity.js';
// ----- 运行时基础类型 -----
export type { LogEntry, LogLevel } from './logger.js';
export { getLogBuffer, isConsoleLogSinkEnabled, Logger, onLogEntry, setConsoleLogSinkEnabled } from './logger.js';
export type { MixinEntry } from './mixin-registry.js';
export { MixinRegistry } from './mixin-registry.js';
export type { ModelRef } from './model-ref.js';
export { formatModelRef, parseModelRef } from './model-ref.js';
// ----- 插件系统类型 -----
export type { PluginEntry, PluginModule, PluginState } from './plugin.js';
export { PluginManager, parseInstanceId } from './plugin.js';
export type { NormalizedDependency, ServiceEntry } from './service.js';
export { ScopedServiceContainer, ServiceContainer } from './service.js';
// ----- 核心数据契约 + 扩展点 -----
export type {
  AalisEvents,
  AppService,
  CapabilityList,
  CapabilityOf,
  ConfigSchema,
  ContentSegment,
  DependencyDeclaration,
  DisposableService,
  ExtendDeclaration,
  HookContextMap,
  IncomingMessage,
  InjectDeclaration,
  Message,
  MiddlewareFn,
  MiddlewareNext,
  OutgoingMessage,
  PermissionId,
  SafetyLevel,
  SchemaArray,
  SchemaField,
  SchemaFieldType,
  SchemaGroup,
  ServiceCapabilityMap,
  ServiceDependency,
  StreamChunkMessage,
  ToolCall,
  ToolCallContext,
  ToolDefinition,
  ToolExecuteMessage,
  ToolFunction,
  UserIdentity,
} from './types/index.js';
// ----- 服务能力声明框架 -----
export { probeCapability, registerCapabilityProbe } from './types/index.js';
