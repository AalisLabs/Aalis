# 第三方插件开发者指南

> 目标读者：希望为 Aalis 编写并发布独立 npm 包的开发者。本文示范从零到发布的最短路径。

## 1. 包的形状

一个 Aalis 插件 = 一个 npm 包，导出一个 `PluginModule`：

```ts
// src/index.ts
import type { Context, PluginModule } from '@aalis/core';

export const name = '@your-scope/plugin-hello';

export default {
  name,
  apply(ctx: Context, _config: Record<string, unknown>) {
    ctx.logger.info('hello from third-party plugin');
  },
} satisfies PluginModule;
```

最小 `package.json`：

```json
{
  "name": "@your-scope/plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "peerDependencies": {
    "@aalis/core": "*"
  }
}
```

> `@aalis/core` 用 **peerDependency** 引用，避免多版本冲突。

## 2. 声明 / 消费服务

### 2.1 仅消费（依赖现成服务）

```ts
import type { Context, PluginModule, LLMService } from '@aalis/llm-api';

export default {
  name: '@your-scope/plugin-x',
  apply(ctx: Context) {
    ctx.whenService<LLMService>('llm', llm => {
      // provider 就绪时同步调用；provider bounce 后自动重新调用一次。
      // 可选返回清理函数：会在 provider 下线或 ctx dispose 时执行。
      // llm.chat(...)
    });
  },
} satisfies PluginModule;
```

`*-api` 包仅导出 `type` 与 `*Capabilities`，运行时零体积，**任何插件都可以放心 import**。

### 2.2 自己 provide 一个服务

```ts
import type { Context, PluginModule } from '@aalis/core';
import { LLMCapabilities } from '@aalis/llm-api';
import type { LLMService } from '@aalis/llm-api';

class MyLLM implements LLMService { /* ... */ }

export default {
  name: '@your-scope/plugin-my-llm',
  apply(ctx: Context) {
    ctx.provide('llm', new MyLLM(), {
      capabilities: [LLMCapabilities.Chat, LLMCapabilities.Streaming],
      priority: 50,
      label: 'my-llm',
    });
  },
} satisfies PluginModule;
```

#### `capabilities` 类型安全

`*-api` 包通过 `declare module './capabilities.js'` 扩展了核心的 `ServiceCapabilityMap`：

```ts
declare module '@aalis/core/types/capabilities' {
  interface ServiceCapabilityMap {
    llm: 'chat' | 'streaming' | 'vision' | 'tool_calling';
  }
}
```

在 `ctx.provide('llm', …, { capabilities: ['chaat'] })` 处拼错会**编译期**报错。

#### 推荐 `priority` 带

| 范围 | 用途 |
|-------|------|
| `0`（默认） | 普通真实提供者（plugin-openai / plugin-deepseek …） |
| `10–50` | 用户希望覆盖默认的次级提供者（`Override`） |
| `200` | `System`；仅供 core 与系统级别使用 |

> Router 层已废除。上层跨 entry 调度请使用 `getAllServices(name, requiredCaps?)` 与各 *-api 提供的纯函数 helper（`resolveLLMModel` / `createStorageGateway` / `resolvePlatformBySession` 等）。

> 在同一服务名下，`getService(name)` 默认返回 ServicePreference > priority > 注册顺序脒首的那个；`getAllServices(name, caps?)` 返回全部并同顺序排序。

### 2.3 多提供者：per-entry 注册

需要在一个服务名下暴露多个实例（如多 root storage、多平台适配、多模型 LLM）时，**在同一个 apply() 里多次调用 `ctx.provide`**，每个 entry 携带真实的 capabilities：

```ts
for (const root of roots) {
  ctx.provide('storage', new ScopedStorageService(root, ...), {
    entryId: `${ctx.id}/${root.name}`,
    capabilities: ['list', 'read', 'write', 'delete', 'local-path'],
    label: root.label,
  });
}
```

上层需要跨实例路由时，调用各 *-api 中的 helper。禁止再注册同名 facade entry。

## 3. 配置 schema

```ts
import { defineSchema } from '@aalis/core';

export const configSchema = defineSchema({
  apiKey: { type: 'string', required: true, secret: true, label: 'API Key' },
  baseUrl: { type: 'string', default: 'https://api.example.com' },
});

export const defaultConfig = { baseUrl: 'https://api.example.com' };

export default {
  name: '@your-scope/plugin-x',
  configSchema,
  defaultConfig,
  apply(ctx, config) { /* config 已按 schema 校验+合并默认 */ },
} satisfies PluginModule;
```

WebUI 会自动根据 schema 渲染配置表单。

