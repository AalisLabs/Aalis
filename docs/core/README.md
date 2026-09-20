# 核心（@aalis/core）

`@aalis/core` 是 Aalis 的极简内核：**零运行时依赖、环境无关**，只提供插件系统与四个原语。领域功能一律由 `-api` 契约包 + 插件实现。插件拿到的是按激活绑定的能力，不是一份公开的执行上下文。

## 按顺序读

| 篇目 | 讲什么 |
|---|---|
| [App — 应用容器](./app.md) | 进程入口、`plugin` / `bind`、生命周期 |
| [插件定义与能力](./context.md) | `definePlugin`、`uses` / `provide`、内置能力、`ServiceRef`、`follow`、`lifecycle.module` |
| [Plugin — 插件管理](./plugin.md) | `PluginEntry`、状态机、`recompute`（`changed` \| `shutdown`）、六动作 `Promise<boolean>` 口径 |
| [Service — 服务](./service.md) | 描述符、按名仲裁、`services.prefer` |
| [Events — 事件](./events.md) | 事件与中间件（洋葱模型）、钩子相位 |
| [Contributions — 贡献点](./contributions.md) | 第四原语：无执行注册表，contribute / collect |
| [Config — 配置](./config.md) | 配置读取、`disabledPlugins`、schema 默认值同步 |
| [Types — 类型](./types.md) | core 导出的类型；领域类型从 `@aalis/api-*` 取 |

## 相关

- 整体分层与包结构：[架构总览](../architecture.md)
- 服务模型的心智：[concepts/service-model.md](../concepts/service-model.md)、[concepts/lazy-service-access.md](../concepts/lazy-service-access.md)
- 写插件：[第三方插件开发者指南](../guide/third-party-plugin.md)
