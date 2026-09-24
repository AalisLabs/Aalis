# Aalis 架构总览

本文档描述 Aalis 框架的整体架构设计、核心流程和扩展机制。

## 设计哲学

Aalis 核心遵循**忒修斯之船**原则：Core 只提供最小化基础设施（事件、服务容器、中间件管道、插件生命周期），所有功能——LLM 调用、消息存储、对话编排、平台接入——由可插拔插件提供。可替换的是服务提供者；内置能力（`events` / `logger` / `config` / `lifecycle` / `provide` / `services` / `hooks` / `contributions`）不可经 `provide` 替换。

插件的交界面是 `definePlugin({ name, uses, provides, apply(caps) })`：能力经描述符显式声明，按激活绑定。没有默认注入。业务服务接口由对应的 `@aalis/api-*` 包以描述符导出，core 不持有任何业务接口。详见 [api 包架构](design/api-packages.md)。

`@aalis/core` 对外暴露：

- 运行时基础设施：`App` / `definePlugin` / `defineService` / `ConfigManager` / `Logger`，以及内置能力描述符（`events` / `hooks` / `contributions` / `lifecycle` / `logger` / `config` / `provide` / `services`）
- 三张扩展点表：`AalisEvents` / `HookContextMap` / `ContributionPointMap`（由 `@aalis/api-*` 经 declaration merging 注入业务键）。服务类型随描述符走，没有服务名类型表
- 宿主入口：`app.plugin` / `app.bind` / `app.config` / `app.plugins`
- `AalisConfig` 仅声明基础字段（`name` / `logLevel` / `plugins` / `disabledPlugins` / `servicePreferences`）加 `[key: string]: unknown` 兜底；业务字段（owners / deniedCapabilities / authorityOverrides / confirmOverrides 等）由对应 api-* 通过 declaration merging 注入，core 不知晓其语义
- `ConfigManager` 是纯内存配置中枢：自身不读写文件，`save()` 把整份配置快照原样委托给宿主注入的 `ConfigProvider.save()`（无 provider 时静默忽略），对所有顶层字段一视同仁、不含任何业务特例（合并默认值时 `mergeDefaultsConfig()` 也是先填 core 已知字段、再透传其余）

业务数据契约与领域类型一律不在 core：`Message` / `ContentSegment` / `ToolCall`（OpenAI 协议形状，跨载体复用）与 `getSenderLabel` / `prefixSender` / `getMessageName` 在 `@aalis/schema-message`，`ToolDefinition` / `ToolFunction` 在 `@aalis/api-tools`，`UserIdentity` 在 `@aalis/api-authority`，`ModelRef` / `resolveLLMModel` 在 `@aalis/api-llm`。

## 宿主层 vs 核心层（Bootstrap 边界）

`@aalis/core` 在物理上是**环境无关**的内存运行时：运行时代码不加载外部包，`package.json` 没有 `dependencies`，源码不 import 任何 `node:fs` / `node:path` / `node:os` / `node:child_process`，不调用 `process.cwd()` / `process.argv` / `console.*`，也不读 `process.env`（`devMode` 由宿主显式注入）。这意味着同一份 core 理论上可跑在浏览器、Worker、Deno 等任何 JS 运行时。

> 业务插件同样受约束：直接 import `node:fs` / `node:child_process` / `node:os` / `node:http(s)` 被 biome 拦截，必须改走 `@aalis/api-storage` / `@aalis/api-process`。完整白名单与豁免理由见 [node-usage-policy](architecture/node-usage-policy.md)。

环境耦合全部收敛在宿主层 `@aalis/runtime`（monorepo 由仓库根 `src/index.ts` 一行 `startAalis()` 拉起），通过 `new App({ ... })` 注入到 core：

| AppOption | 抽象（在 core） | 默认实现（在 `@aalis/runtime`） | 职责 |
|---|---|---|---|
| `config` / `configProvider` | `AalisConfig` / `ConfigProvider` | `createFsYamlConfigProvider()` | 配置读 / 写 / `fs.watch` 热重载 |
| `pluginLoader` | `PluginLoader` | `createFsPluginLoader()` | 扫描 `packages/` + dynamic import |
| `restartStrategy` | `RestartStrategy` | `createProcessRespawnStrategy()` | `child_process.spawn` 重启进程 |
| `devMode` | `boolean` | `process.env.NODE_ENV !== 'production'` | dev 校验开关 |

