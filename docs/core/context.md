# Context — 执行上下文

`Context` 是 Aalis 的核心抽象，每个插件获得独立的子 Context，所有副作用在 dispose 时自动清理。它是插件与框架交互的唯一入口。

**源码**: `packages/core/src/context/context.ts`

## 设计理念

- 每个插件获得独立的子 Context（运行时通过 `rootCtx.fork(instanceId)` 创建）
- 所有副作用（事件监听、服务注册、中间件、命令、工具）都绑定到 Context
- Context 销毁时级联清理所有子 Context 与注册的资源 —— **无需手动清理**
- core 自身极薄：**Context 只提供四个原语——事件（`on` / `emit`）、服务（`provide` / `getService` / `whenService`）、中间件钩子（`middleware` / `runHook`）、贡献点（`contribute` / `collect`）——外加生命周期（`fork` / `onDispose` / `dispose`）**；工具、命令、调度、权限等"业务能力"都由插件以服务方式提供，开发者通过对应 api 包的 `useXxxService(ctx)` helper 消费

## 核心属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 上下文 ID（根 ctx = 'root'，子 ctx = 插件 instanceId） |
| `logger` | `Logger` | 日志器（scope = id） |
| `config` | `ConfigManager` | 配置管理 |
| `devMode` | `boolean` | 开发模式（`provide` 是否跑一致性校验）；由 `AppOptions.devMode` 经根 ctx 继承 |
| `disposed` | `boolean` | 是否已销毁 |

> `ctx.serviceContainer` 标 `@internal`，仅 core 自身（如 `plugin-activation` 检查 provides 完整性）使用。**业务插件不要直接访问** —— 走 `ctx.on/emit/provide/getService/getAllServices` 等公共 API，副作用才能进入自动清理链。四个注册表本身（`#events` / `#services` / `#hooks` / `#contributions`）是 ECMAScript 私有字段，运行时对插件不可见。

## 按场景选 API（速查）

| 你想做的事 | 推荐 API | 备注 |
|---|---|---|
| 监听核心事件 | `ctx.on(event, fn)` | 高频；返回 dispose，Context 销毁自动清理 |
| 发出事件 | `ctx.emit(event, data)` | 高频 |
| 注册一个服务给其它插件用 | `ctx.provide(name, impl, opts?)` | 高频；同时在 `PluginModule.provides` 列出 |
| 跨插件消费服务（**推荐**） | `ctx.whenService(name, svc => …)` | 高频；自动响应 provider 上下/下线 |
| 消费已知一定存在的服务 | `useXxxService(ctx)` helper | 高频；通过 api 包提供，自带类型 |
| 一次性按名拿服务 | `ctx.getService('name')` | 中频；服务未就绪返回 undefined |
| 拦截/改写核心流程 | `ctx.middleware(hook, fn)` | 高频；详见 [events.md](events.md) |
| 往共享产物交一块料（如提示词块） | `ctx.contribute(point, spec)` | 中频；自带幂等与确定性排布，详见 [contributions.md](contributions.md) |
| 枚举自己贡献点收到的全部料 | `ctx.collect(point)` | 罕用；仅贡献点 owner 调用 |
| 注册外部资源清理 | `ctx.onDispose(() => …)` | 高频；**唯一正确的清理 API** |
| 创建子上下文 | `ctx.fork(id)` | 中频；独立生命周期、共享服务 |
| 动态加载子模块 | `ctx.useModule(mod, cfg)` → `ModuleHandle` | 罕用；多用于测试装配/动态注入 |
| 设置全局服务路由偏好 | `ctx.preferService(name, id)` | 罕用；多用于 WebUI/CLI 切换 |
| 枚举/巡视服务（管控类） | `ctx.getAllServices/Names` | 罕用；面向 plugin-doctor / WebUI |

> 大多数插件只会用到 **on / emit / provide / whenService / middleware / onDispose** 加 `useXxxService(ctx)` 系列 helper。表里"罕用"那几条主要是 WebUI、调度、诊断、权限管控类插件才会接触。

## 生命周期

### `ctx.fork(id): Context`

创建子上下文。子 Context 共享父级的 EventBus、ServiceContainer、HookRegistry、ContributionRegistry，但有独立的 disposable 列表。运行时为每个插件实例 fork 一份 ctx。

