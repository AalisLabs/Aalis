# Aalis 类型分层与 api 包架构

> 本文档描述 Aalis 框架的类型分层原则、api 包契约与扩展点机制。
> 与 [architecture.md](../architecture.md) 互补：架构文档描述运行时数据流，本文档描述编译期类型契约。

## 设计目标

1. **core 业务无关**：`packages/core` 不引用任何 `@aalis/plugin-*` 包，不定义任何业务服务接口（`*Service`）。
2. **接口与实现分离**：每个业务领域（LLM / Memory / Storage / …）由两类包组成：
   - **api 包**（`@aalis/plugin-X-api`）：仅类型与扩展点声明，零运行时副作用
   - **实现包**（`@aalis/plugin-X` 或多个具体实现）：依赖对应 api 包，提供运行时
3. **单向依赖**：`实现包 → api 包 → core`，永不反向。多实现可共存。
4. **扩展点显式化**：core 仅保留 3 个空 extension-point 接口，业务键由 api 包通过 declaration merging 注入。

## 包分层

```
┌─────────────────────────────────────────────────────────────────┐
│  实现包（runtime + business logic）                              │
│  plugin-deepseek / plugin-openai / plugin-ollama                │
│  plugin-memory-sqlite / plugin-memory-mongodb / …               │
│  plugin-tools / plugin-commands / plugin-gateway / …     │
└────────────────────────────┬────────────────────────────────────┘
                             │  imports types
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  api 包（types + capability constants + hook augmentation）      │
│  plugin-llm-api / plugin-memory-api / plugin-storage-api        │
│  plugin-embedding-api / plugin-vectorstore-api                  │
│  plugin-tools-api / plugin-commands-api / plugin-gateway-api    │
│  plugin-webui-api / plugin-authority-api / plugin-agent-api     │
└────────────────────────────┬────────────────────────────────────┘
                             │  imports types + augments
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  @aalis/core（runtime infra + extension points only）            │
│  App / Context / EventBus / ServiceContainer / HookRegistry     │
│  PluginManager / ConfigManager / Logger / ……                    │
│                                                                  │
│  3 个扩展点（空接口，由 api 包 declaration merging 注入）：       │
│   - ServiceCapabilityMap   (服务名 → 能力 union)                 │
│   - AalisEvents            (事件名 → 参数元组)                   │
│   - HookContextMap         (钩子名 → 中间件上下文)               │
└─────────────────────────────────────────────────────────────────┘
```

## core 提供的扩展点

### 1. `ServiceCapabilityMap` — 服务能力强类型约束

api 包通过 declaration merging 注册自己服务的能力 union：

```ts
// plugin-llm-api/src/index.ts
export interface LLMCapabilityRegistry {
  Chat: 'chat';
  ToolCalling: 'tool_calling';
  Streaming: 'streaming';
  Vision: 'vision';
}
export type LLMCapability = LLMCapabilityRegistry[keyof LLMCapabilityRegistry];

declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    llm: LLMCapability;
  }
}
```

之后 `ctx.provide('llm', svc, { capabilities: ['vision'] })` 与 `ctx.getService<LLMService>('llm', ['vision'])` 都获得编译期约束。

### 2. `AalisEvents` — 事件名 → 参数元组

```ts
declare module '@aalis/core' {
  interface AalisEvents {
    'scheduler:tick': [jobId: string];
  }
}
```

### 3. `HookContextMap` — 钩子名 → 中间件上下文数据

```ts
// plugin-agent-api 注入 agent:* 钩子
declare module '@aalis/core' {
  interface HookContextMap {
    'agent:input:before': { message: IncomingMessage; metadata: Record<string, unknown> };
    'agent:llm:before':   { messages: Message[]; tools: ToolDefinition[]; sessionId: string };
    // ...
  }
}
```

任何在 `ctx.middleware('agent:llm:before', ...)` 处签名的消费插件，都需要 **side-effect import**（或常规 import）该 api 包以激活类型增强。

## 当前 api 包索引

| api 包 | 注入到 `HookContextMap` | 注入到 `ServiceCapabilityMap` | 主要服务接口 |
|---|---|---|---|
| `plugin-llm-api` | — | `llm` | `LLMService`, `ChatRequest`, `ChatResponse`, `ChatStreamChunk`, `ModelInfo` |
| `plugin-memory-api` | `memory:clear` | `memory` | `MemoryService` |
| `plugin-storage-api` | — | `storage` | `StorageService` |
| `plugin-embedding-api` | — | `embedding` | `EmbeddingService` |
| `plugin-vectorstore-api` | — | `vectorstore` | `VectorStoreService` |
| `plugin-tools-api` | — | `tools` | `ToolService` |
| `plugin-commands-api` | — | `commands` | `CommandService` |
| `plugin-gateway-api` | `inbound:command` / `inbound:flow` / `inbound:trigger` / `inbound:dispatch` / `outbound:dispatch` | — | `GatewayService`, `InboundPhaseData` |
| `plugin-webui-api` | — | `webui-server` | `WebUIService`, `WebuiPage`, `WebuiComponent` 等；导出 `useWebuiService(ctx)` helper 用于注册页面 |
| `plugin-authority-api` | — | `authority` | `AuthorityService`, `ExecutionGuard`, `ExecutionGuardContext`, `DangerousConfirm*` 等 |
| `plugin-agent-api` | `agent:input:before` / `agent:turn:after` / `agent:tool:before` / `agent:tool:after` / `agent:reply:before` / `agent:llm:before` / `agent:llm:after` | — | `AgentService`, `PreprocessorFn`, `PluginGroupInfo` |

## 何时需要新建 api 包

满足任一条件即应建立 api 包：

- 该领域有 **>1 个潜在实现**（多 LLM provider、多 memory backend）
- 该领域要 **augment** core 的 `HookContextMap` / `ServiceCapabilityMap`
- 该领域类型被 **>3 个其他插件**直接 import

只有一个实现且无类型外溢的"叶子插件"（如 plugin-todo-list、plugin-image-recognition 内部）不需要 api 包。

## 消费约定

### 单纯使用服务

```ts
import type { LLMService } from '@aalis/plugin-llm-api';
const llm = ctx.getService<LLMService>('llm', ['tool_calling']);
```

### 使用钩子（需要 side-effect 增强）

```ts
import '@aalis/plugin-agent-api'; // 激活 agent:* 类型增强
ctx.middleware('agent:llm:before', async (data, next) => {
  data.messages.unshift({ role: 'system', content: '...' });
  await next();
});
```

如果同时 `import type { ChatResponse } from '@aalis/plugin-llm-api'`，则 plugin-llm-api 的副作用导入也会一并触发，无需额外 side-effect import。

### 注册自己的能力

```ts
declare module '@aalis/core' {
  interface ServiceCapabilityMap {
    'my-service': 'feature-a' | 'feature-b';
  }
  interface HookContextMap {
    'my-service:before': { args: unknown; result?: unknown };
  }
}
```

## CI 校验

Biome 在 CI 上对全仓库执行 lint + format check（informational 模式）以及对变更文件执行 hard check。业务接口是否回流 core 由代码审查 + 类型系统兜底（任何业务字段重新进入 `packages/core` 都会立刻反映在 PR diff 中）。

