# App — 应用容器

`App` 是 Aalis 的顶层容器，负责初始化核心子系统、管理插件生命周期和启动消息路由。指令、权限、工具等能力由插件提供。

**源码**: `packages/core/src/app.ts`

## 构造函数

```typescript
const app = new App(options: AppOptions);
// 推荐：
const app = createApp(options: AppOptions);
```

core 不感知"文件系统 / 进程 / 终端"等任何 I/O 概念——core 自身不读取任何 YAML 文件。
配置由宿主从任意来源（文件/URL/远端）加载好，作为快照传进 `config`；文件读写、watch、
重启、插件发现等 I/O 全部通过 provider 注入。

`AppOptions` 中只有 `config` 是必填，其余皆可选：

| 字段 | 类型 | 说明 |
|---|---|---|
| `config` | `AalisConfig \| ConfigManager` | **必填**。配置快照（如 `{ name, logLevel, plugins }`），或已构造的 `ConfigManager` |
| `configProvider` | `ConfigProvider` | 配置持久化与外部变更监听；缺省=只读内存模式 |
| `dataDir` | `string` | 业务数据目录（plugin 用作相对路径基准） |
| `pluginLoader` | `PluginLoader` | 插件加载器；缺省=`autoLoadPlugins()` 为 no-op，须手动 `app.plugin(mod)` |
| `restartStrategy` | `RestartStrategy` | 重启策略；缺省=`restart()` 抛错 |
| `events` | `EventBus` | 自定义事件总线 |
| `services` | `ServiceContainer` | 自定义服务容器 |
| `hooks` | `HookRegistry` | 自定义钩子注册表 |
| `logHub` | `LogHub` | 自定义日志通道；缺省=`LogHub.default`（进程级共享） |
| `logger` | `Logger` | 自定义 Logger 实现；缺省=`DefaultLogger`（写入 logHub） |
| `configSync` | `{ trimUnknownFields?: boolean }` | 插件配置同步政策（默认裁剪 schema 外字段） |
| `devMode` | `boolean` | 传给根 Context，决定 `provide` 是否跑能力探测；默认 `true` |

构造时：

- 将 `config`（快照或现成 `ConfigManager`）规范为 `ConfigManager`
- 初始化 events / services / hooks / logger 及根 Context（注入或自建）
- 创建 `PluginManager`，并 `provide('app', this)` / `provide('plugins', …)`
- 应用配置中已有的服务偏好（`preferService`）

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `ctx` | `Context` | 根执行上下文 |
| `plugins` | `PluginManager` | 插件管理器 |
| `logger` | `Logger` | 日志器 |
| `events` | `EventBus` | 事件总线 |
| `services` | `ServiceContainer` | 服务容器 |
| `hooks` | `HookRegistry` | 钩子注册表 |

## 核心方法

### `app.start()`

1. 发出 `app:starting` 事件
2. 发出 `ready` 事件（sticky）
3. 监听配置外部变更（`ctx.config.watch`；provider 不支持 watch 时为 no-op）
4. 发出 `app:started` 事件（sticky）

### `app.stop()`

1. `ctx.config.unwatch()` 停止监听配置变更
2. 发出 `app:stopping` 事件
3. `plugins.stopAll()`：按拓扑逆序 dispose 所有 active 插件（消费者先关、提供者后关，触发其 `ctx.onDispose` 回调）
4. 清空 sticky 缓存（`ready` / `app:started`）
5. 销毁根 Context

### `app.plugin(module, config?, instanceId?)`

注册单个插件。`instanceId` 缺省用 `module.name`。配置合并优先级：`代码传入 > 配置文件 > defaultConfig`。

### `app.autoLoadPlugins()`

通过注入的 `pluginLoader` 自动发现并注册所有插件；未注入 loader 时为 no-op。流程：
`discover()` 发现插件 → 逐个 `load()` 并 `app.plugin(mod)` 注册 → 扫描配置中的多实例条目
（`name:suffix`，要求模块声明 `reusable`）→ `syncPluginDefaults` 同步默认配置。

### `app.rescanPlugins()`

重新扫描插件源，加载新发现的插件（已注册的跳过），返回新加载的插件名列表。优先调用
`pluginLoader.reload(desc)` 做热重载，未实现时退化为 `load(desc)`；未注入 loader 时返回 `[]`。

### `app.saveConfig()`

委托给 `configProvider` 持久化当前配置；无 provider 时静默忽略。

### `app.restart()`

委托给注入的 `restartStrategy`：清空 sticky 缓存 → 发出 `restarting` 事件 → 调用
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

## 配置同步

`App` 在 `autoLoadPlugins()` 末尾及配置热重载时调用 `ConfigManager.syncPluginDefaults` 自动同步配置：
- 深合并补填插件 `defaultConfig` 中缺失的字段（已存在的配置值不被覆盖）
- 删除 `configSchema` 中未定义的多余字段（递归清理）——这是可注入政策，
  宿主传 `AppOptions.configSync = { trimUnknownFields: false }` 可改为保留未知字段
- 仅当合并结果与原文件配置不同才写回，并经 `configProvider` 持久化
