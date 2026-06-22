# Aalis 类型分层与 api 包架构

> 本文档描述 Aalis 框架的类型分层原则、api 包契约与扩展点机制。
> 与 [architecture.md](../architecture.md) 互补：架构文档描述运行时数据流，本文档描述编译期类型契约。

## 设计目标

1. **core 业务无关**：`packages/core` 不引用任何 `@aalis/plugin-*` 包，不定义任何业务服务接口（`*Service`）。
2. **接口与实现分离**：每个业务领域（LLM / Memory / Storage / …）由两类包组成：
   - **api 包**（`@aalis/plugin-X-api`）：仅类型与扩展点声明，零运行时副作用
   - **实现包**（`@aalis/plugin-X` 或多个具体实现）：依赖对应 api 包，提供运行时
3. **单向依赖**：`实现包 → api 包 → core`，永不反向。多实现可共存。
4. **扩展点显式化**：core 仅保留 3 个空 extension-point 接口，业务键由 api 包通过 declaration merging 注入。领域能力（LLM 工具调用/视觉、storage 本地路径权限等）不是 core 扩展点——它们是服务实例 / model handle 上的元数据，由各领域 `*-api` 的 helper 函数（如 `resolveLLMModel`）过滤，不进内核 DI。

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
│  api 包（types + service/hook augmentation + 领域 helper）        │
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
│   - ServiceTypeMap         (服务名 → 服务实例接口)               │
│   - AalisEvents            (事件名 → 参数元组)                   │
│   - HookContextMap         (钩子名 → 中间件上下文)               │
└─────────────────────────────────────────────────────────────────┘
```

## core 提供的扩展点

### 1. `ServiceTypeMap` — 服务名 → 服务实例接口

api 包通过 declaration merging 把「服务名 → 服务实例接口」登记一条，让 `ctx.provide` / `ctx.getService` 在编译期按字面量名自动推断实例类型：

```ts
// plugin-llm-api/src/index.ts
declare module '@aalis/core' {
  interface ServiceTypeMap {
    llm: LLMModel;
  }
}
```

之后 `const m = ctx.getService('llm')` 自动推断为 `LLMModel | undefined`，无需手写泛型。未登记的服务名退回 `unknown`（router 类插件按运行时变量寻址时仍可用字符串重载）。

> **能力不在这里。** `getService(name)` / `getAllServices(name)` 只吃服务名，**没有** capabilities 参数；同名多实现的胜者按「偏好 > 优先级 > 注册顺序」解析（`ctx.preferService` / WebUI 的 Services 页）。领域能力（LLM 的 `tool_calling` / `vision`、storage 的 `local-path` 等）是服务实例 / model handle 上的**元数据**（如 `LLMModel.capabilities`），由各领域 `*-api` 的 helper 函数过滤——见下方「领域能力」。0.5.0 已删除 `ServiceCapabilityMap`，能力不再是 core 扩展点。

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

## 领域能力 = handle 元数据（非 core 扩展点）

0.5.0 之前 core 曾有第 4 个扩展点 `ServiceCapabilityMap`，让 `ctx.provide(name, svc, { capabilities })` / `ctx.getService(name, [caps])` 按能力做 DI 选择。**该机制已删除**：能力匹配属于领域互操作语义，不是内核职责。现在：

- 每个 api 包仍定义自己的能力枚举（如 `plugin-llm-api` 的 `LLMCapability` = `chat | tool_calling | vision | thinking | audio | …`、`plugin-storage-api` 的 `StorageCapability`），但**不**把它声明进任何 core 接口。
- 能力是**服务实例 / model handle 上的元数据**：provider 在 `ctx.provide('llm', modelHandle, …)` 时，`modelHandle.capabilities` 诚实反映该 model 能干啥；storage 后端按 root 的 `readable/writable/deletable` 权限位 + `resolveLocalPath`/`watch` 方法存在性体现能力。
- 按能力筛选由各领域 `*-api` 的 **helper 函数**完成，读 `instance.capabilities`，与 core DI 无关：

```ts
// plugin-llm-api：按 handle 元数据过滤，不经 core 能力选择
import { resolveLLMModel } from '@aalis/plugin-llm-api';
const entry = resolveLLMModel(ctx, ref, ['vision']);   // 过滤 instance.capabilities
await entry?.instance.chat({ messages });

