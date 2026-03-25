# Context — 执行上下文

`Context` 是 Aalis 的核心抽象，每个插件获得独立的子 Context，所有副作用在 dispose 时自动清理。

**源码**: `packages/core/src/context.ts`

## 设计理念

Context 是插件的执行上下文：
- 每个插件获得独立的子 Context（通过 `fork()`）
- 所有副作用（事件监听、服务注册、工具注册）绑定到 Context
- Context 销毁时级联清理所有子 Context 和注册的资源

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 上下文 ID |
| `logger` | `Logger` | 日志器（scope = id） |
| `config` | `ConfigManager` | 配置管理 |
| `tools` | `ToolRegistry` | 工具注册表 |
| `hooks` | `HookRegistry` | 钩子表 |
| `commands` | `CommandRegistry` | 指令表 |
| `authority` | `AuthorityManager` | 权限管理 |
| `disposed` | `boolean` | 是否已销毁 |

## 生命周期

### `ctx.fork(id): Context`

创建子上下文。子 Context 共享父级的 EventBus、ServiceContainer 等核心设施，但有独立的 disposable 列表。

### `ctx.dispose()`

1. 级联销毁所有子 Context
2. 执行所有注册的 disposable（清理事件监听、工具注册等）
3. 通过 `ServiceContainer.unregisterByContext()` 移除该 Context 注册的服务
4. 发出 `service:unregistered` 事件

## 事件

```typescript
// 监听（返回 dispose 函数）
const off = ctx.on('message:received', async (msg) => { ... });

// 一次性监听
ctx.once('ready', () => { ... });

// 发出
await ctx.emit('message:send', outMsg);
```

## 服务（IoC + 能力匹配）

```typescript
// 注册服务
ctx.provide('llm', service, {
  capabilities: ['chat', 'tool_calling'],
  priority: 10,
});

// 获取服务
const llm = ctx.getService<LLMService>('llm', ['tool_calling']);

// 检查可用性
if (ctx.hasService('memory')) { ... }

// 获取能力列表
const caps = ctx.getServiceCapabilities('llm');

// 切换偏好
ctx.preferService('llm', 'plugin-deepseek-context-id');
```

## 快捷方法

```typescript
// 注册工具
ctx.registerTool({ definition, handler, safety, authority });

// 注册指令
ctx.command('test', '测试指令', async (cmdCtx) => '结果', { authority: 2 });

// 注册中间件
ctx.middleware('response:before', async (data, next) => {
  await next();
  data.content = transform(data.content);
}, 50); // priority=50
```

## Mixin 机制

```typescript
// 将服务方法代理到所有 Context 实例
ctx.mixin('websearch', ['search']);

// 之后可在任何 Context 上调用
ctx.search(query); // 自动路由到 websearch 服务的 search 方法
```
