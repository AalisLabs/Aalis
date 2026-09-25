# App — 应用容器

`App` 是 Aalis 的顶层容器，负责初始化核心子系统与管理插件生命周期。消息路由、指令、权限、工具等能力由插件提供。

**源码**: `packages/core/src/orchestration/app.ts`

## 构造函数

```typescript
import { App, createApp } from '@aalis/core';

const app = new App({ name: 'demo', logLevel: 'info' });
const app2 = createApp({ name: 'demo' });
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
| `logHub` | `LogHub` | 自定义日志通道；缺省=`LogHub.default`（进程级共享） |
| `logger` | `Logger` | 自定义 Logger 实现；缺省=`DefaultLogger`（写入 logHub） |
| `devMode` | `boolean` | 传给根激活，决定 `provide` 与激活路径是否跑一致性校验；默认 `true` |
| `disposeTimeoutMs` | `number` | 单个异步清理项的等待上限（毫秒），默认 5000；0=不设限 |
| `now` | `() => Date` | 日志时间戳时钟；缺省墙上时间 |
| `version` | `string` | 启动 banner 用的内核版本；core 不自读 package.json |

构造时：

- 初始化事件总线、服务容器、logger 及根激活
- 创建 `ActivationHost`：直接登记 `provide` 的提供者来自举，再由根激活经 `provide` 独占登记其余五项基础服务
- 创建 `PluginManager`，由根激活经 `provide` 独占登记 `appService` / `pluginsService`：容器里放的只是契约列出的方法（窄面），App / PluginManager 本体不外露；经 `pluginsService` 拿到的 `getPlugin` 是不含内部激活记录的快照
- 打印启动横幅（`name` 与宿主注入的 `version`）

配置文档与其中的服务偏好由宿主接入，不在构造时处理：runtime 的 `installHostConfig` 在登记任何插件之前应用偏好。

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `plugins` | `PluginManagerService` | 插件管理面（与插件经 `pluginsService` 拿到的同一契约） |
| `logger` | `Logger` | 日志器 |

根激活不对外。宿主经 `bind` 取能力；插件经自己激活上的 `uses` 取能力。原语注册表不外露：宿主查询服务、看元数据经 `app.bind({ services })`，消费服务经 `app.bind({ x: descriptor })`。

## 核心方法

### `app.bind(uses)`

按与插件同一套描述符为根激活装配绑定接口。登记归属根激活、随 App 停止撤回。插件拿的是自己激活的绑定，不复用这里的。

```typescript
import { logger, events } from '@aalis/core';

