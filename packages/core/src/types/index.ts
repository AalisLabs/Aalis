// types/ 统一导出入口
// 核心机制类型
export type {
  SafetyLevel,
  UserIdentity,
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
  MiddlewareNext,
  MiddlewareFn,
  HookContextMap,
  CommandContext,
  CommandDefinition,
  RegisteredCommand,
} from './core.js';

// LLM 服务
export type {
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
  LLMService,
} from './llm.js';

// 记忆服务
export type { MemoryService } from './memory.js';

// Embedding 服务
export type { EmbeddingService } from './embedding.js';

// 向量数据库服务
export type { VectorSearchResult, VectorStoreService } from './vectorstore.js';

// 人格服务
export type { OutputFormatField, OutputFormat, PersonaService } from './persona.js';

// Agent 服务
export type { AgentService } from './agent.js';

// 平台适配器
export type { PlatformConnection, PlatformAdapter } from './platform.js';

// WebUI 服务与声明式页面组件
export type {
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
} from './webui.js';

// CLI 服务
export type { CLIService } from './cli.js';

// App 服务
export type { AppService } from './app.js';
