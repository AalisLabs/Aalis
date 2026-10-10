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
  display?: ToolDisplay;
  background?: { yieldSeconds?: number };
}

export interface ToolCallContext {
  sessionId: string;
  userId?: string;
  platform?: string;
  actor?: { platform: string; userId: string };
  enabledGroups?: string[];
  acceptsImages?: boolean;
  signal?: AbortSignal;
  inbound?: { source?: string; callerUserId?: string; messageId?: string };
  turnId?: string;
  callId?: string;
  output?: (text: string) => void;
}
```

`inbound`、`turnId`、`callId` 只由 agent 工具循环填写：所在入站回合的来源、回合 id，以及 agent 为这次调用生成的全局唯一 id（字段说明见 [api-tools](../api/api-tools.md#toolcallcontext)）。`output` 由执行器给每次调用一份：工具执行中的输出写进它，agent 回合里转成 `tool:output`。

`background` 声明工具可以转后台（响应 `signal`、晚些拿到结果仍有意义）：执行器给它的参数表补 `runInBackground` 与 `waitSeconds`，在前台等满让出时限还没结束就登记成后台任务、先回给模型，结束时通知起它的会话（见 [api-tools](../api/api-tools.md#可转后台)、[plugin-tools](../plugins/plugin-tools.md#转后台与后台任务)）。

`handler` 返回字符串即纯文本结果；需要把图片交给主模型亲眼看时返回 `ToolExecutionResult`（`{ content, images? }`）。`risk` 是糖：`safe→{public}`、`sensitive→{restricted}`、`dangerous→{restricted, confirm:'session'}`；显式字段覆盖推导；全缺省 → `public`。

### 2.3 服务接口 `ToolService`

```ts
register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void;
getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
getSummaries(filter?: { groups?: string[] }): ToolSummary[];
getAll(): Array<{ name; description; pluginName; visibility; confirm?; risk?; groups? }>;
execute(toolName, args, callCtx: ToolCallContext): Promise<ToolExecutionResult>;
setExecutionGuard(guard: ExecutionGuard | undefined): void; // 传 undefined 摘掉，退回 fail-closed
registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, contextId: string): () => void;
getGroups(): ToolGroupInfo[];
```

插件侧不要自己传 `contextId`。`getDefinitions`/`getSummaries`：**不传 `groups` 时只返回「无分组」的通用工具**；`'*'` 表示全部分组。

**执行面过同一道闸**：`execute` 在调用方给了 `enabledGroups` 时按同样判据校验。

可见的工具里有可转后台的时，列举与执行连同参考实现自带的四个后台任务工具（`background_list`、`background_output`、`background_wait`、`background_stop`）；`getAll()` 在登记了可转后台的工具时列出它们。

### 2.4 绑定门面

```ts
interface BoundTools extends ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>): () => void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void;
}

