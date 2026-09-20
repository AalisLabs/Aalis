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
  abort?(sessionId: string): void;
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;
  getPreprocessors?(): PreprocessorInfo[];
  getPluginGroups?(): PluginGroupInfo[];
}
```

对话调用走 `ServiceRef`（`agent.current` / `agent.require()`）。Gateway 在 `inbound:dispatch` 相位调 `handleMessage`，业务层很少直接取。

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
| `agent:input:before` | 进入 Agent 之前 | `{ message, metadata }` |
| `agent:llm:before` | 调用 LLM 之前 | `{ messages, tools, sessionId, ... }` |
| `agent:llm:after` | LLM 返回之后 | `{ response, messages }` |
| `agent:tool:before` | 工具调用之前 | `{ name, args, toolCallContext }` |
| `agent:tool:after` | 工具调用之后 | `{ name, result, toolCallContext }` |
| `agent:reply:before` | 发出回复之前 | `{ content, archiveContent?, sessionId, ... }` |
| `agent:turn:after` | 一轮处理完成 | `{ message, reply, outcome, sessionId, metadata }` |

钩子用 `hooks.middleware` 注册。要让 TS 看到这些键，需把 `@aalis/api-agent` 加进依赖（值导入或 side-effect import）。

提示词注入不在这条链上：摘要、语义记忆、档案、技能等走 `agent:prompt` 贡献点（`contributions.contribute('agent:prompt', spec)`），由 plugin-agent 的组装器在 `agent:llm:before` **之前**统一物化。

## 典型用法

```ts
import { agent } from '@aalis/api-agent';
import { definePlugin, hooks, optional } from '@aalis/core';

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
