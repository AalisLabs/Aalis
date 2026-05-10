// types/ 统一导出入口
// 核心机制类型
export type {
  SafetyLevel,
  UserIdentity,
  ContentSegment,
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
  CommandValueType,
  CommandArgumentDefinition,
  CommandOptionDefinition,
  CommandDefinition,
  SubcommandDefinition,
  RegisteredCommand,
  PluginGroupInfo,
  ExecutionGuardContext,
  ExecutionGuard,
} from './core.js';

// 钩子上下文（依赖 agent + llm，单独文件避免循环依赖）
export type { HookContextMap, InboundPhaseData } from './hooks.js';

// 指令服务接口
export type { CommandService, CommandNodeInfo } from './commands.js';

// 工具服务接口
export type { ToolService } from './tools.js';

// Agent 服务
export type { AgentService, PreprocessorFn, PreprocessorInfo } from './agent.js';

// 平台适配器
export type { PlatformConnection, PlatformSelfIdentity, PlatformAdapter, PlatformService, PlatformCapability, PlatformCapabilityRegistry } from './platform.js';
export { PlatformCapabilities } from './platform.js';

// Gateway 服务（消息流编排中枢）
export type { GatewayService } from './gateway.js';

// 流控服务（每会话计数/冷却/限速/闲置调度）
export type { FlowControlService, FlowSessionStateSnapshot } from './flow-control.js';

// 触发策略服务（@/名字/间隔/评分 决策）
export type { TriggerPolicyService, TriggerDecision, TriggerKind } from './trigger-policy.js';

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
export type { ChatRequest, ChatResponse, ChatStreamChunk, ModelInfo, LLMService, LLMCapability, LLMCapabilityRegistry } from './llm.js';
export { LLMCapabilities } from './llm.js';

// 服务能力声明框架
export type { ServiceCapabilityMap, CapabilityOf, CapabilityList, CapabilityProbe } from './capabilities.js';
export { registerCapabilityProbe, probeCapability } from './capabilities.js';

// 网络搜索服务
export type {
  WebSearchService,
  WebSearchRequest,
  WebSearchResponse,
  WebSearchResult,
  WebSearchCapability,
  WebSearchCapabilityRegistry,
} from './web-search.js';
export { WebSearchCapabilities } from './web-search.js';

// 记忆服务
export type { MemoryService, MemoryCapability, MemoryCapabilityRegistry } from './memory.js';
export { MemoryCapabilities } from './memory.js';

// 存储服务
export type {
  StorageRootKind,
  StorageRootInfo,
  StorageEntry,
  StorageStat,
  StorageListResult,
  StorageReadStreamResult,
  StorageService,
  StorageCapability,
  StorageCapabilityRegistry,
} from './storage.js';
export { StorageCapabilities } from './storage.js';

// Embedding 服务
export type { EmbeddingService } from './embedding.js';

// 向量数据库服务
export type { VectorSearchResult, VectorStoreService } from './vectorstore.js';

// 会话管理
export type {
  SessionInfo,
  SessionConfig,
  SessionTreeNode,
  SessionManagerService,
  PlatformProfile,
  SessionManagerCapability,
  SessionManagerCapabilityRegistry,
} from './session.js';
export { SessionManagerCapabilities } from './session.js';
