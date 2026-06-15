# API 包索引

`*-api` 包是 Aalis 三层包架构中的"契约层"：

```
@aalis/core              ← 平台无关的运行时（Context / 事件 / 服务注册中心）
       ↑
@aalis/plugin-<X>-api    ← 契约：服务接口、事件 payload、Context 扩展方法、可复用 runtime 工具
       ↑
@aalis/plugin-<X>        ← 实现：具体的 service 注册、handler 逻辑
```

依赖规则：
- **实现包** `import` 自己的 `-api` 包以获得类型与 capability 声明
- **消费方插件**只依赖 `-api`，不依赖实现包，运行时通过 `ctx.getService('<name>')` 取实例
- `-api` 包之间允许相互依赖（如 `plugin-tools-api` 依赖 `plugin-authority-api`）

## 包列表

| API 包 | 提供的核心契约 | 已知实现 |
|---|---|---|
| [plugin-agent-api](./plugin-agent-api.md) | `AgentService` —— 对话编排服务 | plugin-agent |
| [plugin-authority-api](./plugin-authority-api.md) | `AuthorityService` + `ExecutionGuard` —— 权限校验与执行守卫 | plugin-authority |
| [plugin-commands-api](./plugin-commands-api.md) | `CommandService` + `useCommandService(ctx)` —— 命令系统 | plugin-commands |
| [plugin-embedding-api](./plugin-embedding-api.md) | `EmbeddingService` —— 文本向量化 | plugin-embedding-openai / plugin-embedding-ollama |
| [plugin-gateway-api](./plugin-gateway-api.md) | `GatewayService` —— 消息入站编排 | plugin-gateway |
| [plugin-media-api](./plugin-media-api.md) | `MediaService` —— 多模态预处理（vision/audio/video） | plugin-media |
| [plugin-llm-api](./plugin-llm-api.md) | `LLMService` + capability 框架 | plugin-openai / plugin-ollama / plugin-deepseek 等 |
| [plugin-memory-api](./plugin-memory-api.md) | `MemoryService` —— 历史与元数据存储 | plugin-memory-inmemory / sqlite / mongodb / vector |
| [plugin-message-api](./plugin-message-api.md) | 消息数据契约（无 service） | 由各 adapter 直接 emit |
| [plugin-session-manager-api](./plugin-session-manager-api.md) | `SessionManagerService` —— 会话配置 | plugin-session-manager |
| [plugin-storage-api](./plugin-storage-api.md) | `StorageService` —— 受控文件/对象存储 + `createStorageGateway` / `getStorageRootConflicts` helper | plugin-storage-local |
| [plugin-tools-api](./plugin-tools-api.md) | `ToolService` + 共享 SSRF/路径工具 | plugin-tools |
| [plugin-vectorstore-api](./plugin-vectorstore-api.md) | `VectorStoreService` —— 向量数据库 | plugin-vectorstore-flat / plugin-vectorstore-lancedb |
| [plugin-webui-api](./plugin-webui-api.md) | `WebUIService` + 声明式页面组件 | plugin-webui-server |

## 阅读顺序

如果你在写**新插件**：
1. 先看 [plugin-storage-api](./plugin-storage-api.md) 与 [plugin-tools-api](./plugin-tools-api.md) —— 95% 插件都会用到
2. 看你要扩展的服务的 api 文档
3. 看对应 `docs/plugins/*.md` 里现有实现作为参考

如果你在做**架构改造**：
- 顶层视图见 [docs/architecture.md](../architecture.md)
- 模块边界见 [docs/design/](../design/)

## 约定

1. **服务名 = 包名去掉 `@aalis/plugin-` 前缀和 `-api` 后缀**。例：`@aalis/plugin-tools-api` 提供 `ctx.getService('tools')` 取到的 `ToolService`。
2. **capability 通过 `declare module '@aalis/core' { interface ServiceCapabilityMap }`** 注入；调用方用 `ctx.getService('storage', { capabilities: ['local-path'] })` 或 `inject.required: [{ service: 'storage', capabilities: ['local-path'] }]` 声明需求。
3. **事件通过 `declare module '@aalis/core' { interface AalisEvents }`** 注入；订阅者用 `ctx.on('event-name', ...)`，类型自动补全。
4. **领域 helper**：各契约包导出领域 helper（如 `useToolService(ctx)` / `useCommandService(ctx)`），内部封装 `ctx.getService` + `whenService` 延迟语义；调用方在 apply 阶段直接使用。Core 不再持有任何业务 Mixin。
