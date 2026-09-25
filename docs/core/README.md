# 核心（@aalis/core）

`@aalis/core` 是环境无关的插件底座，提供资源寿命、两种协作原语（事件与服务）与服务装配；运行时 JavaScript 不加载依赖包。插件从哪里来、配置文档存在哪里由宿主负责；钩子与贡献点由普通插件提供。领域功能一律由 `-api` 契约包 + 插件实现。插件拿到的是按激活绑定的能力，不是一份公开的执行上下文。

## 按顺序读

| 篇目 | 讲什么 |
|---|---|
| [App — 应用容器](./app.md) | 进程入口、`plugin` / `pluginAll` / `bind`、生命周期 |
| [插件定义与能力](./context.md) | `definePlugin`、`uses` / `provide`、基础服务、`ServiceRef`、`follow` |
| [Plugin — 插件管理](./plugin.md) | `PluginEntry`、状态机、`recompute`（`changed` \| `shutdown`）、六动作 `Promise<boolean>` 口径 |
| [Service — 服务](./service.md) | 描述符、按名仲裁、`services.prefer` |
| [Events — 事件](./events.md) | core 内置事件、屏障与通知、自定义事件 |
| [运行态与配置文档](./config.md) | core 持有的运行态；配置文档在宿主（`@aalis/runtime`、`@aalis/api-host-config`） |
| [Types — 类型](./types.md) | core 导出的类型；领域类型从 `@aalis/api-*` 取 |

## 相关

- 整体分层与包结构：[架构总览](../architecture.md)
- 服务模型的心智：[concepts/service-model.md](../concepts/service-model.md)、[concepts/lazy-service-access.md](../concepts/lazy-service-access.md)
- 钩子与贡献点：[api-hooks](../api/api-hooks.md)、[api-contributions](../api/api-contributions.md)
- 写插件：[第三方插件开发者指南](../guide/third-party-plugin.md)