> ⚠． **`id` 必须全局唯一**。`ctx.id` 是逻辑身份：贡献按 `${ctx.id}/${局部id}` 成键，两个同 id 的 Context 后注册者替换先注册者；服务偏好、模型引用、`hasByContext` 前缀查询都按它。服务 entry / 中间件 / 贡献 / 监听四原语的清理**不**按它——每个 Context 在本次激活另有一个内部 owner，dispose 只清自己注册的，同名 Context 在这一层互不误清，拆卸在飞时同名新激活的注册也不会被迟到的清理误删。但经 tools / commands / webui-server 等枢纽服务登记的条目仍按 `ctx.id` 走下文第 5 步的 `unregisterByPlugin(id)` 清扫，同名 Context 在这一层仍会互清。运行时侧已保证唯一（插件用 instanceId、`useModule` 自动唯一化 childId），手工 fork 时自行保证。

### `ctx.useModule(module, config?): Promise<ModuleHandle>`

在当前 Context 内 fork 一个子上下文并调用 `module.apply(child, config)`，不进入 `PluginManager`（不参与依赖追踪与 softReload）。返回的句柄与 Context 自身的生命周期面同形：

- `id`：子上下文实际 id，同名重复挂载时自动唯一化（`parent#name`、`parent#name~2`…）
- `dispose()`：同步请求关闭，同步清理当场执行、异步清理不等待
- `disposeAsync(timeoutMs?)`：关闭并等待子上下文里全部异步清理完成；给了 `timeoutMs` 则单项超时后放弃等待、继续后续清理（超时只是停止等待，不代表资源已释放）

模块名在子上下文 **彻底收尾之后** 才释放（清理链排空、按 `ctx.id` 的枢纽清扫都做完）：`disposeAsync` 路径下排空期间同名新挂载拿到 `~n` 后缀而不是旧名，旧模块迟到的清理不会与新模块相撞，也不会清掉新模块的枢纽登记。`dispose()` 不等待异步清理，名字随同步段释放。父 ctx dispose 时子上下文级联销毁。

### `ctx.onDispose(fn, label?): () => void`

注册一个在本 Context dispose 时执行的清理回调。**这是插件清理副作用的唯一正确 API**：

- 挂在清理链的清理段，段内逆序执行；`whenService` 的 cleanup 走撤回段，先于全部 onDispose
- `label` 可选，仅进诊断日志——清理超时或抛错时点名是哪一项；不传则退到链内序号
- 在 `ctx.dispose()` 的任何路径上都会触发（app 停机 / bounce / unload / updateConfig / softReload 级联）
- fork 子上下文同样适用
- **可以返回 Promise**：编排层（PluginManager / App）在 unload / bounce / 停机
  路径上走 `disposeAsync`，会逐项**等待**异步清理完成——落盘、关连接类收尾
  从此真正落地，不再是"开始执行就算完"

> ⚠️ 不要用 `ctx.on('app:stopping', …)` 做资源清理 —— 那只在 app 全局停机时触发一次，**不会**在插件 bounce / hot reload 时触发，会造成旧连接、旧定时器泄漏与数据丢失。该事件定位是通知（如 CLI 打印告别语），不是清理通道。

### `ctx.dispose()` / `ctx.disposeAsync(timeoutMs?)`

两者语义相同，`dispose()` 同步返回（异步清理不等待）、`disposeAsync` 按段串行等待每个异步清理完成（撤回段先、清理段后，段内逆序；编排层用）：

1. 级联销毁所有子 Context
2. 按本次激活的 owner 撤回四原语登记：服务、中间件、贡献、事件监听（在清理链**之前**——异步等待窗口内半拆插件不再响应事件与消息、不再被组装器收集）
3. 清理链撤回段：逆序执行 `whenService` 的 cleanup（经枢纽服务交出去的登记在这里撤回）
4. 清理链清理段：逆序执行 `onDispose` 回调——此时四原语登记与经 `whenService` 交出去的登记已撤回；不经 `whenService` 的裸登记仍待第 5 步兜底
5. 触发服务自清理协议：实现 `unregisterByPlugin(id)` 的服务会被通知清理该 Context 的注册项——不经 `whenService` 的裸登记只有在服务实现了该协议时才被兜底

清理链的分段只约束排空快照内的次序；排空开始后迟到登记的清理仍立即执行。异步 cleanup 只在 `disposeAsync` 路径被等待，`dispose()` 不等：启动次序两条路径一致，落地次序只有 `disposeAsync` 保证。

`disposeAsync` 的 `timeoutMs`（App 经 `AppOptions.disposeTimeoutMs` 注入，默认 5000）是单个异步清理项的等待上限：超时放弃该项、继续后续清理并 warn 点名，保证网络类关闭卡死时停机仍能走完。