## 4. 生命周期与 disposable

`provide()` 返回 dispose；`ctx.on('xxx', handler)` 也返回 dispose。Context 在插件 unload / disable 时自动调用所有 disposable，**插件本身无需手动清理**。需要做副作用清理（关闭 socket、清空 interval）时：

```ts
apply(ctx) {
  const timer = setInterval(work, 1000);
  ctx.onDispose(() => clearInterval(timer));
}
```

## 5. 工具 / 命令 / WebUI 扩展点

| 想做的事 | 用什么 |
|----------|--------|
| 注册 AI 可调用的工具 | `useToolService(ctx).register(...)`（来自 `@aalis/plugin-tools-api`） |
| 注册斜杠命令 | `useCommandService(ctx).command(...)`（来自 `@aalis/plugin-commands-api`） |
| 自定义 WebUI 页面 | `useWebuiService(ctx).registerPage(...)`（来自 `@aalis/plugin-webui-api`） |
| 注册 agent 输入预处理器 | `useAgent(ctx).registerPreprocessor(...)`（来自 `@aalis/plugin-agent-api`） |
| 监听核心事件 | `ctx.on('service:registered', …)` 等 |

helper 内部已封装 `whenService` 延迟语义：即使在 `apply()` 阶段调用 `register` /
`command`，若对应服务尚未 provide，注册操作会被自动延迟到服务就绪。插件加载采用单遍式，无需关心依赖顺序。

## 5.1 类型从哪里 import

`@aalis/core` 只导出**通用 IoC 类型**（Context / PluginModule / Service / Schema / 事件
扩展点 / 能力扩展点 / Dispose / Middleware / Logger 等）。所有 **LLM/agent 领域类型**都在
`@aalis/plugin-*-api` 里。

最常用的对照：

| 你想 import 的类型 | 真正归属包 | 是否需要进 `dependencies` |
|---|---|---|
| `Context` / `PluginModule` / `ConfigSchema` / `SchemaField` | `@aalis/core` | peerDep |
| `Message` / `ContentSegment` / `IncomingMessage` / `OutgoingMessage` | `@aalis/plugin-message-api` | 是 |
| `ToolCall` / `ToolDefinition` / `ToolFunction` / `ToolCallContext` / `RegisteredTool` | `@aalis/plugin-tools-api` | 是 |
| `ChatRequest` / `ChatResponse` / `LLMService` | `@aalis/plugin-llm-api` | 是 |
| `MemoryService` | `@aalis/plugin-memory-api` | 是 |
| `AgentService` / `PreprocessorFn` | `@aalis/plugin-agent-api` | 是 |
| `StorageService` | `@aalis/plugin-storage-api` | 是 |
| `EmbeddingService` | `@aalis/plugin-embedding-api` | 是 |
| `VectorStoreService` | `@aalis/plugin-vectorstore-api` | 是 |
| `IncomingMessage`/`OutgoingMessage` 事件 / `tool:execute` 事件 | 同对应 *-api（包须出现在 `dependencies` 里 TS 才能看到 `declare module` 注入） | 是 |

> **常见错误**：以为工具/命令注册 API 来自 core。它们由
> `@aalis/plugin-tools-api` / `@aalis/plugin-commands-api` 导出
> （`useToolService` / `useCommandService`），**必须**把这些契约包放进自己的
> `dependencies`（或 `peerDependencies`），TS 才能正确解析类型。

全部扩展点（事件 / 钩子 / 能力 / 配置字段 / Context Mixin）的归属表见
[docs/extensions/index.md](../extensions/index.md)。

## 6. 发布

```bash
npm publish --access public
```

用户安装：

```bash
pnpm add @your-scope/plugin-hello
```

然后在 `aalis.config.yaml` 中启用：

```yaml
plugins:
  "@your-scope/plugin-hello": {}
```

或在 WebUI 的「插件市场」里点击安装。

## 7. 参考实现

| 类型 | 参考包 |
|------|--------|
| 单一服务提供者 | `plugin-openai`, `plugin-deepseek` |
| 多 entry 注册 | `plugin-storage-local`（每 root）、`plugin-ollama`（每 model） |
| 跨 entry helper | `plugin-storage-api` (`createStorageGateway`)、`plugin-platform-api` (`resolvePlatformBySession`) |
| 工具注入 | `plugin-tool-search`, `plugin-tool-browser` |
| 命令注入 | `plugin-commands` |
| WebUI 扩展 | `plugin-webui-server`, `plugin-todo-list` |

## 8. 进一步阅读

- [架构总览](../architecture.md)
- [api 包设计](../design/api-packages.md)
