# 核心类型定义

所有核心模块和插件之间共享的类型契约。

> ⚠️ **类型归属说明（2025 重构后）**：
> 自 cleanup-1 ~ cleanup-4 起，**所有业务服务接口**（`LLMModel`（per-model entry，取代旧 `LLMService`）/ `MemoryService` / `StorageService` / `EmbeddingService` / `VectorStoreService` / `ToolService` / `CommandService` / `GatewayService` / `WebUIService` / `AuthorityService` / `AgentService`）以及它们的关联类型（`ChatModelRequest` / `ChatResponse` / `WebuiPage` / `ExecutionGuard*` / `PluginGroupInfo` 等）**已迁出 core**，分别归属到对应的 `@aalis/plugin-*-api` 包。详见 [api 包架构](../design/api-packages.md)。
>
> 本文档保留接口定义文本以供查阅，但**实际源码不再位于 packages/core**。
> core 仅保留：通用 IoC 数据契约（配置 Schema / 依赖声明 / 中间件 / `AalisEvents`）、App 生命周期接口、服务自清理协议（`DisposableService`），以及 3 个空扩展点（`AalisEvents` / `HookContextMap` / `ServiceTypeMap`）——后者供各 `plugin-*-api` 通过 declaration merging 注入「服务名 → 服务接口」。
>
> 注：0.5.0 已**移除内核的「服务能力选择/匹配」层**——`ServiceCapabilityMap` / `getServiceCapabilities` / 按能力筛选服务的整套机制不再存在。服务选择只走「偏好 > 优先级 > 注册顺序」；领域级筛选（如按 LLM 模型能力）由各 `*-api` 的 helper 自理，不进内核 DI。

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
  visibility?: CapabilityVisibility;  // 主能力默认可见性（轴 A；缺省 public）；restricted 须被 owner/委托授予
  confirm?: CapabilityConfirm;        // 确认要求（轴 B，与 visibility 正交、owner 也生效）：'session'/'always'；缺省=不确认
  risk?: CapabilityRisk;              // 风险等级（声明糖）：展开为 (visibility, confirm) 默认；显式 visibility/confirm 覆盖
  groups?: string[];                  // 分组，如 'system', 'code-runner'
}

interface ToolSummary {
  name: string;
  description: string;
  groups?: string[];
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
  getAll(): Array<{
    name: string;
    description: string;
    pluginName: string;
    visibility: CapabilityVisibility;  // 生效默认可见性（缺省 public）；可被 authorityOverrides 调整
    confirm?: CapabilityConfirm;        // 生效确认要求（轴 B）；缺省=不确认
    risk?: CapabilityRisk;              // 原始风险声明（透传，供 authority 派生 minTier）
    groups?: string[];
  }>;
  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string>;
  setExecutionGuard(guard: ExecutionGuard): void;
  unregisterByPlugin(pluginName: string): void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
  getGroups(): ToolGroupInfo[];
}
```

---

## 服务接口

### LLM 服务（per-model entry）

大语言模型服务。`@aalis/plugin-llm-api`。

> service-granularity 重构后：不再有单一 `LLMService` facade / `chat({ model, provider })` 路由。
> 每个 model 是 ServiceContainer `'llm'` 服务名下独立的 entry（`LLMModel`），其 `capabilities`
> 诚实反映该 model 的实际能力。provider 插件在 `apply()` 期间按 `listModels()` 结果为**每个 model**
> 单独 `ctx.provide('llm', modelHandle, {...})`。消费方用 `resolveLLMModel(ctx, ref, caps)` 解析出
> 一个 entry 再调 `handle.chat(...)`——request 不含 model/provider 字段，entry 已绑定具体 (provider, model)。

```typescript
/** Per-model chat request：不再含 model/provider —— entry 已绑定。 */
interface ChatModelRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  think?: boolean;                    // 启用扩展思考
}

interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  reasoningContent?: string | null;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** 工具调用增量进度（非完整 ToolCall，仅用于 UI 提示「正在生成」）。 */
interface ToolCallProgress {
  index: number;                      // tool_calls[i].index
  name: string;                       // 已确定的函数名
  charsAccumulated: number;           // 已累积的 arguments JSON 字符数
}

