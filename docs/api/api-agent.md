# api-agent — Agent 编排服务契约

**包名**: `@aalis/api-agent`  
**源码**: `packages/api-agent/src/index.ts`  
**实现**: `@aalis/plugin-agent`

## 概述

定义对话编排服务 `AgentService`、描述符 `agent`、绑定接口 `BoundAgent`，以及一组 `agent:*` 钩子与 `agent:prompt` 贡献点。Agent 负责接收用户消息后完成"组装系统提示 → 加载历史 → 调用 LLM → 执行工具循环 → 发出回复"的完整流程。

## 服务接口

```ts
interface AgentService {
  handleMessage(message: IncomingMessage): Promise<void>;
  abort?(sessionId: string, turnId?: string): boolean;
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;
  getPreprocessors?(): PreprocessorInfo[];
  getPluginGroups?(): PluginGroupInfo[];
}
```

对话调用走 `ServiceRef`（`agent.current` / `agent.require()`）。Gateway 在 `inbound:dispatch` 相位调 `handleMessage`，业务层很少直接取。

`abort` 不带 `turnId` 时停这个会话所有在飞的回合；带 `turnId` 时只停那一轮，它已经结束或换成了新一轮时什么也不停。返回值是有没有停下回合，调用方据此分辨「turnId 对不上」。

## 回合 id

