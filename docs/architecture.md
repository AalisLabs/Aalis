# Aalis 架构总览

本文档描述 Aalis 框架的整体架构设计、核心流程和扩展机制。

## 设计哲学

Aalis 核心遵循**忒修斯之船**原则：Core 只提供最小化基础设施（事件、服务容器、中间件管道、插件生命周期），所有功能——LLM 调用、消息存储、对话编排、平台接入——由可插拔插件提供。核心的任何行为均可被插件拦截、修改或完全替换。

**类型与接口层面**：所有业务服务接口（LLM / Memory / Storage / Tools / Commands / Gateway / WebUI / Authority / Agent 等）由对应的 `@aalis/plugin-*-api` 包提供，core 不持有任何业务接口。详见 [api 包架构](design/api-packages.md)。

`@aalis/core` 对外暴露：

- 运行时基础设施：`App` / `Context` / `EventBus` / `ServiceContainer` / `HookRegistry` / `ConfigManager` / `Logger` / `PluginManager`
- 三个扩展点：`ServiceCapabilityMap` / `AalisEvents` / `HookContextMap`（均通过 declaration merging 由 `@aalis/plugin-*-api` 注入业务键）
- 核心数据契约：`Message` / `ContentSegment` / `ToolCall` / `ToolDefinition` / `ToolFunction`（OpenAI 协议形状，跨载体复用）
- `AalisConfig` 仅声明基础字段（`name` / `logLevel` / `plugins` / `disabledPlugins` / `servicePreferences`）加 `[key: string]: unknown` 兜底；业务字段（owners / restrictedCapabilities / visibilityOverrides 等）由对应 plugin-*-api 通过 declaration merging 注入，core 不知晓其语义
- `ConfigManager.buildSaveObject()` 对所有顶层字段一视同仁（先输出 core 已知字段，再透传其余），不再含任何业务特例

身份/平台/模型相关的工具与类型一律不在 core 中：`UserIdentity` 在 `@aalis/plugin-authority-api`，`ModelRef` / `resolveLLMModel` 在 `@aalis/plugin-llm-api`，`getSenderLabel` / `prefixSender` / `getMessageName` 在 `@aalis/plugin-message-api`。

## 宿主层 vs 核心层（Bootstrap 边界）

`@aalis/core` 在物理上是**环境无关**的内存运行时：`package.json` 零运行时依赖，源码不 import 任何 `node:fs` / `node:path` / `node:os` / `node:child_process`，不调用 `process.cwd()` / `process.argv` / `console.*`，也不读 `process.env`（`devMode` 由宿主显式注入）。这意味着同一份 core 理论上可跑在浏览器、Worker、Deno 等任何 JS 运行时。

> 业务插件同样受约束：直接 import `node:fs` / `node:child_process` / `node:os` / `node:http(s)` 被 biome 拦截，必须改走 `@aalis/plugin-storage-api` / `@aalis/plugin-process-api`。完整白名单与豁免理由见 [node-usage-policy](architecture/node-usage-policy.md)。

环境耦合全部在仓库根 `src/` 这一层（即"宿主"），通过 `new App({ ... })` 注入到 core：

| AppOption | 抽象（在 core） | 默认实现（在 `src/runtime/`） | 职责 |
|---|---|---|---|
| `config` / `configProvider` | `AalisConfig` / `ConfigProvider` | `createFsYamlConfigProvider()` | 配置读 / 写 / `fs.watch` 热重载 |
| `pluginLoader` | `PluginLoader` | `createFsPluginLoader()` | 扫描 `packages/` + dynamic import |
| `restartStrategy` | `RestartStrategy` | `createProcessRespawnStrategy()` | `child_process.spawn` 重启进程 |
| `dataDir` | `string` | 由 yaml provider 决定 | 数据目录绝对路径 |
| `devMode` | `boolean` | `process.env.NODE_ENV !== 'production'` | dev 校验开关 |

另外 `src/index.ts` 还负责 stdout/stderr console-sink、文件日志、终端状态恢复、子命令分发、SIGINT 优雅退出 —— 这些都是**纯宿主关切**，core 完全不知情。

## 系统分层