## 事件 API

```typescript
// 监听（返回 dispose；Context 销毁自动清理）
const off = ctx.on('inbound:message', async msg => { ... });

// sticky 事件：注册晚于发出也能收到微任务补发（'app:ready' / 'app:started'）
ctx.on('app:started', () => { ... });

// 发出事件
await ctx.emit('outbound:message', outMsg);
```

事件清单见 [events.md](events.md)。

## 服务 API（IoC）

```typescript
// 注册服务（建议同时在 PluginModule.provides 中声明，core 会做一致性校验）
ctx.provide('llm', service, {
  priority: 10,
  label: 'openai',   // 可选；多 entry 巡视时展示
});

// 推荐消费方式：whenService —— 自动响应 provider 上下/下线
ctx.whenService('llm', llm => {
  // provider 就绪时调用；返回的清理函数在 provider 下线或 ctx dispose 时执行。
  // 它是对外绑定的撤回：拆卸时先于全部 onDispose 回调执行——最终提交与关闭若依赖同一资源，
  // 要组织在同一个有序清理流程里（都放 onDispose，或都放这里），不要一半一半。
  // 可以返回 Promise：拒绝被接住记 warn，disposeAsync 等它落地（含手动退订或提供者切换时启动的）；
  // 提供者切换不等旧清理落地就挂新实例。
  const off = llm.onChunk(handle);
  return () => off();
});

// 一次性按名拿：注意可能为 undefined
const memory = ctx.getService<MemoryService>('memory');

// 拿同名服务的全部实例（带提供者信息）
const allLLMs = ctx.getAllServices('llm');

// 检查可用性
if (ctx.getService('memory') !== undefined) { ... }
```

> 0.5.0 起 core 不再做「服务能力匹配」：`provide` 不接受 `capabilities` 选项，
> `getService` 不接受能力参数，`getServiceCapabilities` 已删除。LLM 的
> tool-calling / vision 等能力放在 model handle 元数据上；storage 访问按 root
> 权限位判定，均与 ServiceContainer 无关。

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
});

// 后处理（先 next 再改）
ctx.middleware('agent:reply:before', async (data, next) => {
  await next();
  data.content = transform(data.content);
});
```

> 同一钩子键内的多个 handler 按**注册顺序**执行洋葱模型（next 语义），不使用数字优先级；相位间的次序由调度方显式表达。

详见 [events.md — 中间件钩子管道](events.md)。

## 贡献点 API

往共享产物里交一块料，排布权归收集方：`contribute` 返回 dispose 函数并挂清理链；同一 ctx 内同 `id` 重复注册为替换（幂等）；
收集方 `collect` 拿到按全局键排序的快照。贡献者不掌握控制流（无排序影响力、无短路、看不见其他贡献）。

```typescript
// 贡献者：交一块提示词
const off = ctx.contribute('agent:prompt', { id: 'weather', anchor: 'context', build: () => '今天有雨' });

// 收集方（贡献点 owner）：拿到全部料自己排布
for (const { key, spec } of ctx.collect('agent:prompt')) { ... }
```

详见 [contributions.md](contributions.md)。

## 工具与命令（走 api 包）

工具、命令、调度等"业务能力"都由插件以服务形式提供，不在 core 上挂方法。开发者通过对应 api 包的 helper 消费：

```typescript
import { useToolService } from '@aalis/api-tools';
import { useCommandService } from '@aalis/api-commands';

// 注册一个 LLM 可调用的工具
useToolService(ctx)?.register({
  definition: { type: 'function', function: { name: 'my_tool', description: '...', parameters: { ... } } },
  handler: async (args, toolCtx) => JSON.stringify(result),
  visibility: 'public',   // 'public'（默认 minLevel 0，所有人可用）| 'restricted'（minLevel 2，需达到该等级）
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
| 汇集产物 | `ctx.contribute()` / `ctx.collect()` | 无执行注册表，幂等 + 确定性排布，排布权归收集方 |
| 服务能力 | `ctx.provide()` + `whenService()` | IoC 容器，同名服务按"偏好 > 优先级 > 注册序"竞争 |
| AI 工具 | `useToolService(ctx).register()` | 注册 LLM 可调用的工具 |
| 用户指令 | `useCommandService(ctx).command()` | 注册斜杠指令 |
| 资源清理 | `ctx.onDispose()` | 唯一正确的清理钩子 |

**所有注册都返回 dispose 函数，并且自动绑定到当前 Context 的 disposable 列表** —— 插件卸载时自动清理，无需手动管理。