另外 `@aalis/runtime` 的 `startAalis` 还负责 stdout/stderr console-sink、文件日志、终端状态恢复、子命令分发、SIGINT 优雅退出 —— 这些都是**纯宿主关切**，core 完全不知情。

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
│        接口由 api-* 提供，实现可多提供者并存                  │
├──────────────────────────────────────────────────────────────┤
│                    核心框架层 (Core Layer)                     │
│   App · definePlugin / defineService · PluginManager          │
│   EventBus · ServiceContainer · HookRegistry · ConfigManager   │
│   Logger · 内置能力描述符                                      │
│   DisposableChain（资源内核，不导出）                         │
│   扩展点：AalisEvents / HookContextMap / ContributionPointMap  │
│   （业务接口均在 api-*，类型随描述符走）                       │
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
  ├─ 3. 组装 agent:prompt 贡献 → 物化为带归属标识的 system 块
  │     ├─ plugin-memory-vector / memory-summary: 语义记忆、摘要（context 槽）
  │     ├─ plugin-user-profile / user-relation: 档案、关系（identity 槽）
  │     └─ plugin-skills: 技能库路标与已激活正文（knowledge 槽）
  │
  ├─ 4. hooks.run('agent:llm:before') ← 拦截者审已成型的 messages
  │     └─ plugin-tool-search: 替换工具列表为搜索层
  │
  ├─ 5. trimMessages() ← 按 token 预算裁剪
  │
  ├─ 6. LLM.chatStream() → 流式输出 → outbound:stream 事件
  │
  ├─ 7. hooks.run('agent:llm:after')
  │
  ├─ 8. 工具调用循环 (最多 maxToolIterations 次)
  │     ├─ hooks.run('agent:tool:before')
  │     ├─ tools.require().execute() ← 权限检查 + 执行
  │     ├─ hooks.run('agent:tool:after')
  │     └─ 追加工具结果 → 继续调用 LLM
  │
  ├─ 9. hooks.run('agent:reply:before')
  │     └─ plugin-persona: outputFormat JSON 解析
  │
  ├─ 10. 保存到 memory (用户+助手消息)
  │
  └─ 11. events.emit('outbound:message') → 各平台输出给用户
```

## 核心扩展机制

Aalis 提供四种互补的扩展手段，覆盖不同粒度的定制需求：

### 1. 中间件管道 (Hooks)

插件通过 `hooks.middleware(hook, fn)` 注册中间件，拦截核心流程的各阶段。中间件可修改数据或中断流程。同一钩子内多个 handler 按注册顺序执行洋葱模型（无优先级数字）；跨钩子顺序由调度方（如 plugin-gateway）显式决定。

```typescript
// 拦截消息（不调用 next = 中断整个管道）
hooks.middleware('agent:input:before', async (data, next) => {
  if (shouldBlock(data.message)) return; // 中断
  data.message.content += ' [已审核]';   // 修改
  await next();                           // 继续
});
```

详见 [events.md — 中间件系统](core/events.md)

### 2. 服务替换 (Service IoC)

任何服务都可以被替换。提供同名服务的插件自动参与优先级竞争：

```typescript
provide(agent, myAgent, { priority: 20 });
```

详见 [service.md — 服务](core/service.md)

### 3. 事件监听 (EventBus)

松耦合的发布/订阅模式，用于响应系统事件而不干预流程：

```typescript
events.on('outbound:message', async (msg) => { /* 记录日志、统计等 */ });
```

### 4. 贡献点 (Contribution Points)

向共享产物提交一块内容，排布权归收集方。与 hooks 的分工：**改写或截停既有流程 → hooks；向共享产物添加自己的一块 → 贡献点**。贡献者拿只读视图、不掌握控制流（无短路、无排序影响力、看不到他人产出），因此重复注入、排布漂移、错误连坐在 API 上无法表达。

```typescript
contributions.contribute('agent:prompt', {
  id: 'my-block',
  anchor: 'context',
  build: async view => (view.dryRun ? null : `补充上下文：${await load(view.sessionId)}`),
});