interface ChatStreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCalls?: ToolCall[];
  toolCallProgress?: ToolCallProgress; // 与 toolCalls 互斥：前者增量提示，后者最终结果
  done?: boolean;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** 上送给前端的 model 元数据快照（capabilities 用宽松 string[] 以便跨插件共享自定义能力）。 */
interface ModelInfo {
  id: string;
  capabilities: string[];
  provider?: string;
  contextId?: string;
  contextLength?: number;
}

/** 单个 LLM model 的 service entry（'llm' 服务名下一条 entry）。 */
interface LLMModel {
  readonly id: string;                // model id（provider 内唯一，如 'gpt-4o'）
  readonly providerId: string;        // 所属 provider 的 contextId（plugin instanceId）
  readonly contextLength: number;     // 上下文窗口 tokens
  readonly maxOutputTokens?: number;  // provider 建议的最大输出 token
  readonly capabilities: readonly LLMCapability[]; // 该 model 的能力元数据
  chat(request: ChatModelRequest): Promise<ChatResponse>;
  chatStream?(request: ChatModelRequest): AsyncIterable<ChatStreamChunk>;
  /** 让 webui 触发该 provider 重新探测远端模型列表并 diff 当前已注册 entries（可选）。 */
  refresh?(): Promise<{ added: string[]; removed: string[]; total: number }>;
}

/** ServiceContainer 中一个 'llm' entry 的完整快照（与 ctx.getAllServices 返回形状一致）。 */
interface LLMModelEntry {
  instance: LLMModel;
  contextId: string;
  label?: string;
}

/** LLM model 引用：`{ provider, model }` 二元组，由 ConfigSchema type='llm-ref' 字段统一编辑。 */
interface ModelRef {
  provider?: string;                  // provider 的 contextId（plugin instanceId）
  model?: string;                     // model id
}
```

解析 / 列举 helper（取代旧 `LLMService.listModels` / `getDefaultModelId`）：

```typescript
/** 列出（可按能力过滤的）LLM model entries，供 /model 列表与前端下拉用。 */
function listLLMModels(ctx: Context, opts?: { caps?: readonly LLMCapability[] }): LLMModelEntry[];

/** 把 ref 解析为最匹配的 LLMModel entry（provider+model → provider → model → 首个满足 caps）。 */
function resolveLLMModel(
  ctx: Context,
  ref?: ModelRef | null,
  requiredCaps?: LLMCapability[],
): LLMModelEntry | undefined;
```

### LLM 能力常量

```typescript
interface LLMCapabilityRegistry {
  Chat: 'chat';
  ToolCalling: 'tool_calling';
  Streaming: 'streaming';
  Vision: 'vision';
  Thinking: 'thinking';
  Audio: 'audio';                       // 原生音频理解
  AudioTranscription: 'audio_transcription'; // 专门的语音转文本
  Video: 'video';                       // 原生视频理解
}
type LLMCapability = LLMCapabilityRegistry[keyof LLMCapabilityRegistry];

const LLMCapabilities = {
  Chat: 'chat',
  ToolCalling: 'tool_calling',
  Streaming: 'streaming',
  Vision: 'vision',
  Thinking: 'thinking',
  Audio: 'audio',
  AudioTranscription: 'audio_transcription',
  Video: 'video',
} as const satisfies LLMCapabilityRegistry;
```

> 这些 capability 是 model handle 的元数据（`instance.capabilities`），仅用于展示/列举与 `*-api` 的 helper 过滤，**不参与内核 DI 服务选择**。

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

### StorageService

文件存储抽象层。`@aalis/plugin-storage-api`。

> service-granularity 之后每个 storage 后端按 root 拆出独立 entry
> （`contextId = ${plugin-instance-id}/${root.name}`），无 router facade。
> 按 URI / root 名查询由纯函数 helper（`getStorageEntries` / `resolveStorageByPath` /
> `createStorageGateway` 等）完成。StorageService **不是沙箱**：`resolveLocalPath`
> 一旦把绝对路径交给子进程，子进程能访问当前 OS 用户可访问的任何文件。

```typescript
type StorageRootKind = 'workspace' | 'data' | 'tmp' | 'pluginData' | 'logs' | string;

interface StorageRootInfo {
  name: string;        // 根 ID，如 workspace、data、tmp
  label?: string;      // 展示名称
  kind: StorageRootKind;
  browsable: boolean;  // 是否允许通过通用文件浏览 UI 展示
  readable: boolean;   // 默认是否允许读
  writable: boolean;   // 默认是否允许写
  deletable: boolean;  // 默认是否允许删除
}