```
┌──────────────────────────────────────────────────────────────┐
│                    平台层 (Platform Layer)                    │
│   CLI  ·  WebUI (Express+WS+React)  ·  OneBot v11/v12       │
├──────────────────────────────────────────────────────────────┤
│                    流控层 (Flow Control Layer)                │
│   ChatFlow: 消息缓冲 → 触发评分 → 空闲检测 → 打字延迟        │
├──────────────────────────────────────────────────────────────┤
│                    任务编排层 (Task Layer)                    │
│   SessionManager: 会话树 · 子任务并行 · 平台配置继承     │
│   Scheduler: Cron 定时任务 · 主动执行                      │
│   TodoList: 任务跟踪 · 子任务协调                          │
├──────────────────────────────────────────────────────────────┤
│                    对话编排层 (Agent Layer)                    │
│   DefaultAgent: 消息构建 → LLM 调用 → 工具循环 → 上下文裁剪   │
├──────────────────────────────────────────────────────────────┤
│                    服务层 (Service Layer)                      │
│   LLM · Memory · Embedding · VectorStore · Persona · Tools   │
│   Skills · ImageRecognition · WebSearch · Office              │
│        接口由 plugin-*-api 提供，实现可多提供者并存           │
├──────────────────────────────────────────────────────────────┤
│                    核心框架层 (Core Layer)                     │
│   App · Context · ServiceContainer · PluginManager            │
│   EventBus · HookRegistry · ConfigManager · Logger             │
│   3 个扩展点：ServiceCapabilityMap / AalisEvents / HookContextMap  │
│   （业务接口均在 plugin-*-api，core 不持有）                  │
└──────────────────────────────────────────────────────────────┘
```

## 消息处理完整流程

```
用户输入 (CLI / WebUI / OneBot)
  │
  ▼
Platform 适配器接收 → 发出 inbound:message 事件
  │
  ▼
App 路由 → Agent.handleMessage(incoming) 作为中间件默认行为
  │
  ├─ 1. hooks.run('agent:input:before', { message, metadata }, defaultAction)
  │     │
  │     ├─ [ChatFlow 中间件] 流控拦截/缓冲
  │     ├─ [其他插件中间件]
  │     └─ 全部通过 → defaultAction() 进入 Agent 处理
  │
  ├─ 2. buildMessages()
  │     └─ [系统提示词] + [历史消息(≤50)] + [当前用户消息]
  │
  ├─ 3. hooks.run('agent:llm:before')
  │     ├─ plugin-memory-vector: 注入语义记忆上下文
  │     └─ plugin-tool-search: 替换工具列表为搜索层
  │
  ├─ 4. trimMessages() ← 按 token 预算裁剪
  │
  ├─ 5. LLM.chatStream() → 流式输出 → outbound:stream 事件
  │
  ├─ 6. hooks.run('agent:llm:after')
  │
  ├─ 7. 工具调用循环 (最多 maxToolIterations 次)
  │     ├─ hooks.run('agent:tool:before')
  │     ├─ ctx.getService<ToolService>('tools')!.execute() ← 权限检查 + 执行
  │     ├─ hooks.run('agent:tool:after')
  │     └─ 追加工具结果 → 继续调用 LLM
  │
  ├─ 8. hooks.run('agent:reply:before')
  │     └─ plugin-persona: outputFormat JSON 解析
  │
  ├─ 9. 保存到 memory (用户+助手消息)
  │
  └─ 10. emit('outbound:message') → 各平台输出给用户
```

## 核心扩展机制

Aalis 提供三种互补的扩展手段，覆盖不同粒度的定制需求：

### 1. 中间件管道 (Hooks)

插件通过 `ctx.middleware(hook, fn)` 注册中间件，拦截核心流程的各阶段。中间件可修改数据或中断流程。同一钩子内多个 handler 按注册顺序执行洋葱模型（无优先级数字）；跨钩子顺序由调度方（如 plugin-gateway）显式决定。

```typescript
// 拦截消息（不调用 next = 中断整个管道）
ctx.middleware('agent:input:before', async (data, next) => {
  if (shouldBlock(data.message)) return; // 中断
  data.message.content += ' [已审核]';   // 修改
  await next();                           // 继续
});
```

详见 [events.md — 中间件系统](core/events.md)

### 2. 服务替换 (Service IoC)

任何服务都可以被替换。提供同名服务的插件自动参与优先级竞争：

```typescript
// 注册自定义 Agent 实现
ctx.provide('agent', myAgent, { capabilities: ['multi-turn'], priority: 20 });
```

详见 [service.md — 服务容器](core/service.md)

### 3. 事件监听 (EventBus)

松耦合的发布/订阅模式，用于响应系统事件而不干预流程：

```typescript
ctx.on('outbound:message', async (msg) => { /* 记录日志、统计等 */ });
```

