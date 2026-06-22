# 惰性服务访问（Lazy Service Access）

> 写给第三方插件作者 / 维护者。读完你会知道：为什么**每次用都要重新 `ctx.getService()`**，
> 不能把裸引用缓存进类字段或闭包；什么时候用 `ctx.whenService()` 订阅"晚到的服务"；
> `requiresBounceOnDepChange` 这个逃生舱什么时候才该用；以及 `*-api` 包提供的
> "惰性网关"（`createStorageGateway` / `createProcessGateway`）为什么是推荐的默认姿势。

相关阅读（同级 concept / 服务文档）：

- [DI 服务模型](./service-model.md)（同名多实现的胜者解析：偏好 > 优先级 > 注册顺序）
- [Manifest 双来源](./manifest-metadata.md)（`provides`/`required`/`optional` 声明 vs 运行时 DI）
- [storage URI 文法](./storage-uri-grammar.md)（网关按 URI 跨 root 路由）
- 服务文档（forward-ref）：`docs/services/storage.md`、`docs/services/process.md`
- 内核参考：`docs/core/service.md`、`docs/core/context.md`

---

## 1. 为什么要"惰性"——provider 会在你脚下换人

Aalis 是热重载友好的：插件可以在运行时被 **bounce**（dispose 旧 ctx → 重新 `apply`），
也可以被用户切换 **偏好 provider**。这两件事都会让"某个服务名当前的胜者实例"发生变化。

如果你在 `apply()` 里这样写：

```typescript
// ❌ 反模式：把裸实例缓存到长寿命对象里
export function apply(ctx: Context) {
  const storage = ctx.getService('storage'); // 当时点的裸实例
  ctx.middleware('inbound:message', async (data, next) => {
    await storage.writeFile('data:/log.txt', data.text); // storage 可能早已失效
    await next();
  });
}
```

那么一旦 storage 提供方被 bounce，你闭包里的 `storage` 引用就指向了一个**已 dispose 的旧实例**
（旧连接、旧句柄）。`ctx.getService()` 的文档对此说得很直白：返回的是"当时点的裸实例，
调用后 provider 发生换跳不会跟随"
（`packages/core/src/context.ts:227-237`）。

**正确姿势——每次用时即取即用：**

```typescript
// ✅ 在函数作用域内重新查询，不存入类字段/闭包
export function apply(ctx: Context) {
  ctx.middleware('inbound:message', async (data, next) => {
    const storage = ctx.getService('storage'); // 每次都是当前胜者
    await storage?.writeFile('data:/log.txt', data.text);
    await next();
  });
}
```

`getService()` 只是查一次容器（`return this._services.get<T>(name)`，
`packages/core/src/context.ts:240-242`），代价极低；容器内部按
"偏好 > 优先级 > 注册顺序"解析当前胜者（`ServiceContainer.get` → `resolveEntries`，
`packages/core/src/service.ts:63-79`）。所以"每次查"既便宜又总是拿到最新的提供方。

---

## 2. 核心规则

### 规则一：默认**不**级联 bounce 下游

早期 core 对所有 active 下游做级联 bounce，前提是"大家都缓存裸引用"。现在的契约反过来了：

> **插件应在每次访问时通过 `ctx.getService(...)` 惰性查询；这样 provider 切换天然跟随，
> 无需级联 bounce。**
> —— `packages/core/src/plugin-topology.ts:78-92`

因此当一个 provider 被 bounce 时，`evictDownstreamConsumers` 默认**只**重挂那些显式声明了
`requiresBounceOnDepChange: true` 的下游，其余下游原地不动
（`packages/core/src/plugin-topology.ts:105-127`）。`computeTargetState` 里
`service-down` reason 也只对声明了该标志的 entry 转 pending
（`packages/core/src/plugin-activation.ts:33-47`）。

> 言下之意：如果你**没有**惰性查询、又**没有**声明 `requiresBounceOnDepChange`，
> provider 一换人你就持有了僵尸引用，而 core 不会救你。惰性是你这一侧的责任。

