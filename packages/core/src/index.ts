// ============================================================
// @aalis/core — 公共 API 导出
//
// core 仅提供：
//   - 运行时基础设施（App / Context / EventBus / ServiceContainer / HookRegistry / ConfigManager / Logger / PluginManager 等）
//   - 核心数据契约（Message / Tool* / Command* / Schema / AalisEvents 等）
//   - 三个扩展点（ServiceCapabilityMap / AalisEvents / HookContextMap）+ Context.extend / PluginModule augmentation
//   - 服务能力声明框架（ServiceCapabilityMap + Probe）
//
// 所有业务服务接口（LLM / Memory / Storage / Embedding / VectorStore /
// Tools / Commands / Gateway / WebUI / Authority / Agent / Platform 等）
// 由对应 `@aalis/plugin-*-api` 包导出。
// ============================================================

// ----- 运行时基础设施 -----
export { App, createApp } from './app.js';
export type { AppOptions } from './app.js';
export { INBOUND_PHASE, INBOUND_PHASE_ORDER } from './constants.js';
export type { InboundPhase } from './constants.js';
export { Context } from './context.js';
export { EventBus } from './events.js';
export { ServiceContainer, ScopedServiceContainer } from './service.js';
export { HookRegistry } from './hooks.js';
export { ConfigManager, CORE_CONFIG_SCHEMA } from './config.js';
export { PluginManager, parseInstanceId } from './plugin.js';
export { Logger, getLogBuffer, onLogEntry, setConsoleLogSinkEnabled, isConsoleLogSinkEnabled } from './logger.js';
export { getSenderLabel, prefixSender, getMessageName } from './identity.js';
export { parseModelRef, formatModelRef } from './model-ref.js';
export type { ModelRef } from './model-ref.js';
export { DisposableChain } from './disposable-chain.js';
export { MixinRegistry } from './mixin-registry.js';
export type { MixinEntry } from './mixin-registry.js';
export { PendingRegistrationBuffer } from './pending-buffer.js';

// ----- 服务能力声明框架 -----
export { registerCapabilityProbe, probeCapability } from './types/index.js';

// ----- 插件系统类型 -----
export type { PluginModule, PluginState, PluginEntry } from './plugin.js';

// ----- 运行时基础类型 -----
export type { LogLevel, LogEntry } from './logger.js';
export type { NormalizedDependency, ServiceEntry } from './service.js';
export type { AalisConfig } from './config.js';

// ----- 核心数据契约 + 扩展点 -----
export type {
  Message,
  IncomingMessage,
  OutgoingMessage,
  StreamChunkMessage,
  ToolExecuteMessage,
  ContentSegment,
  ToolFunction,
  ToolDefinition,
  ToolCall,
  ToolCallContext,
  RegisteredTool,
  ToolSummary,
  ToolGroupInfo,
  SafetyLevel,
  PermissionId,
  UserIdentity,
  ServiceDependency,
  DependencyDeclaration,
  InjectDeclaration,
  ExtendDeclaration,
  SchemaFieldType,
  SchemaField,
  SchemaGroup,
  SchemaArray,
  ConfigSchema,
  AalisEvents,
  HookContextMap,
  MiddlewareFn,
  MiddlewareNext,
  CommandContext,
  CommandValueType,
  CommandArgumentDefinition,
  CommandOptionDefinition,
  CommandDefinition,
  SubcommandDefinition,
  RegisteredCommand,
  AppService,
  ServiceCapabilityMap,
  CapabilityOf,
  CapabilityList,
} from './types/index.js';
