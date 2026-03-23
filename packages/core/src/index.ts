// @aalis/core — 公共 API 导出

export { App } from './app.js';
export { Context } from './context.js';
export { EventBus } from './events.js';
export { ServiceContainer, normalizeDependency } from './service.js';
export { ToolRegistry } from './tools.js';
export { HookRegistry } from './hooks.js';
export { ConfigManager } from './config.js';
export { PluginManager } from './plugin.js';
export { Agent } from './agent.js';
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
  ModelInfo,
  LLMService,
  MemoryService,
  PersonaService,
  ServiceDependency,
  DependencyDeclaration,
  InjectDeclaration,
  PluginMeta,
  AalisEvents,
  HookContextMap,
  MiddlewareFn,
  MiddlewareNext,
} from './types.js';
