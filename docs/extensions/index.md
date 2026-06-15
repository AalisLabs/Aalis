# Core 扩展点索引（一方扩展速查）

`@aalis/core` 暴露的所有 `declare module` 扩展点，及**本仓库内**谁在 augment 什么——
便于在一方代码里查定义、查谁扩了什么。

> **这不是注册门禁。** 第三方插件扩展任一扩展点，只需在你自己的包里写
> `declare module '@aalis/core' { ... }`（见 [plugin-author-guide](../plugin-author-guide.md)），
> 编译期即生效——**无需在本表登记**，也不会（无法）出现在本表里。扩展点的**权威定义**在各
> `-api` 包的 `declare module` 声明；本表只收录本仓库的一方包，作发现与查阅之用，并非全集。
查找一个事件/能力/钩子的真实定义，从本表的"扩展者"列直接跳（一方实现）。

> **核心原则**：core 自身只声明**空接口**，所有键值由 plugin-*-api 通过 declaration merging 注入。
> 这是「忒修斯之船」原则——业务概念可以全部换掉，core 永远不感知它们。

---

## 1. `ServiceCapabilityMap`

服务名 → 能力 union 类型映射。`ctx.provide(name, inst, { capabilities: [...] })`
和 `ctx.getService(name, { capability })` 在编译期靠它做 capability 字符串约束。

**位置**：[packages/core/src/types/capabilities.ts](packages/core/src/types/capabilities.ts)

**扩展者**：

| api 包 | 注册的服务 | 能力 union（部分） |
|---|---|---|
| [@aalis/plugin-llm-api](packages/plugin-llm-api/src/index.ts) | `llm` | `chat / tool_calling / vision / ...` |
| [@aalis/plugin-memory-api](packages/plugin-memory-api/src/index.ts) | `memory` | `persistent / encrypted / ...` |
| [@aalis/plugin-storage-api](packages/plugin-storage-api/src/index.ts) | `storage` | — |
| [@aalis/plugin-media-api](packages/plugin-media-api/src/index.ts) | `media` | `vision / audio / video` |
| [@aalis/plugin-session-manager-api](packages/plugin-session-manager-api/src/index.ts) | `session-manager` | — |
| [@aalis/plugin-platform-api](packages/plugin-platform-api/src/index.ts) | `platform` | helper: `resolvePlatformBySession` / `aggregatePlatformDetails` |
| [@aalis/plugin-package-manager](packages/plugin-package-manager/src/index.ts) | `package-manager` | — |
| [@aalis/plugin-message-archive](packages/plugin-message-archive/src/types.ts) | `message-archive` | — |
| [@aalis/plugin-websearch-serper](packages/plugin-websearch-serper/src/types.ts) | `websearch` | — |

---

## 2. `AalisEvents`

EventBus 事件签名表。`ctx.events.on(name, handler)` 在编译期靠它做事件名 + payload 约束。

**位置**：[packages/core/src/types/core.ts](packages/core/src/types/core.ts)（仅含 service:* / plugin:* / app:* / ready / dispose / restarting）

**扩展者**：

| api 包 | 注入的事件键 |
|---|---|
| [@aalis/plugin-message-api](packages/plugin-message-api/src/index.ts) | `inbound:message` / `inbound:message:archived` / `outbound:message` / `outbound:stream` |
| [@aalis/plugin-gateway-api](packages/plugin-gateway-api/src/index.ts) | `gateway:phase:done` |
| [@aalis/plugin-tools-api](packages/plugin-tools-api/src/index.ts) | `tool:execute` |
| [@aalis/plugin-session-channel](packages/plugin-session-channel/src/types.ts) | `session:channel:*` |
| [@aalis/plugin-session-manager-api](packages/plugin-session-manager-api/src/index.ts) | `session:*` |
| [@aalis/plugin-todo-list](packages/plugin-todo-list/src/index.ts) | `todo:*` |

---

## 3. `HookContextMap`

中间件钩子上下文表。`ctx.middleware(name, fn)` 在编译期靠它推 data 类型。

**位置**：[packages/core/src/types/hooks.ts](packages/core/src/types/hooks.ts)（空 interface）

**扩展者**：

| api 包 | 注入的钩子键 |
|---|---|
| [@aalis/plugin-agent-api](packages/plugin-agent-api/src/index.ts) | `agent:llm:before` / `agent:llm:after` / `agent:tool:*` / `agent:reply:*` / `agent:input:*` / `agent:turn:*` |
| [@aalis/plugin-gateway-api](packages/plugin-gateway-api/src/index.ts) | `inbound:*` / `outbound:dispatch` |
| [@aalis/plugin-memory-api](packages/plugin-memory-api/src/index.ts) | `memory:clear` |

