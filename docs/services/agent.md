# agent 服务（对话回合编排）

> 受众：想替换/扩展对话编排引擎，或想在 LLM 回合的各阶段挂钩子（预处理、改提示、改回复、收尾）的第三方插件作者。

## 1. 定位

`agent` 是**对话回合编排引擎**——接收一条入站消息，组装系统提示 + 历史，调用 `llm`，跑工具调用循环，最终把回复派发出去，并在每个阶段广播 `agent:*` 钩子。

- 服务注册名：描述符 `agent`（`name: 'agent'`），绑定接口 `BoundAgent`
- 契约包：`@aalis/api-agent`（`packages/api-agent/src/index.ts`）
- 默认实现：`@aalis/plugin-agent`（`packages/plugin-agent/src/index.ts`，类 `DefaultAgent`）

`agent` 是「编排者」而非「能力」：它本身不持有 LLM/记忆/工具，而是经 `uses` 组合 `llm` / `memory` / `persona` / `tools` / `message-archive` / `session-manager` / `gateway`，全部 optional（缺哪个就降级，见 §6/§7）。

## 2. 契约

`AgentService` 接口（`packages/api-agent/src/index.ts`）。注意只有 `handleMessage` 是必须的，其余全为可选方法：

```ts
export interface AgentService {
  handleMessage(message: IncomingMessage): Promise<void>;
  abort?(sessionId: string): void;
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;
  getPreprocessors?(): PreprocessorInfo[];
  getPluginGroups?(): PluginGroupInfo[];
}

export interface BoundAgent extends ServiceRef<AgentService> {
  registerPreprocessor(name: string, handler: PreprocessorFn): () => void;
}
```

- `PreprocessorFn`：洋葱模型 `(message, next) => Promise<void>`；**不调 `next()` 即中断整条管线**。
- `registerPreprocessor` 走 `registrar`：同名替换、提供者换人自动重挂、随激活撤回。当前提供者不支持预处理器时本次不生效，换到支持的提供者时补上。
- 对话调用走 `agent.current` / `agent.require()`。`current` 每次读取重新解析当前胜者。
- `TokenUsageEvent` / `TokenUsageBreakdown`：每次 LLM 调用后通过 `token:usage` 事件 emit 的 12 桶 prompt 预算快照。

`agent:*` 钩子（declaration merging 注入 `HookContextMap`）——这是 agent 服务最重要的扩展面：

| 钩子 | 触发时机 | data 关键字段 |
|---|---|---|
| `agent:input:before` | 回合最开始，预处理 | `{ message, metadata }`。不调 `next()` → 拦截整条消息 |
| `agent:llm:before` | 每次调 LLM 前（首轮 + 每次工具迭代） | `{ messages, tools, sessionId?, … }`。可改 `messages`/`tools` |
| `agent:llm:after` | 每次 LLM 返回后 | `{ response, messages }` |
| `agent:tool:before` | 每个工具执行前 | `{ name, args, toolCallContext }` |
| `agent:tool:after` | 每个工具执行后 | `{ name, result, toolCallContext }` |
| `agent:reply:before` | 定稿前，回复校验/修复 | `{ content, sessionId, …; retryRequested?, retryFeedback?, attempt?, maxRetries? }` |
| `agent:turn:after` | 回合终态（四条路径都发） | `{ message, reply, outcome, sessionId, metadata }`。`outcome ∈ 'replied'｜'silent'｜'aborted'｜'error'` |

钩子用 `hooks.middleware` 注册。要让 TS 看到这些键，需把 `@aalis/api-agent` 加进依赖。

> **提示词注入不在这条链上**：摘要、语义记忆、用户档案、关系图、技能正文、平台提示等走 `agent:prompt` 贡献点（`contributions.contribute`），由 plugin-agent 的组装器在 `agent:llm:before` **之前**统一物化。往提示词加内容请用贡献点，本钩子留给改写/截停语义。

## 3. 谁提供 / 谁消费

**提供方**：`@aalis/plugin-agent`。`provides: [agent]`，`provide(agent, agentImpl)`，未声明 priority（= 默认 0）。

**消费方**：

- `plugin-gateway`：入站终相 `inbound:dispatch` 调 `agent.handleMessage(message)`——**这是 agent 被驱动的主入口**。
- `plugin-webui-server`：收到 WS `abort` 消息时调 `agent.current?.abort(sessionId)`。
- `plugin-file-reader` / `plugin-media`：`agent.registerPreprocessor(...)`。当前提供者不实现该方法时退到 `hooks.middleware('agent:input:before', ...)`（`packages/plugin-file-reader/src/index.ts`）。

**钩子订阅方**：`plugin-persona`（`agent:reply:before`）、`plugin-checkpoint`、`plugin-session-manager`、`plugin-memory-summary`、`plugin-subtask` / `plugin-tool-search` 等。

## 4. 写一个 provider

99% 的需求用**钩子**就够了，无需替换整个服务。只有当你要彻底接管编排逻辑时才自己 provide `agent`。

**最小必须**：只需 `handleMessage`。省略 `abort` 则前端「停止生成」失效，省略 `registerPreprocessor` 则绑定门面在当前提供者上本次不生效。