interface StorageEntry {
  name: string; path: string; uri: string;
  isDirectory: boolean; size: number; mtime: string; ext: string;
}

interface StorageStat {
  name: string; path: string; uri: string;
  isDirectory: boolean; size: number; mtime: string; birthtime: string; ext: string;
}

interface StorageListResult {
  root: StorageRootInfo;
  path: string;
  entries: StorageEntry[];
}

interface StorageReadStreamResult {
  stream: Readable;          // node:stream Readable
  stat: StorageStat;
}

/** 文件变化事件（当前统一上报 'change'，含创建/修改/删除）。 */
interface StorageWatchEvent {
  type: 'change';
  uri: string;               // 完整 storage URI
  path: string;              // 根内相对路径
}
type StorageWatchListener = (event: StorageWatchEvent) => void;
type StorageUnwatch = () => void;

interface StorageService {
  listRoots(): StorageRootInfo[];
  list(uri: string): Promise<StorageListResult>;
  stat(uri: string): Promise<StorageStat>;
  readFile(uri: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  createReadStream(uri: string): Promise<StorageReadStreamResult>;
  writeFile(uri: string, data: string | Buffer): Promise<void>;
  rename(uri: string, newName: string): Promise<string>;
  delete(uri: string): Promise<void>;
  /** 解析为本机绝对路径（给 shell / code-runner 等子进程用）；远程/纯虚拟根可能不提供。 */
  resolveLocalPath?(uri: string, access?: 'read' | 'write' | 'delete'): Promise<string>;
  /** 监听 URI（文件或目录）下的变化，返回取消函数；远程/纯虚拟根可能不提供。 */
  watch?(uri: string, listener: StorageWatchListener): StorageUnwatch;
}
```

存储能力常量 + helper：

```typescript
type StorageCapability = 'list' | 'read' | 'write' | 'delete' | 'local-path' | 'watch';
const StorageCapabilities = {
  List: 'list', Read: 'read', Write: 'write',
  Delete: 'delete', LocalPath: 'local-path', Watch: 'watch',
} as const;

interface StorageProviderEntry {
  instance: StorageService;
  contextId: string;
  label?: string;
}

function getStorageEntries(ctx: Context): StorageProviderEntry[];
function resolveStorageByPath(ctx, uri, requiredCaps?): StorageProviderEntry | undefined;
/** 构造一个按 URI 路由到对应 entry 的 StorageService 网关（不注册到容器）。 */
function createStorageGateway(ctx: Context): StorageService;
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
// core 内置的字段类型注册表（declaration merging 扩展点）：
// 带业务/宿主语义的类型由 api 包注入，如 'llm-ref' 来自 @aalis/plugin-llm-api
interface SchemaFieldTypes {
  string: true; number: true; boolean: true;
  select: true; multiselect: true; textarea: true;
}
type SchemaFieldType = keyof SchemaFieldTypes & string;

// core 只声明环境中立字段
interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  options?: Array<{ label: string; value: string | number }>;
}

// WebUI 表单交互属性由 @aalis/plugin-webui-api 通过 declaration merging 注入：
//   secret?: boolean;        // 敏感字段，前端自动遮蔽
//   dynamicOptions?: string; // 动态选项来源服务名（运行时调 service.listModels()）
//   allowCustom?: boolean;   // multiselect 允许手动输入自定义值
// 插件使用这些属性需依赖并导入 @aalis/plugin-webui-api（type-only 即可）。
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

core 自身只声明通用 IoC / 生命周期事件；业务事件（消息 / 工具 / 会话 / gateway）由各 `plugin-*-api` 通过 declaration merging 注入。

