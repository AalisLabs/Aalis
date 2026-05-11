// ============================================================
// @aalis/core - types 子模块统一导出
//
// 仅包含 core 自身定义的：
//   - 核心消息/工具/指令/Schema 数据契约（types/core.ts）
//   - 钩子扩展点（types/hooks.ts，仅空 HookContextMap）
//   - 服务能力声明框架（types/capabilities.ts）
//   - App 服务接口（types/app.ts）
//
// 业务服务接口（LLM / Memory / Storage / Embedding / VectorStore /
// Tools / Commands / Gateway / WebUI / Authority / Agent / Platform 等）
// 均由对应 `@aalis/plugin-*-api` 包导出，不再经由 core 中转。
// ============================================================

// 核心机制类型
export type {
  SafetyLevel,
  PermissionId,
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
} from './core.js';

// 钩子上下文扩展点（空接口；由各 plugin-*-api 通过 declaration merging 注入业务键）
export type { HookContextMap } from './hooks.js';

// App 生命周期接口
export type { AppService } from './app.js';

// 服务能力声明框架
export type { ServiceCapabilityMap, CapabilityOf, CapabilityList, CapabilityProbe } from './capabilities.js';
export { registerCapabilityProbe, probeCapability } from './capabilities.js';
