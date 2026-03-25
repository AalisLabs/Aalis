// @aalis/core — 公共 API 导出

export { App, createApp } from './app.js';
export type { AppOptions } from './app.js';
export { Context } from './context.js';
export { EventBus } from './events.js';
export { ServiceContainer, ScopedServiceContainer, normalizeDependency } from './service.js';
export { ToolRegistry } from './tools.js';
export { HookRegistry } from './hooks.js';
export { CommandRegistry } from './commands.js';
export { AuthorityManager } from './authority.js';
export type { DangerousConfirmRequest, DangerousConfirmHandler } from './authority.js';
export { ConfigManager, CORE_CONFIG_SCHEMA } from './config.js';
export { PluginManager } from './plugin.js';
export { InMemoryFallbackService } from './memory-fallback.js';
export { Logger, getLogBuffer, onLogEntry } from './logger.js';
export { builtinAuthority, builtinCommands, builtinTools, builtinLifecycle } from './builtin/index.js';
export type { PluginModule } from './plugin.js';
export type { PluginState, PluginEntry } from './plugin.js';
export type { LogLevel, LogEntry } from './logger.js';
export type { NormalizedDependency, ServiceEntry } from './service.js';
export type { AalisConfig } from './config.js';
export type {
  Message,
  IncomingMessage,
  OutgoingMessage,
  ToolFunction,
  ToolDefinition,
  ToolCall,
  ToolCallContext,
  RegisteredTool,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
  MemoryService,
  VectorSearchResult,
  VectorStoreService,
  PersonaService,
  OutputFormat,
  OutputFormatField,
  EmbeddingService,
  AgentService,
  AppService,
  WebUIService,
  CLIService,
  PlatformConnection,
  PlatformAdapter,
  StreamChunkMessage,
  ToolExecuteMessage,
  ServiceDependency,
  DependencyDeclaration,
  InjectDeclaration,
  ExtendDeclaration,
  PluginMeta,
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
  SafetyLevel,
  ToolSummary,
  UserIdentity,
  WebuiPage,
} from './types.js';
