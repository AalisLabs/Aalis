# EventBus — 事件

事件是 core 的单向通知原语。可拦截、可改写数据的中间件钩子不在 core，由插件 `@aalis/plugin-hooks` 提供，契约与用法见 [api-hooks](../api/api-hooks.md)。

## EventBus — 事件总线

**源码**: `packages/core/src/primitives/events.ts`

类型安全的全局发布/订阅事件总线，用于松耦合的异步通知。事件只通知、不干预流程。插件在 `uses` 里声明 `events` 后，`apply` 拿到按激活绑定的 `on` / `emit`。

### API

```typescript
// 监听事件（返回 dispose 函数；随这次激活撤回）
const off = events.on('inbound:message', async (msg) => { ... });

// sticky 事件：注册晚于发出也能在下一个微任务收到补发（'app:ready' / 'app:started'）
events.on('app:ready', () => { ... });

// 发出事件（按注册顺序依次 await 每个 handler，永不拒绝）
await events.emit('outbound:message', outMsg);
```

### 实现特性

- 异步串行：`emit()` 会 await 每个 handler 完成后再执行下一个
- 按注册顺序调用
- `on()` 返回 dispose 函数，可随时移除监听
- 每次 `on()` 是一条独立登记：同一函数登记两次触发两次，各自的 dispose 只移除自己那条；两次激活共用同一函数也互不影响
- 激活关闭时自动移除这次激活登记的所有监听

### core 内置事件

core 自持的只有下面十一个基础设施事件（源码 `packages/core/src/types/events.ts`）。消息、工具、会话、
调度等业务事件不在 core，由各 `-api` 包经 declaration merging 注入——谁注入了哪一族见
[扩展点索引 §2](../extensions/index.md)，键与 payload 的权威定义在该包的 `declare module` 声明里。

十一个事件按「发射方等不等监听器」分两节，节由前缀判定：

**屏障**（`app:*`）：emit 是 `App` 生命周期方法里的一步，监听器全部返回后才推进下一步。`app:stopping` 的时机见下表与后文。

| 事件 | 参数 | 时机 |
|---|---|---|
| `app:starting` | — | `start()` 的第一步 |
| `app:ready` | — | 启动第一相位（sticky） |
| `app:started` | — | 启动第二相位：全部 `app:ready` 监听器完成之后（sticky）；CLI / TUI 在此接管终端 |
| `app:restarting` | — | `restart()` 先发本事件，监听器全部完成后才把控制交给宿主的 `RestartStrategy` |
| `app:stopping` | — | `stop()` 先 `beginShutdown()` 再 `idle()` 之后发出；监听器全部返回后才执行停机计划。再次调用 `stop()` 返回完整停机的同一 Promise，监听器不能 await 或返回它 |

**通知**（`service:*` / `plugin:*` / `plugins:changed`）：发射方不等监听器。发射点要么是同步的注册 / 拆卸收尾，
要么在 `PluginManager` 的 recompute flight 或挂起段内——那里等监听器会与 `plugins.idle()` 互等死锁。
监听器因此不能假设「我返回了状态机才继续」；要看落定后的状态请 `await plugins.idle()`。

| 事件 | 参数 | 时机 |
|---|---|---|
| `service:registered` | `name` | 某服务多了一个提供者（`provide(descriptor, impl)`） |
| `service:unregistered` | `name` | 某服务少了一个提供者（退订闭包或激活拆卸） |
| `service:preference-changed` | `name` | 该服务的偏好 provider 切换（`services.prefer` / `services.unprefer`）；`follow` 借此按胜者变化重挂 |
| `plugin:loaded` | `instanceId` | 插件实例已激活；同一轮 recompute 可能紧接着激活下一个插件 |
| `plugin:unloaded` | `instanceId` | 插件实例已拆卸；激活失败的回滚与关机拆卸不发 |
| `plugins:changed` | — | 一轮 recompute 收敛，插件状态集合可能已变；关机轮不发 |

`app:ready` 与 `app:started` 是两个相位，不是同一里程碑的两个名字：`start()` 串行 await，`app:started` 严格晚于
全部 `app:ready` 监听器完成。

`app:stopping` 用于知会（打印告别语、切状态条），不是清理通道——清理副作用一律走 `lifecycle.onDrain` / `lifecycle.onDispose`，它们覆盖 bounce / unload / 停机全部路径。总线上没有 `dispose` 事件。本事件发出时停机计划已冻：窗口内 `unload` / `disable` 汇入该计划后立即返回 true；`register` / `bounce` 返回 false。`stop()` 在任何阶段都返回完整停机的同一 Promise。监听器不能 `await stop()` 或返回它，否则停机与正在执行的屏障监听器会互等；调用 `void stop()` 不会重复启动停机。

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
events.on('scheduler:tick', async (jobId) => { ... });
events.emit('scheduler:tick', 'job-1');
```

`AalisEvents` 是**类型封闭**的（没有 `[key: string]` 兜底）：对扩展开放、对拼写错误封闭——
未声明的事件名在 `events.on` / `events.emit` 处直接编译报错，契约始终可枚举、依赖边在包图中可见。

事件名需要**运行时动态生成**（如按频道/任务 ID 派生）时，官方出路是在自己的命名空间内
合并一条模板字面量签名（TS 4.4+）：

```typescript
declare module '@aalis/core' {
  interface AalisEvents {
    // 动态事件名族：myplugin:channel: 前缀下的任意后缀都合法，payload 类型统一
    [k: `myplugin:channel:${string}`]: [payload: ChannelMessage];
  }
}

events.on(`myplugin:channel:${channelId}`, async (msg) => { ... }); // msg: ChannelMessage
```

同前缀下更具体的字面量 key 仍可逐条声明（TS 优先匹配字面量）。前缀必须用自己插件的
命名空间，避免与他人模板签名相互吞并。