---

## 4. `AalisConfig`（配置 schema 业务字段）

应用根配置的字段表。core 只声明**自身管理的字段**（`logLevel` / `logBufferSize` / `dataDir`...），
业务字段由 plugin-*-api 通过 declaration merging 注入。

**位置**：[packages/core/src/config.ts](packages/core/src/config.ts)（`CORE_CONFIG_SCHEMA`）

**扩展者**：

| api 包 | 注入的字段 |
|---|---|
| [@aalis/plugin-authority-api](packages/plugin-authority-api/src/index.ts) | `owners` / `restrictedCapabilities` / `deniedCapabilities` / `visibilityOverrides` / `restrictedPolicy` |

---

## 5. `Context` 领域 Helper

各契约包导出 **领域 helper**（一个普通函数，输入 `ctx`，输出 typed scoped service），调用方在 `apply()` 内自取自用。helper 内部封装 `ctx.getService` 与 `whenService` 延迟逻辑，保留「即插即用、无需关心顺序」的体验。

**扩展者**：

| api 包 | 领域 helper |
|---|---|
| [@aalis/plugin-tools-api](packages/plugin-tools-api/src/index.ts) | `useToolService(ctx)` / `toolsWithGroups(tools, groups)` |
| [@aalis/plugin-commands-api](packages/plugin-commands-api/src/index.ts) | `useCommandService(ctx)` |
| [@aalis/plugin-webui-api](packages/plugin-webui-api/src/index.ts) | `useWebuiService(ctx)` |
| [@aalis/plugin-agent-api](packages/plugin-agent-api/src/index.ts) | `useAgent(ctx)` |

示例：

```ts
import { useToolService, toolsWithGroups } from '@aalis/plugin-tools-api';
import { useCommandService } from '@aalis/plugin-commands-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import { useAgent } from '@aalis/plugin-agent-api';

export default class MyPlugin {
  apply(ctx: Context) {
    const tools = toolsWithGroups(useToolService(ctx), ['my-group']);
    tools.register({ definition, handler });

    const commands = useCommandService(ctx);
    commands.command({ name: 'hello', description: 'hi', action: async () => 'hi' });

    // 注册 WebUI 页面（webui-server 未就绪时自动延迟绑定）
    const webui = useWebuiService(ctx);
    webui.registerPage({ key: 'my', label: '我的', icon: 'star', order: 50, renderer: 'my' });

    // 注册 agent 输入预处理器
    useAgent(ctx).registerPreprocessor('my-preproc', async (msg, next) => { /* ... */ await next(); });
  }
}
```

---

## 6. `PluginModule`

插件模块的元数据接口（`apply` / `name` / `inject` / `services` 等）。
仅供"插件类型自身"扩展使用，业务很少 augment 这个。

**扩展者**：

| api 包 | 注入的字段 |
|---|---|
| [@aalis/plugin-webui-api](packages/plugin-webui-api/src/index.ts) | webui 元数据（`webui?: {...}`） |

---

## 7. 各服务的 `XxxCapabilityRegistry`

按服务隔离的能力注册表。每个服务自己定义一个 `XxxCapabilityRegistry` interface，
第三方插件可以 augment 它新增能力字面量。

**示例**：

- [`LLMCapabilityRegistry`](packages/plugin-llm-api/src/index.ts) — LLM 能力
- [`MemoryCapabilityRegistry`](packages/plugin-memory-api/src/index.ts) — 记忆服务能力
- [`WebSearchCapabilityRegistry`](packages/plugin-websearch-serper/src/types.ts) — 搜索能力

第三方扩展示例：

```ts
declare module '@aalis/plugin-llm-api' {
  interface LLMCapabilityRegistry {
    AudioInput: 'audio_input';
  }
}
```

---

## 速查：我想……

- 加一个**新事件** → 在自己的 `*-api` 包内 `declare module '@aalis/core' { interface AalisEvents { ... } }`
- 加一个**新钩子** → 同上但写 `HookContextMap`
- 加一个**新服务名** → 同上但写 `ServiceCapabilityMap`，同时定义自己的 `XxxCapabilityRegistry`
- 加一个 **`ctx.xxx()` 便捷方法** → 在 `*-api` 包用 `declare module '@aalis/core' { interface Context { xxx(...): ...; } }`，并在 plugin 实现里 `Context.prototype.xxx = ...`。**慎用**——优先考虑改成 Service。
- 加一个**配置字段** → 在 `*-api` 包 `declare module '@aalis/core' { interface AalisConfig { myField: ... } }`，并提供 schema 给 ConfigManager