实现者在一轮开始时生成回合 id（`turnId`），这一轮的 `agent:input:before`、`agent:turn:after`、流式片段（`outbound:stream`）、工具调用（`ToolCallContext` 与 `tool:execute`）与用量（`token:usage`）都带同一个 `turnId`。每次工具调用另有 `callId`，见 [api-tools](./api-tools.md#toolcallcontext)。回应 `token:request` 的用量快照不在任何回合里，不带 `turnId`。

## 落库与外发的约定

会话服务回看历史、在实时推送里标出「未发出」都依据下面几条，别的 agent 实现照此做，历史才与实时推送、与群里看到的一致：

- **元数据的键**：落库的工具调用组（带 `toolCalls` 的 assistant 与 tool 结果）与最终回复在元数据里记下这一轮的回合 id；每次工具调用（含没有执行就失败的）在 tool 结果的元数据与时间线的 `tool_call` 段记下这次调用的 `callId`；最终回复另记这一轮的模型与 token、这一轮的平台与她在那里的身份、这一轮的群与会话类型，回复是结构化输出的信封时另记解码后的可见正文。键一律用 schema-message 登记的 `WellKnownMetadataKeys`，各键见 [schema-message 的「存档元数据的键」](./schema-message.md#存档元数据的键)表里写方为 agent 的各项。`agent:tool:after` 里别的插件写进 `metadata` 的键随 tool 结果原样落库。
- **房间里一轮只把最后一条回复交给平台**：房间（会话种类为 `room` 的 IM 群与私聊）里，一轮里工具调用之前说的话、格式校验没通过而重试丢掉的几版都不发出（不经 `outbound:message`），只有最后一条回复发出。会话服务回看历史时据此把那几段标「未发出」；实时推送按平台的送达结果标，不受影响。

## 用量（token:usage）

`token:usage`（`TokenUsageEvent`）是一次模型调用的输入用量。实现者在每次调用模型之后发一次：首次调用、工具循环里的每次调用、格式重试的每次调用，调用抛错的那次不发。回应 `token:request` 时按会话现组一份消息列表发快照，不调用模型，快照不带 `turnId`；按用量触发动作的消费方（如摘要插件的自动压缩）据此排除快照。

- `used` 与 `usageRatio`：`used` 取模型服务返回的这次调用的输入 token（`ChatResponse.usage.promptTokens`），没有返回或不是正的有限数时（以及快照）按发出的消息与工具定义估算；`usageRatio` 是 `used / contextWindow`。
- `trimmed`：本回合到这次调用为止经过了硬裁剪，即这次或之前某次调用组装后的估算超过了 `tokenBudget`（不一定真裁掉了内容）。之后的调用在首次调用裁剪过的列表上追加，所以有过一次，本回合之后各次都算。
- `untrimmedHistory`：按没经过硬裁剪的消息列表估算的历史与工具结果 token；`breakdown` 的 `history`、`toolResults` 两项按发出的列表算。裁掉的部分仍在会话历史里，全量压缩能把它们一并压掉，摘要插件以它为可压缩部分。
- `historyMessages`：这次的消息列表里来自会话历史的条数，即这一轮开头从记忆读进的条数（含这一轮的入站消息），加本回合到这次调用为止追加的工具调用与结果。按读进与追加的算，与硬裁剪无关；快照只有读进的条数。

`breakdown` 与 `parts` 是同一份输入按来源估算的拆分，各项之和不必等于 `used`。`breakdown` 是按固定桶的数，供 AI 自检（plugin-prompt-budget）判断；`parts` 是同一份数按显示的次序排好、带显示名的拆分表，不含为回复预留的 `maxTokens`，供界面照画：

```ts
interface TokenUsagePart {
  label: string;                        // 显示名
  tokens: number;
  injectors?: Record<string, number>;   // 这一项按注入者的明细，键是注入者的全局键「插件实例 id/局部 id」
}
```

会话服务把 `parts` 原样放进会话协议的 `usage` 条目，界面按条目画行、不认分项的键。别的实现照样给出自己的分项与显示名。

## 会话设置项的键

本包经 declaration merging 给 [api-session-manager](./api-session-manager.md) 的 `SessionConfig` 加四个键，由 plugin-agent 登记：

```ts
interface SessionConfig {
  llm?: ModelRef;               // 会话用的模型；没设置时跟随 llm 服务的偏好
  think?: string;               // 深度思考的档位 id；没设置、当前模型没有这一档或不能调时按模型的默认档
  maxToolIterations?: number;   // 一轮里工具调用循环的最大次数（正整数）；没设置时为 30
  historyLimit?: number;        // 历史条数上限（非负整数）：一轮最多读进的会话历史条数，也是按条数压缩的线；0 或没设置时读全部活跃历史
}
```

## 绑定接口

```ts
interface BoundAgent extends ServiceRef<AgentService> {
  registerPreprocessor(name: string, handler: PreprocessorFn): () => void;
}
```

`registerPreprocessor` 走 `registrar`：同名替换，提供者换人自动重挂，随激活撤回。当前提供者不支持预处理器时本次不生效，换到支持的提供者时补上。不要对 `AgentService.registerPreprocessor` 自己传归属——门面已代填。

## 预处理器

```ts
type PreprocessorFn = (message: IncomingMessage, next: () => Promise<void>) => Promise<void>;
```

洋葱模型：调用 `next()` 把控制权交给下一个；不调用即吞掉消息（LLM 不会被调用）。常见用法：把图片识别为文字、解析文件内容、注入会话级 metadata。

当前提供者不实现该方法时，消费方可退到 `hooks.middleware('agent:input:before', ...)`（`packages/plugin-file-reader/src/index.ts`）。

## 钩子（HookContextMap）

| 钩子 | 时机 | payload |
|---|---|---|
| `agent:input:before` | 进入 Agent 之前；`next` 之后是这一轮的全部，不调即拦下整条消息 | `{ message, turnId, metadata }` |
| `agent:llm:before` | 调用 LLM 之前（含工具调用后的下一次请求） | `{ messages, tools, sessionId, source?, ... }`；`source` 与本回合 `IncomingMessage.source` 相同，真人消息缺省 |
| `agent:llm:after` | LLM 返回之后 | `{ response, messages }` |
| `agent:tool:before` | 工具调用之前 | `{ name, args, toolCallContext }` |
| `agent:tool:after` | 工具调用之后；`result` 可以改写，写进 `metadata` 的键随这次工具结果落库（tool 消息的元数据，`turnId`、`callId` 由 agent 写），供回看历史的一方还原调用的结局 | `{ name, result, toolCallContext, metadata }` |
| `agent:reply:before` | 发出回复之前 | `{ content, archiveContent?, visibleContent?, sessionId, ... }` |
| `agent:turn:after` | 一轮处理完成（消息在 `agent:input:before` 被拦下时不触发） | `{ message, reply, outcome, error?, sessionId, turnId, metadata }` |

这些键经 declaration merging 注入 `@aalis/api-hooks` 的 `HookContextMap`。钩子用 `hooks.middleware` 注册，`hooks` 描述符来自 `@aalis/api-hooks`（见 [api-hooks](./api-hooks.md)）。要让 TS 看到这些键，需把 `@aalis/api-agent` 加进依赖（值导入或 side-effect import）。

提示词注入不在这条链上：摘要、语义记忆、档案、技能等走 `agent:prompt` 贡献点（`contributions.contribute('agent:prompt', spec)`，契约见 [api-contributions](./api-contributions.md)），由 plugin-agent 的组装器在 `agent:llm:before` **之前**统一物化。

## 典型用法

```ts
import { agent } from '@aalis/api-agent';
import { hooks } from '@aalis/api-hooks';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-agent',
  uses: { agent: optional(agent), hooks },
  apply({ agent, hooks }) {
    agent.registerPreprocessor('suffix', async (message, next) => {
      message.content += ' [logged]';
      await next();
    });
    hooks.middleware('agent:turn:after', async (data, next) => {
      await next();
    });
  },
});
```

## 实现者列表

- [@aalis/plugin-agent](../plugins/plugin-agent.md) —— 默认实现，含 12 桶 token 预算追踪与工具循环

## 相关

- `IncomingMessage` / `Message` 定义在 [schema-message](./schema-message.md)
- `agent:turn:after` 的 `outcome` 字段是 `replied | silent | aborted | error`（四条退出路径都会触发，供生命周期订阅方收口）；结局为 `replied` 时最终回复已写进会话历史，它在最后一次模型调用之后落库，不在那次用量的 `historyMessages` 里，其余结局不落库最终回复；结局为 `error` 时 `error` 是一句原因（默认实现填发到会话的 `[错误]` 那句，或解析不出模型时 `[系统]` 那句），会话管理记进 `SessionInfo.lastTurn`，其余结局不带
- token 自检见 [plugin-prompt-budget](../plugins/plugin-prompt-budget.md)
- 关停时默认实现在 `lifecycle.onDrain` 中止在飞回合，见 [services/agent](../services/agent.md)
