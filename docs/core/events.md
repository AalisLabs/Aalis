# EventBus 与 HookRegistry — 事件与钩子

## EventBus — 事件总线

**源码**: `packages/core/src/events.ts`

类型安全的全局事件总线，插件间通过事件松耦合通信。

### API

```typescript
// 监听事件（返回 dispose 函数）
const off = bus.on('message:received', async (msg) => { ... });

// 一次性监听
bus.once('ready', () => { ... });

// 发出事件（按注册顺序依次 await 每个 handler）
await bus.emit('message:send', outMsg);

// 清空
bus.removeAll('message:received'); // 清空指定事件
bus.removeAll();                   // 清空全部
```

### 实现特性

- 异步执行：`emit()` 会 await 每个 handler 完成后再执行下一个
- 按注册顺序调用
- `on()` 返回 dispose 函数，可随时移除监听

### 事件列表

参见 [架构总览 — 事件列表](../architecture.md#事件列表)

---

## HookRegistry — 中间件钩子管道

**源码**: `packages/core/src/hooks.ts`

钩子管道允许插件拦截核心流程的各阶段。与事件不同，钩子是有序管道，可修改数据并控制流程。

### API

```typescript
// 注册中间件（优先级越高越先执行）
const dispose = hooks.register('response:before', async (data, next) => {
  // 修改数据
  data.content = processContent(data.content);
  // 继续管道
  await next();
}, priority, contextId);

// 执行管道
await hooks.run('response:before', { content: '...' });

// 清理指定上下文的所有中间件
hooks.unregisterByContext(contextId);
```

### 钩子列表

| 钩子 | 数据类型 | 用途 |
|---|---|---|
| `message:before` | `{ message: IncomingMessage }` | 修改/拦截收到的消息 |
| `llm-call:before` | `{ messages: Message[], tools: ToolDefinition[] }` | 修改 LLM 请求 |
| `llm-call:after` | `{ response: ChatResponse, messages: Message[] }` | 处理 LLM 响应 |
| `tool-call:before` | `{ name, args, toolCallContext }` | 修改工具调用参数 |
| `tool-call:after` | `{ name, result, toolCallContext }` | 处理工具返回结果 |
| `response:before` | `{ content: string, sessionId: string }` | 修改最终回复 |

### 中间件特性

- **优先级排序**: 按 priority 降序执行（大数字先执行）
- **数据修改**: 通过引用传递，修改 `data` 对象即影响后续中间件
- **流程控制**: 调用 `next()` 继续管道；不调用则中止后续中间件
- **上下文绑定**: 每个中间件关联 contextId，插件卸载时自动清理
