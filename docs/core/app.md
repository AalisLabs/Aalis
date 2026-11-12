# App — 应用容器

`App` 是 Aalis 的顶层容器，负责初始化核心子系统与管理插件生命周期。消息路由、指令、权限、工具等能力由插件提供。

**源码**: `packages/core/src/orchestration/app.ts`

## 构造函数

```typescript
import { App } from '@aalis/core';

const app = new App({ name: 'demo', logLevel: 'info' });
```

core 不感知"文件系统 / 进程 / 终端"等任何 I/O 概念，也不持有配置文档。插件从哪里来、配置存在哪里由宿主负责：
宿主把插件定义连同各实例的配置与禁用标记经 `app.plugin` / `app.pluginAll` 交进来；重启经注入的 `restartStrategy` 完成。
Node 宿主 `@aalis/runtime` 的做法见文末与 [运行态与配置文档](config.md)。

`AppOptions` 的字段全部可选：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 应用名，只用于启动横幅；缺省 `'Aalis'` |
| `logLevel` | `LogLevel` | 默认 Logger 的级别；缺省 `'info'`。注入了 `logger` 时不用 |
| `restartStrategy` | `RestartStrategy` | 重启策略；缺省=`restart()` 抛错 |
| `logHub` | `LogHub` | 自定义日志通道；缺省=`LogHub.default`（进程级共享）。注入了 `logger` 时不用 |
| `logger` | `Logger` | 自定义 Logger 实现；缺省=`DefaultLogger`（写入 logHub）。注入的与缺省的都由 App 包一层再用：日志方法抛错或返回被拒的 Promise 不传进 core 与插件，`child` 派生失败（抛错，或派生出的不是日志器）时沿用上一层，`app.logger` 也是包过的这层。插件管理器（作用域 `plugins`）的日志推迟一个微任务交给它，彼此先后不变：日志回调里发起的管理动作或 `stop()` 看到的是改完之后的状态；插件自己的日志不推迟。要按 App 固定日志时间戳，注入 `new DefaultLogger('aalis', level, hub, now)` |
| `devMode` | `boolean` | 传给根激活，决定 `provide` 与激活路径是否跑一致性校验；默认 `true` |
| `disposeTimeoutMs` | `number` | 单个异步清理项的等待上限（毫秒），默认 5000；也是停用、卸载、重启、停机撞上仍在初始化的插件，或后台激活的 required 依赖下线时 abort 后的宽限（见下文）。0=不设限 |
| `slowThresholdMs` | `number` | 慢操作阈值（毫秒），默认 60000：插件激活超过它仍未完成即告警、转入后台；单个就绪回调（`lifecycle.onReady`）超过它即告警、不再等待。0=不设限 |
| `version` | `string` | 启动 banner 用的内核版本；core 不自读 package.json |

两个时长上限超过 2³¹−1（定时器的最大延迟，约 24.8 天）时按 2³¹−1 计，`Infinity` 同样按它计；负数与 `NaN` 按不设限处理。

构造时：

- 初始化服务容器、logger 及根激活
- 创建 `ActivationHost`：直接登记 `provide` 的提供者来自举，再由根激活经 `provide` 独占登记其余四项基础服务
- 创建 `PluginManager`，由根激活经 `provide` 独占登记 `appService` / `pluginsService`：容器里放的只是契约列出的方法（窄面），App / PluginManager 本体不外露；`getPlugin` 交出调用时刻的浅快照，不含内部激活记录
- 打印启动横幅（`name` 与宿主注入的 `version`）

配置文档与其中的服务偏好由宿主接入，不在构造时处理：runtime 的 `installHostConfig` 在登记任何插件之前应用偏好。

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `plugins` | `PluginManagerService` | 插件管理面（与插件经 `pluginsService` 拿到的同一契约） |
| `logger` | `Logger` | 日志器 |
| `stopping` | `boolean` | 应用是否已开始停机：运行中为 false，`stop()` 一开始即 true（重启策略发起的也一样），停完之后不变 |

根激活不对外。宿主经 `bind` 取能力；插件经自己激活上的 `uses` 取能力。原语注册表不外露：宿主查询服务、看元数据经 `app.bind({ services })`，消费服务经 `app.bind({ x: descriptor })`。

## 核心方法

### `app.bind(uses)`

