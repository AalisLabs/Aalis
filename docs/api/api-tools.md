# api-tools — 工具系统契约

**包名**: `@aalis/api-tools`  
**源码**: `packages/api-tools/src/index.ts`  
**实现**: `@aalis/plugin-tools`（`tools` 服务本体）；`@aalis/plugin-tool-system` 等 `plugin-tool-*` 是往里注册工具组的生产方

## 概述

定义 AI 工具系统的全部"非实现"契约：

- 工具数据结构（`RegisteredTool` / `ToolGroupInfo` / `ToolSummary`），可转后台的执行器参数名判据 `takenBackgroundParams`
- 工具调用上下文（`ToolCallContext`）—— 平台/会话语义
- 工具执行通知（`ToolExecuteMessage`）与执行中的流式输出（`ToolOutputMessage`）
- 工具结果的结局：`toolFailed`、`integerIn`
- 服务接口 `ToolService`、描述符 `tools`、绑定接口 `BoundTools`、`withToolGroups`
- 后台任务登记：`BackgroundTask`、`BackgroundTaskService`、描述符 `backgroundTasks`；结束通知的种类 `BACKGROUND_TASK_NOTICE` 与事实 `BackgroundTaskNoticeFacts`
- 向 `AalisEvents` 注入 `'tool:execute'`、`'tool:output'` 与 `'background:changed'`

**注**：runtime 工具函数已迁出本契约包（见 `packages/api-tools/src/index.ts` 迁出注释）：SSRF/私网判定 → `@aalis/util-network-guard`；工具输入路径解析 → `@aalis/api-storage`。本包只保留契约：类型、描述符与登记门面，以及契约里约定的判据（工具结果的结局、执行器参数名）。

## 服务接口

```ts
interface ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>, contextId: string): () => void;
  getDefinitions(filter?: { groups?: string[] }): ToolDefinition[];
  getSummaries(filter?: { groups?: string[] }): ToolSummary[];
  getAll(): Array<{ name; description; pluginName; visibility; confirm?; risk?; groups?; display? }>;
  execute(toolName: string, args: Record<string, unknown>, callCtx: ToolCallContext): Promise<ToolExecutionResult>;
  setExecutionGuard(guard: ExecutionGuard | undefined): void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>, contextId: string): () => void;
  getGroups(): ToolGroupInfo[];
}
```

插件侧不要直接调 `ToolService.register(..., contextId)`。`contextId` 由绑定门面填本次激活 id。

`setExecutionGuard` 注入执行守卫；传 `undefined` 摘掉，需要更高等级或确认的工具退回 fail-closed。plugin-authority 激活时注入、停用时摘掉。

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
  background?: { yieldSeconds?: number }; // 可以转后台，见下文
}
```

`CapabilityVisibility` / `CapabilityConfirm` / `CapabilityRisk` 从 `@aalis/api-authority` 导入。

### 可转后台

`background` 声明这个工具可以转到后台：它响应中止信号（`ToolCallContext.signal`），晚些拿到结果仍有意义。执行器（[plugin-tools](../plugins/plugin-tools.md)）对声明了的工具统一处理：

- 发给模型的参数表多两项：`runInBackground`（布尔，立即转后台）与 `waitSeconds`（前台最多等多少秒）。执行时这两项先取出，再做参数校验、过守卫、交给工具；审批事实与工具拿到的参数里都没有它们。参数表里已有同名项的工具当作没声明，执行器记一条警告，工具照常登记。`takenBackgroundParams(parameters)` 回参数表里已有的这两项的名字，执行器按它判断；桥接远端工具的插件据此不声明，等多久照远端调用自己的超时。
- 过了守卫之后先在前台等让出时限：`waitSeconds`，缺省取 `yieldSeconds`，再缺省是 30 秒；上限取执行器的配置。在前台时回合中止（停止键、新消息打断）一并中止它。
- 到时没结束、或带了 `runInBackground`，对话回合里的调用登记成后台任务（见下文「后台任务登记」），先回给模型任务 id、已有输出的末尾与一句「已转到后台，结束时会通知你；不必等它，可以先回复」；此后回合怎样都不动它，结束时通知起它的会话。不在对话回合里的调用（没有 `turnId` 或 `callId`，如 workflow 的工具节点、mcp-server）没有可以通知的对话：带 `runInBackground` 直接回错，到让出时限还没结束就中止并回报已有输出。
- 同一会话里对话回合中在跑的可转后台调用有上限（前台与后台一起数），满了时新的调用在过守卫之前就被拒绝。不在对话回合里的调用不会转后台，不占名额。

没声明的工具照旧等到底，照它们自己的超时。`background` 不进 `ToolDefinition`（那是发给模型的线上格式）。

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
  inbound?: InboundTurn;                            // 调用所在的入站回合（source、续做的调用者 callerUserId、入站消息 id messageId；类型见 api-authority），只由 agent 工具循环填写
  turnId?: string;                                  // 调用所在回合的 id，只由 agent 工具循环填写
  callId?: string;                                  // 这次调用的 id，只由 agent 工具循环填写
  output?: (text: string) => void;                  // 执行中的输出口，执行器给每次调用一份
}
```

