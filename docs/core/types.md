# 核心类型定义

所有核心模块和插件之间共享的类型契约。

> ⚠️ **类型归属说明（2025 重构后）**：
> 自 cleanup-1 ~ cleanup-4 起，**所有业务服务接口**（`LLMService` / `MemoryService` / `StorageService` / `EmbeddingService` / `VectorStoreService` / `ToolService` / `CommandService` / `GatewayService` / `WebUIService` / `AuthorityService` / `AgentService`）以及它们的关联类型（`ChatResponse` / `ChatRequest` / `WebuiPage` / `ExecutionGuard*` / `PluginGroupInfo` 等）**已迁出 core**，分别归属到对应的 `@aalis/plugin-*-api` 包。详见 [api 包架构](../design/api-packages.md)。
>
> 本文档保留接口定义文本以供查阅，但**实际源码不再位于 packages/core**。
> core 仅保留：消息类型 / 配置类型 / 插件元信息 / 服务能力声明框架 / 3 个空扩展点（`ServiceCapabilityMap` / `AalisEvents` / `HookContextMap`）。

**源码**: `packages/core/src/types/*.ts`（已拆分为独立文件，`index.ts` 为 barrel export）；业务服务接口源码请到 `packages/plugin-*-api/src/index.ts` 查阅。

---

## 消息类型

### Message

统一的消息结构，用于 LLM 对话上下文和记忆存储。

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  timestamp?: number;
  reasoningContent?: string | null;
  segments?: ContentSegment[];        // 助手输出的有序时间线
  images?: string[];                  // 多模态 LLM 图片 (base64/URL)
  metadata?: Record<string, unknown>; // 来源标记等，不发送给 LLM
}

type ContentSegment =
  | { type: 'text'; content: string }
  | { type: 'reasoning_text'; content: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; result?: string; startTime?: number; endTime?: number };
```

### IncomingMessage

平台适配器传递到 Agent 的入站消息。

```typescript
interface IncomingMessage {
  content: string;
  sessionId: string;
  platform: string;
  userId?: string;
  nickname?: string;
  images?: string[];
  files?: Array<{ name: string; data: string; mimeType?: string }>;
  attachmentOrder?: Array<'image' | 'file'>;
  _imageDescriptions?: string[];
  _fileDescriptions?: string[];
  _imageRecognitionInfo?: { imageCount: number; successCount: number; descriptions: string[]; transformedContent: string };
  sessionType?: 'group' | 'private' | 'channel';
  source?: string;
  groupName?: string;
  groupId?: string;
  replyTo?: { messageId: string; content?: string; userId?: string; nickname?: string };
  noticeType?: string;
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle';
}
```

### OutgoingMessage / StreamChunkMessage / ToolExecuteMessage

```typescript
interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  reasoningContent?: string;
  segments?: ContentSegment[];
  source?: 'agent' | 'system' | 'command';
}

interface StreamChunkMessage {
  sessionId: string;
  platform?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
  toolLimitReached?: boolean;
}

interface ToolExecuteMessage {
  sessionId: string;
  platform?: string;
  toolName: string;
  args: Record<string, unknown>;
  phase: 'start' | 'end';
  result?: string;
}
```

---

## 工具类型

### ToolDefinition / ToolCall

```typescript
interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}

interface ToolFunction {
  name: string;
  strict?: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
```

### RegisteredTool / ToolSummary / ToolGroupInfo

```typescript
interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
  pluginName: string;
  authority?: number;                 // 默认 1
  safety?: SafetyLevel;               // 默认 'safe'
  permissions?: PermissionId[];       // 静态权限，如 tool:file.write
  resolvePermissions?: (args: Record<string, unknown>, ctx: ToolCallContext) => PermissionId[] | Promise<PermissionId[]>;
  groups?: string[];                  // 分组，如 'system', 'code-runner'
}

interface ToolSummary {
  name: string;
  description: string;
  groups?: string[];
  permissions?: PermissionId[];
}

interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  enabledGroups?: string[];           // 当前平台启用的工具分组
}

