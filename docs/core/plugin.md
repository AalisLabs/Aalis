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
  error?: string;              // 激活失败的说明：错误消息后接 cause 链摘要；另有 core 写入的固定说明（见下表）
}
```

公开条目不含内部激活记录与依赖表；依赖信息只在 `getStatus()` 条目的 `uses` 里（包含 Core 基础服务）。

`parseInstanceId(instanceId)`：`@scope/plugin-name:suffix` 或 `plugin-name:suffix` → `{ moduleName, suffix }`；无 suffix 时 `suffix` 为 `undefined`。模块名是 npm 包名、不含 `:`，因此以第一个 `:` 切开，带不带 scope 同一规则；后缀里可以再出现 `/` 或 `:`。

## 插件状态

| 状态 | 说明 |
|---|---|
| `pending` | 已注册，等待 required 依赖满足 |
| `activating` | 正在激活（调用 `apply`）；超过 `slowThresholdMs` 仍未完成时转入后台，`getStatus()` 对它给出 `slow: true` |
| `active` | 已激活，正常运行 |
| `disabled` | 手动禁用 |
| `disposed` | 已卸载（单向终态） |
| `error` | 激活失败，或初始化期间 required 依赖反复缺失、自动重试用尽（见下文）（激活失败时带 `error` 信息：错误消息后接 cause 链各层的首行，以 ` ← ` 相连，至多 5 层；`AggregateError` 层之后接至多 3 条子错误的首行，以 `; ` 相连；上一层首行与本层首行相同，或以冒号接本层首行结尾时，省略本层；非 Error 的值只取首行、至多 200 字符。不会在后续 recompute 中自动重试，需 `enable` / `bounce`） |

## 生命周期流程

```
register(definition, config?, instanceId?, { disabled? })
  │
  ├─ 校验 definition / instanceId（失败 → false）
  ├─ 创建 PluginEntry（状态 = pending；以 { disabled: true } 登记则为 disabled），配置拷贝后原样挂上
  ├─ 从 uses 抽出 required / optional
  └─ recompute()（只登记了禁用条目时不重算）
        required 已满足 → 激活（ActivationHost.create → mount：装配能力并调用 apply → 校验 provides）
        否则保持 pending，等待 service:changed
