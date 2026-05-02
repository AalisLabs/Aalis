# 核心类型定义

所有核心模块和插件之间共享的类型契约。

**源码**: `packages/core/src/types.ts`

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
}
```

### IncomingMessage

平台适配器传递到 Agent 的入站消息。

```typescript
interface IncomingMessage {
  content: string;
  sessionId: string;
  platform: string;
  userId?: string;
  images?: string[]; // base64 or URL
}
```

### OutgoingMessage / StreamChunkMessage / ToolExecuteMessage

```typescript
interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  reasoningContent?: string;
}

interface StreamChunkMessage {
  sessionId: string;
  platform?: string;
  contentDelta?: string;
  reasoningDelta?: string;
  done?: boolean;
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

### RegisteredTool / ToolSummary

```typescript
interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string>;
  pluginName: string;
  safety?: SafetyLevel;   // 默认 'safe'
  authority?: number;      // 默认 1
}

interface ToolSummary {
  name: string;
  description: string;
  authority: number;
  safety: SafetyLevel;
}

interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
}
```

---

## 服务接口

### LLMService

大语言模型服务。

```typescript
interface LLMService {
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<ChatStreamChunk>;
  getTemperature(): number;
  getMaxTokens(): number;
  getContextLength(): number;
  listModels?(): Promise<string[]>;
}

interface ChatRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
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
```

### AgentService

对话编排引擎。

```typescript
interface AgentService {
  handleMessage(message: IncomingMessage): Promise<void>;
}
```

### MemoryService

会话记忆存储（以 sessionId 为粒度）。

```typescript
interface MemoryService {
  saveMessage(sessionId: string, message: Message): Promise<void>;
  getHistory(sessionId: string, limit?: number): Promise<Message[]>;
  clearSession(sessionId: string): Promise<void>;
}
```

### VectorStoreService

向量存储，支持语义相似度检索。

```typescript
interface VectorStoreService {
  add(vector: number[], metadata: Record<string, unknown>): Promise<void>;
  search(queryVector: number[], topK: number): Promise<VectorSearchResult[]>;
  size(): Promise<number>;
  clear(): Promise<void>;
  save(): Promise<void>;
}

interface VectorSearchResult {
  score: number;
  metadata: Record<string, unknown>;
}
```

### EmbeddingService

文本嵌入向量化。

```typescript
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

平台适配器，每个平台插件实现此接口。

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

单个配置字段。

```typescript
type SchemaFieldType = 'string' | 'number' | 'boolean' | 'select' | 'multiselect';

interface SchemaField {
  type: SchemaFieldType;
  label: string;
  description?: string;
  default?: unknown;
  required?: boolean;
  secret?: boolean;           // 前端自动遮蔽
  options?: Array<{ label: string; value: string | number }>;
  dynamicOptions?: string;    // 填服务名，运行时调用 service.listModels()
}
```

### SchemaGroup

配置分组（将字段组织到折叠区域）。

```typescript
interface SchemaGroup {
  label?: string;
  description?: string;
  fields: Record<string, SchemaField>;
}
```

### SchemaArray

对象数组（如 OneBot 多连接、Chat-Flow 多 Profile 等场景）。

```typescript
interface SchemaArray {
  type: 'array';
  label: string;
  description?: string;
  items: Record<string, SchemaField>;
  default?: unknown[];
}
```

### ConfigSchema

顶层配置 Schema，各 key 可以是字段、分组或数组：

```typescript
type ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>;
```

### 使用示例

```typescript
export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
  model: { type: 'select', label: '模型', dynamicOptions: 'llm' },
  advanced: {
    label: '高级设置',
    fields: {
      temperature: { type: 'number', label: '温度', default: 0.7 },
    },
  },
  connections: {
    type: 'array',
    label: '连接列表',
    items: {
      host: { type: 'string', label: '主机', default: '127.0.0.1' },
      port: { type: 'number', label: '端口', default: 6700 },
    },
    default: [],
  },
};
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
  'dispose': [];
  'restarting': [];
  [key: string]: unknown[];  // 运行时安全兜底
}
```

### HookContextMap

内置钩子数据类型映射表，支持 declaration merging 扩展。

```typescript
interface HookContextMap {
  'agent:input:before': { message: IncomingMessage; metadata: Record<string, unknown> };
  'agent:turn:after': { message: IncomingMessage; reply: string; sessionId: string; metadata: Record<string, unknown> };
  'agent:route': { message: IncomingMessage; agent: AgentService | undefined };
  'agent:llm:before': { messages: Message[]; tools: ToolDefinition[]; sessionId?: string; userId?: string; platform?: string; triggerType?: IncomingMessage['triggerType'] };
  'agent:llm:after': { response: ChatResponse; messages: Message[] };
  'agent:tool:before': { name: string; args: Record<string, unknown>; toolCallContext: ToolCallContext };
  'agent:tool:after': { name: string; result: string; toolCallContext: ToolCallContext };
  'agent:reply:before': { content: string; sessionId: string; platform?: string; userId?: string; triggerType?: IncomingMessage['triggerType'] };
}
```

### MiddlewareFn / MiddlewareNext

```typescript
type MiddlewareNext = () => Promise<void>;
type MiddlewareFn<T> = (data: T, next: MiddlewareNext) => Promise<void>;
```

---

## 依赖声明

### InjectDeclaration

插件声明其依赖的服务。

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
```

### ExtendDeclaration

插件声明其对核心的扩展（用于前端展示和文档生成）。

```typescript
interface ExtendDeclaration {
  events?: string[];
  hooks?: string[];
  mixins?: Record<string, string[]>;
}
```

---

## 指令系统

### CommandDefinition / CommandContext

```typescript
interface CommandDefinition {
  name: string;
  description: string;
  authority?: number;      // 默认 1
  safety?: SafetyLevel;    // 默认 'safe'
  arguments?: CommandArgumentDefinition[];
  options?: CommandOptionDefinition[];
  usage?: string;
  examples?: string[];
  action: (ctx: CommandContext) => Promise<string | void>;
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

interface CommandOptionDefinition {
  name: string;
  alias?: string | string[];
  type: 'string' | 'number' | 'boolean' | 'enum' | 'string[]';
  choices?: string[];
  default?: unknown;
  required?: boolean;
  description?: string;
}

type SafetyLevel = 'safe' | 'dangerous';
```
