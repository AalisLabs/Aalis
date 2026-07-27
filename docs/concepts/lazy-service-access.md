# 惰性服务访问（Lazy Service Access）

Aalis 的服务图是"活"的：服务名是稳定的，但名字背后的实例会在运行时被替换——插件热重载、或用户切换偏好 provider，都会换掉某个服务名当前的胜者实例。因此访问服务有一条基本原则：**每次要用就重新 `ctx.getService()`，不要把拿到的实例缓存进类字段或闭包。**

这篇讲清楚为什么要这样，以及两个配套工具：什么时候改用 `ctx.whenService()`、`*-api` 的"惰性网关"为什么是推荐的默认做法，还有 `requiresBounceOnDepChange` 这个逃生舱什么时候才该用。

## 为什么"每次都查"

`getService()` 返回的是"此刻的实例快照"——之后 provider 换了人，你手里的引用并不会跟着更新。所以把它存进长寿命的地方是危险的。先看一段不推荐的写法：

```typescript
// ❌ 反模式：把裸实例缓存到闭包里
export function apply(ctx: Context) {
  const storage = ctx.getService('storage'); // 当时点的裸实例
  ctx.middleware('inbound:message', async (data, next) => {
    await storage.writeFile('data:/log.txt', data.text); // storage 可能早已失效
    await next();
  });
}
```

一旦 storage 被热重载，闭包里的 `storage` 就指向一个已销毁的旧实例，旧连接、旧句柄全废。把查询挪进函数作用域，用时即取，就没有这个问题：

```typescript
// ✅ 每次用时重新查
export function apply(ctx: Context) {
  ctx.middleware('inbound:message', async (data, next) => {
    const storage = ctx.getService('storage'); // 每次都是当前胜者
    await storage?.writeFile('data:/log.txt', data.text);
    await next();
  });
}
```

不必担心性能：`getService()` 只是查一次容器，按"偏好 > 优先级 > 注册顺序"返回当前胜者，成本极低，且每次都拿到最新实例。

## provider 换人时会发生什么

理解了"要每次查"，还得知道"实例是怎么被换掉的"，才能明白这条原则的边界。

**默认不级联。** 一个 provider 被热重载时，Aalis 默认不动它的下游——只有显式声明了 `requiresBounceOnDepChange: true` 的下游才会跟着重载，其余原地不动。这是刻意的设计：早期版本会级联重载所有下游（那时假设大家都缓存了裸引用、必须强制刷新），现在假设反了过来——你应该惰性查询，provider 一换你自然跟上，级联就没必要了。

::: warning 这是你这一侧的责任
如果你既没惰性查询、又没声明 `requiresBounceOnDepChange`，那么 provider 一换人，你就持有了一个失效的旧引用，框架不会替你兜底。
:::

**一次热重载的完整流程**是：持久化新配置、替换模块 → 摘除下游 → 销毁旧 context → 转入 pending → 重新 `apply`。销毁这一步会把该插件注册的所有服务实例一并注销，重新激活时新实例重新注册。服务名没变，实例却是全新的——这正是缓存裸引用会出事的根本原因。

具体到"谁是当前胜者"，有三种信号会改变它：

| 信号 | 触发 | 事件 |
| --- | --- | --- |
| provider 注册 | `ctx.provide(name, inst)` | `service:registered` |
| provider 注销 | dispose | `service:unregistered` |
| 偏好切换 | `ctx.preferService` / `unpreferService` | `service:preference-changed` |

偏好切换是个特例：它不改变实例集合，只改变谁是胜者，所以单独用一个事件、不复用注册/注销。下一节的 `whenService` 三种信号都会监听。

## `whenService`：订阅"会迟到、会换人"的服务

`getService()` 解决的是"每次读到最新值"。但还有一类需求它不覆盖：**一次性地把某个副作用挂上去**，最典型的就是把工具注册进 `tools` 这个 hub 服务。麻烦在于，hub 可能比你晚上线，或者中途被热重载换了实例——手动监听 `service:registered` 既啰嗦又容易漏掉清理。

`ctx.whenService(name, cb)` 就是为这个设计的，一行搞定"就绪即挂、换人即重挂、下线即清理"：

```typescript
// 例 A：把工具注册进 tools hub（最常见用法）
// tools 可能晚于本插件就绪，whenService 会等它就绪再注册、换人时自动重挂
ctx.whenService('tools', svc => svc.register(myTool, ctx.id));

// 例 B：订阅 provider 的内部状态，返回一个 cleanup
ctx.whenService('llm', llm => {
  const handle = llm.onModelChange(updateUI);
  return () => handle.dispose(); // llm 被换人时自动调用
});
```

它替你保证这几件事：服务若已就绪，调用时**立即**触发一次 `cb`；provider 换人时，**先跑上次返回的 cleanup、再用新实例调一次 `cb`**，所以你手里永远不是失效引用；`cb` 返回的 cleanup 会在插件卸载或 provider 换人时自动调用，且这个过程是幂等的，重复触发也安全。它只认胜者——低优先级的败者 provider 上下线不会惊动你，只有胜者真的换了才会 cleanup 加重挂。

选型上，读取一个值用 `getService()`，挂载一个需要跟随 provider 的副作用用 `whenService()`；两者都不要把裸实例存进类字段。

## 惰性网关：`*-api` 的推荐用法

`storage`、`process` 这类服务，消费者通常不想关心"当前哪个 root 由哪个后端提供"。为此，它们的 `*-api` 包提供了**惰性网关工厂**：给你一个用起来和普通服务一样的句柄，但它每个方法内部都会重新查一次容器，等于把"每次 `getService`"包进了句柄。

