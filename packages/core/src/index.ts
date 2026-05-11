// @aalis/core — 公共 API 导出

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
export { registerCapabilityProbe, probeCapability } from './types/index.js';
// MemoryCapabilities 已迁出至 @aalis/plugin-memory-api
// StorageCapabilities 已迁出至 @aalis/plugin-storage-api
// PlatformCapabilities 已迁出至 @aalis/plugin-platform
// LLMCapabilities 已迁出至 @aalis/plugin-llm-api
export type { PluginModule } from './plugin.js';
export type { PluginState, PluginEntry } from './plugin.js';
export type { LogLevel, LogEntry } from './logger.js';
export type { NormalizedDependency, ServiceEntry } from './service.js';
export type { AalisConfig } from './config.js';
export type {
  // 核心机制类型
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
  InboundPhaseData,
  MiddlewareFn,
  MiddlewareNext,
  CommandContext,
  CommandValueType,
  CommandArgumentDefinition,
  CommandOptionDefinition,
  CommandDefinition,
  SubcommandDefinition,
  RegisteredCommand,
  // 执行守卫
  ExecutionGuardContext,
  ExecutionGuard,
  // 服务接口（抽象契约，具体实现由插件提供）
  CommandService,
  CommandNodeInfo,
  ToolService,
  // Agent 服务
  AgentService,
  PreprocessorFn,
  PreprocessorInfo,
  // 平台适配器（已迁出至 @aalis/plugin-platform）
  // Gateway 服务（消息流编排中枢）
  GatewayService,
  PluginGroupInfo,
  // WebUI 页面骨架（WebUIService / WebuiComponent 等已迁出至 @aalis/plugin-webui-api）
  WebuiPage,
  // App 服务
  AppService,
  // LLM 服务骨架（ChatRequest/ChatStreamChunk/ModelInfo/LLMService 等已迁出至 @aalis/plugin-llm-api）
  ChatResponse,
  // 服务能力声明框架
  ServiceCapabilityMap,
  CapabilityOf,
  CapabilityList,
  // 记忆服务（已迁出至 @aalis/plugin-memory-api）
  // 存储服务（已迁出至 @aalis/plugin-storage-api）
  // 消息归档服务已迁出 core（@aalis/plugin-message-archive）
  // Embedding 服务
  EmbeddingService,
  // 向量数据库服务
  VectorSearchResult,
  VectorStoreService,
} from './types/index.js';