// plugin-storage-api：按 root 权限位 / 方法存在性判定，同样是纯 helper
import { resolveStorageByPath } from '@aalis/plugin-storage-api';
const target = resolveStorageByPath(ctx, 'data:/foo', ['local-path']);
```

`ctx.provide` 的 options 是 `{ priority?, label?, entryId? }`，没有 `capabilities`；`ctx.getService` / `ctx.getAllServices` 只吃名字。能力字符串也会随 entry 上送前端（`ModelInfo.capabilities`）供下拉展示与过滤——同样是元数据用途，不是 DI 通道。

## 当前 api 包索引

| api 包 | 注入到 `HookContextMap` | 注入到 `ServiceTypeMap`（服务名） | 主要服务接口 |
|---|---|---|---|
| `plugin-llm-api` | — | `llm` | `LLMModel`, `ChatModelRequest`, `ChatResponse`, `ChatStreamChunk`, `ModelInfo`；导出 `resolveLLMModel` / `listLLMModels` helper（按能力过滤） |
| `plugin-memory-api` | `memory:clear` | `memory` | `MemoryService` |
| `plugin-storage-api` | — | `storage` | `StorageService`；导出 `resolveStorageByPath` / `createStorageGateway` helper（按 root 权限位过滤） |
| `plugin-embedding-api` | — | `embedding` | `EmbeddingService` |
| `plugin-vectorstore-api` | — | `vectorstore` | `VectorStoreService` |
| `plugin-tools-api` | — | `tools` | `ToolService` |
| `plugin-commands-api` | — | `commands` | `CommandService` |
| `plugin-gateway-api` | `inbound:command` / `inbound:flow` / `inbound:trigger` / `inbound:dispatch` / `outbound:dispatch` | — | `GatewayService`, `InboundPhaseData` |
| `plugin-webui-api` | — | `webui-server` | `WebUIService`, `WebuiPage`, `WebuiComponent` 等；导出 `useWebuiService(ctx)` helper 用于注册页面 |
| `plugin-authority-api` | — | `authority` | `AuthorityService`, `ExecutionGuard`, `ExecutionGuardContext`, `CapabilityVisibility`, `AccessConfirmHandler`, `TemporaryGrant` 等 |
| `plugin-agent-api` | `agent:input:before` / `agent:turn:after` / `agent:tool:before` / `agent:tool:after` / `agent:reply:before` / `agent:llm:before` / `agent:llm:after` | — | `AgentService`, `PreprocessorFn`, `PluginGroupInfo` |

## 何时需要新建 api 包

满足任一条件即应建立 api 包：

- 该领域有 **>1 个潜在实现**（多 LLM provider、多 memory backend）
- 该领域要 **augment** core 的 `ServiceTypeMap` / `HookContextMap`（或定义自己的能力枚举 + helper）
- 该领域类型被 **>3 个其他插件**直接 import

只有一个实现且无类型外溢的“叶子插件”（如 plugin-todo-list、plugin-image-sender 内部）不需要 api 包。

## 消费约定

### 单纯使用服务（按名解析，无能力参数）

```ts
import '@aalis/plugin-llm-api'; // 激活 ServiceTypeMap 增强，getService('llm') 自动推断为 LLMModel
const llm = ctx.getService('llm');          // → LLMModel | undefined（胜者：偏好 > 优先级 > 注册顺序）
```

### 按能力挑选实现（领域 helper，非 core DI）

`getService` 不接受能力参数；要按能力过滤，调对应 api 包的 helper（读 handle 元数据 `instance.capabilities`）：

```ts
import { resolveLLMModel } from '@aalis/plugin-llm-api';
const entry = resolveLLMModel(ctx, ref, ['tool_calling']); // 过滤 instance.capabilities
await entry?.instance.chat({ messages });
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

### 注册自己的服务与钩子

向 core 注入「服务名 → 实例接口」和钩子上下文（能力枚举留在自己 api 包里，不进 core）：

```ts
// my-service-api/src/index.ts
export type MyCapability = 'feature-a' | 'feature-b'; // 领域能力，作为实例元数据，不声明进 core

declare module '@aalis/core' {
  interface ServiceTypeMap {
    'my-service': MyService;          // 服务名 → 实例接口
  }
  interface HookContextMap {
    'my-service:before': { args: unknown; result?: unknown };
  }
}

// 按能力筛选靠自己导出的 helper，读 instance 上的元数据
export function resolveMyService(ctx: Context, caps?: MyCapability[]): MyService | undefined {
  return ctx.getAllServices<MyService>('my-service')
    .find(e => (caps ?? []).every(c => e.instance.capabilities.includes(c)))?.instance;
}
```

## CI 校验

Biome 在 CI 上对全仓库执行 lint + format check（informational 模式）以及对变更文件执行 hard check。业务接口是否回流 core 由代码审查 + 类型系统兜底（任何业务字段重新进入 `packages/core` 都会立刻反映在 PR diff 中）。