function withToolGroups(bound: BoundTools, groups: string[]): BoundTools;
```

`register` / `registerGroup` 走 `registrar`。查询与执行同样走业务句柄 `tools.use`（如 `tools.use.getDefinitions(...)`），转发给本插件选中的那一家。`withToolGroups(tools.use, groups)` 只覆盖 `register`，其余沿原型链落到原句柄上；不要对象展开 `BoundTools`（句柄只转发属性读取与调用，展开后看不到提供者的成员）。

事件：`AalisEvents['tool:execute']`，只由 agent 工具循环发出，带 `turnId` 与 `callId`，开始与结束按 `callId` 配对；`'tool:output'` 是执行中的输出；`'background:changed'` 是后台任务登记的变化。本包纯契约：SSRF 判定在 `@aalis/util-network-guard`；路径解析在 `@aalis/api-storage`。另导出 `wrapUntrustedContent` 与工具结果的结局判据 `toolFailed`、`integerIn`。

### 2.5 后台任务登记

描述符 `backgroundTasks`（服务名 `background-tasks`），`list({ sessionId? })`、`output(id, after?)`、`stop(id)`；类型 `BackgroundTask`、`BackgroundTaskChange`；结束通知的种类 `BACKGROUND_TASK_NOTICE` 与给界面的事实 `BackgroundTaskNoticeFacts`。字段与语义见 [api-tools](../api/api-tools.md#后台任务登记)。

## 3. 谁提供 / 谁消费

**提供者（唯一）**：`@aalis/plugin-tools` —— `provide.use(tools, new ToolRegistry(logger.use, tasks))`，同时 `provide.use(backgroundTasks, tasks)`。本服务是**单实例中心 Registry**。

**工具提供者**：`plugin-tool-system`、`plugin-tool-math`、`plugin-tool-browser`、`plugin-tool-search`、`plugin-tool-onebot`、`plugin-tool-code-runner`、`plugin-skills`、`plugin-todo-list`、`plugin-memory-*` 等经 `tools.use.register` 登记。

**核心消费者**：

- `plugin-agent` —— 先看 `tools.present`，再 `tools.use.getDefinitions(...)` / `tools.use.execute(...)`
- `plugin-authority` —— `tools.follow(svc => { svc.setExecutionGuard(guard); return () => svc.setExecutionGuard(undefined); })` 注入权限守卫，停用时摘掉
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
    const grouped = withToolGroups(tools.use, ['hello']);
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

`pluginName` 由绑定门面填本次激活 id，**不要**自己传。登记不强制 required；若还要读 `getDefinitions` / `execute`，用 `uses: { tools }`（required）并经 `tools.use` 调用；optional 时先看 `tools.present`。

自建整个 `ToolService` 仅当你要替换注册表：`provide.use(tools, impl, { priority })`，**务必实现 `setExecutionGuard`**。

## 5. 标准消费写法

业务句柄 `tools.use` 是活的，选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。可选依赖时按 `present` 降级：

```ts
const defs = tools.present ? tools.use.getDefinitions(enabledGroups ? { groups: enabledGroups } : undefined) : [];
const result = tools.present
  ? await tools.use.execute(call.name, call.args, { sessionId, userId, platform, enabledGroups })
  : { content: JSON.stringify({ error: 'tools 服务不可用' }) };
```

`execute` 把失败转成 `{ error }` 回灌 LLM，**不会**冒泡异常（以 `plugin-tools` 实现为准）。

## 6. 能力 / 风险 → 影响

工具是受 authority 管的「能力」，`tool:<name>` 即其 capability id。两条正交轴：可见性与确认。`risk` 是糖。`getAll()` **原样透传 `risk`**。

**提供者必须遵守**：写/删/越权读/外发类工具都要声明 `risk` 或显式 `visibility/confirm`。外发网络走 `safeFetch`。访问文件系统只走 storage URI。

**执行守卫链路**：`execute` 先展开 `(visibility, confirm)`，若已注入 guard 则把调用上下文（身份、回合与调用 id、`inbound`、中止信号）交给它。需要确认的工具调用由守卫请 owner 审批，只有 owner 本人与 owner 链的延续发起的回合能产生审批。owner 视为等级 ∞。

## 7. 注意事项

- **守卫缺失 = fail-closed（拒绝）**：若 `plugin-authority` 未加载，参考实现等同所有人都是默认等级、没人能确认——需要更高等级（restricted 或 risk 为 sensitive / dangerous）或声明了 `confirm` 的工具一律拒绝并提示缺少权限插件，默认等级可用且无需确认的工具照常执行。
- **`http_download`** 现为 `restricted + confirm:'session'`。新写下载/上传类工具照此挂闸。
- **`file_read` 的 `allowedRoots`** 默认 `['workspace', 'tmp']`，配置可设 `["*"]`。
- **重名即覆盖**。应选用带前缀的工具名。
- **参数校验是「轻量」级**：只查 `required` 缺失 + （仅当 `additionalProperties:false` 时）未知键。

## 8. 交叉链接

- 概念：[`service-model`](../concepts/service-model.md) · [`lazy-service-access`](../concepts/lazy-service-access.md) · [`manifest-metadata`](../concepts/manifest-metadata.md) · [`security-model`](../concepts/security-model.md) · [`storage-uri-grammar`](../concepts/storage-uri-grammar.md) · [`message-llm-pipeline`](../concepts/message-llm-pipeline.md)
- 核心：[`plugins/plugin-tools`](../plugins/plugin-tools.md) · [`plugins/plugin-authority`](../plugins/plugin-authority.md) · [`plugins/plugin-commands`](../plugins/plugin-commands.md) · [`core/service`](../core/service.md) · [`core/context`](../core/context.md)