### 规则二：bounce 是 "dispose 旧 ctx → softReload 重激活"

`bouncePlugin`（`updatePluginConfig` 也是它的薄别名，`packages/core/src/plugin.ts:250-255`）的流程：
持久化新 config / 替换 module → `evictDownstreamConsumers` → `entry.context.dispose()` →
转 `pending` → `softReload()` 重新 `apply`（`packages/core/src/plugin.ts:269-313`）。

`dispose()` 会经 `unregisterByContext(this.id)` 把该插件注册的**所有** service entry 摘掉，
并发出 `service:unregistered`（`packages/core/src/context.ts:580-590`）。随后重激活时
新实例重新 `provide`，发出 `service:registered`。**实例换了，名字没变**——这正是缓存裸引用会出事的根因。

### 规则三：三种"换人"信号，都由容器当前态决定胜者

| 信号 | 触发 | 事件 |
| --- | --- | --- |
| provider 注册 | `ctx.provide(name, inst)` | `service:registered`（`context.ts:220`） |
| provider 注销 | dispose / 手动 dispose 返回值 | `service:unregistered`（`context.ts:211-216`、`580-590`） |
| 偏好切换 | `ctx.preferService(name, ctxId)` / `unpreferService` | `service:preference-changed`（`context.ts:281-304`） |

偏好切换很特殊：它**不改变 entry 集合**，只改变 `getService(name)` 的胜者，所以单独有一个
`service:preference-changed` 事件，不能复用 registered/unregistered
（事件定义见 `packages/core/src/types/core.ts:108-116`）。`whenService` 三个事件都监听。

---

## 3. `ctx.whenService(name, cb)` —— 订阅"晚到 / 会换人"的服务

`getService()` 解决的是"每次读最新"，但有一类副作用是**一次性注册**：你想把某个工具/监听器
注册进一个 hub 服务（如 `tools`），而那个 hub 可能在你之后才上线，或者中途被 bounce 换了实例。
这时手动监听 `service:registered` 既啰嗦又容易漏掉 cleanup。`whenService` 把这件事收成一行
（`packages/core/src/context.ts:328-436`）。

语义（逐条对应源码注释，`context.ts:336-353`）：

- 调用时服务**已就绪 → 立即触发首次 `cb`**（`sync()` 在末尾立即跑一次，`context.ts:421`）。
- provider 重新 provide（unregister → register）会**先调上次 cleanup、再用新 svc 调一次 `cb`**，
  保证你手里永远不是失效引用（`runCleanup` → 新 `winner` 调 `cb`，`context.ts:385-407`）。
- `cb` 可返回一个 cleanup 函数；返回的 dispose 与 `ctx.dispose()` 都会调它。
- 返回的 dispose **幂等**，手动多调安全（`disposed` 守卫，`context.ts:423-432`）。
- **胜者不变则不动**：败者 entry（低优先级并存的 provider）上下线不会触发重挂；
  只有"胜者换人"（含偏好切换、胜者注销后由次优顶上）才 cleanup + 重挂
  （`sync()` 核心：`if (winner === attached) return;`，`context.ts:385-389`）。

### 例 A：把工具注册进 `tools` hub（最常见用法）

```typescript
export function apply(ctx: Context) {
  // tools 服务可能晚于本插件就绪；whenService 保证就绪即注册、换人即重挂
  ctx.whenService('tools', svc => svc.register(myTool, ctx.id));
}
```

### 例 B：订阅 provider 内部状态，返回 cleanup

```typescript
ctx.whenService('llm', llm => {
  const handle = llm.onModelChange(updateUI);
  return () => handle.dispose(); // llm 被 bounce / 换人时自动调用
});
```

> 选型：**"每次读一个值"用 `getService()`；"挂一次副作用并随 provider 跟随"用 `whenService()`。**
> 二者都不要把裸引用存进类字段。

---

## 4. 惰性网关模式（`*-api` 的推荐姿势）