按与插件同一套描述符为根激活装配各项选择层，与插件拿到的同样分选择层与业务层。登记归属根激活、随 App 停止撤回。插件拿的是自己激活的绑定，不复用这里的。

```typescript
import { lifecycle, logger } from '@aalis/core';

const { logger: log, lifecycle: life } = app.bind({ logger, lifecycle });
life.use.onReady(() => log.use.info('已启动'));
```

### `app.start()`

1. 等插件状态机静置（`plugins.idle()`）
2. 跑就绪回调（`lifecycle.onReady`）：此刻已激活的插件按激活顺序逐个跑，同一激活内按登记序逐个等，宿主根排在全部插件之后

单飞：重入返回同一 Promise。停机开始后（含停机完成后）调用记一条 warn 后直接返回；启动途中停机开始，进行中的 `start()` 照常落定，还没轮到的回调不再跑。App 只有一轮生命周期，要重新跑一轮就新建 App。

单个回调至多等 `slowThresholdMs`，超过即 warn 点名（插件实例 id，宿主为 `root`），不再等它、转向下一个；抛错与拒绝只记在登记它的激活名下。`start()` 不等转入后台的插件激活：它们在自己的 `apply` 落定、激活成功后各自跑就绪回调。配置文档外部变更的热重载编排属宿主政策（runtime 的 `installConfigHotReload`），`start()` 不做。

### `app.stop()`

单飞：重入返回同一 Promise。现序：

1. 插件管理进入停机终态（内部的 beginShutdown，不在 `app.plugins` 的公开面上）：置停机态、丢弃排队的重算，把根激活与全部插件激活冻进一张计划（之后六个管理动作一律返回 false；对这些激活的 `disposeAsync` 汇入该计划）。已静置时仍须先冻闸——`idle()` 会让出一轮微任务，同轮排队的 bounce 否则会在置位前过闸、留下 pending 幽灵。冻完后，`apply` 尚未完成的插件（在飞或后台）立即收到 `lifecycle.use.signal` 的 abort
2. `plugins.idle()`：排干在飞的 bounce / unload recompute；重算不再等已 abort 的激活
3. 执行已冻的停机计划（内部的 stopAll）：逐项 drain / close，根激活也在这张计划里，返回时都已关完

清理回调与就绪回调（`lifecycle.onReady`）不能 `await app.stop()`，也不能直接返回该 Promise：停机正等待这些回调返回，二者会互等（至多等到 `disposeTimeoutMs` 后被放弃，为 0 时一直等）。需要请求停机时可以调用 `void app.stop()`；完整停机完成由外部宿主等待。

单个异步清理项的等待上限由 `AppOptions.disposeTimeoutMs` 控制，不是整个停机流程的总期限。仍在初始化的插件 abort 之后，自它的收尾段开始至多再等 `disposeTimeoutMs`，到期仍未落定就不再等待，停机继续。关闭后陆续登记进来的异步清理与撤回（清理里再登记、漏清的定时器一直往里登记），在每段收口共用这一个上限，不随新登记延长。`slowThresholdMs` 与 `disposeTimeoutMs` 都非 0 时 `stop()` 总能结束；`disposeTimeoutMs` 为 0（不设限）时，永不落定的 `apply` 或清理项仍可能让它等待不返回。边规则见 [插件定义与能力](context.md)。

### `app.plugin(definition, config?, instanceId?, options?)`

注册单个插件，返回值同 `plugins.register`（false = 重名、未声明 `reusable` 的多实例、多实例 id 不是 `name:后缀`、定义 / 实例 id 校验失败、配置无效（不是纯对象或无法拷贝）、或停机中）。`instanceId` 缺省用 `definition.name`。

- `config` 原样生效：core 不合并默认值，也不读配置文档。入参会被拷贝（纯对象与普通数组逐层拷开，危险键 `__proto__` / `constructor` / `prototype` 跳过），调用方之后改它不影响实例；`Date`、`Map`、类实例等非纯对象按引用透传，调用方与插件都不要就地改它们。默认值回填是宿主政策：runtime 的 `withPluginConfigSync` 在登记前把 schema 派生默认值深合并进文档。
- `options.disabled` 为 `true` 时以禁用态登记、不激活，之后经 `plugins.enable` 启用。core 不读禁用名单，由宿主按配置文档传入。

