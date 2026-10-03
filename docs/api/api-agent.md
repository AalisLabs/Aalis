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

plugin-agent 落库的工具调用组（带 `toolCalls` 的 assistant 与 tool 结果）与最终回复在 `metadata.turnId` 记下这一轮的回合 id；每次工具调用（含没有执行就失败的）在 tool 结果的 `metadata.callId` 与时间线的 `tool_call` 段记下这次调用的 `callId`。

## 会话设置项的键

本包经 declaration merging 给 [api-session-manager](./api-session-manager.md) 的 `SessionConfig` 加三个键，由 plugin-agent 登记：

```ts
interface SessionConfig {
  llm?: ModelRef;               // 会话用的模型；没设置时跟随 llm 服务的偏好
  think?: boolean;              // 深度思考开关；没设置时由各模型服务自己的配置决定
  maxToolIterations?: number;   // 一轮里工具调用循环的最大次数（正整数）；没设置时用对话代理的配置
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
| `agent:turn:after` | 一轮处理完成（消息在 `agent:input:before` 被拦下时不触发） | `{ message, reply, outcome, sessionId, turnId, metadata }` |

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
- `agent:turn:after` 的 `outcome` 字段是 `replied | silent | aborted | error`（四条退出路径都会触发，供生命周期订阅方收口）
- token 自检见 [plugin-prompt-budget](../plugins/plugin-prompt-budget.md)
- 关停时默认实现在 `lifecycle.onDrain` 中止在飞回合，见 [services/agent](../services/agent.md)