interface ToolGroupInfo {
  name: string;
  label: string;
  description?: string;
  pluginName: string;
}
```

### ToolService

```typescript
interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, pluginName: string): () => void;
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
  getSummaries(filter?: { groups?: string[] }): ToolSummary[];
  getAll(): Array<{ name: string; description: string; pluginName: string; authority?: number; safety?: SafetyLevel; permissions?: string[]; groups?: string[] }>;
  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string>;
  setExecutionGuard(guard: ExecutionGuard): void;
  unregisterByPlugin(pluginName: string): void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
  getGroups(): ToolGroupInfo[];
}
```

---

## 服务接口

### LLMService

大语言模型服务。

```typescript
interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  model?: string;                     // 覆盖模型
  provider?: string;                  // 精确指定 provider (contextId)
  signal?: AbortSignal;
  think?: boolean;                    // 启用扩展思考
}

interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  reasoningContent?: string | null;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

interface ModelInfo {
  id: string;
  capabilities: LLMCapability[];
  provider?: string;
  contextId?: string;
  contextLength?: number;
}

interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  getContextLength(): number;
  listModels?(): Promise<ModelInfo[]>;
  getDefaultModelId?(): string | undefined;
}
```

### LLM 能力常量

```typescript
const LLMCapabilities = {
  Chat: 'chat',
  ToolCalling: 'tool_calling',
  Streaming: 'streaming',
  Vision: 'vision',
  Thinking: 'thinking',
  Router: 'router',
} as const;
```

### AgentService

对话编排引擎。

```typescript
interface AgentService {
  handleMessage(message: IncomingMessage): Promise<void>;
  abort?(sessionId: string): void;
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;
  getPreprocessors?(): PreprocessorInfo[];
  getPluginGroups?(): PluginGroupInfo[];
}

type PreprocessorFn = (message: IncomingMessage, next: () => Promise<void>) => Promise<void>;
```

### MemoryService

会话记忆存储（以 sessionId 为粒度）。

```typescript
interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
  clearAll?(): Promise<void>;
  trimHistory?(sessionId: string, keepRecent: number): Promise<number>;
  getFullHistory?(sessionId: string, limit?: number): Promise<Message[]>;

  // 范围查询（供向量检索上下文窗口扩展）
  getMessagesBySessionRange?(sessionId: string, fromTs: number, toTs: number, roles?: Array<Message['role']>): Promise<Message[]>;

  // 结构化元数据
  saveMetadata?(namespace: string, key: string, data: Record<string, unknown>): Promise<void>;
  getMetadata?(namespace: string, key: string): Promise<Record<string, unknown> | undefined>;
  listMetadata?(namespace: string): Promise<Array<{ key: string; data: Record<string, unknown> }>>;
  deleteMetadata?(namespace: string, key: string): Promise<void>;

  // 消息内容更新
  updateMessageContent?(sessionId: string, oldText: string, newText: string, recentLimit?: number): Promise<number>;
}
```

### Memory 能力常量

```typescript
const MemoryCapabilities = {
  History: 'history',
  Metadata: 'metadata',
  ContentUpdate: 'content-update',
} as const;
```

### StorageService

文件存储抽象层。

详见 `packages/core/src/types/storage.ts`

```typescript
interface StorageRoot {
  name: string;        // workspace, tmp, data, pluginData, logs...
  path: string;
  label: string;
  kind: string;
  browsable: boolean;
  readable: boolean;
  writable: boolean;
  deletable: boolean;
}

interface StorageService {
  listRoots(): StorageRoot[];
  resolveLocalPath(uri: string, access: 'read' | 'write' | 'delete'): Promise<string>;
  readFile(uri: string, encoding?: string): Promise<string | Buffer>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  delete(uri: string): Promise<void>;
  stat(uri: string): Promise<FileStat>;
  list(uri: string): Promise<{ root: StorageRoot; path: string; entries: DirEntry[] }>;
  createReadStream(uri: string): Promise<{ stream: NodeJS.ReadableStream }>;
}
```

### VectorStoreService / EmbeddingService

```typescript
interface VectorStoreService {
  add(vector: number[], metadata: Record<string, unknown>): Promise<void>;
  search(queryVector: number[], topK: number): Promise<VectorSearchResult[]>;
  searchBatch?(queries: Array<{ vector: number[]; topK: number }>): Promise<VectorSearchResult[][]>;
  delete?(metadata: Record<string, unknown>): Promise<number>;
  size(): Promise<number>;
  clear(): Promise<void>;
  save(): Promise<void>;
}