### 4. Declaration Merging

第三方插件可通过 TypeScript 声明合并来扩展核心类型：

```typescript
declare module '@aalis/core' {
  interface AalisEvents {
    'scheduler:tick': [jobId: string];
  }
  interface HookContextMap {
    'schedule:before': { jobId: string; cron: string };
  }
}
```

## 服务 IoC 与能力匹配

### 服务注册

```typescript
ctx.provide('llm', deepseekService, {
  capabilities: ['chat', 'tool_calling', 'streaming', 'thinking'],
  priority: 10,
});
```

### 服务消费

```typescript
const llm = ctx.getService<LLMService>('llm', ['tool_calling']);
```

### 多实现优先级

同一服务可有多个提供者。框架按优先级降序排列，`getService()` 返回满足所需能力的最高优先级实例。

```
llm 服务:
  [0] plugin-deepseek (priority=10, caps=[chat, tool_calling, streaming])
  [1] plugin-openai   (priority=0,  caps=[chat, tool_calling, streaming])
```

### 服务偏好

用户可通过配置或 WebUI 切换首选提供者（`preferService`）。

## 插件生命周期

```
register
  │
  ▼
pending ──(所有 required 依赖满足)──→ activating ──→ active
  ▲                                                    │
  │                                                    │
  └───(依赖服务被移除)────────────────────────────────┘

disabled ←─(手动禁用)─ active
  │
  └─(手动启用)─→ pending → ...
```

### 统一状态机：`recompute(reason)`

PluginManager 只有一个外部可见的状态变更入口：`recompute(reason)`。所有生命周期路径
（服务注册/移除、启用/禁用、配置更新、bounce、关机）都被归一为 `RecomputeReason` 后
汇入同一状态机。

| Reason | 触发场景 |
|---|---|
| `service-up` | `service:registered` 反应式调用 |
| `service-down` | `service:unregistered` 反应式调用；仅下游声明 `requiresBounceOnDepChange: true` 时才级联 bounce（默认否） |
| `plugin-state-changed` | enable/disable/updateConfig/bounce 后调用（`softReload()` 薄壳） |
| `shutdown` | `App.stop()` 调用（`stopAll()` 薄壳） |

#### 单轮两阶段（拓扑保证）

每轮 recompute 先按 provider→consumer 拓扑排序（Kahn），然后：

1. **Phase A 反向遍历 dispose**：消费者先于提供者 dispose，保证 dispose hook 访问依赖服务安全。
2. **Phase B 正向遍历 activate**（非 shutdown）：提供者先于消费者 active。

如本轮有变动则进入下一轮，直到稳定（fixed-point）或达到 `maxRounds=20`。`service-up` /
`service-down` 在第二轮起退化为 `plugin-state-changed`，避免无限 optional bounce。

### 沙盒与隔离作用域

Aalis 提供两种隔离粒度：

- **`ctx.fork(id)`** — 复用全部根子系统，仅独立 `_disposables`。适合"同 App 内一个独立插件实例"。
- **`ctx.createScope(id)`** — 创建 `ScopedServiceContainer` + `ScopedConfigManager`（fallback 读、写不影响父），但仍**共享** `EventBus` 与 `HookRegistry`。
  - 沙盒内 `ctx.provide(...)` / `ctx.config.set(...)` 隔离 ✓
  - 沙盒内 `ctx.on(event, ...)` / `ctx.middleware(hook, ...)` 仍**全局生效**，dispose 时由 `contextId` 反查清理
  - ⚠️ 沙盒应避免注册"产生跨作用域副作用"的全局事件（如 `service:registered`），可能干扰主进程逻辑
  - 🧪 **状态：实验性**。当前生产代码里 `createScope` / `useModule({ scoped: true })` 没有任何插件直接消费，仅 `test/core/sandbox.test.ts` 自测；接口语义稳定可用，但若长期未消费可能在未来版本被精简。`whenService(name, cb)` 是**稳定 API**：每次 provider 上线都调一次 `cb`，下线/ctx dispose 自动调上次返回的 cleanup，跨 bounce 自动重挂——是消费 hub 型服务的推荐入口（参见 [docs/core/context.md](core/context.md)）。
- **完全隔离** — 需要独立事件总线、独立日志通道时，应直接 `createApp({ events, services, hooks, ... })` 创建新的 `App` 实例。`Logger` 可注入独立 `LogHub` 隔离日志缓冲。