for (const { key, spec } of contributions.collect('my-plugin:panel')) { /* ... */ }
```

### 5. Declaration Merging

第三方插件可通过 TypeScript 声明合并来扩展核心类型（事件 / 钩子 / 贡献点）。服务类型随描述符走，不往扩展点表里登记服务名。

```typescript
declare module '@aalis/core' {
  interface AalisEvents {
    'scheduler:tick': [jobId: string];
  }
  interface HookContextMap {
    'schedule:before': { jobId: string; cron: string };
  }
  interface ContributionPointMap {
    'my-plugin:panel': { id: string; render(): string };
  }
}
```

## 服务 IoC 与多实现解析

### 服务注册

```typescript
provide(llm, deepseekService, { priority: 10 });
```

`provide` 不接受 `capabilities` 选项——内核 DI 只关心「按名解析服务实例」。
领域级筛选（如按 LLM 模型的 tool-calling / vision 能力挑模型、按 storage root 选权限）
由各 `-api` 包在服务实例自己的元数据上处理（如 LLM 把能力挂在 model handle 上），
不再经过内核的服务能力匹配层。

### 服务消费

```typescript
const model = llm.current; // ServiceRef：每次读取重新解析胜者
```

`current` / `require` 只接受已经写进 `uses` 的描述符所绑定的接口，返回当前胜者（不再有 capabilities 参数）。动态按名查询走 `services.get`，不产生依赖边。

### 多实现解析顺序

同一服务可有多个提供者。解析顺序为 **偏好 > 优先级 > 注册顺序**：
先看是否有用户偏好的 entry，否则取 priority 最高者（同优先级取先注册者）。

```
llm 服务:
  [0] plugin-llm-deepseek (priority=10)   ← current 默认胜者
  [1] plugin-llm-openai   (priority=0)
```

### 服务偏好

用户可通过配置（`servicePreferences`）或 WebUI Services 页切换首选提供者
（`services.prefer(key, contextId)`）。偏好者总是 `current` 的第一返回值，
即使其 priority 低于其他 entry；切换偏好会发出 `service:preference-changed`，
驱动 `follow` 订阅者按胜者变化重挂。

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

### 统一状态机：`recompute(kind)`

PluginManager 只有一个外部可见的状态变更入口：`recompute(kind)`。种类只有 `'changed' | 'shutdown'`。所有生命周期路径（服务注册/移除、启用/禁用、配置更新、bounce、关机）都汇入同一状态机。

| kind | 触发场景 |
|---|---|
| `changed` | `service:registered` / `service:unregistered`、enable / disable / updateConfig / bounce |
| `shutdown` | `App.stop()` 经 `stopAll()` |

optional 上下线与胜者替换不改变目标态，不级联 bounce。有状态接线走 `ServiceRef.follow`。

#### 单轮两阶段（拓扑保证）

每轮 recompute 先按 provider→consumer 拓扑排序（Kahn），然后：

1. **Phase A 成批关闭**：本轮目标不再是 active 的，它们之间的次序由关停编排按实际绑定决定。
2. **Phase B 正向遍历 activate**（非 shutdown）：提供者先于消费者 active。

如本轮有变动则进入下一轮，直到稳定或达到轮次上限（`maxRounds = 2×插件数 + 8`）。

整体停机（`app.stop()`）单飞：先冻闸并进入停机态，再 `idle()`，再发 `app:stopping`，等监听器完成后执行停机计划。每次调用都返回完整停机的同一 Promise；监听器与清理回调不能 await 或返回它，以免等待自身。全部 active 插件与根激活进同一张计划：每个激活 drain 后 close。optional 依赖成环时，分量内成员先全部 drain，再任一 close。边规则见 [插件定义与能力](core/context.md)。单插件 unload / disable / bounce 同样先关正在用它的 required 下游（传递闭包），下游收尾时提供者仍在。动态 `services.get` 不产生依赖边，关停期间可能取到空。

### 隔离粒度

- **完全隔离** — 需要独立事件总线、独立日志通道时，应直接 `createApp({ events, services, hooks, ... })` 创建新的 `App` 实例。`Logger` 可注入独立 `LogHub` 隔离日志缓冲。
- 按会话/租户**差异化配置**不需要激活隔离——用键控解析（参考 session-manager 的 `resolveConfig(sessionId)` 模式）。
- `ServiceRef.follow(attach)`：在场即调 attach，换人时先跑上次返回的清理再用新实例调，下线与关闭时清理。attach 必须同步返回函数 cleanup（或不需要清理时不返回）；thenable 会被接住并 warn。这是消费枢纽型服务、建立有状态资源的入口（参见 [docs/core/context.md](core/context.md)）。

#### 激活关闭时的推荐 API

| 场景 | API |
|---|---|
| 监听事件 | `events.on(event, fn)` — 关闭时自动注销 |
| 注册中间件 | `hooks.middleware(hook, fn)` — 关闭时自动注销 |
| 发布服务 | `provide(descriptor, impl)` — 关闭时自动注销 |
| 清理外部资源（连接、定时器、子进程） | `lifecycle.onDrain` / `lifecycle.onDispose` |
| 跟随提供者 | `x.follow(attach)` |

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
| `inbound:confirm` | `InboundPhaseData` | plugin-session-confirm | （无）|
| `inbound:command` | `InboundPhaseData` | plugin-commands | （无）|
| `inbound:flow` | `InboundPhaseData` | plugin-flow-control | （无）|
| `inbound:trigger` | `InboundPhaseData` | plugin-trigger-policy | （无）|
| `inbound:dispatch` | `InboundPhaseData` | — | `agent.handleMessage(message)` |

`InboundPhaseData = { message, metadata, agent }`，对象在各相位间共享传递。
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
await hooks.run('my-plugin:before', { task: taskData }, async () => {
  // defaultAction
});

// 注入 handler 的第三方插件
hooks.middleware('my-plugin:before', async (data, next) => {
  data.task.modified = true;
  await next();
});
```

