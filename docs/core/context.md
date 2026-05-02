# Context — 执行上下文

`Context` 是 Aalis 的核心抽象，每个插件获得独立的子 Context，所有副作用在 dispose 时自动清理。它是插件与框架交互的唯一入口。

**源码**: `packages/core/src/context.ts`

## 设计理念

Context 是插件的执行上下文，同时也是 Aalis 扩展性的基石：

- 每个插件获得独立的子 Context（通过 `fork()`）
- 所有副作用（事件监听、服务注册、工具注册、中间件注册）绑定到 Context
- Context 销毁时级联清理所有子 Context 和注册的资源
- 插件通过 Context 操作事件、服务、中间件、工具、指令——所有扩展能力都通过 Context 暴露

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 上下文 ID（即插件名） |
| `logger` | `Logger` | 日志器（scope = id） |
| `config` | `ConfigManager` | 配置管理 |
| `tools` | `ToolRegistry` | 工具注册表 |
| `hooks` | `HookRegistry` | 钩子管道注册表 |
| `commands` | `CommandRegistry` | 指令注册表 |
| `authority` | `AuthorityManager` | 权限管理 |
| `disposed` | `boolean` | 是否已销毁 |

## 生命周期

### `ctx.fork(id): Context`

创建子上下文。子 Context 共享父级的 EventBus、ServiceContainer、HookRegistry 等核心设施，但有独立的 disposable 列表。

### `ctx.dispose()`

1. 级联销毁所有子 Context
2. 通过 `ServiceContainer.unregisterByContext()` 移除该 Context 注册的服务
3. 逆序执行所有注册的 disposable（清理事件监听、工具注册、中间件注册等）
4. 发出 `service:unregistered` 事件（触发 soft reload）

## 事件 API

```typescript
// 监听（返回 dispose 函数，ctx 销毁时自动清理）
const off = ctx.on('inbound:message', async (msg) => { ... });

// 一次性监听
ctx.once('ready', () => { ... });

// 发出事件
await ctx.emit('outbound:message', outMsg);
```

## 服务 API（IoC + 能力匹配）

```typescript
// 注册服务（支持能力声明和优先级）
ctx.provide('llm', service, {
  capabilities: ['chat', 'tool_calling', 'streaming'],
  priority: 10,
});

// 按能力匹配获取服务
const llm = ctx.getService<LLMService>('llm', ['tool_calling']);

// 检查可用性
if (ctx.hasService('memory')) { ... }

// 获取服务能力列表
const caps = ctx.getServiceCapabilities('llm');

// 列出所有已注册服务名
const names = ctx.listServices();

// 获取某服务所有 entry（含优先级/能力信息）
const entries = ctx.getServiceEntries('llm');

// 切换偏好提供者
ctx.preferService('llm', 'plugin-deepseek-context-id');
```

## 中间件 API

最强大的扩展手段——插件通过中间件拦截核心流程的每个阶段。

```typescript
// 注册中间件（不调用 next = 中断整个管道）
ctx.middleware('agent:input:before', async (data, next) => {
  if (shouldBlock(data.message)) return; // 中断
  data.message.content += ' [已审核]';   // 修改
  await next();                           // 继续
}, 200); // priority=200

// 注入上下文到 LLM 调用
ctx.middleware('agent:llm:before', async (data, next) => {
  data.messages.unshift({ role: 'system', content: '额外指令...' });
  await next();
});

// 后处理（先 next 再修改）
ctx.middleware('agent:reply:before', async (data, next) => {
  await next();
  data.content = transform(data.content);
}, 50);
```

详见 [events.md — 中间件钩子管道](events.md)

## 工具 API

```typescript
ctx.registerTool({
  definition: {
    type: 'function',
    function: { name: 'my_tool', description: '...', parameters: { ... } },
  },
  handler: async (args, toolCtx) => JSON.stringify(result),
  safety: 'safe',
  authority: 1,
});
```

## 指令 API

```typescript
// 简单指令
ctx.command('ping', '测试连通性', async () => 'pong!');

// 带参数和权限的指令
ctx.command('echo', '回显消息', async (cmdCtx) => {
  return cmdCtx.args.join(' ') || '(空)';
}, { authority: 2 });

// 声明式选项
ctx.command('clear', '清空记忆', async (cmdCtx) => {
  const types = cmdCtx.options?.type as string[] | undefined;
  return clearMemory(types);
}, {
  options: [{ name: 'type', alias: 't', type: 'string[]', description: '清理类型' }],
});

// 标记为高危指令
ctx.command('restart', '重启应用', async () => { ... }, {
  safety: 'dangerous',
  authority: 5,
});
```

## Mixin 机制

将服务方法直接代理到 Context 原型上，让所有插件都能像调用内置方法一样使用：

```typescript
// 注册服务并 mixin
ctx.provide('scheduler', schedulerImpl);
ctx.mixin('scheduler', ['schedule', 'cron', 'interval']);

// 之后任何 Context 实例都可以调用（类型需配合 declare module）
(ctx as any).schedule('daily', callback);

// 配合 declaration merging 获得类型安全
declare module '@aalis/core' {
  interface Context {
    schedule(name: string, cb: () => void): void;
  }
}
```

特性：
- mixin 方法在 Context.prototype 上定义 getter，实际执行时通过 `getService()` 获取当前活跃实例
- 同名方法已存在时跳过（不覆盖内置方法）
- 服务被卸载后，mixin 方法返回 undefined（安全降级）
- Context 销毁时自动清理其注册的 mixin

## Context 与扩展性

Context 作为唯一入口，使得 Aalis 的扩展模型非常统一：

| 扩展维度 | Context 方法 | 效果 |
|---|---|---|
| 事件通知 | `ctx.on()` / `ctx.emit()` | 松耦合的发布/订阅 |
| 流程拦截 | `ctx.middleware()` | 中间件管道，可修改数据或中断流程 |
| 服务替换 | `ctx.provide()` | IoC 容器，同名服务按优先级竞争 |
| AI 工具 | `ctx.registerTool()` | 注册 LLM 可调用的工具 |
| 用户指令 | `ctx.command()` | 注册斜杠指令 |
| API 代理 | `ctx.mixin()` | 将服务方法代理到 Context 上 |

所有注册都返回 dispose 函数，且绑定到当前 Context 的 disposable 列表中——插件卸载时自动清理，无需手动管理。