```

`app.pluginAll(items)` 是同一流程的批量形式：整批同步落账后只 recompute 一次，依赖方因此在同一次重算里排在它 required 服务的全部提供者之后激活。

### 慢激活转入后台

重算逐个激活插件，对单个激活至多等 `AppOptions.slowThresholdMs`（默认 60000；0 = 不设限，一直等）：

- 超过阈值仍未完成：记一条 warn 点名，转入后台继续，重算接着激活后面的插件；`register` / `pluginAll` / `idle()` 照常在阈值处返回，启动流程不再卡在插件登记。此后不再提醒，后台状态看 `getStatus()` 的 `slow`；阈值定时器只触发一次，没调 `stop()` 的宿主进程至多被它拖到阈值到点才退出。
- 重算逐个激活，每个慢激活都单独等满一个阈值：排在前面的慢插件有 N 个时，后面插件的激活与 `register` / `pluginAll` / `idle()` 的返回约晚 N×阈值。
- 后台期间条目停在 `activating`，`getStatus()` 对它给出 `slow: true`。它经 `provide` 登记的服务不对外：`get` / `all` / `inspect` / `names` 与激活闸都看不到，阈值前已登记的在转入后台时撤下（发 `service:changed`），后台期间新登记的照常发事件但重读看不到；依赖它的插件保持 `pending`。它经 `registrar` 登记到别处的条目与事件监听照常生效，它的 `app:ready` / `app:started` 监听器可能在 `apply` 完成之前被调用。
- 落定：成功则先转 `active` 再上线服务（发 `service:changed`），依赖方随之激活；失败进 `error`，服务从未上线；`apply` 期间 required 依赖丢失的回到 `pending`（计入下文的重试预算）。无论哪种都另补一次重算。
- 后台激活的 required 依赖下线时被拆掉（它 `apply` 里拿到的已是旧实例），abort 与宽限同下文，回到 `pending` 并计入下文的重试预算（用尽转 `error`）。在飞（未到阈值）的激活由重算等它落定后再按依赖判定。

`apply` 尚未完成时被停机或管理动作接手（`disable` / `unload` / `bounce`，或它的 required 提供者被这样处理），或后台激活因 required 依赖下线被拆，它的 `lifecycle.use.signal` 在关闭计划冻结后立即 abort，重算不再等它；关闭时自它的收尾段开始至多再等 `disposeTimeoutMs` 让 `apply` 落定，到期仍未落定就不再等待，流程继续。被放弃的 `apply` 之后落定也不会改写条目（让位检查比对状态），它迟到的 `provide.use` / `events.use.on` 按已关闭的激活拒收、`onDispose` 就地执行。

### 旧实例停下之前不起新实例

一个激活关完时还有工作没落定（`apply` 或某项清理超过 `disposeTimeoutMs` 被放弃等待，或关闭后就地执行的清理还在跑），core 把它记在实例 id 名下：条目照写目标态（`bounce` 为 `pending`、`disable` 为 `disabled`、依赖下线被拆的回到 `pending`），`getStatus()` 对它给出 `lingering: true`，记一条 warn；这些工作全部落定之前，同一 id 不起新实例，`bounce`、`updateConfig`、`enable`、依赖恢复与卸载后同 id 重新登记都一样。落定后去掉标记、补一次重算，按目标态继续。管理动作与 `idle()` 不等它。永不落定的工作会让这个 id 一直等下去，只有重启进程能解决。

激活成功发 `plugin:loaded`（通知，不等监听器）。若本次激活 required 依赖的 `use` 句柄在 `apply` 中抛出的服务不可用错误原样传出，Core 会先撤回本次资源，再回到 `pending` 等待或重新观察依赖。这类自动重试与后台激活因 required 依赖下线被拆，按插件记入同一份重试预算，跨重算累计、有界；用尽转 `error`（「初始化期间 required 依赖反复缺失（最后一次缺 "<服务名>"），自动重试未收敛，已停止；enable 或 bounce 后重试」），不再自动重试。optional 依赖与 `of(id)` 句柄的错误、其他激活传来的错误、包装后的新异常与普通业务错误仍进入 `error`；不按错误文本或“此刻恰好缺服务”猜测原因。`plugin:unloaded` 只发给发过 `plugin:loaded` 的激活：失败激活、仍在初始化时被拆的激活都不发。

## 统一状态机：`recompute()`

PluginManager 只有一个状态变更入口：服务上下线、注册、启停、bounce、配置更新都汇入 `recompute()`。停机不经它，由停机计划拆卸。

在飞 recompute 或手动 dispose 段期间到来的请求合并成一次，管理动作收尾时再调一次 `recompute()`。重算的目标态只看容器里此刻有没有服务，别的计划正关着的提供者不算在。

每轮：

1. 按 required 依赖正序（提供者 → 消费者）拓扑排序，同时就绪者按登记序。仅 required 参与建图；optional 缺席照样激活，不制造排序约束。
2. **Phase A**：把目标不再是 `active` 的成批关闭（含 required 依赖已不在、仍在后台初始化的），连同 required 服务会随这批一起失去全部提供者的下游（传递闭包；还有后备提供者的不算，别的计划正关着的提供者不算后备）。它们之间的次序由关停编排按实际绑定决定，不是注册序：下游先收尾，收尾时上游仍在。
3. **Phase B**：正向遍历，激活目标 `active` 且依赖满足的 pending entry（提供者先起、消费者后起）。旧激活仍在拆卸中的跳过，等管理路径收尾后的重算；某个 required 服务此刻为它选中的那一家已进关闭计划的（例如在飞的提供者被管理动作接手，重算已不再等它）同样跳过，等提供者关完、服务下线触发的重算再判定。单个激活至多等到阈值，见上文慢激活一节。
4. 本轮有变动则继续下一轮，直到稳定或达到上限（`2×插件数 + 8`）。最后发 `plugins:changed`。

`disabled` / `disposed` / `error` 是显式态，recompute 不动它们；active / pending 条目按 required 依赖此刻是否都有提供者定目标态：不满足 → `pending`，满足 → `active`。optional 依赖的上下线不改变目标态：业务句柄每次访问都重新解析到当前选中的那一家，有状态的接线经 `follow` 跟随提供者换人，不靠重启插件。

`App.stop()` 单飞：先 `beginShutdown()`（置停机态、丢弃排队的重算并冻计划，此后的重算请求直接跳过）再 `idle()`（仍等待已在飞的重算和手动 dispose 段），然后发 `app:stopping`，最后 `stopAll()` 执行 drain / close。从 `beginShutdown()` 起，新发起的六个管理动作一律立即返回 false，不改变条目状态或配置，也不加入额外拆卸；清理由已有停机计划负责。每次 `stop()` 都返回完整停机的同一 Promise；`app:stopping` 监听器与清理回调不能 await 或返回它，以免等待自身。

停机时全部 active 插件与宿主的根激活进同一张关停计划（无依赖关系时后注册的先关）。每个激活 drain 后 close；边规则见 [插件定义与能力](context.md)。单插件 `unload` / `disable` / `bounce` 与整机停机同一套交接保证：正在用它所提供服务的 required 下游（传递闭包）并入同一批，先收尾、先关，提供者之后；判据是下游此刻选中的那一家属于要走的激活，空档里不切到后备。下游之后转 pending，`bounce` 时随提供者按拓扑序重新激活。这项保证覆盖动作发起时处于 `active` 或仍在初始化（在飞或后台）的 required 下游；仍在初始化的下游被 abort，按上文的宽限处理，不响应 abort 的旧实例停下之前不会重新激活。仍在 `pending` 的下游不会在提供者关闭期间开始激活（见上文 Phase B）。并发的管理动作、停机之间谁等谁见 [插件定义与能力](context.md)。

## 管理动作口径

六个管理动作（`register` / `unload` / `enable` / `disable` / `bounce` / `updateConfig`）一律返回 `Promise<boolean>`：

**false** = 主体不在注册表，或本次动作被状态 / 政策规则挡下，例如重名、未声明 `reusable` 的多实例、`disposed` 单向终态、`disabled` 态的 bounce，以及**定义或实例 id 校验失败**（含空白、危险键 `__proto__` / `constructor` / `prototype`）。从 `beginShutdown()` 起，新发起的六个动作都立即返回 false，不改状态或配置。

**true** = 正常运行中其余已受理的请求，含主体已在目标态的幂等情形。正常运行中，对已在途卸载再次 `unload` 会 join 首次卸载，返回时该实例已拆卸并离开注册表；进入停机后不再 join 或新增拆卸。

每个 false 分支都已记一笔日志：注册被拒、该插件或实例因此不会运行的记 error（定义或实例 id 校验失败，含定义里有另一份 `@aalis/core` 造的对象；未声明 `reusable` 的多实例；配置无法拷贝）；重名这类只是重复请求被忽略的与其余政策挡下的记 warn；主体不存在、`disposed` 终态与停机中 debug。正常运行中 true 只说明请求已受理，不说明激活已落定——那看 `idle()`；停机完整完成信号是 `app.stop()`。

管理动作只改运行态（实例配置、禁用态），不写配置文档。要跨重启保留，调用方在动作成功后经 host-config 写文档并 `save()`，见 [运行态与配置文档](config.md)。

`idle()` 等待状态机静置（无在飞 recompute、无排队、无手动 dispose 段）。变更 API 在已有 flight 在飞时排队并立即返回。不等转入后台的激活：它落定后另触发一次重算，之后调用的 `idle()` 会等这次重算。后台激活落定失败时的回滚不在重算之内，`idle()` 不等它完成（状态已先写好）。**不得在插件 `apply` / `onDispose` 内调用**——flight 正等着你返回，互等死锁。

插件的 `apply` 与关闭回调（`onDrain` / `onDispose`）不能等待针对自身或自身用到的任何提供者（required、optional 或经 `follow` 跟随）的 `bounce` / `updateConfig` / `disable` / `unload`：这些动作的拆卸可能要等本插件的这些回调返回，回调又在等动作完成。例如在 `apply` 中 `await` 对 required 提供者的 `bounce`：这个动作要把正在用该服务的本插件并入同一批拆掉，拆卸要等 `apply` 返回；在 `onDrain` 里 `await` 卸载 optional 提供者也一样，那份计划要等本插件关完。两者至多互等到宽限（`disposeTimeoutMs`）到期（为 0 时一直等下去），本插件的旧实例停下之前不会重新激活（见上文）。

### `register(definition, config?, instanceId?, options?)`

注册并尝试激活。`config` 原样生效（core 不合并默认值、不读配置文档）；`options.disabled` 为 `true` 时以禁用态登记、不激活。手写的定义对象（没经 `definePlugin`）在这里补上同一道校验。缺 / 空 / 非法 `name`、`uses` 非描述符、非法 `instanceId`（空、危险键），以及定义里有另一份 `@aalis/core` 造的描述符或 `optional` 包装，各记一笔 error 并返回 false。配置无法拷贝（环状引用、读取抛错的 getter 或 Proxy）时同样记 error 并返回 false，不落账；`registerAll` 的其余条目照常登记。停机中立即返回 false，不落账。

### `unload(instanceId)`

正常运行中拆掉激活并从注册表移除；撞上在途卸载时 join 它，返回时该实例已离开注册表。并发首个 unload 完成后同 id 可能已重新注册，删除带恒等卫，不会按名盲删新 entry。停机中立即返回 false，不改条目，也不加入额外拆卸；等待完整停机用 `app.stop()`。

### `enable(instanceId)` / `disable(instanceId)`

正常运行中启用 / 禁用。`error` 态可经 `enable` 转 `pending` 重试。`disable` 清掉上一次激活失败留下的 `error`；停用时旧实例超过宽限仍未停下的照样转 `disabled`，带 `lingering`，见上文。停机中两个动作都立即返回 false，`enable` 不会把禁用或错误条目转回 `pending`。

### `bounce(instanceId)`

增量重载：按现有配置拆掉当前激活 → 转 `pending` → 重算后重新激活。即 **retire + 重算**。换配置走 `updateConfig`。

- 正在用本插件所提供服务的 required 下游随之重启（先收尾、先关，本插件重新激活后按拓扑序重新激活）；optional 依赖经 `follow` 在换人时交接。
- 不换代码：跑的仍是注册时的那份定义。要换代码走 `unload` + `register`。
- `disposed`、停机进行中拒绝 bounce。
- `disabled` 态拒绝（warn，返回 false）。
- `error` 态会被重置为 pending 重试。

### `updateConfig(instanceId, config)`

换上新的运行配置，再按 `bounce` 重启。入参拷贝后再挂到 entry，插件经内置 `config` 就地改嵌套不会写穿调用方的对象；拷贝失败时返回 false，保留旧配置。正常运行中 `disabled` 态只换上新配置、保持禁用，返回 true，启用时按新配置激活。停机中返回 false，不更换配置。

## 反应式监听

- `service:changed` → `recompute()`
- flight 不再等的激活（转入后台，或被接手）落定 → `recompute()`

单飞 / 挂起 / 关机的取舍都在 `recompute` 内部：在飞期间排队，关机后跳过。
