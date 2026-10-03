# api-tools — 工具系统契约

**包名**: `@aalis/api-tools`  
**源码**: `packages/api-tools/src/index.ts`  
**实现**: `@aalis/plugin-tools`（`tools` 服务本体）；`@aalis/plugin-tool-system` 等 `plugin-tool-*` 是往里注册工具组的生产方

## 概述

定义 AI 工具系统的全部"非实现"契约：

- 工具数据结构（`RegisteredTool` / `ToolGroupInfo` / `ToolSummary`）
- 工具调用上下文（`ToolCallContext`）—— 平台/会话语义
- 工具执行通知（`ToolExecuteMessage`）与执行中的流式输出（`ToolOutputMessage`）
- 服务接口 `ToolService`、描述符 `tools`、绑定接口 `BoundTools`、`withToolGroups`
- 向 `AalisEvents` 注入 `'tool:execute'` 与 `'tool:output'`

**注**：runtime 工具函数已迁出本契约包（见 `packages/api-tools/src/index.ts` 迁出注释）：SSRF/私网判定 → `@aalis/util-network-guard`；工具输入路径解析 → `@aalis/api-storage`。本包只保留契约/类型与登记门面。

## 服务接口

```ts
interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void;
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
  getSummaries(filter?: { groups?: string[] }): ToolSummary[];
  getAll(): Array<{ name; description; pluginName; visibility; confirm?; risk?; groups?; display? }>;
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
  display?: ToolDisplay;                  // 工具卡与审批卡上的展示种类
}
```

`CapabilityVisibility` / `CapabilityConfirm` / `CapabilityRisk` 从 `@aalis/api-authority` 导入。

### 展示种类

```ts
type ToolDisplay =
  | { kind: 'command'; fields: { command: string; cwd?: string }; result?: { exitCode: string } }
  | { kind: 'file-change'; fields: { path: string; removed?: string; added?: string } };
```

`fields` 写明各项取自哪个参数（参数名）：`command` 是命令与工作目录；`file-change` 是路径，以及删、加两侧的文本，只有一侧的只写那一侧（`file_edit` 是 `{ path: 'path', removed: 'oldText', added: 'newText' }`，`file_write` 是 `{ path: 'path', added: 'content' }`）。`command` 的 `result` 写明退出码取自结果（JSON 对象）的哪个键（`exec` 是 `{ exitCode: 'exitCode' }`）：退出码不为 0 时工具卡记为失败、写明退出码；没写 `result`、结果不是 JSON 对象或那一项不是整数时不看退出码。种类是宿主维护的封闭集合，以后按加法加。

会话服务（[plugin-session-server](../plugins/plugin-session-server.md)）经 `getAll()` 取声明，从参数里逐字取出各项、工具返回时从结果里取退出码（取在 agent 截断过长的结果之前）：工具卡带解析好的展示（会话协议 tool-call 条目的 `display`），审批卡的事实按它取命令、工作目录与 diff。没声明、种类不认识、声明的命令或路径不是字符串时，界面走通用卡，审批卡逐字列出全部参数；前端不写工具名清单。

## ToolCallContext

`handler` 的第二参，描述这次调用发生在哪里、以谁的身份：

```ts
interface ToolCallContext {
  sessionId: string;
  userId?: string;                                  // 消息物理来源的发言者（会话语义）
  platform?: string;                                // 会话所属平台
  actor?: { platform: string; userId: string };    // 授权身份；缺省即 (platform, userId)
  enabledGroups?: string[];                         // 当前会话启用的工具分组
  acceptsImages?: boolean;                          // 调用方能把结果里的图片交给主模型
  signal?: AbortSignal;                             // 调用方回合的中止信号
  inbound?: InboundTurn;                            // 调用所在的入站回合（source、续做的调用者 callerUserId；类型见 api-authority），只由 agent 工具循环填写
  turnId?: string;                                  // 调用所在回合的 id，只由 agent 工具循环填写
  callId?: string;                                  // 这次调用的 id，只由 agent 工具循环填写
}
```

`inbound` 用来正向判断「这次调用来自由入站消息驱动的 agent 回合」：

- 只有 plugin-agent 的工具循环填写它，`source` 取那条入站消息的 `IncomingMessage.source`：真人消息为 `undefined`，定时任务、闲置触发、宿主通知等内部注入为注入方标识。
- workflow 的 tool 节点、mcp-server 等自己构造上下文的调用方不填，`inbound` 缺省。
- 需要「真人当面发起」判据的工具，应把 `inbound` 缺省当作不满足，并拒绝 `inbound.source` 非空的调用。只看 `actor` 分不出来：定时任务注入的回合带着创建者的 `actor`。

`turnId` 与 `callId` 同样只由 agent 工具循环填写，与 `inbound` 同时出现。`turnId` 是所在回合的 id（见 [api-agent](./api-agent.md#回合-id)）；`callId` 由 agent 为每次调用生成、全局唯一（模型生成参数时报过进度的，用那时随进度推出的那一个），不取模型给的 tool call id——模型给的 id 不保证唯一，例如有的 provider 用毫秒时间戳加序号拼出来，并发的两轮会撞上。

## 会话设置项的键

本包经 declaration merging 给 [api-session-manager](./api-session-manager.md) 的 `SessionConfig` 加 `enabledToolGroups?: string[]`（启用的工具分组，`'*'` 为全部；没设置或为空时只给不属于任何分组的工具），由 [plugin-tools](../plugins/plugin-tools.md) 登记。agent 按会话的生效值填 `ToolCallContext.enabledGroups`。

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
  turnId: string;   // 所在回合
  callId: string;   // 这次调用，同 ToolCallContext.callId
  platform?: string;
  toolName: string;
  args: Record<string, unknown>;
  phase: 'start' | 'end';
  result?: string;  // 仅 phase='end'
}]
```

只由 agent 工具循环发出，开始与结束按 `callId` 配对，模型发出的每一次调用都有一对：参数不是合法 JSON 对象、执行前的钩子出错这类没有执行就失败的调用同样发一对，结束的 `result` 是回给模型的错误。会话服务（plugin-session-server）据此给出工具卡，`callId` 就是卡片的 `itemId`；模型生成参数期间，流式片段的工具调用进度已带上同一个 `callId`（见 [schema-message](./schema-message.md)），卡片在那时就出现。

```ts
'tool:output': [{
  sessionId: string;
  turnId: string;
  callId: string;   // 同 ToolCallContext.callId
  text: string;
}]
```

工具执行中的流式输出，在这次调用的开始与结束之间发出，只给界面看：不进模型、不落库，工具结果照旧在调用结束时一次给出。只有 agent 回合里的调用（`ToolCallContext` 带 `turnId` 与 `callId`）才发。现在发它的是 plugin-tool-system 的 `exec`：stdout 与 stderr 按到达顺序推出，总量不超过结果里保留的输出上限。

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
