# plugin-tools-api — 工具系统契约

**包名**: `@aalis/plugin-tools-api`  
**源码**: `packages/plugin-tools-api/src/index.ts`  
**实现**: `@aalis/plugin-tool-system`

## 概述

定义 AI 工具系统的全部"非实现"契约：

- 工具数据结构（`RegisteredTool` / `ToolGroupInfo` / `ToolSummary`）
- 工具调用上下文（`ToolCallContext`）—— 平台/会话语义
- 工具执行通知（`ToolExecuteMessage`）
- 服务接口 `ToolService` 与领域 helper `useToolService` / `toolsWithGroups`
- 向 `AalisEvents` 注入 `'tool:execute'`

**注**：runtime 工具函数已迁出本契约包（见 `index.ts` 迁出注释）：SSRF/私网判定 → `@aalis/util-network-guard`；工具输入路径解析 → `@aalis/plugin-storage-api`。本包只保留契约/类型。

## 服务接口

```ts
interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, pluginName: string): () => void;
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
  getSummaries(filter?: { groups?: string[] }): ToolSummary[];
  getAll(): Array<{ name; description; pluginName; visibility; groups? }>;
  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<string>;
  setExecutionGuard(guard: ExecutionGuard): void;
  unregisterByPlugin(pluginName: string): void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, pluginName: string): () => void;
  getGroups(): ToolGroupInfo[];
}
```

## RegisteredTool 结构

```ts
interface RegisteredTool {
  definition: ToolDefinition;             // OpenAI 风格函数声明
  handler: (args, callCtx: ToolCallContext) => Promise<string>;
  pluginName: string;
  visibility?: CapabilityVisibility;      // 'public' | 'restricted'（默认 public）
  // 注：CapabilityVisibility 从 @aalis/plugin-authority-api 导入
  groups?: string[];                      // 工具分组，未设置时始终可用
}
```

## 领域 Helper

```ts
const tools = useToolService(ctx);
tools.register({ definition, handler, ... }): () => void;
tools.registerGroup({ name, label, description? }): () => void;

// 自动给后续 register 注入 groups 字段
const groupTools = toolsWithGroups(tools, ['my-group']);
groupTools.register({ definition, handler });   // 自动 groups: ['my-group']
```

helper 内部封装了 `ctx.getService('tools')` 与 `whenService` 延迟逻辑：
服务尚未 provide 时 `register` 调用会被自动延迟到服务就绪，调用方无需关心顺序。

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
import { useToolService } from '@aalis/plugin-tools-api';

const tools = useToolService(ctx);
tools.register({
  definition: { type: 'function', function: { name: 'my_tool', ... } },
  handler: async (args, callCtx) => '...',
  visibility: 'public',
  groups: ['custom'],
});
```

## 实现者

- [@aalis/plugin-tool-system](../plugins/plugin-tool-system.md) —— 提供 shell / file / system / http 工具组

## 相关

- 权限校验见 [plugin-authority-api](./plugin-authority-api.md)
- storage URI 体系见 [plugin-storage-api](./plugin-storage-api.md)
