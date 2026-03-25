# EventBus 与 HookRegistry — 事件与中间件

Aalis 提供两种互补的扩展机制：**事件**（单向通知）和**中间件钩子**（可拦截的管道）。

## EventBus — 事件总线

**源码**: `packages/core/src/events.ts`

类型安全的全局发布/订阅事件总线，用于松耦合的异步通知。事件只通知、不干预流程。

### API

```typescript
// 监听事件（返回 dispose 函数）
const off = ctx.on('message:received', async (msg) => { ... });

// 一次性监听
ctx.once('ready', () => { ... });

// 发出事件（按注册顺序依次 await 每个 handler）
await ctx.emit('message:send', outMsg);
```

### 实现特性

- 异步串行：`emit()` 会 await 每个 handler 完成后再执行下一个
- 按注册顺序调用
- `on()` 返回 dispose 函数，可随时移除监听
- Context 销毁时自动移除该 Context 注册的所有监听

### 内置事件

| 事件 | 参数 | 说明 |
|---|---|---|
| `message:received` | `IncomingMessage` | 平台收到用户消息 |
| `message:send` | `OutgoingMessage` | AI 回复即将发送 |
| `message:stream` | `StreamChunkMessage` | 流式输出增量 |
| `tool:execute` | `ToolExecuteMessage` | 工具调用开始/结束 |
| `service:registered` | `name, capabilities[]` | 服务注册 |
| `service:unregistered` | `name` | 服务移除 |
| `plugin:loaded` | `name` | 插件加载 |
| `plugin:unloaded` | `name` | 插件卸载 |
| `plugins:changed` | — | 插件状态变更 |
| `ready` | — | 应用启动完成 |
| `dispose` | — | 应用关闭 |
| `restarting` | — | 应用即将重启 |

### 扩展自定义事件

第三方插件通过 TypeScript declaration merging 即可为事件系统新增类型安全的自定义事件：

```typescript
declare module '@aalis/core' {
  interface AalisEvents {
    'scheduler:tick': [jobId: string];
    'scheduler:error': [jobId: string, error: Error];
  }
}

// 之后可以类型安全地使用
ctx.on('scheduler:tick', async (jobId) => { ... });
ctx.emit('scheduler:tick', 'job-1');
```

运行时也支持任意字符串 key（`AalisEvents` 有 `[key: string]: unknown[]` 兜底），无需声明即可使用。

---

## HookRegistry — 中间件钩子管道

**源码**: `packages/core/src/hooks.ts`

中间件钩子是 Aalis 最强大的扩展机制。与事件不同，钩子是**有序管道**，插件可以修改管道中的数据、也可以完全中断流程。

### 核心概念

中间件采用 `(data, next)` 签名。调用 `next()` 将控制权传递给下一个中间件（或最终的 defaultAction）。**不调用 `next()` 即中断整个管道**——这是拦截消息的标准做法。

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
defaultAction() ← 所有中间件都 next() 后执行
```

### API

```typescript
// 注册中间件（优先级越高越先执行）
const dispose = ctx.middleware('response:before', async (data, next) => {
  data.content = processContent(data.content);
  await next();
}, 50); // priority=50

// 执行管道（由 Agent 或其他插件调用）
await ctx.hooks.run('response:before', { content: '...' }, async () => {
  // defaultAction: 所有中间件通过后才执行
});

// 按 contextId 移除所有中间件（插件卸载时自动执行）
ctx.hooks.unregisterByContext(contextId);
```

### 内置钩子

| 钩子 | 数据类型 | 用途 |
|---|---|---|
| `message:before` | `{ message: IncomingMessage, metadata: Record<string, unknown> }` | 修改/拦截收到的消息 |
| `message:after` | `{ message: IncomingMessage, response: string, sessionId: string, metadata: Record<string, unknown> }` | 消息处理完成后 |
| `llm-call:before` | `{ messages: Message[], tools: ToolDefinition[] }` | 修改发给 LLM 的消息列表和工具 |
| `llm-call:after` | `{ response: ChatResponse, messages: Message[] }` | 处理 LLM 返回的响应 |
| `tool-call:before` | `{ name: string, args: Record<string, unknown>, toolCallContext: ToolCallContext }` | 修改工具调用参数 |
| `tool-call:after` | `{ name: string, result: string, toolCallContext: ToolCallContext }` | 处理工具返回结果 |
| `response:before` | `{ content: string, sessionId: string }` | 修改最终回复内容 |

### 中间件特性

- **优先级排序**: 按 priority 降序执行（数字越大越先执行）
- **数据修改**: data 通过引用传递，修改 data 对象即影响后续中间件和 defaultAction
- **流程控制**: 调用 `next()` 继续管道；不调用则中止后续中间件和 defaultAction
- **上下文绑定**: 每个中间件关联 contextId，插件卸载时自动清理（通过 `unregisterByContext`）

### 典型用法

```typescript
// 1. 拦截消息（不调用 next = 中断管道）
ctx.middleware('message:before', async (data, next) => {
  if (shouldBlock(data.message)) return; // 不调用 next，整个管道终止
  await next();
}, 100);

// 2. 注入上下文到 LLM 调用
ctx.middleware('llm-call:before', async (data, next) => {
  data.messages.unshift({ role: 'system', content: '额外上下文...' });
  await next();
});

// 3. 后处理回复内容
ctx.middleware('response:before', async (data, next) => {
  await next();
  data.content = transform(data.content);
});

// 4. 替换工具列表（如工具搜索层）
ctx.middleware('llm-call:before', async (data, next) => {
  data.tools = await searchRelevantTools(data.messages);
  await next();
}, 50);
```

### 扩展自定义钩子

第三方插件可以定义自己的钩子，并让其他插件注入中间件：

```typescript
// 声明类型（可选但推荐）
declare module '@aalis/core' {
  interface HookContextMap {
    'schedule:before': { jobId: string; cron: string };
  }
}

// 定义钩子的插件：在关键路径上调用 hooks.run
await ctx.hooks.run('schedule:before', { jobId, cron }, async () => {
  // defaultAction: 执行调度任务
  await executeJob(jobId);
});

// 拦截钩子的第三方插件
ctx.middleware('schedule:before', async (data, next) => {
  logger.info(`即将执行: ${data.jobId}`);
  data.cron = modifyCron(data.cron);
  await next();
});
```

运行时支持任意字符串 key（`HookContextMap` 有 `[key: string]: Record<string, unknown>` 兜底），因此即使不声明合并也可以在运行时工作。
