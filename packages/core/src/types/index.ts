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

// 平台适配器（已迁出至 @aalis/plugin-platform）
// export type { PlatformConnection, PlatformSelfIdentity, PlatformAdapter, PlatformService, PlatformCapability, PlatformCapabilityRegistry } from './platform.js';
// export { PlatformCapabilities } from './platform.js';

// Gateway 服务（消息流编排中枢）
export type { GatewayService } from './gateway.js';

// WebUI 页面骨架（WebUIService / WebuiComponent / 各 Webui*Component 已迁出至 @aalis/plugin-webui-api）
export type { WebuiPage } from './webui.js';

// CLI 服务（已迁出至 @aalis/plugin-cli）
// 会话管理（已迁出至 @aalis/plugin-session-manager）

// App 服务
export type { AppService } from './app.js';

// LLM 骨架（ChatRequest/ChatStreamChunk/ModelInfo/LLMService/LLMCapability 等已迁出至 @aalis/plugin-llm-api）
export type { ChatResponse } from './llm.js';

// 服务能力声明框架
export type { ServiceCapabilityMap, CapabilityOf, CapabilityList, CapabilityProbe } from './capabilities.js';
export { registerCapabilityProbe, probeCapability } from './capabilities.js';

// 记忆服务（已迁出至 @aalis/plugin-memory-api）

// 存储服务（已迁出至 @aalis/plugin-storage-api）

// Embedding 服务（已迁出至 @aalis/plugin-embedding-api）

// 向量数据库服务（已迁出至 @aalis/plugin-vectorstore-api）

// 会话管理已迁移至 @aalis/plugin-session-manager