const { logger: log, events: bus } = app.bind({ logger, events });
```

### `app.start()`

1. 发出 `app:starting` 事件
2. 发出 `app:ready` 事件（sticky）
3. 发出 `app:started` 事件（sticky）

每一步都等前一个事件的监听器全部返回后才推进。配置文档外部变更的热重载编排属宿主政策（runtime 的 `installConfigHotReload`），`start()` 不做。

### `app.stop()`

单飞：重入返回同一 Promise。现序：

1. `plugins.beginShutdown()`：置停机态并冻计划（之后 `register` / `bounce` 拒绝；对本树的 `disposeAsync` 汇入该计划）。已静置时仍须先冻闸——`idle()` 会让出一轮微任务，同轮排队的 bounce 否则会在置位前过闸、留下 pending 幽灵
2. `plugins.idle()`：排干在飞的 bounce / unload recompute
3. 发出 `app:stopping`（知会用；清理一律走 `lifecycle.onDrain` / `onDispose`）。监听器全部返回后才继续。期间再次调用 `stop()` 仍返回完整停机的同一 Promise，不提前兑现
4. 再 `plugins.idle()`
5. `plugins.stopAll()`：执行已冻计划的 drain / close
6. 清空 sticky 缓存（`app:ready` / `app:started`）
7. `disposeAsync` 根激活（等待异步清理）

监听器与清理回调不能 `await app.stop()`，也不能直接返回该 Promise：停机正等待这些回调返回，二者会互等。需要请求停机时可以调用 `void app.stop()`；完整停机完成由外部宿主等待。

单个异步清理项的等待上限由 `AppOptions.disposeTimeoutMs` 控制，不是整个停机流程的总期限。本次没有为 `apply` 或屏障监听器新增超时；它们永不落定时，`register()` / `stop()` 仍可能等待不返回。边规则见 [插件定义与能力](context.md)。

### `app.plugin(definition, config?, instanceId?, options?)`

注册单个插件，返回值同 `plugins.register`（false = 重名、未声明 `reusable` 的多实例、定义 / 实例 id 校验失败、或停机中）。`instanceId` 缺省用 `definition.name`。

- `config` 原样生效：core 不合并默认值，也不读配置文档。入参会被拷贝（危险键 `__proto__` / `constructor` / `prototype` 跳过），调用方之后改它不影响实例。默认值回填是宿主政策：runtime 的 `withPluginConfigSync` 在登记前把 schema 派生默认值深合并进文档。
- `options.disabled` 为 `true` 时以禁用态登记、不激活，之后经 `plugins.enable` 启用。core 不读禁用名单，由宿主按配置文档传入。

resolve 语义 = 注册落账 + 尽力即时激活。有在飞 recompute 或手动 dispose 段时本次请求排队，resolve 时激活可能尚未发生。需要「激活已落定」则 `await app.plugins.idle()`（不得在插件 apply / onDispose 内）。

### `app.pluginAll(items)`

批量注册。条目为 `{ definition, config?, instanceId?, disabled? }`，各字段同 `app.plugin` 的参数；返回值与 `items` 逐项对应，口径同 `app.plugin`，单项校验失败只拒该项。

整批同步落账后只重算一次：依赖方在同一次重算里按拓扑序排在它 required 服务的全部提供者之后激活，不会先挂到先登记的后备提供者上。同时就绪的插件按登记序激活。宿主的冷启动与热扫描都走这里。resolve 语义同 `app.plugin`。

### `app.restart()`

委托给注入的 `restartStrategy`：清空 sticky 缓存 → 发出 `app:restarting` 事件 → 调用
`strategy.restart({ stop })`（stop / restart 时序由策略决定）。**未注入 `restartStrategy` 时抛错**，
自身不保存任何数据、也不直接 spawn 进程。

## 基础指令

App 本身不注册指令。基础指令由插件提供，例如 `@aalis/plugin-commands` 提供 `/help`、`/status`、`/clear`、`/shutdown`、`/restart`，`@aalis/plugin-authority` 提供 `/authority`、`/level`、`/auto`。

| 指令 | 可见性 | 说明 |
|---|---|---|
| `/help` | public | 列出所有已注册指令 |
| `/status` | public | 显示系统状态（服务可用性、工具数、指令数） |
| `/clear [--type/-t <type>]` | public | 清空当前会话指定类型记忆 |
| `/clear list` | public | 列出可清理的记忆类型 |
| `/clear all [--type/-t <type>]` | restricted | 全局清空指定类型记忆 |
| `/shutdown` | restricted | 关闭应用 |
| `/restart` | restricted | 重启应用 |
| `/authority [target]` | public | 查看自己或指定用户的权限等级（owner 显示 ∞） |
| `/level <target> <level>` | restricted | owner 给某外部身份设置权限等级（整数；0 默认，负数封禁；仅 owner 可用，防自授） |
| `/auto [<分钟>\|on\|off]` | restricted | owner 临时免 dangerous 二次确认（仅 owner 本人） |

## 插件发现与配置文档（宿主，不在 core）

插件发现、配置文档与配置同步都属**宿主政策**。Node 宿主 `@aalis/runtime` 提供：

- `createPluginDiscovery(app, loader, doc)`：`loadAll()` 在冷启动时发现并导入全部插件，按文档取各实例的配置与禁用标记（含配置键里的 `name:suffix` 实例），整批交给 `app.pluginAll`，返回时已静置；`rescan()` 热扫描新出现的插件，返回本次新登记的主实例名，不等静置。`startAalis` 把 `rescan` 作为 `plugin-source` 服务独占提供在根上（契约 `@aalis/api-plugin-source`），市场与 WebUI 经 `optional(pluginSource)` 调用。
- `createConfigStore` / `installHostConfig`：配置文档与 `host-config` 服务，见 [运行态与配置文档](config.md)。
- config-sync：默认值回填、按 configSchema 裁剪未知字段、配置外部变更的热重载编排（`withPluginConfigSync` / `syncPluginDefaults` / `installConfigHotReload`，`startAalis` 默认接线；`configSync.trimUnknownFields=false` 可保留未知字段）。

core 只持有机制：各实例的运行配置与禁用态、`app.pluginAll`、`updateConfig`。不经 runtime 的嵌入式宿主需要时用这些公开 API 自行编排。
