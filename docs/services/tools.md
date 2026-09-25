# tools 服务

## 1. 定位

**工具注册表（Tool Registry）**：管理「AI 可调用工具」的注册、查询、执行与统一权限闸。LLM function-calling 的工具池就是这个服务里的一张 `Map<name, RegisteredTool>`。

- 服务注册名：描述符 `tools`（`name: 'tools'`），绑定接口 `BoundTools`。
- 契约包：`@aalis/api-tools`（`packages/api-tools/src/index.ts`）。
- 参考实现：`@aalis/plugin-tools`（`packages/plugin-tools/src/tools.ts` 的 `ToolRegistry`）。

工具是「能力（capability）」在 LLM 侧的一种 surface（另一种是指令 command）。两者共用同一套 authority 执行守卫，详见 [`docs/concepts/security-model.md`](../concepts/security-model.md)、[`docs/plugins/plugin-authority.md`](../plugins/plugin-authority.md)。

## 2. 契约（`@aalis/api-tools`）

### 2.1 LLM 函数声明协议

```ts
export interface ToolFunction {
  name: string;
  strict?: boolean;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: ToolFunction;
}
```

### 2.2 已注册工具与上下文

```ts
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: (args: Record<string, unknown>, ctx: ToolCallContext) => Promise<string | ToolExecutionResult>;
  pluginName: string;
  visibility?: CapabilityVisibility;
  confirm?: CapabilityConfirm;
  risk?: CapabilityRisk;
  groups?: string[];
}

export interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  actor?: { platform: string; userId: string };
  enabledGroups?: string[];
  acceptsImages?: boolean;
  signal?: AbortSignal;
}
```

`handler` 返回字符串即纯文本结果；需要把图片交给主模型亲眼看时返回 `ToolExecutionResult`（`{ content, images? }`）。`risk` 是糖：`safe→{public}`、`sensitive→{restricted}`、`dangerous→{restricted, confirm:'session'}`；显式字段覆盖推导；全缺省 → `public`。

### 2.3 服务接口 `ToolService`

```ts
register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void;
getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
getSummaries(filter?: { groups?: string[] }): ToolSummary[];
getAll(): Array<{ name; description; pluginName; visibility; confirm?; risk?; groups? }>;
execute(toolName, args, callCtx: ToolCallContext): Promise<ToolExecutionResult>;
setExecutionGuard(guard: ExecutionGuard): void;
registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, contextId: string): () => void;
getGroups(): ToolGroupInfo[];
```

插件侧不要自己传 `contextId`。`getDefinitions`/`getSummaries`：**不传 `groups` 时只返回「无分组」的通用工具**；`'*'` 表示全部分组。

**执行面过同一道闸**：`execute` 在调用方给了 `enabledGroups` 时按同样判据校验。

### 2.4 绑定门面

```ts
interface BoundTools extends ServiceRef<ToolService> {
  register(tool: Omit<RegisteredTool, 'pluginName'>): () => void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void;
}

function withToolGroups(bound: BoundTools, groups: string[]): BoundTools;
```

`register` / `registerGroup` 走 `registrar`。查询与执行走 `tools.current` / `tools.require()`。`withToolGroups` 只覆盖 `register`，不要对象展开 `BoundTools`（会把 `current` 求成快照）。

事件：`AalisEvents['tool:execute']`。本包纯契约：SSRF 判定在 `@aalis/util-network-guard`；路径解析在 `@aalis/api-storage`。另导出 `wrapUntrustedContent`。

## 3. 谁提供 / 谁消费

**提供者（唯一）**：`@aalis/plugin-tools` —— `provide(tools, new ToolRegistry(logger))`。本服务是**单实例中心 Registry**。

**工具提供者**：`plugin-tool-system`、`plugin-tool-math`、`plugin-tool-browser`、`plugin-tool-search`、`plugin-tool-onebot`、`plugin-tool-code-runner`、`plugin-skills`、`plugin-todo-list`、`plugin-memory-*` 等经 `tools.register` 登记。

**核心消费者**：