```typescript
// core 内置（packages/core/src/types/core.ts）
interface AalisEvents {
  'service:registered': [name: string];
  'service:unregistered': [name: string];
  // 某服务偏好 provider 切换（preferService / unpreferService）；whenService 借此重挂
  'service:preference-changed': [name: string];
  'plugin:loaded': [name: string];
  'plugin:unloaded': [name: string];
  'plugins:changed': [];
  'ready': [];
  'app:started': [];        // 应用启动完成，适合 CLI/TUI 接管终端
  'restarting': [];
  'app:starting': [];       // start() 开头，服务检查/路由注册之前
  'app:stopping': [];       // stop() 开头，拓扑逆序 dispose 之前
}

// 由 api 包注入的业务事件示例（declaration merging）：
//   @aalis/plugin-message-api  → 'inbound:message' / 'inbound:message:archived' / 'outbound:message' / 'outbound:stream'
//   @aalis/plugin-tools-api    → 'tool:execute'
//   @aalis/plugin-gateway-api  → 'gateway:phase:done'
//   @aalis/plugin-session-manager → 'session:created' / 'session:updated' / 'session:completed' / ...
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
  'inbound:confirm': InboundPhaseData;       // 会话内待确认回复拦截（Y/YS/否）；命中即吞掉、不 abort 在途生成
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
    outcome: 'replied' | 'silent' | 'aborted' | 'error';
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
  'agent:reply:before': {
    content: string;
    archiveContent?: string;
    sessionId: string;
    platform?: string;
    userId?: string;
    triggerType?: IncomingMessage['triggerType'];
    retryRequested?: boolean;  // 中间件检测到回复不满足约束（如 outputFormat 解析失败）时置 true 触发重试
    retryFeedback?: string;    // 重试时附给模型的反馈系统消息内容（仅 retryRequested 时生效）
    attempt?: number;          // 当前已重试次数（首次进入为 0）
    maxRetries?: number;       // 中间件期望的最大重试次数（缺省 0 = 不重试）
  };

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
  visibility: CapabilityVisibility;   // 主能力生效可见性（注册时已由 resolveCapabilityPolicy 展开 risk/默认）
  risk?: CapabilityRisk;              // 原始风险声明（透传，供 authority 派生 minTier）；缺省回退 visibility
  confirm?: CapabilityConfirm;        // 生效确认要求（轴 B，与 visibility/等级 正交、owner 也生效）；缺省=不确认
  sessionId: string;
  platform: string;
  userId?: string;
  args?: Record<string, unknown>;
  skipConfirm?: boolean;              // 受信系统源（scheduler）：仍走 authorize，仅跳过交互确认弹窗
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
}

interface ExtendDeclaration {
  events?: string[];
  hooks?: string[];
  mixins?: Record<string, string[]>;
}
```

---

## 指令系统（v2 — 链式 builder）

`@aalis/plugin-commands-api`。

> v2 设计：单一 `Command` 类型，层级用 name 的点路径表达（`'memory.clear.all'`）；
> builder API `useCommandService(ctx).command(name).option().action()`；
> 位置参数用 inline DSL 声明（`'memory.set <key:string> [value:text]'`），
> 作为 handler 形参传入（`(argv, key, value) => ...`）。不再有 v1 的嵌套
> `subcommands` / `CommandDefinition` / `action(ctx)`。

### CommandArgv / CommandHandler

```typescript
/** Handler 收到的会话/选项视图（不含原始 args，位置参数走形参） */
interface CommandArgv {
  session: {
    sessionId: string;
    platform: string;
    userId?: string;
    sessionType?: 'group' | 'private' | 'channel'; // 会话信道类型（私聊敏感指令据此设防）
    raw: string;                                    // 原始输入文本（含前缀）
  };
  options: Record<string, unknown>;
}

/**
 * 命令执行函数。
 * @param argv 会话上下文 + 解析后的选项
 * @param positionals 按 inline DSL 顺序解析出的位置参数
 */
type CommandHandler = (
  argv: CommandArgv,
  ...positionals: unknown[]
) => Promise<string | undefined> | string | undefined;
```

### 参数 / 选项 spec

```typescript
type PositionalArgType = 'string' | 'number' | 'boolean' | 'text';

interface PositionalArgSpec {
  name: string;
  type: PositionalArgType;
  required: boolean;
}

type OptionValueType = 'string' | 'number' | 'boolean' | 'string[]';

interface OptionSpec {
  name: string;                       // 长选项名 (--name)
  aliases: string[];                  // 短选项别名 (-x)，可多个
  type: OptionValueType;              // 值类型；boolean 表示纯 flag
  valueName?: string;                 // 占位符名（用于 help 输出）
  takesValue: boolean;                // 是否需要取值
  valueOptional: boolean;             // 值可选时（[val:type] 语法）flag 存在但无值给 true
  description?: string;
  default?: unknown;
  required: boolean;
  choices?: readonly string[];
}
```