interface VectorSearchResult {
  score: number;
  metadata: Record<string, unknown>;
}

interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  listModels?(): Promise<string[]>;
}
```

### PersonaService

人设/角色卡管理。

```typescript
interface PersonaService {
  getSystemPrompt(): string;
  getPersonaName(): string;
  getOutputFormat?(): OutputFormat | undefined;
  isTimeInjectionEnabled?(): boolean;
  listModels?(): Promise<string[]>;
}

interface OutputFormat {
  fields: Record<string, OutputFormatField>;
  replyField: string;
}

interface OutputFormatField {
  description: string;
  reply?: boolean;
}
```

### PlatformAdapter

平台适配器。

```typescript
interface PlatformAdapter {
  adapterName: string;
  platform: string;
  getConnections(): PlatformConnection[];
  sendMessage(sessionId: string, content: string): Promise<void>;
  isReady?(): boolean;
}

interface PlatformConnection {
  id: string;
  platform: string;
  selfId?: string;
  status: 'online' | 'offline' | 'connecting';
  detail?: Record<string, unknown>;
}
```

### WebUIService / CLIService

```typescript
interface WebUIService {
  getPort(): number;
  getHost(): string;
  setClientDir?(dir: string): void;
}

interface CLIService {
  getSessionId(): string;
  isRunning(): boolean;
}
```

---

## 配置 Schema

Aalis 的配置 Schema 体系用于声明插件配置项，同时驱动 WebUI 自动生成表单。

### SchemaField

```typescript
type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect' | 'textarea';

interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;
  options?: Array<{ label: string; value: string | number }>;
  dynamicOptions?: string;      // 填服务名，运行时调用 service.listModels()
  dynamicProviders?: string;    // 填服务名，获取所有提供者列表
  allowCustom?: boolean;        // multiselect 允许手动输入自定义值
}
```

### SchemaGroup / SchemaArray / ConfigSchema

```typescript
interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}

interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  items: Record<string, SchemaField>;
  default?: unknown[];
}

type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;
```

---

## 事件与钩子类型

### AalisEvents

内置事件类型映射表，支持 declaration merging 扩展。

```typescript
interface AalisEvents {
  'inbound:message': [message: IncomingMessage];
  'inbound:message:archived': [data: { sessionId: string; incoming: IncomingMessage; archivedMessage: Message }];
  'outbound:message': [message: OutgoingMessage];
  'outbound:stream': [chunk: StreamChunkMessage];
  'tool:execute': [info: ToolExecuteMessage];
  'service:registered': [name: string, capabilities: string[]];
  'service:unregistered': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  'ready': [];
  'app:started': [];
  'dispose': [];
  'restarting': [];
  'app:starting': [];
  'app:stopping': [];
  'session:created': [session: SessionInfo];
  'session:updated': [session: SessionInfo];
  'session:completed': [session: SessionInfo];
  'session:deleted': [sessionId: string];
  'session:switched': [sessionId: string];
  'gateway:phase:done': [data: { phase: string; reachedEnd: boolean; durationMs: number; sessionId: string; platform: string }];
  [key: string]: unknown[];
}
```

### HookContextMap

内置钩子数据类型映射表。Gateway 入站使用命名相位替代旧版单一钩子 + 数字优先级。

```typescript
interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  agent: AgentService | undefined;
}

interface HookContextMap {
  // 预处理
  'agent:input:before': { message: IncomingMessage; metadata: Record<string, unknown> };

  // Gateway 入站命名相位（按顺序串行执行，任一 swallow 即停止）
  'inbound:command': InboundPhaseData;       // 指令解析
  'inbound:flow': InboundPhaseData;          // 流控闸门
  'inbound:trigger': InboundPhaseData;       // 触发策略
  'inbound:dispatch': InboundPhaseData;      // 默认派发到 agent

