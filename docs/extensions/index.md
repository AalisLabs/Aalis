# Core 扩展点索引（一方扩展速查）

`@aalis/core` 暴露的所有 `declare module` 扩展点，及**本仓库内**谁在 augment 什么——
便于在一方代码里查定义、查谁扩了什么。

> **这不是注册门禁。** 第三方插件扩展任一扩展点，只需在你自己的包里写
> `declare module '@aalis/core' { ... }`（见 [plugin-author-guide](../plugin-author-guide.md)），
> 编译期即生效——**无需在本表登记**，也不会（无法）出现在本表里。扩展点的**权威定义**在各
> `-api` 包的 `declare module` 声明；本表只收录本仓库的一方包，作发现与查阅之用，并非全集。
查找一个事件/钩子/贡献点的真实定义，按本表「扩展者」列的包名去 `packages/<包目录>/src/index.ts` 查（一方实现；例外路径在行内标注）。

> **核心原则**：core 自身只声明空的钩子/贡献点接口，所有键值由 `-api` 包通过 declaration merging 注入。
> `AalisEvents` 自持基础设施事件，从来不空。服务类型随描述符走，不经一张核心服务名表。
> 这是「忒修斯之船」原则——业务概念可以全部换掉，core 永远不感知它们。

---

## 1. 服务描述符（不是一张核心类型表）

契约包导出运行时描述符（`defineService` 的结果）。消费方 `import { tools } from '@aalis/api-tools'` 写进 `uses`，`apply` 参数类型从描述符推导。同名多实现时的胜者由 preference > priority > 注册顺序决定。

> 领域能力（LLM 的 tool-calling / vision、storage 的 local-path 等）**不在描述符的 name 上**——
> 它们挂在服务**实例 / model-handle 元数据**上，由各领域 `*-api` 的 helper（如 `resolveLLMModel`）按需筛选。

一方契约包各导出一条描述符，服务名即包名去掉 `api-` 前缀（`agent` / `asr` / `authority` / `code-sandbox` / `commands` /
`cron-engine` / `doctor` / `embedding` / `flow-control` / `gateway` / `llm` / `media` / `memory` / `message-archive` / `persona` /
`platform` / `process` / `session-confirm` / `session-manager` / `storage` / `tools` / `vectorstore` / `workflow`），两个例外：
`@aalis/api-tool-session` 为 `session-history`，`@aalis/api-webui` 为 `webui-server` 与 `webui-client`。

没有独立契约包、在自己 `src/index.ts` 里就地 `defineService` 的插件：

| 插件包 | 注册的服务 |
|---|---|
| `@aalis/plugin-checkpoint` | `checkpoint` |
| `@aalis/plugin-cli` | `cli` |
| `@aalis/plugin-file-reader` | `file-reader` |
| `@aalis/plugin-memory-vector` | `semantic-memory` |
| `@aalis/plugin-package-manager` | `package-manager` |
| `@aalis/plugin-scheduler` | `scheduler` |
| `@aalis/plugin-skills` | `skills` |
| `@aalis/plugin-trigger-policy` | `trigger-policy` |
| `@aalis/plugin-user-relation` | `user-relation` |
| `@aalis/plugin-websearch-serper` | `web-search` |

宿主管理面（须显式 uses）：`app` / `plugins` / `host-config`（`packages/core/src/orchestration/host-services.ts`）。

---

## 2. `AalisEvents`

EventBus 事件签名表。`events.on(name, handler)` 在编译期靠它做事件名 + payload 约束。

**位置**：`packages/core/src/types/events.ts`。core 内置十一项，目录与时序说明以 [core/events.md](../core/events.md) 为准
（没有 `dispose` 事件——清理副作用用 `lifecycle.onDispose`，见 [context](../core/context.md)）

**扩展者**：

| api 包 | 注入的事件键 |
|---|---|
| `@aalis/schema-message` | `inbound:message` / `inbound:message:archived` / `assistant:message:archived` / `outbound:message` / `outbound:stream` |
| `@aalis/api-agent` | `token:usage` / `token:request` |
| `@aalis/api-doctor` | `doctor:updated` |
| `@aalis/api-gateway` | `gateway:phase:done` |
| `@aalis/api-media` | `media:processed` |
| `@aalis/api-memory` | `memory:messages-deleted` / `history:changed` / `session:compress` / `session:compressing` |
| `@aalis/api-session-manager` | `session:created` / `session:updated` / `session:completed` / `session:deleted` |
| `@aalis/api-tools` | `tool:execute` |
| `@aalis/api-workflow` | `trigger:fired` / `workflow:run:start` / `workflow:run:done` / `workflow:run:error` / `workflow:node:done` |
| `@aalis/plugin-scheduler` | `scheduler:job:start` / `scheduler:job:done` / `scheduler:job:error` |
| `@aalis/plugin-todo-list` | `todo:updated` |
| `@aalis/runtime`、`@aalis/plugin-cli` | `terminal:claimed` / `terminal:released`（同一对键，两处等价声明） |

---

## 3. `HookContextMap`

中间件钩子上下文表。`hooks.middleware(name, fn)` 在编译期靠它推 data 类型。

**位置**：`packages/core/src/types/hooks.ts`（空 interface）

**扩展者**：

| api 包 | 注入的钩子键 |
|---|---|
| `@aalis/api-agent` | `agent:input:before` / `agent:llm:before` / `agent:llm:after` / `agent:tool:before` / `agent:tool:after` / `agent:reply:before` / `agent:turn:after` |
| `@aalis/api-gateway` | `inbound:confirm` / `inbound:command` / `inbound:flow` / `inbound:trigger` / `inbound:dispatch` / `outbound:dispatch` |
| `@aalis/api-memory` | `memory:clear` |