### CommandMeta / Command

```typescript
/** 注册时的元数据 */
interface CommandMeta {
  visibility?: CapabilityVisibility;  // 主能力默认可见性（轴 A；缺省 public）；子命令继承父分组声明
  confirm?: CapabilityConfirm;        // 确认要求（轴 B，与 visibility 正交、owner 也生效）；子命令继承父声明
  risk?: CapabilityRisk;              // 风险等级（声明糖）：展开为 (visibility, confirm) 默认
  usage?: string;
  examples?: string[];
}

/** 已注册命令（运行期完整态） */
interface Command {
  name: string;                       // 完整点路径名
  pluginName: string;
  description: string;
  visibility: CapabilityVisibility;   // 生效默认可见性（缺省 public）；可被 authorityOverrides 调整
  confirm?: CapabilityConfirm;        // 生效确认要求（含从父分组继承）；缺省=不确认
  risk?: CapabilityRisk;              // 原始风险声明（透传，含沿点路径继承）
  aliases: string[];                  // 别名（完整点路径）
  positionalArgs: PositionalArgSpec[];
  options: OptionSpec[];
  usage?: string;
  examples?: string[];
  handler?: CommandHandler;           // 执行函数；分组节点为 undefined
  isGroup: boolean;                   // 是否为自动创建的分组节点
}
```

### ExecutionInput

命令服务消费方（CLI / 适配器）传入的执行输入。

```typescript
interface ExecutionInput {
  sessionId: string;
  platform: string;
  userId?: string;
  sessionType?: 'group' | 'private' | 'channel'; // 透传自 IncomingMessage.sessionType
  args: string[];
  raw: string;
  skipConfirm?: boolean;              // 跳过受限被拒后的交互确认弹窗；authorize 仍然生效
}
```

### CommandBuilder / CommandService

```typescript
interface OptionRegisterOptions {
  description?: string;
  default?: unknown;
  required?: boolean;
  choices?: readonly string[];
}

interface CommandBuilder {
  alias(name: string): CommandBuilder;
  option(name: string, syntax: string, options?: OptionRegisterOptions): CommandBuilder;
  action(handler: CommandHandler): CommandBuilder;
  usage(text: string): CommandBuilder;
  example(line: string): CommandBuilder;
}

/** 仅供 useCommandService 内部使用：携带 pluginName 隐式参数 */
interface InternalCommandMeta extends CommandMeta {
  pluginName?: string;
}

interface CommandService {
  prefix: string;
  /** 启动 builder 注册一个命令（name 可含 inline DSL）。 */
  command(name: string, description?: string, meta?: InternalCommandMeta): CommandBuilder;
  unregister(name: string): void;
  unregisterByPlugin(pluginName: string): void;
  execute(name: string, ctx: ExecutionInput): Promise<string | undefined>;
  parseCommand(input: string): { name: string; args: string[]; raw: string } | null;
  /** 给定 head + tokens 是否能解析到任何已注册指令节点（区分「已识别指令」与「碰巧带前缀」）。 */
  hasMatch(head: string, tokens?: string[]): boolean;
  has(name: string): boolean;         // 顶层段是否存在（含分组节点）
  get(name: string): Command | undefined;
  getNode(name: string | string[]): Command | undefined;
  getAll(): Command[];
  setExecutionGuard(guard: ExecutionGuard): void;
}
```

> 插件侧用 `useCommandService(ctx)` 获得 `ScopedCommandService`（`pluginName` 自动填充），
> 其 `command()` 返回一个支持热转发 + bounce 重放的 builder。

### 能力词汇（CapabilityVisibility 等）

来自 `@aalis/plugin-authority-api`，被 tools / commands / 守卫共享。

```typescript
type CapabilityId = string;
type CapabilityVisibility = 'public' | 'restricted';        // 轴 A · 授权：谁默认能用
type CapabilityConfirm = 'session' | 'always';              // 轴 B · 确认：是否需人确认（与 visibility 正交）
type CapabilityRisk = 'safe' | 'sensitive' | 'dangerous';   // 声明糖：展开为 (visibility, confirm) 默认
// safe → (public, 无确认)；sensitive → (restricted, 无确认)；dangerous → (restricted, 'session')
```
