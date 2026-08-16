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

> 具名导出与 `export default` 两种形态都能被加载（default 会被加载器自动解包）。

最小 `package.json`：

```json
{
  "name": "@your-scope/plugin-hello",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "keywords": ["aalis-plugin"],
  "peerDependencies": {
    "@aalis/core": ">=0.2.0 <1.0.0"
  }
}
```

> `keywords` 里的 `"aalis-plugin"` 是**加载硬门**而非检索装饰：加载器只认它，漏写则插件
> 装上后永远不会被发现（启动日志会有"疑似插件缺关键词"提示，但不会加载）；`files` 须含
> 构建产物，否则入口解析失败同样不加载。
>
> `@aalis/core` 用 **peerDependency** 引用，避免多版本冲突。范围用 **`>=0.2.0 <1.0.0`**：
> 这区间接受任何 0.x 宿主 core，插件不必随 core 次版本升级而重发。**但 1.0 之前 core 的公开面
> 可能在次版本被删**（0.7.0 / 0.9.0 都删过），用了新 API 就把下限抬到对应版本
> （别用 `^0.x` caret，它只匹配单个次版本会把插件锁死；也别用裸 `*`，
> 那会连未来破坏性的 1.0 都接受）。

## 2. 声明 / 消费服务

### 2.1 仅消费（依赖现成服务）

```ts
import type { Context, PluginModule } from '@aalis/core';
import type { LLMService } from '@aalis/api-llm';

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

`*-api` 包仅导出 `type` 与少量纯函数 helper / 常量，运行时近零体积，**任何插件都可以放心 import**。

### 2.2 自己 provide 一个服务

```ts
import type { Context, PluginModule } from '@aalis/core';
import type { LLMService } from '@aalis/api-llm';

class MyLLM implements LLMService { /* ... */ }

export default {
  name: '@your-scope/plugin-my-llm',
  apply(ctx: Context) {
    ctx.provide('llm', new MyLLM(), {
      priority: 50,
      label: 'my-llm',
    });
  },
} satisfies PluginModule;
```

`provide(name, instance, options?)` 的 `options` 只有三个字段：`priority`、`label`、`entryId`。
**core 不再做"服务能力（capability）选择"**——0.5.0 已删除 `ServiceCapabilityMap` /
`getServiceCapabilities` 及 provide 的 `capabilities` 选项。服务选择只看「偏好 > 优先级 > 注册顺序」，
跨实例的"按能力挑选"交给领域 helper（见下）。

#### 能力（capability）现在挂在 handle 元数据上

以 LLM 为例：模型的能力（chat / tool_calling / vision …）不再传给 `ctx.provide`，
而是作为 **model handle 自身的 `capabilities` 元数据**暴露，由 `@aalis/api-llm`
的纯函数 helper 按需过滤：

```ts
import { LLMCapabilities } from '@aalis/api-llm';
import type { LLMCapability } from '@aalis/api-llm';

// provide 时不传 capabilities；能力写在 handle 实例上：
class MyModelHandle {
  readonly capabilities: LLMCapability[] = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling];
  // ...
}
ctx.provide('llm', new MyModelHandle(), { entryId: `${ctx.id}/my-model`, label: 'my-model' });

// 消费方按能力解析（在 *-api 层过滤，不经 core）：
import { resolveLLMModel } from '@aalis/api-llm';
const model = resolveLLMModel(ctx, ref, [LLMCapabilities.Vision])?.instance;
```

#### 推荐 `priority` 带

| 范围 | 用途 |
|-------|------|
| `0`（默认） | 普通真实提供者（plugin-llm-openai / plugin-llm-deepseek …） |
| `10–50` | 用户希望覆盖默认的次级提供者（`Override`） |
| `200` | `System`；仅供 core 与系统级别使用 |

> Router 层已废除。上层跨 entry 调度请使用 `getAllServices(name)`（只接收服务名，**无** capabilities 参数）
> 与各 *-api 提供的纯函数 helper（`resolveLLMModel` / `listLLMModels` / `createStorageGateway` /
> `resolvePlatformBySession` 等）做按能力 / 按 ref 的过滤。

> 在同一服务名下，`getService(name)` 默认返回「偏好 > priority > 注册顺序」居首的那个；
> `getAllServices(name)` 返回全部并按同一顺序排序。用户可经 `ctx.preferService(name, contextId)`
> 或 WebUI 的「服务」页指定偏好 provider。

### 2.3 多提供者：per-entry 注册

需要在一个服务名下暴露多个实例（如多 root storage、多平台适配、多模型 LLM）时，**在同一个 apply() 里多次调用 `ctx.provide`**，用 `entryId` 区分（约定以 `ctx.id` 为前缀）：

```ts
for (const root of roots) {
  ctx.provide('storage', new ScopedStorageService(root, ...), {
    entryId: `${ctx.id}/${root.name}`,
    label: root.label,
  });
}
```

上层需要跨实例路由时，调用各 *-api 中的 helper。禁止再注册同名 facade entry。

## 3. 配置 schema

```ts
import type { Context, PluginModule } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type {} from '@aalis/api-webui'; // declaration merging：SchemaField 表单属性（secret 等）

