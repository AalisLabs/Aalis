# api-tools — 工具系统契约

**包名**: `@aalis/api-tools`  
**源码**: `packages/api-tools/src/index.ts`  
**实现**: `@aalis/plugin-tools`（`tools` 服务本体）；`@aalis/plugin-tool-system` 等 `plugin-tool-*` 是往里注册工具组的生产方

## 概述

定义 AI 工具系统的全部"非实现"契约：

- 工具数据结构（`RegisteredTool` / `ToolGroupInfo` / `ToolSummary`）
- 工具调用上下文（`ToolCallContext`）—— 平台/会话语义
- 工具执行通知（`ToolExecuteMessage`）
- 服务接口 `ToolService`、描述符 `tools`、绑定接口 `BoundTools`、`withToolGroups`
- 向 `AalisEvents` 注入 `'tool:execute'`

**注**：runtime 工具函数已迁出本契约包（见 `packages/api-tools/src/index.ts` 迁出注释）：SSRF/私网判定 → `@aalis/util-network-guard`；工具输入路径解析 → `@aalis/api-storage`。本包只保留契约/类型与登记门面。

## 服务接口

```ts
interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void;
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
  getSummaries(filter?: { groups?: string[] }): ToolSummary[];
  getAll(): Array<{ name; description; pluginName; visibility; confirm?; risk?; groups? }>;
  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<ToolExecutionResult>;
  setExecutionGuard(guard: ExecutionGuard): void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, contextId: string): () => void;
  getGroups(): ToolGroupInfo[];
}
```

插件侧不要直接调 `ToolService.register(..., contextId)`。`contextId` 由绑定门面填本次激活 id。

## RegisteredTool 结构

```ts
interface RegisteredTool {
  definition: ToolDefinition;             // OpenAI 风格函数声明
  handler: (args, callCtx: ToolCallContext) => Promise<string | ToolExecutionResult>; // { content, images? }：images 交主模型亲眼看
  pluginName: string;
  visibility?: CapabilityVisibility;      // 'public' | 'restricted'（默认 public）
  confirm?: CapabilityConfirm;
  risk?: CapabilityRisk;
  groups?: string[];                      // 工具分组，未设置时始终可用
}
```

`CapabilityVisibility` / `CapabilityConfirm` / `CapabilityRisk` 从 `@aalis/api-authority` 导入。

## 描述符与绑定门面

```ts
interface BoundTools extends ServiceRef<ToolService> {
  register(tool: Omit<RegisteredTool, 'pluginName'>): () => void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void;
}

function withToolGroups(bound: BoundTools, groups: string[]): BoundTools;
```

`tools` 是登记型能力：`register` / `registerGroup` 走 `registrar`，同名替换、提供者换人整体重挂、关闭后拒收。查询与执行走 `ServiceRef`：`tools.current?.getDefinitions(...)`、`tools.require().execute(...)`。

`withToolGroups` 只覆盖 `register`，其余（含 `current` 这个 getter）沿原型链落到原接口，跟着提供者换人。不要对象展开一份 `BoundTools`——会把 `current` 求成一次性快照。

同一激活内同名（工具名 / 分组名）是替换语义：新登记顶掉旧登记，旧登记的退订闭包随即失效，不会误删新登记。

## 事件（AalisEvents）

```ts
'tool:execute': [{
  sessionId: string;
  platform?: string;
  toolName: string;
  args: Record<string, unknown>;
  phase: 'start' | 'end';
  result?: string;  // 仅 phase='end'
}]
```

供 WebUI / 日志归档订阅展示。

## 典型用法

```ts
import { tools, withToolGroups } from '@aalis/api-tools';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-tools',
  uses: { tools: optional(tools) },
  apply({ tools }) {
    const grouped = withToolGroups(tools, ['custom']);
    grouped.register({
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          description: '原样返回 text',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
      handler: async args => String(args.text ?? ''),
    });
  },
});
```

登记不强制把 `tools` 标成 required：绑定门面在提供者未就绪时排队，就绪后挂上。若还要读 `getDefinitions` / `getAll` / `execute`，应 `uses: { tools }`（required），用 `tools.require()` 或先判 `tools.current`。

## 实现者

- [@aalis/plugin-tools](../plugins/plugin-tools.md) —— `tools` 服务本体（注册表、分组、可见性）
- [@aalis/plugin-tool-system](../plugins/plugin-tool-system.md) —— 往里注册 `system` 一个工具组（含 shell / 文件 / 系统信息 / HTTP 四类工具）

## 相关

- 权限校验见 [api-authority](./api-authority.md)
- storage URI 体系见 [api-storage](./api-storage.md)
