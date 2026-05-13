# plugin-tools-api — 工具系统契约与共享运行时

**包名**: `@aalis/plugin-tools-api`  
**源码**: `packages/plugin-tools-api/src/index.ts` + `utils.ts`  
**实现**: `@aalis/plugin-tools`

## 概述

定义 AI 工具系统的全部"非实现"契约：

- 工具数据结构（`RegisteredTool` / `ToolGroupInfo` / `ToolSummary`）
- 工具调用上下文（`ToolCallContext`）—— 平台/会话语义
- 工具执行通知（`ToolExecuteMessage`）
- 服务接口 `ToolService` 与领域 helper `useToolService` / `toolsWithGroups`
- 向 `AalisEvents` 注入 `'tool:execute'`

**新增**（v0.1+）：本包额外导出一组工具实现侧共享的 runtime 工具函数，避免 `plugin-tools / plugin-tool-browser / plugin-tool-code-runner` 重复造轮子。

## 服务接口

```ts
interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, pluginName: string): () => void;
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
  getSummaries(filter?: { groups?: string[] }): ToolSummary[];
  getAll(): Array<{ name; description; pluginName; authority?; safety?; permissions?; groups? }>;
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
  authority?: number;                     // 默认 1
  safety?: SafetyLevel;                   // 默认 'safe'
  permissions?: PermissionId[];           // 静态权限
  resolvePermissions?: (args, ctx) => PermissionId[] | Promise<PermissionId[]>; // 动态权限
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

## 共享 runtime 工具（utils.ts）

```ts
// storage URI 规范化（多个工具插件原先各写一份）
toStorageUri(input: string | undefined, options?: {
  fallback?: string;          // 默认 'workspace:/'
  requireValue?: boolean;     // 输入为空时抛错
  errorContext?: string;      // 错误信息中字段名，默认 '路径'
}): string;

// SSRF 私网/保留地址判定
isPrivateIpv4(address: string): boolean;
isPrivateIpv6(address: string): boolean;
isPrivateIp(address: string): boolean;      // 自动识别 v4/v6
isPrivateHost(host: string): boolean;       // host=域名或 IP 字面量，仅字符串级判定
```

规则：
- `toStorageUri` 拒绝宿主机绝对路径（`C:\...` 或 `/abs`），相对路径自动拼到 `workspace:/`
- `isPrivateHost` 处理 localhost / `.localhost` / `0.0.0.0` / `::` / IPv4 IPv6 字面量；非 IP 域名返回 false（调用方若需更严格 SSRF 应自行 DNS 解析后对每个 address 调 `isPrivateIp`）

## 典型用法

```ts
import { toStorageUri, isPrivateHost } from '@aalis/plugin-tools-api';

const uri = toStorageUri(userInput, { errorContext: 'cwd', fallback: 'workspace:/' });

if (isPrivateHost(new URL(rawUrl).hostname)) {
  throw new Error('拒绝访问内网地址');
}

const tools = useToolService(ctx);
tools.register({
  definition: { type: 'function', function: { name: 'my_tool', ... } },
  handler: async (args, callCtx) => '...',
  permissions: ['tool:custom.my_tool'],
  groups: ['custom'],
});
```

## 实现者

- [@aalis/plugin-tools](../plugins/plugin-tools.md) —— 提供 shell / file / system / http 工具组

## 相关

- 权限校验见 [plugin-authority-api](./plugin-authority-api.md)
- storage URI 体系见 [plugin-storage-api](./plugin-storage-api.md)