`signal` 由调用方传回合的中止信号。可转后台的工具拿到的是执行器给这次调用的信号：在前台时随回合一并中止，转到后台之后只随停止、工具撤回登记与执行器停用中止。

`output` 由执行器填写，调用方不填。工具执行中把输出写进它：有 `turnId` 与 `callId` 时转成 `tool:output` 推给界面，一次调用推出的总量不超过 64 KiB；可转后台的调用另留进这次调用的输出缓冲（只留末尾 64 KiB），后台任务的最后一行、最后输出时间与取输出都取它。工具结果照旧在调用结束时一次给出。

`inbound` 用来正向判断「这次调用来自由入站消息驱动的 agent 回合」：

- 只有 plugin-agent 的工具循环填写它，`source` 取那条入站消息的 `IncomingMessage.source`：真人消息为 `undefined`，定时任务、闲置触发、宿主通知等内部注入为注入方标识。
- workflow 的 tool 节点、mcp-server 等自己构造上下文的调用方不填，`inbound` 缺省。
- 需要「真人当面发起」判据的工具，应把 `inbound` 缺省当作不满足，并拒绝 `inbound.source` 非空的调用。只看 `actor` 分不出来：定时任务注入的回合带着创建者的 `actor`。

`inbound.messageId` 是那条入站消息的平台消息 id（`IncomingMessage.messageId`，平台适配器填写，没有的不带）。转到后台的调用结束时，执行器把它写进结束通知的 `hostNotice.replyTo`，她回复通知时引用这条消息。