`storage` / `process` 这类服务是按子粒度多 entry 注册的（storage 每个 root 一个 entry、
process 单实例），消费者通常不想关心"当前哪个 root 由哪个后端提供"。`*-api` 包提供
**惰性网关工厂**：构造出一个看起来普通的 `StorageService` / `ProcessService` 句柄，
但它的**每个方法调用内部都重新查容器**——本质上是把"每次 `getService`"封装进了句柄。

### `createProcessGateway(ctx)` —— 最小示范

`packages/plugin-process-api/src/index.ts:112-126`：

```typescript
export function createProcessGateway(ctx: Context): ProcessService {
  const pick = (): ProcessService => {
    const inst = ctx.getService<ProcessService>('process'); // 每次调用都重新拿
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

关键点：网关对象本身**可以**长期持有（存进类字段没问题），因为它**不**捕获裸实例——
每个方法在调用瞬间才 `pick()`。所以下面这种写法是安全的，与第 1 节的反模式相反：

```typescript
export function apply(ctx: Context) {
  const proc = createProcessGateway(ctx); // 句柄长寿命 OK——它内部惰性
  ctx.onDispose(/* ... */);
  ctx.middleware('inbound:command', async (data, next) => {
    await proc.execFile('echo', ['hi']); // 这一刻才解析当前 process 提供方
    await next();
  });
}
```

### `createStorageGateway(ctx)` —— 还顺带按 URI 跨 root 路由

`packages/plugin-storage-api/src/index.ts:317-372`：网关的每个方法对传入的 storage URI
调 `dispatch(uri, caps)` → `resolveStorageByPath(ctx, uri, caps)`，后者每次都重新
`getStorageEntries(ctx)`（即 `ctx.getAllServices('storage')`，
`packages/plugin-storage-api/src/index.ts:179-181`、`259-264`）。所以它既是惰性、又是按
`<root>:/path` 文法路由的多 entry 聚合器：

```typescript
const storage = createStorageGateway(ctx);
await storage.writeFile('data:/notes/today.md', text); // 路由到提供 data 根的 entry
await storage.readFile('cache:/x.bin');                // 路由到提供 cache 根的 entry
```

> 何时直接 `getService` vs 用网关：服务是**单实例**且你只要当前胜者 → `getService` 即可
> （或干脆用网关，二者都惰性）；服务是 **per-root / per-model 多 entry** 且你想按 URI/模型
> 透明调度 → 用对应 `*-api` 的网关/`resolveXxx` helper，别自己重抄聚合逻辑
> （契约级文法见 `service.ts` 的 `ServicePriority` 注释，`packages/core/src/types/service.ts:22-25`）。
> storage 的 URI 文法细节见 [storage URI 文法](./storage-uri-grammar.md)。

社区里这是绝对主流：`createStorageGateway` / `createProcessGateway` 被几十个 first-party
插件复用（authority / checkpoint / scheduler / commands / media / tool-* …），全部走惰性句柄。

---

## 5. `requiresBounceOnDepChange` —— 逃生舱，不是默认

```typescript
// packages/core/src/types/plugin.ts:49
requiresBounceOnDepChange?: boolean;
```

声明在你的插件模块上（`PluginModule`）。设为 `true` 后，当你**依赖（required 或 optional）**
的某个 provider 被 bounce / 下线时，core 会把**你**也降级为 pending 并重新 `apply`
（`evictDownstreamConsumers`，`packages/core/src/plugin-topology.ts:95-127`；
`computeTargetState` 的 `service-down` 分支，`packages/core/src/plugin-activation.ts:40-45`）。

它是给**少数无法响应式处理状态**的插件、或迁移成本高的第三方插件准备的逃生舱
（`plugin-topology.ts:90-91`）。代价是：依赖一抖动你就整体重启，比惰性查询昂贵得多，
还可能放大级联。

**优先级判断：**

1. 你能改成"每次 `getService()` / 用网关句柄"吗？→ 能就这么做，**不要**设这个标志。
2. 你的副作用是"一次性注册进 hub"吗？→ 用 `whenService()`，它已经帮你处理换人重挂。
3. 实在做不到响应式（比如你在 `apply` 里基于 provider 当前态构建了大量难以增量更新的内部结构）
   → 才设 `requiresBounceOnDepChange: true`。

> 注意：required 依赖**消失**时，无论是否设此标志，`computeTargetState` 都会把你转 pending
> （`reqUnmet → 'pending'`，`packages/core/src/plugin-activation.ts:38-39`）——因为没了 required
> 依赖你本就不该运行。该标志真正改变的是 **provider 仅仅 bounce（随后会回来）** 时要不要跟着重启，
> 以及 **optional 依赖下线** 时的行为。

---

## 6. 审计标记过的坑 / 边界情形

- **裸引用进类字段 / 闭包 = 僵尸引用。** 第 1 节的根因。默认无级联 bounce 兜底，
  这是你的责任（`plugin-topology.ts:82-88`）。
- **不要 `ctx.on('app:stopping', …)` 做资源清理。** 那只在 app 全局停机时触发一次，
  **不会**在插件 bounce / hot reload 时触发，旧连接/旧定时器会泄漏。清理副作用的唯一正确 API 是
  `ctx.onDispose(fn)`（在 bounce / unload / updatePluginConfig / softReload 级联 evict 的
  任何 dispose 路径上都会触发，`packages/core/src/context.ts:524-558`）。
- **`whenService` 的 cb 里同步触发自身 dispose 也安全。** core 处理了"cb 执行期间 disposed
  变 true"的竞态——此时返回的 cleanup 会被立即执行而非挂起泄漏
  （`packages/core/src/context.ts:393-405`）。
- **败者上下线不会触发 `whenService` 重挂。** 只看胜者。如果你真的要枚举**所有**并存 provider
  （罕见，多为管控/展示场景），用 `ctx.getAllServices(name)` / `ctx.getServiceEntries(name)`，
  且同样每次重新枚举（`context.ts:258-326`）。
- **作用域容器（沙盒）的 fallback。** `createScope()` 下 `getService` 先查本地、miss 再
  fallback 到父容器（`ScopedServiceContainer.get`，`packages/core/src/service.ts:235-239`）；
  惰性查询在 scope 里同样成立——沙盒里临时 `provide` 的覆盖 dispose 后，下次 `getService`
  自动回落到全局胜者。
- **手动 dispose 后闭包自移除。** `provide` / `whenService` 返回的 dispose 调用后会把自己从
  disposable 链摘掉，避免持有 entry/handler 引用阻碍 GC（`context.ts:206-218`、`423-432`）；
  你不需要、也不应该缓存实例去"帮忙"延长生命周期。

---

## 7. 一页速查

| 你想做的事 | 用什么 | 不要 |
| --- | --- | --- |
| 偶尔读一次某服务的当前胜者 | `ctx.getService(name)`（即取即用） | 别存进类字段 / 闭包 |
| 长期持有一个会自动跟随换人的句柄 | `createStorageGateway(ctx)` / `createProcessGateway(ctx)`（句柄惰性，可缓存） | 别 `getService()` 一次后缓存裸实例 |
| 把副作用一次性注册进 hub，且随 provider 重挂 | `ctx.whenService(name, cb)`（cb 可返回 cleanup） | 别手写 `on('service:registered', …)` |
| 跨 root / 跨 model 透明路由 | `*-api` 的 `resolveXxx` / 网关 helper | 别自己重抄聚合逻辑 |
| 清理资源（连接/定时器/外部句柄） | `ctx.onDispose(fn)` | 别用 `on('app:stopping', …)` |
| 依赖 provider 抖动时整体重启（最后手段） | `requiresBounceOnDepChange: true` | 别当默认；优先惰性 / `whenService` |

**一句话记忆：** Aalis 的服务图是活的——名字稳定、实例会换。
**每次用都查、句柄要惰性、清理走 `onDispose`、整体重启是逃生舱。**
