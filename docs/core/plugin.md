# PluginManager — 插件管理

管理插件的注册、激活、停用和热更新。

**源码**: `packages/core/src/orchestration/plugin.ts`、`packages/core/src/types/plugin.ts`

## 插件定义

插件是 `definePlugin` 的产物（`PluginDefinition`），由加载器以 default 导出接入。形状与能力见 [插件定义与能力](context.md)。

注册表里的一条实例（管理面经 `plugins.getPlugin` 读到的形状）是 `PluginEntry`：

```typescript
interface PluginEntry {
  definition: PluginDefinition;
  instanceId: string;          // 单实例时与 definition.name 相同，多实例时为 `name:suffix`
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;
  required: string[];          // 参与激活闸的依赖服务名（uses 里未包 optional 的外部服务）
  optional: string[];          // 不参与激活闸的依赖服务名
}
```

公开条目不含内部激活记录。`required` / `optional` 是服务名数组，在注册时从 `uses` 抽出（包含 Core 基础服务）。

`parseInstanceId(instanceId)`：`@scope/plugin-name:suffix` → `{ moduleName, suffix }`；无 suffix 时 `suffix` 为 `undefined`。从 `/` 之后切开，不把 scope 里的字符当成后缀。

## 插件状态

| 状态 | 说明 |
|---|---|
| `pending` | 已注册，等待 required 依赖满足 |
| `activating` | 正在激活（调用 `apply`） |
| `active` | 已激活，正常运行 |
| `disabled` | 手动禁用 |
| `disposed` | 已卸载（单向终态） |
| `error` | 激活失败（带 `error` 信息；不会在后续 recompute 中自动重试，需 `enable` / `bounce`） |

## 生命周期流程

```
register(definition, config?, instanceId?)
  │
  ├─ 校验 definition / instanceId（失败 → false）
  ├─ 创建 PluginEntry（状态 = pending 或配置禁用则为 disabled）
  ├─ 从 uses 抽出 required / optional
  └─ recompute('changed')
        required 已满足 → 激活（ActivationHost.create → mount：装配能力并调用 apply → 校验 provides）
        否则保持 pending，等待 service:registered
```

激活成功发 `plugin:loaded`（通知，不等监听器）。若本次激活的 required 绑定在 `apply` 中通过 `require()` 原样抛出服务不可用错误，Core 会先撤回本次资源，再回到 `pending` 等待或重新观察依赖。optional 绑定、其他激活传来的错误、包装后的新异常与普通业务错误仍进入 `error`；不按错误文本或“此刻恰好缺服务”猜测原因。失败激活不发 `plugin:unloaded`（从未 loaded）。

## 统一状态机：`recompute(kind)`

PluginManager 只有一个状态变更入口。种类只有两种：

```typescript
type RecomputeKind = 'changed' | 'shutdown';
```

- `'changed'`（默认）：服务上下线、注册、启停、bounce、配置更新。合并处理。
- `'shutdown'`：覆盖整批；`App.stop()` 经 `stopAll()` 走这一条。

在飞 recompute 或手动 dispose 段期间到来的请求合并成一次，停机覆盖普通变化。目标态只看容器里此刻有没有服务。

每轮（非 shutdown）：

1. 按 required 依赖正序（提供者 → 消费者）拓扑排序。仅 required 参与建图；optional 缺席照样激活，不制造排序约束。
2. **Phase A**：把目标不再是 `active` 的成批关闭。它们之间的次序由关停编排按实际绑定决定，不是注册序。
3. **Phase B**：正向遍历，激活目标 `active` 且依赖满足的 pending entry（提供者先起、消费者后起）。
4. 本轮有变动则继续下一轮，直到稳定或达到上限（`2×插件数 + 8`）。非停机时发 `plugins:changed`。

`computeTargetState`：`disabled` / `disposed` / `error` 是显式态，recompute 不动它们；required 不满足 → `pending`；其余 → `active`。optional 依赖的上下线不改变目标态：绑定接口每次查询解析当前值，有状态的接线经 `follow` 跟随提供者换人，不靠重启插件。