#### Context dispose 推荐 API

| 场景 | API |
|---|---|
| 监听事件 | `ctx.on(event, fn)` — dispose 时自动注销 |
| 注册中间件 | `ctx.middleware(hook, fn)` — dispose 时自动注销 |
| 注册服务 | `ctx.provide(name, impl, { capabilities })` — dispose 时自动注销 |
| 清理外部资源（连接、定时器、子进程） | `ctx.onDispose(() => cleanup())` |
| ⚠️ 绕过自动清理（需手动管理） | `ctx.serviceContainer.register(...)` — 仅供桥接/诊断 |

## 中间件钩子管道

钩子（Hook）是命名的中间件管道，插件可拦截核心流程的各阶段。

### 执行模型

```
hooks.run(hookName, data, defaultAction?) → reachedEnd: boolean
  │
  ▼
handler A（先注册）─── await fn(data, next)
  │ next()              │ 不调用 next() → 链终止
  ▼                      ▼
handler B（后注册）   管道返回 false，defaultAction 不执行
  │ next()
  ▼
defaultAction()        ← 所有 handler 通过后执行
```

**关键约定**：
- 同一钩子内多个 handler 按 **注册顺序** 执行洋葱模型，无优先级数字
- 不调用 `next()` 即中止整个管道（含 defaultAction）；`hooks.run()` 返回 `false`
- 跨钩子的顺序由调度方（如 plugin-gateway）显式决定

### Gateway 入站生命周期相位

入站消息按以下命名相位**顺序**串行执行；任一相位被 swallow 即停止后续调度：

| 相位 | 数据载荷 | 占据者 | 默认动作 |
|---|---|---|---|
| `inbound:command` | `InboundPhaseData` | plugin-commands | （无）|
| `inbound:flow` | `InboundPhaseData` | plugin-flow-control | （无）|
| `inbound:trigger` | `InboundPhaseData` | plugin-trigger-policy | （无）|
| `inbound:dispatch` | `InboundPhaseData` | — | `agent.handleMessage(message)` |

`InboundPhaseData = { message, metadata, agent }`，对象在四个相位间共享传递。
第三方插件可注册到任一相位获得清晰的语义位置——无需理解优先级数字、无需与其他插件协商占位。

### 其他钩子

| 钩子名 | 数据 | 用途 |
|---|---|---|
| `outbound:dispatch` | `{ message, metadata }` | 出站主管道；默认动作是 `emit('outbound:message')`，handler 可脱敏 / 限速 / 审计。 |
| `agent:input:before` | `{ message, metadata }` | 修改/拦截收到的消息（图像识别、文件提取） |
| `agent:turn:after` | `{ message, reply, sessionId, metadata }` | agent 回复周期完成后（摘要触发、子任务完成检测） |
| `agent:llm:before` | `{ messages, tools, sessionId }` | 修改发给 LLM 的消息列表和工具（记忆注入、技能注入、工具搜索替换） |
| `agent:llm:after` | `{ response, messages }` | 处理 LLM 返回的响应 |
| `agent:tool:before` | `{ name, args, toolCallContext }` | 修改工具调用参数 |
| `agent:tool:after` | `{ name, result, toolCallContext }` | 处理工具返回结果 |
| `agent:reply:before` | `{ content, sessionId }` | 修改最终回复内容（persona JSON 解析） |

> 入站请使用 `inbound:*` 相位，出站请使用 `outbound:dispatch`。

### 遥测事件

`gateway:phase:done` 在每个 inbound 相位结束后发出，携带 `{ phase, reachedEnd, durationMs, sessionId, platform }`，可用于度量耗时与 swallow 率，对主流程零侵入。

### 扩展自定义钩子

插件可以定义并触发自己的钩子，第三方可注入 handler：

```typescript
// 定义钩子的插件
await ctx.hooks.run('my-plugin:before', { task: taskData }, async () => {
  // defaultAction
});

// 注入 handler 的第三方插件
ctx.middleware('my-plugin:before', async (data, next) => {
  data.task.modified = true;
  await next();
});
```

## 权限与安全

### 能力委托模型（无数字等级）

```
owner = `*`              → 拥有一切、可委托一切（owners 配置 + webui/cli console）
public 能力              → 所有人默认拥有（除非被 deny）
restricted 能力          → 默认禁止，须被 owner / 上层委托授予
有效能力 = owner ? 全部 : (所有 public ∪ 被授予的 restricted) − 被禁用的
裁决优先级 = deny > owner(*) > public > granted(restricted)
```