```ts
import { agent, type AgentService } from '@aalis/api-agent';
import { definePlugin, optional, provide } from '@aalis/core';
import { llm } from '@aalis/api-llm';
import type { IncomingMessage } from '@aalis/schema-message';

class MyAgent implements AgentService {
  async handleMessage(_message: IncomingMessage): Promise<void> {
    // 跑 input:before → llm:before → 工具循环 → reply:before → turn:after
  }
  abort(_sessionId: string): void {}
}

export default definePlugin({
  name: '@acme/plugin-my-agent',
  provides: [agent],
  uses: { provide, llm: optional(llm) },
  apply({ provide }) {
    provide(agent, new MyAgent(), { priority: 50 });
  },
});
```

default agent 用整个 service 注册（不是 per-entry）。自定义 `handleMessage` 必须在四条终态路径都发 `agent:turn:after`——否则 `session-manager` 永远把会话停在 `active`、`checkpoint` 回合永不关闭。

## 5. 标准消费方式

`agent.current` 每次读取重新解析。不要把返回值或 `agent.all()[i]` 存进字段：提供者换人后旧引用失效；关停边不保护缓存引用。

```ts
const svc = agent.current;
if (svc?.abort) svc.abort(sessionId);
```

登记预处理器：

```ts
import { agent } from '@aalis/api-agent';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-my-pre',
  uses: { agent: optional(agent) },
  apply({ agent }) {
    agent.registerPreprocessor('my-pre', async (msg, next) => {
      await next();
    });
  },
});
```

门面已把退订挂到本次激活，不必再手写 `lifecycle.onDispose`。

**服务缺失**：`agent` 全 optional 依赖。`llm` 缺失会回一条 `[系统]` 前缀诊断消息；`memory` 缺失则无历史；`gateway` 缺失则 fallback 到 `events.emit('outbound:message')`（**跳过审计/脱敏/限速/authority 中间件链，仅限测试/嵌入式**）。

**关停**：以激活为单位分 drain / close 两阶段。默认实现在 `lifecycle.onDrain` 里先 `abortInflightAndSettle()`（与 WebUI「停止生成」同语义），再等在飞回合 Promise——收尾段 memory / 钩子还在，中止后的交接写得进去；`onDispose` 再 `abortAll()` 一次，给 drain 超时或未走到收尾兜底。依赖交接放 `onDrain`：根激活若用插件的服务，根 drain 先于插件 close，到根的 `onDispose` 时插件可能已关。llm / memory / gateway 等是普通依赖，消费者整个 close 完提供者才 drain，故本插件 `onDispose` 期间那些依赖仍在。单独卸载某个提供者没有交接保证。超时沿用 core 对 `onDrain` 的 `disposeTimeoutMs`，不另加配置键（`packages/plugin-agent/src/index.ts`）。

## 6. 能力 / 风险 → 影响

**ToolCallContext 的 actor 优先**：agent 构造工具上下文时用 `incoming.actor` 作授权身份，`platform`/`userId` 保持会话语义。默认实现还传入 `enabledGroups`、`acceptsImages: true`、以及回合 `signal`（守卫等待确认期间被 abort 的工具不再执行）。自定义 provider 必须保留 actor 语义，否则系统触发的工具会以错误身份执权。

**reply:before 重试协议**：钩子可置 `retryRequested=true` + `retryFeedback` + `maxRetries`；用尽后若仍 `retryRequested` 强制把 `content` 置空。

**token 预算契约**：每次 LLM 调用后 emit `token:usage`；监听 `token:request` 在客户端重连时重算快照。

**出站走 gateway**：回复经 `gateway.dispatchOutbound`。provider 务必经 gateway，不要直接 emit。

## 7. 边界情形与注意事项（审计标注）

**`abort(sessionId)` 用 `startsWith` 匹配 lane**：lane key = `${sessionId}::${source}`。`abort('S')` 会一次性中止 `S` 的**所有** lane。若存在 sessionId 互为前缀的命名，`startsWith` 可能误伤——调用方需保证 sessionId 不互为前缀。

**`abort` 中止不了已经进入 `execute` 的工具**：`AbortSignal` 在 LLM 流式消费和工具循环每次迭代头部被检查。一旦进入并行 `tools.execute()`，当前在飞的 handler 会跑完，副作用照常发生，只是下一轮 LLM 不再发起。默认实现把 `signal` 放进 `ToolCallContext`，工具 handler 可自行尊重它；契约不强制每个工具都中断。

**abort 路径不回滚已完成的工具记录**（有意为之）：删除会让 agent「忘记自己刚做过的有副作用的事」导致下一轮重复调用。真正的 orphan 由 `sanitizeToolCallHistory` 在装载历史时兜底过滤。

**`getPluginGroups()` 硬编码子系统服务集**：只纳入 `llm/memory/persona/message-archive`，不含 `platform`。

## 8. 交叉链接

- [concepts/message-llm-pipeline](../concepts/message-llm-pipeline.md)
- [concepts/service-model](../concepts/service-model.md)
- [concepts/lazy-service-access](../concepts/lazy-service-access.md)
- [concepts/manifest-metadata](../concepts/manifest-metadata.md)
- [concepts/security-model](../concepts/security-model.md)
- [plugins/plugin-authority](../plugins/plugin-authority.md) / [plugins/plugin-tools](../plugins/plugin-tools.md)
- [core/events](../core/events.md)
- [services/llm](./llm.md)、[services/memory](./memory.md)、[services/message-archive](./message-archive.md)、[services/gateway](./gateway.md)