resolve 语义 = 登记完成 + 尽力即时激活。有在飞 recompute 或管理动作的挂起段时本次请求排队，resolve 时激活可能尚未发生。需要「激活已落定」则 `await app.plugins.idle()`（不得在插件 apply / onDispose 内）。激活超过 `slowThresholdMs` 仍未完成的插件转入后台，本方法与 `idle()` 在阈值处返回，见 [插件管理](plugin.md) 的慢激活一节。

### `app.pluginAll(items)`

批量注册。条目为 `{ definition, config?, instanceId?, disabled? }`，各字段同 `app.plugin` 的参数；返回值与 `items` 逐项对应，口径同 `app.plugin`，单项校验失败只拒该项。

整批同步登记后只重算一次：依赖方在同一次重算里按拓扑序排在它 required 服务的全部提供者之后激活，不会先挂到先登记的后备提供者上。同时就绪的插件按登记序激活。宿主的冷启动与热扫描都走这里。resolve 语义同 `app.plugin`。

### `app.restart()`

委托给注入的 `restartStrategy`：在下一个微任务里调用
`strategy.restart({ stop })`（stop / restart 时序由策略决定）。**未注入 `restartStrategy` 时抛错**，
自身不保存任何数据、也不直接 spawn 进程。

每个 App 只受理一次重启：已受理过的再调记一条 debug 后返回，策略交出的 `stop` 已开始也是（只调一次策略）；未受理过而停机已开始时抛错。策略失败（记 error）而没有停机时，App 照常运行，之后再调 `restart()` 仍只记 debug、不再受理。

## 基础指令

App 本身不注册指令。基础指令由插件提供，例如 `@aalis/plugin-commands` 提供 `/help`、`/status`、`/clear`、`/shutdown`、`/restart`，`@aalis/plugin-authority` 提供 `/authority`、`/level`、`/perm`。

| 指令 | 可见性 | 说明 |
|---|---|---|
| `/help` | public | 列出调用者能用的指令；`/help <指令>` 看用法 |
| `/status` | public | 显示系统状态（插件在跑与出错的个数、工具数、指令数） |
| `/clear [--type/-t <type>]` | restricted（risk: sensitive，等级 1） | 清空当前会话指定类型记忆 |
| `/clear all [--type/-t <type>]` | restricted | 全局清空指定类型记忆 |
| `/shutdown` | restricted | 关闭应用 |
| `/restart` | restricted | 重启应用 |
| `/authority [target]` | restricted（risk: sensitive，等级 1） | 查看自己或指定用户的权限等级与所属权限组（owner 显示 ∞） |
| `/level <target> <level>` | restricted | owner 给某外部身份设置权限等级（整数；0 默认，负数封禁；仅 owner 可用，防自授） |
| `/perm <target> [groups]` | restricted | owner 覆盖式设某外部身份所属的权限组（组名用空格隔开，不给即清空；仅 owner 可用，防自授） |

## 插件发现与配置文档（宿主，不在 core）

插件发现、配置文档与配置同步都属**宿主政策**。Node 宿主 `@aalis/runtime` 提供：

- `createPluginDiscovery(app, loader, store)`：`loadAll()` 在冷启动时发现并导入全部插件，按配置存储取各实例的配置（解析密钥引用后）与禁用标记（含配置键里的 `name:suffix` 实例），整批交给 `app.pluginAll`，返回时已静置；`rescan()` 热扫描新出现的插件，返回本次新登记的主实例名，不等静置；`registerConfiguredInstances()` 只登记配置里尚未注册的 `name:suffix` 实例，供配置热重载调用。`loaded(name)` 回以 `name` 登记的主实例是不是经本驱动登记的。`startAalis` 把 `rescan` 与 `loaded` 作为 `plugin-source` 服务独占提供在根上（契约 `@aalis/api-plugin-source`），市场与 WebUI 经 `optional(pluginSource)` 调用。
- `createConfigStore` / `installHostConfig`：配置文档与 `host-config` 服务，见 [运行态与配置文档](config.md)。
- config-sync：默认值回填、按 configSchema 裁剪未知字段、配置外部变更的热重载编排（`withPluginConfigSync` / `syncPluginDefaults` / `installConfigHotReload`，`startAalis` 默认接线；`configSync.trimUnknownFields=false` 可保留未知字段）。

core 只持有机制：各实例的运行配置与禁用态、`app.pluginAll`、`updateConfig`。不经 runtime 的嵌入式宿主需要时用这些公开 API 自行编排。
