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
  content: string;
  name?: string;         // tool 消息的 tool name
  tool_call_id?: string; // tool 消息关联的 call ID
  tool_calls?: ToolCall[];
  timestamp?: number;
}
```

### ToolCall

```typescript
interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;  // JSON string
  };
}
```

---

## 服务接口

### LLMService

大语言模型服务，必须提供聊天和消息token估算能力。

```typescript
interface LLMService {
  chat(messages: Message[], options?: LLMChatOptions): Promise<LLMResponse>;
  estimateTokens(messages: Message[]): number;
}

interface LLMChatOptions {
  temperature?: number;
  tools?: ToolDefinition[];
  stream?: boolean;
  onToken?: (token: string) => void;
}

interface LLMResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  thinking?: string;  // DeepSeek 推理链内容
}
```

### AgentService

Agent 负责处理完整的消息收发流程。

```typescript
interface AgentService {
  handleMessage(session: SessionContext): Promise<void>;
}

interface SessionContext {
  sessionId: string;
  platform: string;
  userId: string;
  content: string;
  send: (content: string) => Promise<void>;
}
```

### MemoryService

会话记忆存储，以 sessionId 为粒度。

```typescript
interface MemoryService {
  getMessages(sessionId: string, limit?: number): Promise<Message[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;
  clearMessages(sessionId: string): Promise<void>;
}
```

### VectorStoreService

向量存储服务，支持语义相似度检索。

```typescript
interface VectorStoreService {
  upsert(id: string, vector: number[], metadata: Record<string, unknown>): Promise<void>;
  query(vector: number[], topK: number): Promise<VectorSearchResult[]>;
}

interface VectorSearchResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}
```

### EmbeddingService

文本嵌入向量化服务。

```typescript
interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
}
```

### PersonaService

人设/角色卡管理服务。

```typescript
interface PersonaService {
  getSystemPrompt(): string;
  getPersonaCard(): PersonaCard;
}

interface PersonaCard {
  name: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  outputFormat?: Record<string, string>;
}
```

### PlatformAdapter

平台适配器，连接外部通信渠道。

```typescript
interface PlatformAdapter {
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(sessionId: string, content: string): Promise<void>;
}
```

---

## 配置类型

### ConfigSchema

插件声明配置项时使用的 JSON Schema 子集。

```typescript
interface ConfigSchemaItem {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  default?: unknown;
  description?: string;
  required?: boolean;
}

type ConfigSchema = Record<string, ConfigSchemaItem>;
```

---

## 事件类型映射

### EventMap

```typescript
interface EventMap {
  'message':       (session: SessionContext) => void;
  'message:send':  (params: { sessionId: string; content: string }) => void;
  'ready':         () => void;
  'dispose':       () => void;
}
```

### HookMap

```typescript
interface HookMap {
  'llm-call:before':  (data: { messages: Message[]; options: LLMChatOptions }) => void | Promise<void>;
  'llm-call:after':   (data: { messages: Message[]; response: LLMResponse }) => void | Promise<void>;
  'response:before':  (data: { session: SessionContext; content: string }) => void | Promise<void>;
  'command:before':   (data: { name: string; args: Record<string, unknown>; ctx: CommandContext }) => void | Promise<void>;
  'command:after':    (data: { name: string; result: unknown; ctx: CommandContext }) => void | Promise<void>;
  'tool:before':      (data: { name: string; args: Record<string, unknown> }) => void | Promise<void>;
  'tool:after':       (data: { name: string; result: unknown }) => void | Promise<void>;
}
```

---

## 工具定义

### ToolDefinition

可以注册到 ToolRegistry 且被 LLM 调用的工具。

```typescript
interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;   // JSON Schema 描述参数
  };
}
```

### ToolHandler

```typescript
type ToolHandler = (args: Record<string, unknown>) => Promise<string>;
```

---

## 指令定义

### CommandDefinition

```typescript
interface CommandDefinition {
  name: string;
  description: string;
  authority?: number;          // 所需最低权限，默认 1
  dangerous?: boolean;         // 是否需要确认
  options?: CommandOption[];
  action: (ctx: CommandContext) => Promise<string | void>;
}

interface CommandOption {
  name: string;
  alias?: string;
  type: 'string' | 'number' | 'boolean';
  default?: unknown;
  description?: string;
  required?: boolean;
}
```

### CommandContext

```typescript
interface CommandContext {
  args: Record<string, unknown>;
  session?: SessionContext;
  raw?: string;
  send: (content: string) => Promise<void>;
}
```
