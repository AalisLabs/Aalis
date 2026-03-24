// @aalis/core — 公共 API 导出

export { App } from './app.js';
export { Context } from './context.js';
export { EventBus } from './events.js';
export { ServiceContainer, normalizeDependency } from './service.js';
export { ToolRegistry } from './tools.js';
export { HookRegistry } from './hooks.js';
export { CommandRegistry } from './commands.js';
export { ConfigManager } from './config.js';
export { PluginManager } from './plugin.js';
export { InMemoryFallbackService } from './memory-fallback.js';
export { Logger, getLogBuffer, onLogEntry } from './logger.js';
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
  EmbeddingService,
  AgentService,
  StreamChunkMessage,
  ToolExecuteMessage,
  ServiceDependency,
  DependencyDeclaration,
  InjectDeclaration,
  PluginMeta,
  SchemaFieldType,
  SchemaField,
  SchemaGroup,
  ConfigSchema,
  AalisEvents,
  HookContextMap,
  MiddlewareFn,
  MiddlewareNext,
  CommandContext,
  CommandDefinition,
  RegisteredCommand,
} from './types.js';
