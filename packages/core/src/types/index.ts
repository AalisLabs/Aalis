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
  ToolGroupInfo,
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
  MiddlewareNext,
  MiddlewareFn,
  CommandContext,
  CommandDefinition,
  RegisteredCommand,
  PluginGroupInfo,
  ExecutionGuardContext,
  ExecutionGuard,
} from './core.js';

// 钩子上下文（依赖 agent + llm，单独文件避免循环依赖）
export type { HookContextMap } from './hooks.js';

// 指令服务接口
export type { CommandService } from './commands.js';

// 工具服务接口
export type { ToolService } from './tools.js';

// Agent 服务
export type { AgentService, PreprocessorFn, PreprocessorInfo } from './agent.js';

// 平台适配器
export type { PlatformConnection, PlatformAdapter, PlatformManagerService } from './platform.js';

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

// LLM 服务
export type { ChatRequest, ChatResponse, ChatStreamChunk, ModelInfo, LLMService } from './llm.js';

// 记忆服务
export type { MemoryService, ConversationTurn } from './memory.js';

// 消息归档服务
export type { ArchiveIncomingResult, MessageArchiveService } from './archive.js';

// Embedding 服务
export type { EmbeddingService } from './embedding.js';

// 向量数据库服务
export type { VectorSearchResult, VectorStoreService } from './vectorstore.js';

// 人格服务
export type { OutputFormatField, OutputFormat, PersonaSessionOptions, PersonaService } from './persona.js';

// 权限服务
export type { AuthorityService, DangerousConfirmRequest, DangerousConfirmHandler } from './authority.js';

// 会话管理
export type { SessionInfo, SessionConfig, SessionTreeNode, SessionManagerService, PlatformProfile } from './session.js';
