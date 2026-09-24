# App — 应用容器

`App` 是 Aalis 的顶层容器，负责初始化核心子系统、管理插件生命周期和启动消息路由。指令、权限、工具等能力由插件提供。

**源码**: `packages/core/src/orchestration/app.ts`

## 构造函数

```typescript
import { App, createApp } from '@aalis/core';

const options = { config: { name: 'demo', logLevel: 'info', plugins: {} } };
const app = new App(options);
const app2 = createApp(options);
```

core 不感知"文件系统 / 进程 / 终端"等任何 I/O 概念——core 自身不读取任何 YAML 文件。
配置由宿主从任意来源（文件/URL/远端）加载好，作为快照传进 `config`；文件读写、watch、
重启、插件发现等 I/O 全部通过 provider 注入。

`AppOptions` 中只有 `config` 是必填，其余皆可选：

| 字段 | 类型 | 说明 |
|---|---|---|
| `config` | `AalisConfig \| ConfigManager` | **必填**。配置快照（如 `{ name, logLevel, plugins }`），或已构造的 `ConfigManager` |
| `configProvider` | `ConfigProvider` | 配置持久化与外部变更监听；缺省=只读内存模式 |
| `pluginLoader` | `PluginLoader` | 插件加载器；缺省=`autoLoadPlugins()` 为 no-op，须手动 `app.plugin(definition)` |
| `pluginDefaults` | `(definition) => Record<string, unknown>` | 插件默认配置的派生器；缺省=无默认值。core 不解释 `configSchema`，由宿主注入（runtime 用 `defaultsFrom(d.configSchema)`） |
| `restartStrategy` | `RestartStrategy` | 重启策略；缺省=`restart()` 抛错 |
| `events` | `EventBus` | 自定义事件总线 |
| `services` | `ServiceContainer` | 自定义服务容器 |
| `hooks` | `HookRegistry` | 自定义钩子注册表 |
| `contributions` | `ContributionRegistry` | 自定义贡献点注册表 |
| `logHub` | `LogHub` | 自定义日志通道；缺省=`LogHub.default`（进程级共享） |
| `logger` | `Logger` | 自定义 Logger 实现；缺省=`DefaultLogger`（写入 logHub） |
| `devMode` | `boolean` | 传给根激活，决定 `provide` 与激活路径是否跑一致性校验；默认 `true` |
| `disposeTimeoutMs` | `number` | 单个异步清理项的等待上限（毫秒），默认 5000；0=不设限 |
| `now` | `() => Date` | 日志时间戳时钟；缺省墙上时间 |
| `version` | `string` | 启动 banner 用的内核版本；core 不自读 package.json |

构造时：

- 将 `config`（快照或现成 `ConfigManager`）规范为 `ConfigManager`
- 初始化 events / services / hooks / contributions / logger 及根激活（注入或自建）
- 创建 `ActivationHost`：直接登记 `provide` 的提供者来自举，再由根激活经 `provide` 独占登记其余七项基础服务
- 创建 `PluginManager`，由根激活经 `provide` 独占登记 `appService` / `pluginsService` / `hostConfig`：容器里放的只是契约列出的方法（窄面），App / PluginManager / ConfigManager 本体不外露；经 `pluginsService` 拿到的 `getPlugin` 是不含内部激活记录的快照
- 应用配置中已有的服务偏好

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `plugins` | `PluginManager` | 插件管理器 |
| `config` | `ConfigManager` | 整份配置的读写、落盘与外部变更监听（插件侧经 `hostConfig` 拿到的是只含读写方法的窄面 `HostConfig`，落盘走 `appService.saveConfig`） |
| `logger` | `Logger` | 日志器 |
| `events` | `EventBus` | 事件总线 |
| `services` | `ServiceContainer` | 服务容器 |
| `hooks` | `HookRegistry` | 钩子注册表 |
| `contributions` | `ContributionRegistry` | 贡献点注册表 |

根激活不对外。宿主经 `bind` 取能力；插件经自己激活上的 `uses` 取能力。`app.services.get/getAll` 返回登记进容器的对象本身；内置八项登记的是提供者函数，宿主要用其接口经 `app.bind`。查看元数据用 `app.services.inspect`。

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