- `plugin-agent` —— `tools.current?.getDefinitions(...)` / `?.execute(...)`
- `plugin-authority` —— `tools.follow(svc => { svc.setExecutionGuard(guard); })` 注入权限守卫（不返回 cleanup：守卫随旧实例一起消失；契约没有「摘掉守卫」的口）
- `plugin-mcp-server` —— `uses: { tools }` required
- WebUI 经 `getAll()` 列工具+可见性

## 4. 写一个工具提供者

```ts
import { tools, withToolGroups } from '@aalis/api-tools';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@aalis/plugin-tool-hello',
  uses: { tools: optional(tools) },
  apply({ tools }) {
    const grouped = withToolGroups(tools, ['hello']);
    grouped.registerGroup({ name: 'hello', label: '示例工具' });
    grouped.register({
      definition: {
        type: 'function',
        function: {
          name: 'hello_echo',
          description: '原样回显一段文本。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '要回显的文本' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      handler: async args => JSON.stringify({ echo: String(args.text ?? '') }),
    });
  },
});
```

`pluginName` 由绑定门面填本次激活 id，**不要**自己传。登记不强制 required；若还要读 `getDefinitions` / `execute`，用 `uses: { tools }`（required）并 `tools.require()` 或先判 `tools.current`。

自建整个 `ToolService` 仅当你要替换注册表：`provide(tools, impl, { priority })`，**务必实现 `setExecutionGuard`**。

## 5. 标准消费写法

`tools.current` 每次读取重新解析。不要缓存实例或 `tools.all()[i]`。

```ts
const defs = tools.current?.getDefinitions(enabledGroups ? { groups: enabledGroups } : undefined) ?? [];
const result =
  (await tools.current?.execute(call.name, call.args, { sessionId, userId, platform, enabledGroups })) ?? {
    content: JSON.stringify({ error: 'tools 服务不可用' }),
  };
```

`execute` 把失败转成 `{ error }` 回灌 LLM，**不会**冒泡异常（以 `plugin-tools` 实现为准）。

## 6. 能力 / 风险 → 影响

工具是受 authority 管的「能力」，`tool:<name>` 即其 capability id。两条正交轴：可见性与确认。`risk` 是糖。`getAll()` **原样透传 `risk`**。

**提供者必须遵守**：写/删/越权读/外发类工具都要声明 `risk` 或显式 `visibility/confirm`。外发网络走 `safeFetch`。访问文件系统只走 storage URI。

**执行守卫链路**：`execute` 先展开 `(visibility, confirm)`，若已注入 guard 则调它。`skipConfirm` 只跳交互确认、**不**绕过 authorize。owner 视为等级 ∞。

## 7. 注意事项

- **守卫缺失 = fail-open（放行）**：若 `plugin-authority` 未加载，所有 `restricted`/`confirm` 工具直接执行。敏感工具应在 handler 内再做一层自检。
- **`http_download`** 现为 `restricted + confirm:'session'`。新写下载/上传类工具照此挂闸。
- **`file_read` 的 `allowedRoots`** 默认 `['workspace', 'tmp']`，配置可设 `["*"]`。
- **重名即覆盖**。应选用带前缀的工具名。
- **参数校验是「轻量」级**：只查 `required` 缺失 + （仅当 `additionalProperties:false` 时）未知键。

## 8. 交叉链接

- 概念：[`service-model`](../concepts/service-model.md) · [`lazy-service-access`](../concepts/lazy-service-access.md) · [`manifest-metadata`](../concepts/manifest-metadata.md) · [`security-model`](../concepts/security-model.md) · [`storage-uri-grammar`](../concepts/storage-uri-grammar.md) · [`message-llm-pipeline`](../concepts/message-llm-pipeline.md)
- 核心：[`plugins/plugin-tools`](../plugins/plugin-tools.md) · [`plugins/plugin-authority`](../plugins/plugin-authority.md) · [`plugins/plugin-commands`](../plugins/plugin-commands.md) · [`core/service`](../core/service.md) · [`core/context`](../core/context.md)
