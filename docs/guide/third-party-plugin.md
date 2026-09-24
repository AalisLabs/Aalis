# 第三方插件开发者指南

> 目标读者：希望为 Aalis 编写并发布独立 npm 包的开发者。本文示范从零到发布的最短路径。

## 1. 包的形状

一个 Aalis 插件 = 一个 npm 包，**默认导出**一份 `definePlugin` 的产物：

```ts
import { definePlugin, logger } from '@aalis/core';

export default definePlugin({
  name: '@your-scope/plugin-hello',
  uses: { logger },
  apply({ logger }) {
    logger.info('hello from third-party plugin');
  },
});
```

加载器只认这份 default 定义。具名导出、函数 default、类 default 都会出声并跳过。

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
    "@aalis/core": ">=0.17.0 <1.0.0"
  }
}
```

> `keywords` 里的 `"aalis-plugin"` 是**加载硬门**而非检索装饰：加载器只认它，漏写则插件
> 装上后永远不会被发现（启动日志会有「疑似插件缺关键词」提示，但不会加载）；`files` 须含
> 构建产物，否则入口解析失败同样不加载。
>
> `@aalis/core` 用 **peerDependency** 引用，避免多版本冲突。范围用 **`>=0.17.0 <1.0.0`**：
> 这是 `definePlugin` / 服务描述符首次成为公开面的版本。**1.0 之前 core 的公开面可能在次版本被删**，
> 用了更新的 API 就把下限再抬。别用 `^0.x` caret（只匹配单个次版本会把插件锁死）；也别用裸 `*`。

## 2. 声明 / 消费服务

### 2.1 仅消费（依赖现成服务）

描述符是**值导入**：写进 `uses`，并进入 `dependencies`（不是 `import type`）。

```ts
import { llm } from '@aalis/api-llm';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@your-scope/plugin-x',
  uses: { llm: optional(llm) },
  apply({ llm }) {
    llm.follow(model => {
      // 胜者在场即调；换人时先清理再挂新实例。attach 必须同步。
      // model.chat(...)
    });
  },
});
```

调用型接口是 `ServiceRef`：每次读 `current` 重新解析；有状态资源用 `follow`。详见 [惰性服务访问](../concepts/lazy-service-access.md)。

### 2.2 自己 provide 一个服务

```ts
import { type LLMModel, llm } from '@aalis/api-llm';
import { definePlugin, lifecycle, provide } from '@aalis/core';

class MyModelHandle implements LLMModel { /* ... */ }

export default definePlugin({
  name: '@your-scope/plugin-my-llm',
  provides: [llm],
  uses: { provide, lifecycle },
  apply({ provide, lifecycle }) {
    provide(llm, new MyModelHandle(), {
      priority: 50,
      label: 'my-llm',
      entryId: `${lifecycle.id}/my-model`,
    });
  },
});
```

`provide(descriptor, instance, options?)` 的 `options`：`priority`、`label`、`entryId`、`onBehalfOf`。
core 不做服务能力选择。服务选择只看「偏好 > 优先级 > 注册顺序」，跨实例的「按能力挑选」交给领域 helper。

#### 能力挂在 handle 元数据上

以 LLM 为例：模型的能力（chat / tool_calling / vision …）作为 model handle 自身的 `capabilities` 暴露，由 `@aalis/api-llm` 的 helper 按需过滤：

```ts
import { LLMCapabilities, resolveLLMModel } from '@aalis/api-llm';
import type { LLMCapability } from '@aalis/api-llm';

class MyModelHandle {
  readonly capabilities: LLMCapability[] = [LLMCapabilities.Chat, LLMCapabilities.ToolCalling];
  // ...
}
provide(llm, new MyModelHandle(), { entryId: `${lifecycle.id}/my-model`, label: 'my-model' });

const model = resolveLLMModel(llmRef, ref, [LLMCapabilities.Vision])?.instance;
```

`resolveLLMModel` 的第一参是 `ServiceRef<LLMModel>`，不是 Context。

#### 推荐 `priority` 带

| 范围 | 用途 |
|-------|------|
| `0`（默认） | 普通真实提供者 |
| `10–50` | 希望盖过默认的次级提供者 |
| `200` | 系统级别；仅供 core 与系统级使用 |

上层跨 entry 调度请使用 `x.all()` 或 `services.all(desc)`（只接收名字，**无** capabilities 参数）
与各 `*-api` helper（`resolveLLMModel` / `listLLMModels` / `createStorageGateway` /
`resolvePlatformBySession` 等）。

`current` 默认返回「偏好 > priority > 注册顺序」居首的那个。用户可经 `services.prefer(desc, contextId)`
或 WebUI 的「服务」页指定偏好 provider。

### 2.3 多提供者：per-entry 注册

需要在一个服务名下暴露多个实例时，在同一次 `apply` 里多次 `provide`，用 `entryId` 区分（须以激活 id 为前缀）：

```ts
for (const root of roots) {
  provide(storage, new ScopedStorageService(root, ...), {
    entryId: `${lifecycle.id}/${root.name}`,
    label: root.label,
  });
}
```

上层需要跨实例路由时，调用各 `*-api` 中的 helper。禁止再注册同名 facade entry。

## 3. 配置 schema

```ts
import { definePlugin, config } from '@aalis/core';
import type { ConfigSchema } from '@aalis/schema-config';
import type {} from '@aalis/api-webui'; // SchemaField 表单属性（secret 等）

const configSchema: ConfigSchema = {
  apiKey: { type: 'string', label: 'API Key', required: true, secret: true },
  baseUrl: { type: 'string', label: 'API 地址', default: 'https://api.example.com' },
};