每一步都等前一个事件的监听器全部返回后才推进。配置外部变更的热重载编排属宿主政策，由宿主自行 `app.config.watch(cb)` 接管，`start()` 不做。

### `app.stop()`

单飞：重入返回同一 Promise。现序：

1. `config.unwatch()` 停止监听配置变更
2. `plugins.beginShutdown()`：置停机态并冻计划（之后 `register` / `bounce` 拒绝；对本树的 `disposeAsync` 汇入该计划）。已静置时仍须先冻闸——`idle()` 会让出一轮微任务，同轮排队的 bounce 否则会在置位前过闸、留下 pending 幽灵
3. `plugins.idle()`：排干在飞的 bounce / unload recompute
4. 发出 `app:stopping`（知会用；清理一律走 `lifecycle.onDrain` / `onDispose`）。监听器全部返回后才继续。期间再次调用 `stop()` 仍返回完整停机的同一 Promise，不提前兑现
5. 再 `plugins.idle()`
6. `plugins.stopAll()`：执行已冻计划的 drain / close
7. 清空 sticky 缓存（`app:ready` / `app:started`）
8. `disposeAsync` 根激活（等待异步清理）

监听器与清理回调不能 `await app.stop()`，也不能直接返回该 Promise：停机正等待这些回调返回，二者会互等。需要请求停机时可以调用 `void app.stop()`；完整停机完成由外部宿主等待。

单个异步清理项的等待上限由 `AppOptions.disposeTimeoutMs` 控制，不是整个停机流程的总期限。本次没有为 `apply` 或屏障监听器新增超时；它们永不落定时，`register()` / `stop()` 仍可能等待不返回。边规则见 [插件定义与能力](context.md)。

### `app.plugin(definition, config?, instanceId?)`

注册单个插件，返回值同 `plugins.register`（false = 重名、未声明 `reusable` 的多实例、定义 / 实例 id 校验失败、或停机中）。`instanceId` 缺省用 `definition.name`。配置合并优先级：`代码传入 > 配置文件 > 宿主派生默认值`。三层是**逐层深合并**：同一路径上双方都是纯对象则递归合并，否则后者整体覆盖；数组与非纯对象是原子值。危险键（`__proto__` / `constructor` / `prototype`）跳过。全程返回新对象、不改写入参。

resolve 语义 = 注册落账 + 尽力即时激活。有在飞 recompute 或手动 dispose 段时本次请求排队，resolve 时激活可能尚未发生。需要「激活已落定」则 `await app.plugins.idle()`（不得在插件 apply / onDispose 内）。

### `app.autoLoadPlugins()`

通过注入的 `pluginLoader` 自动发现并注册所有插件；未注入 loader 时为 no-op。流程：
`discover()` 发现插件 → 逐个 `load()` 并 `app.plugin(mod)` 注册 → 扫描配置中的多实例条目
（`name:suffix`，要求模块声明 `reusable`）。返回前 `await plugins.idle()`。

### `app.rescanPlugins()`

重新扫描插件源，加载新发现的插件（已注册的跳过），返回新加载的插件名列表。与
`autoLoadPlugins` 共用配置键里的 `name:suffix` 多实例登记。优先调用
`pluginLoader.reload(desc)` 做热重载，未实现时退化为 `load(desc)`；未注入 loader 时返回 `[]`。
刻意不等静置（HTTP 热路径）。返回值只含新发现的主描述符名，不含 `:suffix`。

### `app.saveConfig()`

委托给 `configProvider` 持久化当前配置，返回 `Promise<void>`：Promise 兑现时保存已完成，provider 失败以拒绝传出，调用方应 `await`；无 provider 时立即完成。并发保存的先后与外部编辑的合并不在此契约内。

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

## 配置同步（宿主政策，不在 core）

默认值回填、按 configSchema 裁剪未知字段、配置外部变更的热重载编排均属**宿主政策**，
由 `@aalis/runtime` 的 config-sync 模块提供（`syncPluginDefaults` / `installConfigHotReload`，
`startAalis` 默认接线；`configSync.trimUnknownFields=false` 可保留未知字段）。
core 只持有机制：配置快照 get/set、`config.watch` 透传、`updateConfig`。
不经 runtime 的嵌入式宿主需要时用这些公开 API 自行编排。