## 权限与安全

权限是**两条正交的轴**：轴 A「等级」决定**谁可以执行**，轴 B「确认」做 HITL 意图核对
（owner 同样受确认轴约束，以抵御提示词注入借权）。两轴由 plugin-authority 统一裁决。

### 轴 A · 数字等级裁决（开放整数等级）

```
每个外部身份 → 一个整数等级（缺省 0，封禁 = 负数）
owner        → ∞（靠 owners 列表归属，不在等级轴上，永不能被设成有限值）
每个操作     → 一个最低等级 minLevel

minLevel 解析（首个命中赢）:
  1. authorityOverrides[capability]  ← owner 逐条覆盖成任意整数
  2. risk 派生                       ← safe→0 · sensitive→1 · dangerous→2
  3. visibility 兜底（无 risk 时）   ← public→0 · restricted→2

裁决 resolveAccess（首个命中赢）:
  1. deniedCapabilities glob 全局硬禁 → 拒（压过一切，含 owner；配置总闸，非 per-user）
  2. isOwner                          → 放行
  3. level >= minLevel                → 放行；否则拒（封禁=负数连 minLevel=0 都不过）
```

没有命名档位（受信/管理员等表面名仅是等级整数的别称）、没有能力委托图、
没有 per-user 的逐条能力授予/禁用列表。owner **只管理权限**（不能自授）：
WebUI authority 页（仅 owner）+ 指令 `/level`（设某用户等级）与 `/auto`（自动确认模式）。
模型详见 [docs/plugins/plugin-authority.md](plugins/plugin-authority.md)。

### 轴 B · 确认（HITL 意图核对）

确认轴与等级轴正交，由独立的 **plugin-session-confirm**（HITL 协调器）执行，
经 `setConfirmHandler` 注册进 authority。`risk` 声明同时设两轴默认值
（如 `dangerous` = `visibility:'restricted'` + `confirm:'session'`）。

```
触发命中 confirm 的操作
  │
  ▼
可跳过确认? （shouldSkipConfirm，always 永不可跳）
  ├─ skipConfirm（系统/受信源，如 scheduler 无人可点）→ 跳过
  ├─ auto 模式 且 触发者是 owner 本人 → 跳过
  └─ 否则 → 向 confirmHandler 发起确认
       │
       ▼
     回复 Y   → 放行本次
     回复 YS  → 放行本会话（限时，session 记住）
     其它     → 取消
```

`confirm:'always'` 是最高危档：**每次都必须有人确认**，永不被 session 记住、
也不被 auto 模式跳过（cron 等无人确认场景直接拒）。

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

core 自持的十一个基础设施事件（`app:*` 五个屏障、`service:*` / `plugin:*` / `plugins:changed` 六个通知）及其时序见
[core/events.md](core/events.md)；业务事件由各 `-api` 包注入，按包查见[扩展点索引 §2](extensions/index.md)。
总线上没有 `dispose` 事件，清理副作用用 `lifecycle.onDrain` / `lifecycle.onDispose`；`memory:clear` 是钩子不是事件，见 events.md 的钩子节。

## 向量语义记忆

### 索引流程

仅对已落库的入站用户消息建索引（`inbound:message:archived`），助手/出站消息不入向量库。

```
inbound:message:archived → embedding.embed(prefixSender(text)) → vectorstore.add(vector, metadata)
```

### 检索与注入

检索通过 `agent:prompt` 贡献（context 槽）完成，非独立 hook、无优先级数字；token 干跑（dryRun）跳过真实检索。

```
agent:prompt 贡献 (context 槽):
  1. 提取最后一条用户消息
  2. embedding.embed(query)
  3. vectorstore.search(queryVector, topK*4)  ← 粗召回
  4. 阈值过滤 + 跨会话模式过滤
  5. 时间加权重排:
     finalScore = (1-timeWeight) * semanticScore + timeWeight * recencyScore
     recencyScore = exp(-0.1 * daysSince)
  6. 取前 topK，扩展上下文窗口并去重
  7. 物化为 system 块（带日期和来源标注）
```