export default definePlugin({
  name: '@your-scope/plugin-x',
  configSchema,
  uses: { config },
  apply({ config }) {
    // config 已含 schema 派生默认值（宿主经 pluginDefaults 注入；注册期纯对象/数组会拷贝）
  },
});
```

> `secret`（以及 `dynamicOptions` / `allowCustom` 等表单属性）不是 `SchemaField` 的自带字段——
> `@aalis/schema-config` 只声明各宿主共需的中立字段（`type` / `label` / `description` /
> `default` / `required` / `options`），渲染相关属性由 `@aalis/api-webui` 经
> declaration merging 注入。用到这些属性时**必须** `import type {} from '@aalis/api-webui'`。
> 自定义字段类型（如 `'llm-ref'`）要 merging 到 `@aalis/schema-config` 的 `SchemaFieldTypes`。

WebUI 会自动根据 schema 渲染配置表单。

## 4. 生命周期

`provide()` 与 `events.on` 返回退订；经绑定门面的登记随激活撤回，**插件本身无需再退订这些**。需要做副作用清理（关闭 socket、清空 interval）时：

```ts
apply({ lifecycle }) {
  const timer = setInterval(work, 1000);
  lifecycle.onDispose(() => clearInterval(timer));
}
```

需要在对外登记仍在、声明的依赖仍可调用时交接数据，用 `lifecycle.onDrain`；`onDispose` 只释放自己的资源，那时依赖可能已不可用。普通依赖下消费者 close 完提供者才 drain；根激活用插件的服务时根 drain 先于插件 close。`App.stop()` 先冻结并进入停机态，再发 `app:stopping`（知会，不是清理通道），然后执行停机计划。单独 unload / disable / bounce 提供者时，正在用它的 required 消费者先收尾再关，收尾时提供者仍在。

## 5. 工具 / 命令 / WebUI 扩展点

| 想做的事 | 用什么 |
|----------|--------|
| 注册 AI 可调用的工具 | `uses: { tools }`，`tools.register(...)`（`@aalis/api-tools` 的描述符） |
| 注册斜杠命令 | `uses: { commands }`，`commands.command(...)`（`@aalis/api-commands`） |
| 自定义 WebUI 页面与页面动作 | `uses: { webui: webuiServer }`，`webui.registerPage` / `registerAction`（`@aalis/api-webui`） |
| 注册 agent 输入预处理器 | `uses: { agent }`，`agent.registerPreprocessor(...)`（`@aalis/api-agent`） |
| 监听核心事件 | `uses: { events }`，`events.on('service:registered', …)` |

这些绑定门面内部已处理「服务晚上线或换人时重挂」。插件加载采用单遍式，无需关心依赖顺序；若还要在方法里 **读** hub（`require()` / `execute`），或希望激活闸清晰，把对应描述符写成 required（不要 `optional()`）。

## 5.1 类型从哪里 import；依赖怎么归类

`@aalis/core` 导出通用 IoC 类型与内置描述符（`definePlugin` / `ServiceRef` / `events` / `logger` / …）。所有 **LLM / agent / 工具** 领域类型与描述符都在 `@aalis/api-*` 里。

判定规则：**运行时值导入进 `dependencies`，纯类型导入进 `devDependencies`**。描述符是值——`import { tools } from '@aalis/api-tools'` 必须进 `dependencies`，不能只放 devDep。`@aalis/core` 恒为 peerDependency（区间 `>=x <1.0.0`，禁 caret），并同时列入 devDependencies 供本地编译。`dependencies` 里的 `@aalis` 包版本同写 `>=当前版本 <1.0.0` 区间——区间可被包管理器去重到与宿主同一份安装，避免同名契约装出两份（两份 `declare module` 相撞成 TS2717，被 skipLibCheck 静默吞掉）。

> 脚手架生成的依赖用 `latest`（硬编码版本会过时，workspace: 协议在外部装不上）——那只是
> 首次安装的引导值，发布前请按上述规则收紧为区间。

全部扩展点（事件 / 钩子 / 贡献点 / 配置字段 / 描述符）的归属表见
[docs/extensions/index.md](../extensions/index.md)。

## 6. 发布

```bash
npm publish --access public
```

用户安装：

```bash
pnpm add @your-scope/plugin-hello
```

装进依赖即被自动发现并加载（靠 `keywords` 含 `aalis-plugin`），**插件默认启用**。
`aalis.config.yaml` 的 `plugins` 段只放该包的**配置项**，不是启用开关：

```yaml
plugins:
  "@your-scope/plugin-hello":
    someOption: true
```

停用是把包名写进顶层 `disabledPlugins` 数组。

或在 WebUI 的「插件市场」里点击安装。

## 7. 参考实现

| 类型 | 参考包 |
|------|--------|
| 单一服务提供者 | `plugin-llm-openai`, `plugin-llm-deepseek`, `plugin-tools` |
| 多 entry 注册 | `plugin-storage-local`（每 root）、`plugin-llm-ollama`（每 model） |
| 跨 entry helper | `api-storage` (`createStorageGateway`)、`api-platform` (`resolvePlatformBySession`) |
| 工具注入 | `plugin-todo-list`, `plugin-tool-search` |
| 命令注入 | `plugin-commands` |
| WebUI 扩展 | `plugin-webui-server`, `plugin-todo-list` |
| `follow` | `plugin-session-confirm` |

## 8. 进一步阅读

- [架构总览](../architecture.md)
- [api 包设计](../design/api-packages.md)
- [枢纽服务：第三方能力的登记契约](../design/hub-services.md)
- [从 0.16 迁移对照](../plugin-author-guide.md#从-016-迁移)