---

## 4. `ContributionPointMap`

贡献点表：贡献点名 → spec 类型。`contributions.contribute(point, spec)` / `collect(point)` 在编译期靠它推 spec 类型。

与 `HookContextMap` 的分工：**改写或截停既有流程 → hooks；往共享产物添自己的一块 → 贡献点**。
贡献者拿只读视图、无短路、无排序影响力；排布与执行策略归收集方（贡献点 owner）。

**位置**：`packages/core/src/types/contributions.ts`（空 interface）

**扩展者**：

| api 包 | 注入的贡献点键 |
|---|---|
| `@aalis/api-agent` | `agent:prompt`（提示词块，锚位 identity / knowledge / context / turn-context / turn-hint） |

---

## 5. `AalisConfig`（配置 schema 业务字段）

应用根配置的字段表。core 只声明**自身管理的字段**（`name` / `logLevel` / `plugins` / `disabledPlugins` / `servicePreferences`），
业务字段由 `-api` 包通过 declaration merging 注入。

**位置**：`packages/core/src/context/config.ts`（`interface AalisConfig`）。表单描述 `CORE_CONFIG_SCHEMA` 在
`packages/schema-config/src/index.ts`，那是宿主侧的渲染词汇，与本接口是两件事。

**扩展者**：

| api 包 | 注入的字段 |
|---|---|
| `@aalis/api-authority` | `owners` / `deniedCapabilities` / `authorityOverrides` / `confirmOverrides` / `restrictedPolicy` / `autoConfirmUntil` / `network` |

---

## 6. 按激活绑定的领域门面

各契约包导出**描述符**（值）。消费方写进 `uses`，`apply` 拿到按本次激活绑定的接口：登记自动归属这次激活，提供者换人整体重挂。不要再给 Context 挂领域方法。

**扩展者**：

| api 包 | 绑定门面（在 `ServiceRef` 上额外挂的方法） |
|---|---|
| `@aalis/api-tools` | `tools.register` / `registerGroup`；`withToolGroups(bound, groups)` |
| `@aalis/api-commands` | `commands.command(name, description?)` |
| `@aalis/api-webui` | `webuiServer.registerPage` / `registerAction` |
| `@aalis/api-agent` | `agent.registerPreprocessor` |

示例：

```ts
import { agent } from '@aalis/api-agent';
import { commands } from '@aalis/api-commands';
import { tools, withToolGroups } from '@aalis/api-tools';
import { type WebuiPage, webuiServer } from '@aalis/api-webui';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: 'my-plugin',
  uses: { tools, commands: optional(commands), webui: optional(webuiServer), agent: optional(agent) },
  apply({ tools, commands, webui, agent }) {
    const grouped = withToolGroups(tools, ['my-group']);
    grouped.register({
      definition: {
        type: 'function',
        function: { name: 'ping', description: 'ping', parameters: { type: 'object', properties: {} } },
      },
      handler: async () => 'pong',
    });

    commands.command('hello', 'hi').action(async () => 'hi');

    const page: WebuiPage = { key: 'my', label: '我的', icon: 'star', order: 50 };
    webui.registerPage(page);

    agent.registerPreprocessor('my-preproc', async (msg, next) => {
      await next();
    });
  },
});
```

第三方要造同类登记门面：在自己的契约包 `defineService(name, port => …)`，用 `port.registrar` / `follow` / `track`（`BindingPort`），不要给内部激活记录加方法。

---

## 7. `PluginMeta`

插件定义的元数据扩展点（core 对这里的字段零感知，只原样带在定义上）。`PluginDefinition` 自持 `name` / `displayName` / `subsystem` / `uses` / `provides` / `core` / `reusable` / `apply`。

**扩展者**：

| 包 | 注入的字段 |
|---|---|
| `@aalis/schema-config` | `configSchema`（插件配置表单 schema，默认值经 `defaultsFrom` 派生） |
| `@aalis/api-webui` | `extends`（对 core 扩展的声明，仅前端展示；页面与页面动作在 apply 里 `registerPage` / `registerAction`） |

`subsystem` 是 `PluginDefinition` 上的展示字符串，core 不读不校验；第一方界面认的 id 见 `DEFAULT_SUBSYSTEM_METADATA`。

---

## 8. 各服务的 `XxxCapabilityRegistry`

按服务隔离的能力注册表。每个服务自己定义一个 `XxxCapabilityRegistry` interface，
第三方插件可以 augment 它新增能力字面量。

**示例**：

- `LLMCapabilityRegistry`（`packages/api-llm/src/index.ts`）— LLM 能力

第三方扩展示例：

```ts
declare module '@aalis/api-llm' {
  interface LLMCapabilityRegistry {
    AudioInput: 'audio_input';
  }
}
```

---

## 速查：我想……

- 加一个**新事件** → 在自己的 `*-api` 包内 `declare module '@aalis/core' { interface AalisEvents { ... } }`
- 加一个**新钩子** → 同上但写 `HookContextMap`
- 加一个**新贡献点** → 同上但写 `ContributionPointMap`（spec 须含 `id: string`）
- 加一个**新服务** → 在 `-api` 包 `export const mySvc = defineService<MyIface>('my-svc')`（登记型再给 `bind`）。领域能力放到实例 / model-handle 元数据上，用 helper 筛选（可选 `XxxCapabilityRegistry` 见第 8 节）
- 加一个**登记门面** → `defineService` 的 `bind` 里用 `BindingPort.registrar` / `serviceRef(port, extra)`
- 加一个**配置字段** → 在 `*-api` 包 `declare module '@aalis/core' { interface AalisConfig { myField: ... } }`，并提供 schema 给 ConfigManager