  // Gateway 出站
  'outbound:dispatch': { message: OutgoingMessage; metadata: Record<string, unknown> };

  // Agent 回复周期
  'agent:turn:after': {
    message: IncomingMessage;
    reply: string;
    outcome: 'replied' | 'silent' | 'aborted';
    sessionId: string;
    metadata: Record<string, unknown>;
  };

  // LLM 调用
  'agent:llm:before': { messages: Message[]; tools: ToolDefinition[]; sessionId?: string; userId?: string; platform?: string; triggerType?: IncomingMessage['triggerType'] };
  'agent:llm:after': { response: ChatResponse; messages: Message[] };

  // 工具调用
  'agent:tool:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'agent:tool:after': { name: string; result: string; toolCallContext: ToolCallContext };

  // 最终回复
  'agent:reply:before': { content: string; archiveContent?: string; sessionId: string; platform?: string; userId?: string; triggerType?: IncomingMessage['triggerType'] };

  // 记忆清除
  'memory:clear': {
    scope: 'session' | 'all';
    types?: string[];
    sessionId?: string;
    results: Array<{ source: string; success: boolean; message: string }>;
    rollbacks: Array<{ source: string; fn: () => Promise<void> }>;
  };
}
```

> 历史上的 `gateway:inbound` / `gateway:outbound` / `agent:route` 钩子已废弃。
> 入站请使用 `inbound:*` 命名相位，出站请使用 `outbound:dispatch`。

### MiddlewareFn / MiddlewareNext

```typescript
type MiddlewareNext = () => Promise<void>;
type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;
```

---

## 执行守卫

### ExecutionGuard / ExecutionGuardContext

```typescript
interface ExecutionGuardContext {
  name: string;
  type: 'command' | 'tool';
  authority: number;
  safety: SafetyLevel;
  permissions?: PermissionId[];
  sessionId: string;
  platform: string;
  userId?: string;
  args?: Record<string, unknown>;
  skipSafetyCheck?: boolean;
}

type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;
// 返回 null = 放行，返回 string = 拦截（值为提示消息）
```

---

## 依赖声明

### InjectDeclaration / ExtendDeclaration

```typescript
interface InjectDeclaration {
  required?: DependencyDeclaration[];
  optional?: DependencyDeclaration[];
}

type DependencyDeclaration = string | ServiceDependency;

interface ServiceDependency {
  service: string;
  capabilities?: string[];
}

interface ExtendDeclaration {
  events?: string[];
  hooks?: string[];
  mixins?: Record<string, string[]>;
}
```

---

## 指令系统

### CommandDefinition / SubcommandDefinition / CommandContext

```typescript
interface CommandDefinition {
  name: string;
  description: string;
  authority?: number;
  safety?: SafetyLevel;
  permissions?: PermissionId[];
  arguments?: CommandArgumentDefinition[];
  options?: CommandOptionDefinition[];
  usage?: string;
  examples?: string[];
  action: (ctx: CommandContext) => Promise<string | void>;
  subcommands?: SubcommandDefinition[];
}

interface SubcommandDefinition {
  name: string;
  description: string;
  authority?: number;
  safety?: SafetyLevel;
  permissions?: PermissionId[];
  arguments?: CommandArgumentDefinition[];
  options?: CommandOptionDefinition[];
  usage?: string;
  examples?: string[];
  action?: (ctx: CommandContext) => Promise<string | void>;
  subcommands?: SubcommandDefinition[];
}

interface CommandContext {
  sessionId: string;
  platform: string;
  userId?: string;
  args: string[];
  operands?: Record<string, unknown>;
  options?: Record<string, unknown>;
  raw: string;
  skipSafetyCheck?: boolean;
}

interface CommandArgumentDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'text';
  description?: string;
  required?: boolean;
  variadic?: boolean;
}

interface CommandOptionDefinition {
  name: string;
  alias?: string | string[];
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string[]';
  description?: string;
  choices?: string[];
  default?: unknown;
  required?: boolean;
}

type SafetyLevel = 'safe' | 'dangerous';
type PermissionId = string;
```