`softReload()` 是 `recompute('changed')` 的薄壳；`stopAll()` 是 `recompute('shutdown')` 的薄壳。`App.stop()` 单飞：先 `beginShutdown()`（置停机态并冻计划）再 `idle()`，然后发 `app:stopping`，最后 `stopAll()` 执行 drain / close。停机进行中 `register` / `bounce` 返回 false；`unload` / `disable` 汇入已冻计划后立即返回 true。每次 `stop()` 都返回完整停机的同一 Promise；`app:stopping` 监听器与清理回调不能 await 或返回它，以免等待自身。

停机时全部 active 插件与宿主的根激活进同一张关停计划（无依赖关系时后注册的先关）。每个激活 drain 后 close；边规则见 [插件定义与能力](context.md)。单插件 `unload` / `disable` / `bounce` 与整机停机同一套交接保证：正在用它所提供服务的 required 下游（传递闭包）并入同一批，先收尾、先关，提供者之后；判据是下游此刻解析到的胜者属于要走的激活，空档里不切到后备。下游之后转 pending，`bounce` 时随提供者按拓扑序重新激活。

## 管理动作口径

六个管理动作（`register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig`）一律返回 `Promise<boolean>`：

**false** = 主体不在注册表，或本次动作被状态 / 政策规则挡下（重名、未声明 `reusable` 的多实例、core 插件禁用、`disposed` 单向终态、`disabled` 态 bounce、**定义或实例 id 校验失败**（含空白、危险键 `__proto__` / `constructor` / `prototype`）、停机中的 `register` / `bounce`）。

**true** = 其余，含主体已在目标态的幂等情形。停机进行中，`unload` / `disable` 汇入停机计划后立即返回 true——不等待拆卸完成，拆卸由停机计划执行（在 `app:stopping` 监听器里等待会与屏障事件死锁）。

每个 false 分支都已记一笔日志（政策挡下 warn，主体不存在与 `disposed` 在途 debug）。true 只说明请求已受理，不说明激活已落定——那看 `idle()`。`enable` / `updateConfig` 对已 `disposed` 的插件返回 false 不变。

`idle()` 等待状态机静置（无在飞 recompute、无排队、无手动 dispose 段）。变更 API 在已有 flight 在飞时排队并立即返回。**不得在插件 `apply` / `onDispose` 内调用**——flight 正等着你返回，互等死锁。

### `register(definition, config?, instanceId?)`

注册并尝试激活。手写的定义对象（没经 `definePlugin`）在这里补上同一道校验。缺 / 空 / 非法 `name`、`uses` 非描述符、非法 `instanceId`（空、含 `#`）各记一笔 warn 并返回 false。停机中拒绝新登记。

### `unload(instanceId)`

拆掉激活并从注册表移除。撞上在途卸载时 join 它，返回时该实例已离开注册表。并发首个 unload 完成后同 id 可能已重新注册，删除带恒等卫，不会按名盲删新 entry。停机中把该激活汇入已冻计划后立即返回 true，不在这里等待拆卸。

### `enable(instanceId)` / `disable(instanceId)`

启用 / 禁用。core 插件不可禁用。`error` 态可经 `enable` 转 `pending` 重试。停机中 `disable` 汇入已冻计划后立即返回 true。

### `bounce(instanceId, opts?: { config? })`

增量重载：可选写回配置 → 拆掉当前激活 → 转 `pending` → 重算后重新激活。即 **retire + 重算**。

- 正在用本插件所提供服务的 required 下游随之重启（先收尾、先关，本插件重新激活后按拓扑序重新激活）；optional 依赖经 `follow` 在换人时交接。
- 不换代码：跑的仍是注册时的那份定义。要换代码走 `unload` + `register`。
- `disabled`、`disposed`、停机进行中拒绝 bounce。传 `opts.module` 期望换码会 warn 并返回 false。
- `error` 态会被重置为 pending 重试。

### `updateConfig(instanceId, config)`

`bounce(instanceId, { config })` 的薄壳。入参会拷贝后再挂到 entry 与 ConfigManager，避免插件经内置 `config` 就地改嵌套写穿快照。

## 反应式监听

- `service:registered` / `service:unregistered` → `recompute('changed')`

单飞 / 挂起 / 关机的取舍都在 `recompute` 内部：在飞期间排队，关机后非 shutdown 请求跳过。