`turnId` 与 `callId` 同样只由 agent 工具循环填写，与 `inbound` 同时出现。`turnId` 是所在回合的 id（见 [api-agent](./api-agent.md#回合-id)）；`callId` 由 agent 为每次调用生成、全局唯一（模型生成参数时报过进度的，用那时随进度推出的那一个），不取模型给的 tool call id——模型给的 id 不保证唯一，例如有的 provider 用毫秒时间戳加序号拼出来，并发的两轮会撞上。

## 会话设置项的键

本包经 declaration merging 给 [api-session-manager](./api-session-manager.md) 的 `SessionConfig` 加 `enabledToolGroups?: string[]`（启用的工具分组，`'*'` 为全部；没设置或为空时只给不属于任何分组的工具），由 [plugin-tools](../plugins/plugin-tools.md) 登记。agent 按会话的生效值填 `ToolCallContext.enabledGroups`。

## 描述符与绑定门面

```ts
interface BoundTools extends ToolService {
  register(tool: Omit<RegisteredTool, 'pluginName'>): () => void;
  registerGroup(group: Omit<ToolGroupInfo, 'pluginName'>): () => void;
}

function withToolGroups(bound: BoundTools, groups: string[]): BoundTools;
```

`tools` 是登记型能力：`register` / `registerGroup` 走 `registrar`，同名替换、提供者换人整体重挂、关闭后拒收。查询与执行经业务句柄转发给选中的那一家：`tools.use.getDefinitions(...)`、`tools.use.execute(...)`。

`withToolGroups` 接 `tools.use`，只覆盖 `register`，其余沿原型链落到原接口，跟着提供者换人。不要对象展开一份 `BoundTools`——提供者的成员经原型链上的活句柄转发，展开只得到 `register` / `registerGroup`。

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

工具执行中的流式输出（工具写进 `ToolCallContext.output` 的文字），在这次调用的开始与结束之间发出，只给界面看：不进模型、不落库，工具结果照旧在调用结束时一次给出。只有 agent 回合里的调用（`ToolCallContext` 带 `turnId` 与 `callId`）才发；转到后台的调用此后不再发，进度看后台任务登记。

```ts
'background:changed': [{ task: BackgroundTask } | { removed: string; sessionId: string }]
```

后台任务登记变了：开始、结束、最后一行与最后输出时间变化（带变了的任务），或删掉（带任务 id 与所在会话）。

## 工具结果的结局

```ts
function integerIn(result: string, key: string): number | undefined;
function toolFailed(result: string, exitCode?: number): boolean;
```

`toolFailed`：结果是带 `error` 的 JSON 对象（工具与执行器报失败的约定），或退出码不为 0，即为失败。退出码按展示种类取：`command` 种类写明了取自结果的哪个键时，用 `integerIn(result, display.result.exitCode)` 取。执行器判后台任务的结局与会话服务判工具卡的状态共用这一份，模型与界面看到同一个结局。

## 后台任务登记

```ts
interface BackgroundTask {
  id: string;
  sessionId: string;
  kind: 'tool-call';                 // 宿主维护的封闭集合，以后按加法加
  label: string;                     // 显示名：工具调用是工具名
  call: { tool: string; args: Record<string, unknown>; turnId: string; callId: string }; // 起它的那次调用，参数是模型给的原样
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'aborted';
  startedAt: number;
  endedAt?: number;
  lastLine?: string;                 // 输出的最后一行
  lastOutputAt?: number;             // 最后一次有输出的时刻
  reason?: string;                   // 失败或中断的一句原因：失败的取自结果里的 error
  exitCode?: number;                 // 命令的退出码：声明了 command 种类展示、结束时取得到才有（随登记落盘）
  result?: ToolExecutionResult;      // 结束的任务：工具的结果（不落盘）
}

interface BackgroundTaskService {
  list(filter?: { sessionId?: string }): BackgroundTask[];
  output(id: string, after?: number): { text: string; end: number; truncated: boolean } | undefined;
  stop(id: string): Promise<BackgroundTask | undefined>;
}

export const backgroundTasks = defineService<BackgroundTaskService>('background-tasks');
```

由 [plugin-tools](../plugins/plugin-tools.md) 提供，现在唯一的登记方是它的执行器（转到后台的工具调用）。会话服务（[plugin-session-server](../plugins/plugin-session-server.md)）把它投影成会话协议的后台任务（[api-session-protocol](./api-session-protocol.md#后台任务) 的 `background/*`），不下发参数与结果。

**局限：** 契约只有列出、取输出与停止，没有登记的口。别的插件自己的长任务进不了 WebUI 的「后台」标签与运行状况的「正在运行」，第三方的替代面板也只看得到转后台的工具调用与子会话。通用的登记口（经 registrar 登记、随激活撤回，执行器也改走同一个口，`kind` 按加法加一个通用种类）在远端任务拆成独立插件时开，那是第一个执行器之外的登记方。

- `list`：在跑的与保留的结束的任务（每个会话留最近 20 条结束的），给 `sessionId` 时只列这个会话的。
- `output`：`text` 是 `after` 之后的输出；`end` 是至今的输出总字数，下次带作 `after` 只取新增的；缓冲只留末尾 64 KiB，早于缓冲的部分取不到时 `truncated` 为 true。Aalis 重启前的任务没有留下输出。
- `stop`：中止并等它落定（宽限 3 秒），回落定后的任务；宽限内没停下的仍是 `running`，之后停下时记为 `stopped`。被停止的不通知。
- 结局：结果带 `error` 或退出码不为 0 为 `failed`；`stop` 停的为 `stopped`；工具撤回登记、执行器停用、重启时还在跑的为 `aborted`；其余 `completed`。

### 结束通知

```ts
export const BACKGROUND_TASK_NOTICE = 'background-task';

type BackgroundTaskNoticeFacts = {
  tool: string;                      // 工具名
  status: 'completed' | 'failed';    // 只有正常结束（含失败）的才通知
  durationMs: number;                // 用时
  exitCode?: number;                 // 失败的命令取得到退出码时带上
};
```

任务正常结束（含失败）时，执行器向起它的会话注入一条宿主通知（[schema-message](./schema-message.md#宿主通知-hostnotice)）：`hostNotice.kind` 为 `BACKGROUND_TASK_NOTICE`，`id` 为任务 id，`facts` 为 `BackgroundTaskNoticeFacts`；正文写给模型，只写同样的事实，结果与输出由模型用 `background_output` 取。通知的身份、引用与链只延续一层等约定见 [plugin-tools](../plugins/plugin-tools.md#转后台与后台任务)。界面按 `BACKGROUND_TASK_NOTICE` 认出结束通知（会话协议的通知条目带 `noticeId` 与 `facts`，见 [api-session-protocol](./api-session-protocol.md)），按事实画成一行状态，不显示写给模型的正文，也不认工具名。

## 典型用法

```ts
import { tools, withToolGroups } from '@aalis/api-tools';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-tools',
  uses: { tools: optional(tools) },
  apply({ tools }) {
    const grouped = withToolGroups(tools.use, ['custom']);
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

登记不强制把 `tools` 标成 required：绑定门面在提供者未就绪时排队，就绪后挂上。若还要读 `getDefinitions` / `getAll` / `execute`，应 `uses: { tools }`（required），经 `tools.use` 调用（缺席规则见 [选择层与业务层](../core/context.md#选择层与业务层)），或先看 `tools.present`。

## 实现者

- [@aalis/plugin-tools](../plugins/plugin-tools.md) —— `tools` 服务本体（注册表、分组、可见性、执行器）与 `backgroundTasks`
- [@aalis/plugin-tool-system](../plugins/plugin-tool-system.md) —— 往里注册 `system` 一个工具组（含 shell / 文件 / 系统信息 / HTTP 四类工具）

## 相关

- 权限校验见 [api-authority](./api-authority.md)
- storage URI 体系见 [api-storage](./api-storage.md)
