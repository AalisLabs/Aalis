# 核心（@aalis/core）

`@aalis/core` 是 Aalis 的极简内核：**零运行时依赖、环境无关**，只提供插件系统与四个原语，领域功能一律由 `-api` 契约包 + 插件实现。

## 按顺序读

| 篇目 | 讲什么 |
|---|---|
| [App — 应用容器](./app.md) | 进程入口、生命周期、插件加载与 `rescanPlugins` |
| [Context — 插件上下文](./context.md) | 插件拿到的那个 `ctx`：id、fork、dispose |
| [Plugin — 插件模型](./plugin.md) | 插件形状、状态机（pending/active/disabled/error）、启停判据 |
| [Service — 服务](./service.md) | provide / getService / 选优 / per-entry 多实例 |
| [Events — 事件](./events.md) | 事件与中间件（洋葱模型）、钩子相位 |
| [Contributions — 贡献点](./contributions.md) | 第四原语：无执行注册表，contribute / collect |
| [Config — 配置](./config.md) | 配置读取、`disabledPlugins`、schema 默认值同步 |
| [Types — 类型](./types.md) | core 导出的类型，以及哪些类型该从 `@aalis/api-*` 取 |

## 相关

- 整体分层与包结构：[架构总览](../architecture.md)
- 服务模型的心智（为什么不能缓存服务引用）：[concepts/service-model.md](../concepts/service-model.md)、[concepts/lazy-service-access.md](../concepts/lazy-service-access.md)
- 写插件：[第三方插件开发者指南](../guide/third-party-plugin.md)
