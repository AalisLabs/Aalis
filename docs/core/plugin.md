# PluginManager — 插件管理

管理插件的注册、激活、停用和热更新。

**源码**: `packages/core/src/orchestration/plugin.ts`、`packages/core/src/types/plugin.ts`

## 插件定义

插件是 `definePlugin` 的产物（`PluginDefinition`），由宿主的加载器以 default 导出接入（入口判定 `pluginDefinitionOf` 在 `@aalis/api-plugin-source`）。形状与能力见 [插件定义与能力](context.md)。

注册表里的一条实例（管理面经 `plugins.getPlugin` 读到的形状）是 `PluginEntry`：

```typescript
interface PluginEntry {
  definition: PluginDefinition;
  instanceId: string;          // 单实例时与 definition.name 相同，多实例时为 `name:suffix`
  config: Record<string, unknown>;
  state: PluginState;
  error?: string;              // 激活失败的说明：错误消息后接 cause 链摘要
  required: string[];          // 参与激活闸的依赖服务名（uses 里未包 optional 的外部服务）
  optional: string[];          // 不参与激活闸的依赖服务名
}
```

公开条目不含内部激活记录。`required` / `optional` 是服务名数组，在注册时从 `uses` 抽出（包含 Core 基础服务）。

`parseInstanceId(instanceId)`：`@scope/plugin-name:suffix` 或 `plugin-name:suffix` → `{ moduleName, suffix }`；无 suffix 时 `suffix` 为 `undefined`。模块名是 npm 包名、不含 `:`，因此以第一个 `:` 切开，带不带 scope 同一规则；后缀里可以再出现 `/` 或 `:`。

## 插件状态

| 状态 | 说明 |
|---|---|
| `pending` | 已注册，等待 required 依赖满足 |
| `activating` | 正在激活（调用 `apply`）；超过 `slowThresholdMs` 仍未完成时转入后台，`getStatus()` 对它给出 `slow: true` |
| `active` | 已激活，正常运行 |
| `disabled` | 手动禁用 |
| `disposed` | 已卸载（单向终态） |
| `error` | 激活失败，或停用 / 重启、后台激活的 required 依赖下线时 abort 后超过宽限仍未停止（`error` 为「未在宽限内停止（…）」）（激活失败时带 `error` 信息：错误消息后接 cause 链各层的首行，以 ` ← ` 相连，至多 5 层；`AggregateError` 层之后接至多 3 条子错误的首行，以 `; ` 相连；上一层首行与本层首行相同，或以冒号接本层首行结尾时，省略本层；非 Error 的值只取首行、至多 200 字符。不会在后续 recompute 中自动重试，需 `enable` / `bounce`） |

## 生命周期流程

```
register(definition, config?, instanceId?, { disabled? })
  │
  ├─ 校验 definition / instanceId（失败 → false）
  ├─ 创建 PluginEntry（状态 = pending；以 { disabled: true } 登记则为 disabled），配置拷贝后原样挂上
  ├─ 从 uses 抽出 required / optional
  └─ recompute('changed')（只登记了禁用条目时不重算）
        required 已满足 → 激活（ActivationHost.create → mount：装配能力并调用 apply → 校验 provides）
        否则保持 pending，等待 service:registered
```

`app.pluginAll(items)` 是同一流程的批量形式：整批同步落账后只 recompute 一次，依赖方因此在同一次重算里排在它 required 服务的全部提供者之后激活。

### 慢激活转入后台

重算逐个激活插件，对单个激活至多等 `AppOptions.slowThresholdMs`（默认 60000；0 = 不设限，一直等）：

