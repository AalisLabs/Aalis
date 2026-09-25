# API 包索引

`@aalis/api-*` 包是 Aalis 三层包架构中的契约层：

```
@aalis/core              ← 平台无关的运行时（服务描述符、内置能力、插件定义、编排）
       ↑
@aalis/api-<X>           ← 契约：服务接口、运行时描述符、事件/钩子/贡献点声明、领域 helper
       ↑
@aalis/plugin-<X>        ← 实现：provide(描述符, 实现) 与业务逻辑
```

依赖规则：

- **实现包**值导入自己的 `-api` 包，拿到描述符与类型
- **消费方插件**只依赖 `-api`，不依赖实现包；在 `definePlugin` 的 `uses` 里声明描述符，`apply(caps)` 里经绑定接口取用
- 描述符是**运行时值**，必须进 `dependencies`，不能只放 `devDependencies` / `import type`
- `-api` 包之间允许相互依赖（如 `api-tools` 依赖 `api-authority`）

## 包列表

| API 包 | 提供的核心契约 | 已知实现 |
|---|---|---|
| [api-agent](./api-agent.md) | `agent` 描述符 + `BoundAgent`（`registerPreprocessor`） | plugin-agent |
| [api-authority](./api-authority.md) | `authority` 描述符 + `ExecutionGuard` | plugin-authority |
| [api-commands](./api-commands.md) | `commands` 描述符 + `BoundCommands`（`command` builder） | plugin-commands |
| [api-contributions](./api-contributions.md) | `contributions` 描述符 + `Contributions`（`contribute` / `collect`）+ 扩展点 `ContributionPointMap` | plugin-contributions |
| [api-embedding](./api-embedding.md) | `embedding` 描述符 | plugin-embedding-openai / plugin-embedding-ollama |
| [api-gateway](./api-gateway.md) | `gateway` 描述符 | plugin-gateway |
| [api-hooks](./api-hooks.md) | `hooks` 描述符 + `Hooks`（`middleware` / `run`）+ 扩展点 `HookContextMap` | plugin-hooks |
| [api-host-config](./api-host-config.md) | `hostConfig` 描述符（服务名 `host-config`）+ `HostConfig` + 配置文档类型 `AalisConfig` | 宿主提供（`@aalis/runtime`） |
| [api-media](../services/media.md) | `media` 描述符 | plugin-media |
| [api-llm](./api-llm.md) | `llm` 描述符（per-model handle）+ `listLLMModels` / `resolveLLMModel` | plugin-llm-openai / plugin-llm-ollama / plugin-llm-deepseek 等 |
| [api-memory](./api-memory.md) | `memory` 描述符 | plugin-memory-inmemory / sqlite / mongodb / vector |
| [api-plugin-source](./api-plugin-source.md) | `pluginSource` 描述符（服务名 `plugin-source`）+ 插件入口判定 `pluginDefinitionOf` | 宿主提供（`@aalis/runtime`） |
| [schema-message](./schema-message.md) | 消息数据契约（无 service） | 由各 adapter 直接 emit |
| [api-session-manager](./api-session-manager.md) | `sessionManager` 描述符 | plugin-session-manager |
| [api-storage](./api-storage.md) | `storage` 描述符 + `createStorageGateway` 等 helper（第一参吃 `ServiceRef`） | plugin-storage-local |
| [api-tools](./api-tools.md) | `tools` 描述符 + `BoundTools` / `withToolGroups` | plugin-tools |
| [api-vectorstore](./api-vectorstore.md) | `vectorstore` 描述符 | plugin-vectorstore-flat / plugin-vectorstore-lancedb |
| [api-webui](./api-webui.md) | `webuiServer` / `webuiClient` 描述符 + `BoundWebui`（`registerPage` / `registerAction`） | plugin-webui-server |

## 阅读顺序

如果你在写**新插件**：

1. 先看 [api-storage](./api-storage.md) 与 [api-tools](./api-tools.md) —— 多数插件会用到
2. 看你要扩展的服务的 api 文档
3. 看对应 `docs/plugins/*.md` 里现有实现作为参考

如果你在做**架构改造**：

- 顶层视图见 [docs/architecture.md](../architecture.md)
- 模块边界见 [docs/design/api-packages](../design/api-packages)

## 约定

1. **服务身份是描述符的 `name`**。例：`@aalis/api-tools` 导出 `tools`，`name` 为 `'tools'`。消费方 `uses: { tools }`，调用型接口是 `ServiceRef`（`current` / `require()` / `all()` / `follow()`）；登记型能力另有绑定门面（如 `tools.register`、`webui.registerAction`）。
2. **按名仲裁**：同名多实现按「偏好 > 优先级 > 注册顺序」选胜者，可经 `services.prefer` 或 WebUI 服务页调整。领域能力（storage 的 `local-path`、LLM 的 vision / tool-calling）挂在**服务实例 / model-handle 的元数据**上，由各领域 helper 过滤（如 `resolveLLMModel(llm, ref, ['vision'])`、storage gateway 的 `resolveLocalPath`），不经 core DI、也不用按能力选服务。
3. **事件**通过 `declare module '@aalis/core' { interface AalisEvents }` 注入；订阅者在 `uses` 里声明 `events`，用 `events.on` / `events.emit`。
4. **钩子与贡献点**的键分别经 `declare module '@aalis/api-hooks' { interface HookContextMap }` 与 `declare module '@aalis/api-contributions' { interface ContributionPointMap }` 注入。使用方在 `uses` 里声明 `hooks` / `contributions`（描述符分别从这两个契约包导入），服务由 `@aalis/plugin-hooks` / `@aalis/plugin-contributions` 提供，core 不内置。
5. **绑定门面 vs 动态查询**：登记（工具、指令、页面、预处理器）走描述符自带的绑定门面，归属这次激活、提供者换人自动重挂。只读当前胜者用 `x.current`（每次读取重新解析）。动态按名查询走 `services.get`，**不产生依赖边**，关停期可能拿空。把 `x.current` 或 `x.all()[i]` 存进字段后，关停边不保护这份缓存引用：提供者有失效逻辑则抛，无则静默成功。
