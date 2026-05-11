# plugin-agent-api — Agent 编排服务契约

**包名**: `@aalis/plugin-agent-api`  
**源码**: `packages/plugin-agent-api/src/index.ts`  
**实现**: `@aalis/plugin-agent-default`

## 概述

定义对话编排服务 `AgentService` 与一组 `agent:*` 钩子。Agent 负责接收用户消息后完成"组装系统提示 → 加载历史 → 调用 LLM → 执行工具循环 → 发出回复"的完整流程。

## 服务接口

```ts
interface AgentService {
  handleMessage(message: IncomingMessage): Promise<void>;
  abort?(sessionId: string): void;
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;
  getPreprocessors?(): PreprocessorInfo[];
  getPluginGroups?(): PluginGroupInfo[];
}
```

通过 `ctx.getService<AgentService>('agent')` 获取（实际由 Gateway 在 `inbound:dispatch` 相位自动注入到 `InboundPhaseData.agent`，业务层很少直接取）。

## 预处理器

```ts
type PreprocessorFn = (message: IncomingMessage, next: () => Promise<void>) => Promise<void>;
```

洋葱模型：调用 `next()` 把控制权交给下一个；不调用即吞掉消息（LLM 不会被调用）。常见用法：把图片识别为文字、解析文件内容、注入会话级 metadata。

## 钩子（HookContextMap）

| 钩子 | 时机 | payload |
|---|---|---|
| `agent:input:before` | 进入 Agent 之前 | `{ message, metadata }` |
| `agent:llm:before` | 调用 LLM 之前 | `{ messages, tools, sessionId, ... }` |
| `agent:llm:after` | LLM 返回之后 | `{ response, messages }` |
| `agent:tool:before` | 工具调用之前 | `{ name, args, toolCallContext }` |
| `agent:tool:after` | 工具调用之后 | `{ name, result, toolCallContext }` |
| `agent:reply:before` | 发出回复之前 | `{ content, archiveContent?, sessionId, ... }` |
| `agent:turn:after` | 一轮处理完成 | `{ message, reply, outcome, sessionId, metadata }` |

## 典型用法

```ts
// 注册一个把所有用户输入末尾加签的 preprocessor
const dispose = ctx.useHook('agent:input:before', async (data, next) => {
  data.message.content += ' [logged]';
  await next();
});
```

## 实现者列表

- [@aalis/plugin-agent-default](../plugins/plugin-agent-default.md) —— 默认实现，含 12 桶 token 预算追踪与工具循环

## 相关

- `IncomingMessage` 定义在 [plugin-message-api](./plugin-message-api.md)
- `agent:turn:after` 的 `outcome` 字段是 `replied | silent | aborted`
- token 自检见 [plugin-prompt-budget](../plugins/plugin-prompt-budget.md)
