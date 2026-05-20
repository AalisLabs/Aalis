# Context — 执行上下文

`Context` 是 Aalis 的核心抽象，每个插件获得独立的子 Context，所有副作用在 dispose 时自动清理。它是插件与框架交互的唯一入口。

**源码**: [packages/core/src/context.ts](../../packages/core/src/context.ts)

## 设计理念

- 每个插件获得独立的子 Context（运行时通过 `rootCtx.fork(instanceId)` 创建）
- 所有副作用（事件监听、服务注册、中间件、命令、工具）都绑定到 Context
- Context 销毁时级联清理所有子 Context 与注册的资源 —— **无需手动清理**
- core 自身极薄：**Context 只提供事件、服务、中间件、钩子、生命周期五大原语**；工具、命令、调度、权限等"业务能力"都由插件以服务方式提供，开发者通过对应 api 包的 `useXxxService(ctx)` helper 消费

## 核心属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 上下文 ID（根 ctx = 'app'，子 ctx = 插件 instanceId） |
| `logger` | `Logger` | 日志器（scope = id） |
| `config` | `ConfigManager` | 配置管理 |
| `hooks` | `HookRegistry` | 钩子管道注册表（中间件底层） |
| `disposed` | `boolean` | 是否已销毁 |

> ⚠️ `ctx.serviceContainer` 标 `@internal`，仅 core 自身（如 `plugin-activation` 检查 provides 完整性）使用。**业务插件不要直接访问** —— 走 `ctx.on/emit/provide/getService/getServiceEntries` 等公共 API，副作用才能进入自动清理链。

## 按场景选 API（速查）

| 你想做的事 | 推荐 API | 备注 |
|---|---|---|
| 监听核心事件 | `ctx.on(event, fn)` | 高频；返回 dispose，Context 销毁自动清理 |
| 发出事件 | `ctx.emit(event, data)` | 高频 |
| 注册一个服务给其它插件用 | `ctx.provide(name, impl, opts?)` | 高频；同时在 `PluginModule.provides` 列出 |
| 跨插件消费服务（**推荐**） | `ctx.whenService(name, svc => …)` | 高频；自动响应 provider 上下/下线 |
| 消费已知一定存在的服务 | `useXxxService(ctx)` helper | 高频；通过 api 包提供，自带类型 |
| 一次性按名拿服务 | `ctx.getService('name')` | 中频；服务未就绪返回 undefined |
| 拦截/改写核心流程 | `ctx.middleware(hook, fn, priority?)` | 高频；详见 [events.md](events.md) |
| 注册外部资源清理 | `ctx.onDispose(() => …)` | 高频；**唯一正确的清理 API** |
| 创建沙盒/子作用域 | `ctx.createScope(id)` / `ctx.fork(id)` | 中频；scope 自带服务隔离 |
| 动态加载子模块 | `ctx.useModule(mod, cfg, opts?)` | 罕用；多用于沙盒/动态注入 |
| 设置全局服务路由偏好 | `ctx.preferService(name, id)` | 罕用；多用于 WebUI/CLI 切换 |
| 枚举/巡视服务（管控类） | `ctx.getServiceEntries/Names/Capabilities` | 罕用；面向 plugin-doctor / WebUI |

> 大多数插件只会用到 **on / emit / provide / whenService / middleware / onDispose** 加 `useXxxService(ctx)` 系列 helper。表里"罕用"那几条主要是 WebUI、调度、诊断、权限管控类插件才会接触。

## 生命周期

### `ctx.fork(id): Context`

创建子上下文。子 Context 共享父级的 EventBus、ServiceContainer、HookRegistry，但有独立的 disposable 列表。运行时为每个插件实例 fork 一份 ctx。

### `ctx.createScope(id): Context`

创建沙盒子上下文（fork 的强化版）：在共享的 ServiceContainer 之上额外覆盖一层 scope 私有的服务表，沙盒内 `ctx.provide()` 的服务**不会**外泄。沙盒内 `ctx.getService()` 优先看自己的覆盖层，未命中再 fallback 到父级全局服务。

### `ctx.onDispose(fn): () => void`

注册一个在本 Context dispose 时执行的清理回调。**这是插件清理副作用的唯一正确 API**：

- 直接挂在 `_disposables` 链上，逆序执行
- 在 `ctx.dispose()` 的任何路径上都会触发（app 停机 / bounce / unload / updatePluginConfig / softReload 级联）
- 沙盒 / fork 子上下文同样适用

> ⚠️ 不要用 `ctx.on('app:stopping', …)` 做资源清理 —— 那只在 app 全局停机时触发一次，**不会**在插件 bounce / hot reload 时触发，会造成旧连接、旧定时器泄漏。

### `ctx.dispose()`