- 超过阈值仍未完成：记一条 warn 点名，转入后台继续，重算接着激活后面的插件；`register` / `pluginAll` / `idle()` 照常在阈值处返回，启动流程不再卡在插件登记。此后每隔同样时长提醒一次「仍在激活（已超过 N ms）」，直到它落定或被接手。
- 后台期间条目停在 `activating`，`getStatus()` 对它给出 `slow: true`。它经 `provide` 登记的服务不对外：`get` / `all` / `inspect` / `names` 与激活闸都看不到，阈值前已登记的在转入后台时撤下（发 `service:unregistered`），后台期间新登记的不发事件；依赖它的插件保持 `pending`。它经 `registrar` 登记到别处的条目与事件监听照常生效，它的 `app:ready` / `app:started` 监听器可能在 `apply` 完成之前被调用。
- 落定：成功则先转 `active` 再上线服务（发 `service:registered`），依赖方随之激活；失败进 `error`，服务从未上线；`apply` 期间 required 依赖丢失的回到 `pending`。无论哪种都另补一次重算。
- 后台激活的 required 依赖下线时被拆掉（它 `apply` 里拿到的已是旧实例），abort 与宽限同下文：宽限内落定的回到 `pending`，依赖恢复后重新激活；到期仍未落定的转 `error`，依赖恢复后也不自动重试。在飞（未到阈值）的激活由重算等它落定后再按依赖判定。

`apply` 尚未完成时被停机或管理动作接手（`disable` / `unload` / `bounce`，或它的 required 提供者被这样处理），或后台激活因 required 依赖下线被拆，它的 `lifecycle.signal` 在关闭计划冻结后立即 abort，重算不再等它；关闭时自它的收尾段开始至多再等 `disposeTimeoutMs` 让 `apply` 落定。到期仍未落定：记 error「未在宽限内停止」、不再等待，流程继续；目标态为 `disabled` / `pending` 的（`disable` / `bounce` 的主体、任何管理动作同批的下游、依赖下线被拆的后台激活）改为 `error`：`apply` 仍在跑，不能再起新实例，`bounce` 因此不会重新激活，依赖恢复后也不自动重试；目标态为 `disposed` 的（`unload` 的主体、停机）是单向终态，只记日志。被放弃的 `apply` 之后落定也不会改写条目（让位检查比对状态与激活身份），它迟到的 `provide` / `events.on` 按已关闭的激活拒收、`onDispose` 就地执行。

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

1. 按 required 依赖正序（提供者 → 消费者）拓扑排序，同时就绪者按登记序。仅 required 参与建图；optional 缺席照样激活，不制造排序约束。
2. **Phase A**：把目标不再是 `active` 的成批关闭（含 required 依赖已不在、仍在后台初始化的）。它们之间的次序由关停编排按实际绑定决定，不是注册序。
3. **Phase B**：正向遍历，激活目标 `active` 且依赖满足的 pending entry（提供者先起、消费者后起）。旧激活仍在拆卸中的跳过，等管理路径收尾后的重算。单个激活至多等到阈值，见上文慢激活一节。
4. 本轮有变动则继续下一轮，直到稳定或达到上限（`2×插件数 + 8`）。非停机时发 `plugins:changed`。

`disabled` / `disposed` / `error` 是显式态，recompute 不动它们；active / pending 条目的目标态只看 required 依赖此刻是否都有提供者（`requiredSatisfied`）：不满足 → `pending`，满足 → `active`。optional 依赖的上下线不改变目标态：绑定接口每次查询解析当前值，有状态的接线经 `follow` 跟随提供者换人，不靠重启插件。

管理动作收尾时调用 `recompute('changed')`；`stopAll()` 是 `recompute('shutdown')` 的薄壳。停机置位后普通重算不再做状态转移，拆卸全归停机计划。`App.stop()` 单飞：先 `beginShutdown()`（置停机态并冻计划）再 `idle()`，然后发 `app:stopping`，最后 `stopAll()` 执行 drain / close。停机进行中 `register` / `bounce` 返回 false；`unload` 汇入已冻计划后立即返回 true；`disable` 在停机拆卸开始后对已标 `disposed` 的条目返回 false，其余同 `unload`。每次 `stop()` 都返回完整停机的同一 Promise；`app:stopping` 监听器与清理回调不能 await 或返回它，以免等待自身。

停机时全部 active 插件与宿主的根激活进同一张关停计划（无依赖关系时后注册的先关）。每个激活 drain 后 close；边规则见 [插件定义与能力](context.md)。单插件 `unload` / `disable` / `bounce` 与整机停机同一套交接保证：正在用它所提供服务的 required 下游（传递闭包）并入同一批，先收尾、先关，提供者之后；判据是下游此刻解析到的胜者属于要走的激活，空档里不切到后备。下游之后转 pending，`bounce` 时随提供者按拓扑序重新激活。这项保证覆盖动作发起时处于 `active` 或仍在初始化（在飞或后台）的 required 下游；仍在初始化的下游被 abort，按上文的宽限处理，不响应 abort 的会因此进 `error`。并发的另一个管理动作里已在收尾的下游、管理动作期间才开始激活的下游、管理动作进行中发生的停机，与本次管理动作彼此不排序。

