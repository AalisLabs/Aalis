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
export { LLMCapabilities } from './types/index.js';
export { ImageRecognitionCapabilities } from './types/index.js';
export { WebSearchCapabilities } from './types/index.js';
export { MemoryCapabilities } from './types/index.js';
export { StorageCapabilities } from './types/index.js';
export { PlatformCapabilities } from './types/index.js';
export { MessageArchiveCapabilities } from './types/index.js';
export { SessionManagerCapabilities } from './types/index.js';
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
  // 平台适配器
  PlatformConnection,
  PlatformSelfIdentity,
  PlatformAdapter,
  PlatformService,
  PlatformCapability,
  PlatformCapabilityRegistry,
  // Gateway 服务（消息流编排中枢）
  GatewayService,
  // 流控服务
  FlowControlService,
  FlowSessionStateSnapshot,
  // 触发策略服务
  TriggerPolicyService,
  TriggerDecision,
  TriggerKind,
  PluginGroupInfo,
  // WebUI 服务
  WebUIService,
  WebuiStatComponent,
  WebuiTableComponent,
  WebuiFormComponent,
  WebuiActionsComponent,
  WebuiInfoComponent,
  WebuiMarkdownComponent,
  WebuiTabsComponent,
  WebuiComponent,
  WebuiPage,
  // CLI 服务
  CLIService,
  // App 服务
  AppService,
  // LLM 服务
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  ModelInfo,
  LLMService,
  LLMCapability,
  LLMCapabilityRegistry,
  // 服务能力声明框架
  ServiceCapabilityMap,
  CapabilityOf,
  CapabilityList,
  // 记忆服务
  MemoryService,
  MemoryCapability,
  MemoryCapabilityRegistry,
  // 存储服务
  StorageRootKind,
  StorageRootInfo,
  StorageEntry,
  StorageStat,
  StorageListResult,
  StorageReadStreamResult,
  StorageService,
  StorageCapability,
  StorageCapabilityRegistry,
  // 消息归档服务
  ArchiveIncomingResult,
  ArchiveNoticeOptions,
  MessageArchiveService,
  MessageArchiveCapability,
  MessageArchiveCapabilityRegistry,
  // Embedding 服务
  EmbeddingService,
  // 向量数据库服务
  VectorSearchResult,
  VectorStoreService,
  // 权限服务
  AuthorityService,
  DangerousConfirmRequest,
  DangerousConfirmHandler,
  DangerousConfirmResult,
  DangerousGrantRequest,
  DangerousGrant,
  // 会话管理
  SessionInfo,
  SessionConfig,
  SessionTreeNode,
  SessionManagerService,
  PlatformProfile,
  SessionManagerCapability,
  SessionManagerCapabilityRegistry,
  // 图像识别服务
  ImageRecognitionService,
  ImageRecognitionInput,
  ImageRecognitionContextOptions,
  ImageRecognitionResult,
  ImageRecognitionCapability,
  ImageRecognitionCapabilityRegistry,
  // 网络搜索服务
  WebSearchService,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
  WebSearchCapability,
  WebSearchCapabilityRegistry,
} from './types/index.js';
