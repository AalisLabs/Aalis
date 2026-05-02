# Aalis 架构总览

本文档描述 Aalis 框架的整体架构设计、核心流程和扩展机制。

## 设计哲学

Aalis 的核心遵循**忒修斯之船**原则：Core 自身只提供最小化的基础设施（事件、服务容器、中间件管道、插件生命周期），所有功能——包括 LLM 调用、消息存储、对话编排、平台接入——全部由可插拔的插件提供。核心的任何行为都可以被插件拦截、修改或完全替换。

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
├──────────────────────────────────────────────────────────────┤
│                    核心框架层 (Core Layer)                     │
│   App · Context · ServiceContainer · PluginManager            │
│   EventBus · HookRegistry · CommandRegistry · ToolRegistry    │
│   ConfigManager · AuthorityManager · Logger                   │
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
  │     ├─ [ChatFlow 中间件, priority=200] 流控拦截/缓冲
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
  │     ├─ ctx.tools.execute() ← 权限检查 + 执行
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

Aalis 提供四种互补的扩展手段，覆盖不同粒度的定制需求：

### 1. 中间件管道 (Hooks)

最强大的扩展手段。插件通过 `ctx.middleware(hook, fn, priority)` 注册中间件，拦截核心流程的每个阶段。中间件既可以修改数据、也可以完全中断流程。

```typescript
// 拦截消息（不调用 next = 中断整个管道）
ctx.middleware('agent:input:before', async (data, next) => {
  if (shouldBlock(data.message)) return; // 中断
  data.message.content += ' [已审核]';   // 修改
  await next();                           // 继续
}, 200);
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

### 4. Context Mixin

将服务方法直接代理到 Context 原型上，让所有插件都可以像调用内置方法一样使用：

```typescript
ctx.mixin('scheduler', ['schedule', 'cron']);
// 之后任何 Context 实例都可以调用 ctx.schedule(...)
```

### 5. Declaration Merging

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

### Soft Reload 机制

当服务注册/移除时触发 soft reload（固定点迭代）：

1. **Phase 1**: 停用所有 required 依赖不满足的 active 插件 → pending
2. **Phase 2**: 尝试激活所有 pending 插件
3. **Phase 3**: 检查必需服务缺失时自动恢复（`ensureServiceProvider`）
4. **Phase 4**: 发出 `plugins:changed` 事件

### 依赖与服务恢复

`ensureServiceProvider(serviceName)` 会搜索所有 pending 插件中能 `provides` 该服务的插件，并尝试递归激活其依赖链。

## 中间件钩子管道

钩子（Hook）是有序的中间件管道，插件可拦截核心流程的各阶段。

### 执行模型

```
hooks.run(hookName, data, defaultAction)
  │
  ▼
中间件 A (priority=200) ─── await fn(data, next)
  │ next()                     │ 不调用 next() → 中断
  ▼                             ▼
中间件 B (priority=100)      管道终止，defaultAction 不执行
  │ next()
  ▼
中间件 C (priority=0)
  │ next()
  ▼
defaultAction() ← 所有中间件通过后执行
```

### 钩子列表

| 钩子名 | 数据 | 用途 |
|---|---|---|
| `agent:input:before` | `{ message, metadata }` | 修改/拦截收到的消息（图像识别、文件提取、流控拦截） |
| `agent:turn:after` | `{ message, reply, sessionId, metadata }` | agent 回复周期完成后（摘要触发、子任务完成检测） |
| `agent:llm:before` | `{ messages, tools, sessionId }` | 修改发给 LLM 的消息列表和工具（记忆注入、技能注入、工具搜索替换） |
| `agent:llm:after` | `{ response, messages }` | 处理 LLM 返回的响应 |
| `agent:tool:before` | `{ name, args, toolCallContext }` | 修改工具调用参数 |
| `agent:tool:after` | `{ name, result, toolCallContext }` | 处理工具返回结果 |
| `agent:reply:before` | `{ content, sessionId }` | 修改最终回复内容（persona JSON 解析） |

中间件按优先级降序执行，通过调用 `next()` 传递控制权。**不调用 `next()` 即中止整个管道（包括 defaultAction）**——这是拦截消息的标准做法。

### 扩展自定义钩子

插件可以定义并触发自己的钩子，第三方可注入中间件：

```typescript
// 定义钩子的插件
await ctx.hooks.run('my-plugin:before', { task: taskData }, async () => {
  // defaultAction
});

// 拦截钩子的第三方插件
ctx.middleware('my-plugin:before', async (data, next) => {
  data.task.modified = true;
  await next();
});
```

## 权限与安全

### 权限等级

```
0 (默认) → 普通用户
1        → 配置中 defaultAuthority
2        → 可执行 /grant 等管理指令
5        → 可执行 dangerous 操作 (/shutdown 等)
Owner    → 最高权限 (配置 ownerAuthority，默认 5)
```

### 高危操作确认流程

```
工具/指令标记 safety='dangerous'
  │
  ▼
检查用户权限 ≥ 要求等级
  │
  ▼
检查白名单 (isDangerousAllowed)
  │ 未在白名单
  ▼
交互式确认 (平台 confirmHandler)
  │ 用户确认 Y
  ▼
加入临时白名单 (含有效期)
  │
  ▼
执行操作
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