// ConfigSchema = Record<string, SchemaField | SchemaGroup | SchemaArray>；
// 每个 SchemaField 必须有 type 与 label。
export const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://api.example.com' },
};

export default {
  name: '@your-scope/plugin-x',
  configSchema,
  apply(ctx: Context, config: Record<string, unknown>) { /* config 已含 schema 派生默认值（顶层合并） */ },
} satisfies PluginModule;
```

> `secret`（以及 `dynamicOptions` / `allowCustom` 等表单属性）不是 `SchemaField` 的自带字段——
> `@aalis/schema-config` 只声明各宿主共需的中立字段（`type` / `label` / `description` /
> `default` / `required` / `options`），渲染相关属性由 `@aalis/api-webui` 经
> declaration merging 注入。用到这些属性时**必须** `import type {} from '@aalis/api-webui'`
> 才能通过类型检查。同理，自定义字段类型（如 `'llm-ref'`）要 merging 到
> `@aalis/schema-config` 的 `SchemaFieldTypes`，merging 到 `@aalis/core` **不会报错但静默失效**。

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
| 注册 AI 可调用的工具 | `useToolService(ctx).register(...)`（来自 `@aalis/api-tools`） |
| 注册斜杠命令 | `useCommandService(ctx).command(...)`（来自 `@aalis/api-commands`） |
| 自定义 WebUI 页面 | `useWebuiService(ctx).registerPage(...)`（来自 `@aalis/api-webui`） |
| 注册 agent 输入预处理器 | `useAgent(ctx).registerPreprocessor(...)`（来自 `@aalis/api-agent`） |
| 监听核心事件 | `ctx.on('service:registered', …)` 等 |

helper 内部已封装 `whenService` 延迟语义：即使在 `apply()` 阶段调用 `register` /
`command`，若对应服务尚未 provide，注册操作会被自动延迟到服务就绪。插件加载采用单遍式，无需关心依赖顺序。

## 5.1 类型从哪里 import

`@aalis/core` 只导出**通用 IoC 类型**（Context / PluginModule / Service / Schema / 事件
扩展点 / 能力扩展点 / Dispose / Middleware / Logger 等）。所有 **LLM/agent 领域类型**都在
`@aalis/plugin-*-api` 里。

判定规则：**运行时值导入进 `dependencies`，纯类型导入进 `devDependencies`**——与本仓
一方插件的一致实践相同（60 包实测：值 helper 如 `useToolService` 所在契约包进 deps；
只拿类型 / 只做 declaration merging 的契约包留 devDeps，编译期擦除、运行时不装）。
`@aalis/core` 恒为 peerDependency（区间 `>=x <1.0.0`，禁 caret），并同时列入
devDependencies 供本地编译。`dependencies` 里的 `@aalis` 包版本同写
`>=当前版本 <1.0.0` 区间——区间可被包管理器去重到与宿主同一份安装，避免同名契约
装出两份（两份 `declare module` 相撞成 TS2717，被 skipLibCheck 静默吞掉）。

> 脚手架生成的依赖用 `latest`（硬编码版本会过时，workspace: 协议在外部装不上）——那只是
> 首次安装的引导值，发布前请按上述规则收紧为区间。

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
| 单一服务提供者 | `plugin-llm-openai`, `plugin-llm-deepseek` |
| 多 entry 注册 | `plugin-storage-local`（每 root）、`plugin-llm-ollama`（每 model） |
| 跨 entry helper | `api-storage` (`createStorageGateway`)、`api-platform` (`resolvePlatformBySession`) |
| 工具注入 | `plugin-tool-search`, `plugin-tool-browser` |
| 命令注入 | `plugin-commands` |
| WebUI 扩展 | `plugin-webui-server`, `plugin-todo-list` |

## 8. 进一步阅读

- [架构总览](../architecture.md)
- [api 包设计](../design/api-packages.md)