这样做的好处是这个句柄**可以长期持有**——存进类字段完全没问题，因为它从不捕获裸实例，只在方法被调用的那一刻才去解析当前 provider：

```typescript
// createProcessGateway：每个方法调用时才 pick() 出当前的 process 实例
export function createProcessGateway(ctx: Context): ProcessService {
  const pick = (): ProcessService => {
    const inst = ctx.getService<ProcessService>('process');
    if (!inst) throw new Error('未找到 process 服务（请启用 @aalis/plugin-process-local …）');
    return inst;
  };
  return {
    spawn: (cmd, args, opts) => pick().spawn(cmd, args, opts),
    execFile: (cmd, args, opts) => pick().execFile(cmd, args, opts),
    makeTempDir: prefix => pick().makeTempDir(prefix),
    readExternalFile: path => pick().readExternalFile(path),
  };
}
```

所以下面这种写法是安全的，正好和第一节的反模式相反——句柄长寿命，但内部惰性：

```typescript
export function apply(ctx: Context) {
  const proc = createProcessGateway(ctx); // 长期持有 OK
  ctx.middleware('inbound:command', async (data, next) => {
    await proc.execFile('echo', ['hi']); // 这一刻才解析当前 process 提供方
    await next();
  });
}
```

`createStorageGateway` 在惰性之外还多做一件事：**按 storage URI 跨 root 路由**。它的每个方法会根据传入的 `<root>:/path` 解析出该由哪个 root 的后端处理，并且每次都重新解析，所以它同时是"惰性"和"多后端聚合器"：

```typescript
const storage = createStorageGateway(ctx);
await storage.writeFile('data:/notes/today.md', text); // 路由到提供 data 根的后端
await storage.readFile('cache:/x.bin');                // 路由到提供 cache 根的后端
```

怎么选：如果服务是单实例、你只要当前胜者，`getService()` 直接用即可（或者用网关，两者都惰性）；如果是多实例（每 root 或每 model 一个），且你想按 URI 或模型透明调度，就用对应 `*-api` 的网关或 `resolveXxx` helper，不要自己重抄聚合逻辑。这也是社区里的主流做法，多数官方插件都走惰性句柄。storage 的 URI 文法细节见 [storage URI 文法](./storage-uri-grammar.md)。

## `requiresBounceOnDepChange`：逃生舱，不是默认

```typescript
// 声明在插件模块（PluginModule）上
requiresBounceOnDepChange?: boolean;
```

设为 `true` 后，只要你依赖的 provider（required 或 optional）被热重载或下线，框架就会把你自己也降级为 pending 并重新 `apply`。

它是留给少数实在无法响应式处理状态的插件（或者迁移成本很高的老插件）的逃生舱。代价不小：依赖一抖动你就整体重启，比惰性查询贵得多，还可能放大级联。所以优先按下面的顺序处理，尽量避免设它：

1. 能改成"每次 `getService()`、或用网关句柄"吗？能就这么做，**不要**设这个标志。
2. 副作用是"一次性挂进某个 hub"吗？用 `whenService()`，它已经替你处理了换人重挂。
3. 实在做不到响应式——比如你在 `apply` 里基于 provider 当前状态构建了大量难以增量更新的内部结构——才设 `requiresBounceOnDepChange: true`。

::: tip 一个容易混淆的边界
required 依赖**彻底消失**时，无论你设不设这个标志，框架都会把你转入 pending，因为没了 required 依赖你本就不该运行。这个标志真正改变的，只是 provider 仅仅热重载（随后就回来）时你要不要跟着重启，以及 optional 依赖下线时的行为。
:::

## 注意事项

- **裸引用进类字段或闭包，就是僵尸引用。** 这是第一节反模式的根因，默认没有级联兜底，是你自己的责任。
- **不要用 `ctx.on('app:stopping', …)` 清理资源。** 它只在整个应用停机时触发一次，插件热重载并不会触发它，旧连接、旧定时器会因此泄漏。清理副作用请一律走 `ctx.onDispose(fn)`——热重载、卸载、更新配置等任何销毁路径都会触发它。
- **`whenService` 的 cb 里同步触发自身卸载也是安全的。** 框架处理了"cb 执行期间就被卸载"的竞态，返回的 cleanup 会被立即执行，不会泄漏。
- **要枚举所有并存的 provider**（比较少见，多用于管控或展示），用 `ctx.getAllServices(name)`，同样每次重新枚举。
- **手动卸载后，回调会自动摘除**，不阻碍垃圾回收。你不需要、也不该缓存实例去"帮忙"延长它的生命周期。

## 一页速查

| 你想做的事 | 用什么 | 不要 |
| --- | --- | --- |
| 偶尔读一次某服务的当前胜者 | `ctx.getService(name)`，即取即用 | 不要存进类字段或闭包 |
| 长期持有一个自动跟随换人的句柄 | `createStorageGateway` / `createProcessGateway`，句柄惰性可缓存 | 不要 `getService()` 一次后缓存裸实例 |
| 把副作用一次性挂进 hub，且随 provider 重挂 | `ctx.whenService(name, cb)`，cb 可返回 cleanup | 不要手写 `on('service:registered', …)` |
| 跨 root 或跨 model 透明路由 | `*-api` 的 `resolveXxx` 或网关 helper | 不要自己重抄聚合逻辑 |
| 清理资源（连接、定时器、外部句柄） | `ctx.onDispose(fn)` | 不要用 `on('app:stopping', …)` |
| 依赖抖动时整体重启（最后手段） | `requiresBounceOnDepChange: true` | 不要当默认，优先惰性或 `whenService` |