## 管理动作口径

六个管理动作（`register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig`）一律返回 `Promise<boolean>`：

**false** = 主体不在注册表，或本次动作被状态 / 政策规则挡下（重名、未声明 `reusable` 的多实例、`disposed` 单向终态、`disabled` 态 bounce、**定义或实例 id 校验失败**（含空白、危险键 `__proto__` / `constructor` / `prototype`）、停机中的 `register` / `bounce`）。

**true** = 其余，含主体已在目标态的幂等情形。停机进行中，`unload` 汇入停机计划后立即返回 true——不等待拆卸完成，拆卸由停机计划执行（在 `app:stopping` 监听器里等待会与屏障事件死锁）。`disable` 先判 `disposed` 终态再判停机：停机拆卸开始时已把有激活的条目标成 `disposed`，此后对它们 `disable` 返回 false，其余情形同 `unload` 返回 true。

每个 false 分支都已记一笔日志（政策挡下 warn，主体不存在与 `disposed` 在途 debug）。true 只说明请求已受理，不说明激活已落定——那看 `idle()`。`enable` / `updateConfig` 对已 `disposed` 的插件返回 false 不变。

管理动作只改运行态（实例配置、禁用态），不写配置文档。要跨重启保留，调用方在动作成功后经 host-config 写文档并 `save()`，见 [运行态与配置文档](config.md)。

`idle()` 等待状态机静置（无在飞 recompute、无排队、无手动 dispose 段）。变更 API 在已有 flight 在飞时排队并立即返回。不等转入后台的激活：它落定后另触发一次重算，之后调用的 `idle()` 会等这次重算。后台激活落定失败时的回滚不在重算之内，`idle()` 不等它完成（状态已先写好）。**不得在插件 `apply` / `onDispose` 内调用**——flight 正等着你返回，互等死锁。

### `register(definition, config?, instanceId?, options?)`

注册并尝试激活。`config` 原样生效（core 不合并默认值、不读配置文档）；`options.disabled` 为 `true` 时以禁用态登记、不激活。手写的定义对象（没经 `definePlugin`）在这里补上同一道校验。缺 / 空 / 非法 `name`、`uses` 非描述符、非法 `instanceId`（空、含 `#`）各记一笔 warn 并返回 false。停机中拒绝新登记。

### `unload(instanceId)`

拆掉激活并从注册表移除。撞上在途卸载时 join 它，返回时该实例已离开注册表。并发首个 unload 完成后同 id 可能已重新注册，删除带恒等卫，不会按名盲删新 entry。停机中把该激活汇入已冻计划后立即返回 true，不在这里等待拆卸。

### `enable(instanceId)` / `disable(instanceId)`

启用 / 禁用。`error` 态可经 `enable` 转 `pending` 重试。停机中 `disable` 汇入已冻计划后立即返回 true；停机拆卸开始后，被标成 `disposed` 的条目返回 false。

### `bounce(instanceId, opts?: { config? })`

增量重载：可选换上新的运行配置 → 拆掉当前激活 → 转 `pending` → 重算后重新激活。即 **retire + 重算**。

- 正在用本插件所提供服务的 required 下游随之重启（先收尾、先关，本插件重新激活后按拓扑序重新激活）；optional 依赖经 `follow` 在换人时交接。
- 不换代码：跑的仍是注册时的那份定义。要换代码走 `unload` + `register`。
- `disabled`、`disposed`、停机进行中拒绝 bounce。
- `error` 态会被重置为 pending 重试。

### `updateConfig(instanceId, config)`

`bounce(instanceId, { config })` 的薄壳。入参拷贝后再挂到 entry，插件经内置 `config` 就地改嵌套不会写穿调用方的对象。

## 反应式监听

- `service:registered` / `service:unregistered` → `recompute('changed')`
- flight 不再等的激活（转入后台，或被接手）落定 → `recompute('changed')`

单飞 / 挂起 / 关机的取舍都在 `recompute` 内部：在飞期间排队，关机后非 shutdown 请求跳过。