委托遵循子集约束（非 owner 只能授予自己持有的能力，孙 ⊆ 子 ⊆ owner）。
模型详见 [docs/core/authority.md](core/authority.md)。

### 受限能力临时委托流程

```
工具/指令声明 visibility='restricted'（命中未授予能力时）
  │
  ▼
authorize 统一闸（deny > owner > public > granted）— 被授予则直接放行
  │ 未授予且为 restricted
  ▼
restrictedPolicy 白名单（config + 时限）→ 命中放行
  │ 未命中
  ▼
会话内临时授予复用（按 sessionId 隔离）→ 命中放行
  │ 未命中
  ▼
交互式确认 (平台 confirmHandler) — owner 确认 Y
  │
  ▼
建立会话内临时授予（durationSeconds / maxUses）并执行
```

## 上下文窗口管理算法

`trimMessages()` 采用五阶段裁剪策略适配 LLM 上下文窗口：

```
可用 token = contextLength - maxTokens - 512(安全余量)

保护规则:
  1. 首条系统消息 (主提示词) — 永不删除
  2. 最新用户消息 (当前任务上下文) — 永不删除
  3. 最后一组工具调用 (assistant+tool 成组) — 永不删除
  4. Hook 注入的系统消息有独立预留额度 (memoryTokenBudget)

裁剪阶段:
  第一阶段: 压缩超大系统消息 (最少保留 200 字符)
  第二阶段: 截断过长工具输出 (>1500 字符 → 保留前 500)
  第 2.5 阶段: 精简思考内容 (删除旧迭代、截断最新)
  第三阶段: 摘要旧工具调用组 (压缩为 "[tool] → result" 格式)
  第四阶段: 从最旧开始删除非系统消息 (保护最新用户消息 + 工具组)
  第五阶段: 删除 Hook 注入的系统消息 (最后手段)

压缩后延续提示:
  当裁剪删除 ≥6 条消息时，自动注入系统提示：
  "由于上下文长度限制，部分历史消息已被压缩或移除。
   请基于当前可见的上下文继续完成任务。"
```

## 事件列表

| 事件 | 参数 | 说明 |
|---|---|---|
| `inbound:message` | `IncomingMessage` | 平台收到用户消息 |
| `outbound:message` | `OutgoingMessage` | AI 回复即将发送 |
| `outbound:stream` | `StreamChunkMessage` | 流式输出增量 |
| `tool:execute` | `ToolExecuteMessage` | 工具调用开始/结束 |
| `session:created` | `sessionId` | 会话创建 |
| `session:updated` | `sessionId` | 会话更新 |
| `session:switched` | `sessionId` | 会话切换 |
| `session:deleted` | `sessionId` | 会话删除 |
| `session:completed` | `sessionId` | 子任务会话完成 |
| `todo:updated` | `{ sessionId, items }` | 待办事项更新 |
| `scheduler:job:start` | `jobId` | 定时任务开始 |
| `scheduler:job:done` | `jobId` | 定时任务完成 |
| `scheduler:job:error` | `jobId, error` | 定时任务出错 |
| `memory:clear` | `scope, types?, sessionId?, results, rollbacks` | 统一记忆清理编排 |
| `service:registered` | `name, capabilities[]` | 服务注册 |
| `service:unregistered` | `name` | 服务移除 |
| `plugin:loaded` | `name` | 插件加载 |
| `plugin:unloaded` | `name` | 插件卸载 |
| `plugins:changed` | — | 插件状态变更 |
| `app:starting` | — | 应用启动中 |
| `ready` | — | 应用启动完成 |
| `app:stopping` | — | 应用停止中 |
| `dispose` | — | 应用关闭 |
| `restarting` | — | 应用即将重启 |

## 向量语义记忆

### 索引流程

```
inbound:message → embedding.embed(text) → vectorstore.add(vector, metadata)
outbound:message     → embedding.embed(text) → vectorstore.add(vector, metadata)
```

### 检索与注入

```
agent:llm:before hook (优先级 50):
  1. 提取最后一条用户消息
  2. embedding.embed(query)
  3. vectorstore.search(queryVector, topK*3)  ← 粗召回
  4. 时间加权重排:
     finalScore = (1-timeWeight) * semanticScore + timeWeight * recencyScore
     recencyScore = exp(-0.1 * daysSince)
  5. 取前 topK，过滤重复
  6. 插入 system 消息（带日期和来源标注）
```