1. 级联销毁所有子 Context
2. 通过 `ServiceContainer.unregisterByContext()` 移除该 Context 注册的服务
3. 逆序执行所有注册的 disposable（事件监听、中间件、命令注册等）
4. 触发服务自清理协议：实现 `unregisterByPlugin(id)` 的服务会被通知清理该 Context 的注册项

## 事件 API

```typescript
// 监听（返回 dispose；Context 销毁自动清理）
const off = ctx.on('inbound:message', async msg => { ... });

// 一次性监听
ctx.once('app:ready', () => { ... });

// 发出事件
await ctx.emit('outbound:message', outMsg);
```

事件清单见 [events.md](events.md)。

## 服务 API（IoC + 能力匹配）

```typescript
// 注册服务（建议同时在 PluginModule.provides 中声明，core 会做一致性校验）
ctx.provide('llm', service, {
  capabilities: ['chat', 'tool_calling', 'streaming'],
  priority: 10,
});

// 推荐消费方式：whenService —— 自动响应 provider 上下/下线
ctx.whenService('llm', llm => {
  // provider 就绪时调用；返回的清理函数在 provider 下线或 ctx dispose 时执行
  const off = llm.onChunk(handle);
  return () => off();
});

// 一次性按名拿：注意可能为 undefined
const memory = ctx.getService<MemoryService>('memory');

// 按能力筛
const llmWithTools = ctx.getService('llm', ['tool_calling']);

// 检查可用性
if (ctx.hasService('memory')) { ... }
```

### 服务解析顺序

`getService(name)` 的解析顺序：**偏好 (`preferService`) > 优先级 (`priority`) > 注册顺序**。匹配的第一个返回。

### 跨多 entry 按会话持久化选择

多 provider 同名注册（如多个 LLM provider 都叫 `'llm'`）时，会话需要持久化
用户选择下一轮接续，推荐走 **请求维度的 hint**（而非容器维度的 preference）：
把选择存在用户 profile，请求时显式传入面向指定 provider 的参数（参见
[plugin-author-guide §13](../plugin-author-guide.md#13-用户偏好放哪里-per-user-不进-servicecontainer)）。

> `ctx.preferService(name, contextId)` 是全局、进程级单例的偏好、不适合平 per-user。

## 中间件 API

最强大的扩展手段 —— 插件通过中间件拦截核心流程的每个阶段（Koa 风格 onion model）。

```typescript
ctx.middleware('agent:input:before', async (data, next) => {
  if (shouldBlock(data.message)) return; // 中断
  data.message.content += ' [已审核]';   // 修改
  await next();                           // 继续
}, 200); // priority 越大越外层

// 后处理（先 next 再改）
ctx.middleware('agent:reply:before', async (data, next) => {
  await next();
  data.content = transform(data.content);
}, 50);
```

详见 [events.md — 中间件钩子管道](events.md)。

## 工具与命令（走 api 包）

工具、命令、调度等"业务能力"都由插件以服务形式提供，不在 core 上挂方法。开发者通过对应 api 包的 helper 消费：

```typescript
import { useToolService } from '@aalis/plugin-tools-api';
import { useCommandService } from '@aalis/plugin-commands-api';

// 注册一个 LLM 可调用的工具
useToolService(ctx)?.register({
  definition: { type: 'function', function: { name: 'my_tool', description: '...', parameters: { ... } } },
  handler: async (args, toolCtx) => JSON.stringify(result),
  safety: 'safe',
  authority: 1,
});

// 注册一个用户斜杠命令
useCommandService(ctx)?.command({
  name: 'ping',
  description: '测试',
  action: async () => 'pong!',
});
```

helper 的实现就是 `whenService` + 类型注入 —— 不会绕过 core 的服务/生命周期机制，副作用照样自动清理。

## 扩展性概览

Context 作为唯一入口，使 Aalis 的扩展模型非常统一：

| 扩展维度 | API | 效果 |
|---|---|---|
| 事件通知 | `ctx.on()` / `ctx.emit()` | 松耦合的发布/订阅 |
| 流程拦截 | `ctx.middleware()` | 中间件管道，可修改数据或中断流程 |
| 服务能力 | `ctx.provide()` + `whenService()` | IoC 容器，同名服务按"偏好 > 优先级 > 注册序"竞争 |
| AI 工具 | `useToolService(ctx).register()` | 注册 LLM 可调用的工具 |
| 用户指令 | `useCommandService(ctx).command()` | 注册斜杠指令 |
| 资源清理 | `ctx.onDispose()` | 唯一正确的清理钩子 |

**所有注册都返回 dispose 函数，并且自动绑定到当前 Context 的 disposable 列表** —— 插件卸载时自动清理，无需手动管理。
