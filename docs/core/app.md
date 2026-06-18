# App — 应用容器

`App` 是 Aalis 的顶层容器，负责初始化核心子系统、管理插件生命周期和启动消息路由。指令、权限、工具等能力由插件提供。

**源码**: `packages/core/src/app.ts`

## 构造函数

```typescript
const app = new App(options?: AppOptions);
// 推荐：
const app = createApp(options?: AppOptions);
```

`AppOptions` 全部字段可选，未提供则自动创建默认实例：

| 字段 | 类型 | 说明 |
|---|---|---|
| `configPath` | `string` | YAML 配置文件路径（默认 `aalis.config.yaml`） |
| `events` | `EventBus` | 自定义事件总线 |
| `services` | `ServiceContainer` | 自定义服务容器 |
| `hooks` | `HookRegistry` | 自定义钩子注册表 |
| `config` | `ConfigManager` | 自定义配置管理器 |

构造时：

- 加载 YAML 配置文件（缺省 `aalis.config.yaml`）
- 初始化根 Context + 所有核心子系统
- 提供 `app` 服务并管理插件加载

## 关键属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `ctx` | `Context` | 根执行上下文 |
| `plugins` | `PluginManager` | 插件管理器 |
| `logger` | `Logger` | 日志器 |
| `packagesDir` | `string` | packages 目录路径 |

## 核心方法

### `app.start()`

1. 发出 `app:starting` 事件
2. 发出 `ready` 事件（sticky）
3. 监听配置文件外部变更（provider 支持 watch 时）
4. 发出 `app:started` 事件（sticky）

### `app.stop()`

1. 保存权限数据到磁盘
2. 发出 `app:stopping` 事件
3. 按拓扑逆序 dispose 所有 active 插件（触发其 `ctx.onDispose` 回调）
4. 销毁根 Context

### `app.plugin(module, config?)`

注册单个插件。配置合并优先级：`代码传入 > YAML 配置 > defaultConfig`。

### `app.autoLoadPlugins(packagesDir?)`

扫描 `packages/` 目录，自动 `import()` 并注册所有插件包。跳过 `package.json` 中 `"aalis": { "core": true }` 的包。

### `app.installPlugin(npmPkg)` / `app.uninstallPlugin(name)`

支持从 npm 安装/卸载插件包。

### `app.restart()`

保存配置 → 发出 `restarting` 事件 → 关闭当前进程 → spawn 新进程。

## 基础指令

App 本身不注册指令。基础指令由插件提供，例如 `@aalis/plugin-commands` 提供 `/help`、`/status`、`/clear`、`/shutdown`、`/restart`，`@aalis/plugin-authority` 提供 `/grant`、`/authority`。

| 指令 | 可见性 | 说明 |
|---|---|---|
| `/help` | public | 列出所有已注册指令 |
| `/status` | public | 显示系统状态（服务可用性、工具数、指令数） |
| `/clear [--type/-t <type>]` | public | 清空当前会话指定类型记忆 |
| `/clear all [--type/-t <type>]` | restricted | 全局清空指定类型记忆 |
| `/shutdown` | restricted | 关闭应用 |
| `/restart` | restricted | 重启应用 |
| `/grant <target> <capability>` | restricted | 给用户授予一个能力（受子集约束，不可授予自己不持有的） |
| `/deny <target> <capability>` | restricted | 禁用用户一个能力 |
| `/authority [target]` | public | 查看自己或指定用户的能力授予 |
| `/bind <code>` | public | 将当前平台账号绑定到 WebUI 账户 |

## 配置同步

`App` 在加载插件时自动同步配置：
- 补填插件 `defaultConfig` 中缺失的字段
- 删除 `configSchema` 中未定义的多余字段（递归清理）——这是可注入政策，
  宿主传 `AppOptions.configSync = { trimUnknownFields: false }` 可改为保留未知字段
- 保护环境变量占位符（`${VAR}`）不被覆盖
