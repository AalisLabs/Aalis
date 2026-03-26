// @aalis/core — 公共 API 导出

export { App, createApp } from './app.js';
export type { AppOptions } from './app.js';
export { Context } from './context.js';
export { EventBus } from './events.js';
export { ServiceContainer, ScopedServiceContainer, normalizeDependency } from './service.js';
export { HookRegistry } from './hooks.js';
export { ConfigManager, CORE_CONFIG_SCHEMA } from './config.js';
export { PluginManager } from './plugin.js';
export { Logger, getLogBuffer, onLogEntry } from './logger.js';
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
  PluginMeta,
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
  CommandDefinition,
  RegisteredCommand,
  // 服务接口（抽象契约，具体实现由插件提供）
  AuthorityService,
  DangerousConfirmRequest,
  DangerousConfirmHandler,
  CommandService,
  ToolService,
  // LLM 服务
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
  // 记忆服务
  MemoryService,
  ConversationTurn,
  // Embedding 服务
  EmbeddingService,
  // 向量数据库服务
  VectorSearchResult,
  VectorStoreService,
  // 人格服务
  OutputFormatField,
  OutputFormat,
  PersonaService,
  // Agent 服务
  AgentService,
  // 平台适配器
  PlatformConnection,
  PlatformAdapter,
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
} from './types/index.js';
