# agent 服务（对话回合编排）

> 受众：想替换/扩展对话编排引擎，或想在 LLM 回合的各阶段挂钩子（预处理、改提示、改回复、收尾）的第三方插件作者。

## 1. 定位

`agent` 是**对话回合编排引擎**——接收一条入站消息，组装系统提示 + 历史，调用 `llm`，跑工具调用循环，最终把回复派发出去，并在每个阶段广播 `agent:*` 钩子。

- 服务注册名：描述符 `agent`（`name: 'agent'`），绑定接口 `BoundAgent`
- 契约包：`@aalis/api-agent`（`packages/api-agent/src/index.ts`）
- 默认实现：`@aalis/plugin-agent`（`packages/plugin-agent/src/index.ts`，类 `DefaultAgent`）

`agent` 是「编排者」而非「能力」：它本身不持有 LLM/记忆/工具，而是经 `uses` 组合 `llm` / `memory` / `persona` / `tools` / `message-archive` / `session-manager` / `gateway`，全部 optional（缺哪个就降级，见 §6/§7）。事件、钩子与贡献点是 required 服务 `events` / `hooks` / `contributions`，由 `@aalis/plugin-events` / `@aalis/plugin-hooks` / `@aalis/plugin-contributions` 提供，缺少时默认实现停在 pending。

## 2. 契约

`AgentService` 接口（`packages/api-agent/src/index.ts`）。`handleMessage`、`abort`、`clearing` 与 `assignModel` 必须实现，`registerPreprocessor` 可选：

```ts
export interface AgentService {
  handleMessage(message: IncomingMessage): Promise<void>;
  abort(
    sessionId: string,
    options?: { turnId?: string; queued?: boolean; reason?: string; by?: NonNullable<IncomingMessage['actor']> },
  ): boolean;
  clearing(sessionIds: readonly string[] | undefined, clear: () => Promise<unknown>, reason?: string): Promise<void>;
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void;
  assignModel(sessionId: string, model: ModelRef): Promise<void>;
}

export interface BoundAgent extends AgentService {
  registerPreprocessor(name: string, handler: PreprocessorFn): () => void;
}
```

- `PreprocessorFn`：洋葱模型 `(message, next) => Promise<void>`，挂在 `agent:input:before` 上，每条输入一次、在它进入一轮之前；**不调 `next()` 即丢掉这条输入**（不进一轮、不归档）。
- `registerPreprocessor` 走 `registrar`：同名替换、提供者换人自动重挂、随激活撤回。当前提供者不支持预处理器时本次不生效，换到支持的提供者时补上。
- 对话调用走业务句柄 `agent.use`（如 `agent.use.handleMessage(message)`）：转发给本插件选中的那一家，每次访问成员重新解析。`handleMessage` 返回时这条输入已落定（所在的一轮结束，或它被放掉、没进一轮就被丢掉）；入口记下这个会话的代号（api-session-manager 的 `generationOf`），交给通道之前（按住期间等着的放开之后）再取一次，变了的是会话删除之前的一代，放掉、不归档。
- `abort(sessionId, { turnId?, queued?, reason?, by? })`：停下这个会话在跑的一轮。给了 `turnId` 而对不上（那一轮已结束或换成了新一轮）时什么也不停；`queued` 为真时连同排队与待插入、还没进一轮的输入一起放掉（不开轮，在那一轮落定之后归档，不带回合 id），否则它们照常开下一轮；`reason` 只写进回合结束那一行日志；`by` 是停下这一轮的人（与入站的 `actor` 同一形状），不给即没有具体的人，参考实现据此在历史里给下一轮的模型写停下标记（schema-message 的 `TurnStopped`）。返回有没有停下在跑的一轮。
- `clearing(sessionIds, clear, reason?)`：清消息历史的一方（`/clear` 与会话管理删会话）把整条清理（`memory:clear` 链连同默认动作；会话管理删会话时交来的先删各级子会话、发 `session:deleted`）交给它：先停下这些会话（不给即全部会话）在跑的一轮、放掉排着与待插入的输入（不归档），等它们落定再跑 `clear`，按住这些会话到 `clear` 结束，这期间到的输入之后再处理。停下与按住在各家清理之外，不看中间件的登记先后。实现者自己的 `session:deleted` 监听在这次按住之内被调用，不能等按住放开。`reason` 同 `abort` 的，只写进回合结束那一行日志。
- 事件 `agent:queue`：`{ sessionId, waiting }`，这个会话排着与待插入、还没进一轮的输入（已过逐条处理，按入队先后），入队、进了一轮、被放掉时发。
- `assignModel(sessionId, model)`：把这个会话本会话层的对话模型设成 `model`（写进会话设置）。子任务插件给子会话指定模型时，在建好之后、发首条消息之前调；会话设置不在或写入被拒时抛错。
- `TokenUsageEvent` / `TokenUsageBreakdown` / `TokenUsagePart`：每次 LLM 调用之后通过 `token:usage` 事件 emit 的输入用量：`used` 取模型服务返回的输入 token（没有时取估算），12 桶拆分与按显示次序排好、带显示名的拆分表 `parts`（界面照画）是估算的拆分，另带本回合到这次调用为止是否经过了硬裁剪（`trimmed`）、按没经过硬裁剪的列表估算的历史与工具结果（`untrimmedHistory`）、会话历史的条数（`historyMessages`，只数对话消息，含条数线之外、没发给模型的部分）与所在回合的 `turnId`（回应 `token:request` 的快照不带）。
- **回合 id**：实现者在一轮开始时生成 `turnId`，这一轮的 `agent:turn:before`、`agent:turn:after`、输入的归档（`archiveIncoming` 的回合参数，存档记成 `TurnId` 与进入方式 `TurnEntry`）、`outbound:stream`、`ToolCallContext` 与 `tool:execute`、`token:usage` 都带同一个。每次工具调用另生成全局唯一的 `callId`（不取模型给的 tool call id，模型给的不保证唯一），工具开始与结束事件按它配对。

`agent:*` 钩子（declaration merging 注入 `@aalis/api-hooks` 的 `HookContextMap`）——这是 agent 服务最重要的扩展面：

| 钩子 | 触发时机 | data 关键字段 |
|---|---|---|
| `agent:input:before` | 每条输入一次，在它进入一轮之前（预处理） | `{ message }`。不调 `next()` → 丢掉这条，agent 照发流结束标记；`next()` 返回时这条已落定 |
| `agent:turn:before` | 一轮开始 | `{ turnId, sessionId, inputs }`。`inputs` 是这一轮的输入（`TurnInput`：`message`，归档后带 `archived`），是活的：插进来的输入在送进模型之前追加到末尾；`next()` 之后是这一轮的全部（从归档这些输入开始）；不调 `next()` → 这一轮不跑、输入不归档 |
| `agent:llm:before` | 每次调 LLM 前（首轮 + 每次工具迭代） | `{ messages, tools, sessionId?, … }`。可改 `messages`/`tools` |
| `agent:llm:after` | 每次 LLM 返回后 | `{ response, messages }` |
| `agent:tool:before` | 每个工具执行前 | `{ name, args, toolCallContext }` |
| `agent:tool:after` | 每个工具执行后 | `{ name, result, toolCallContext }` |
| `agent:reply:before` | 定稿前，回复校验/修复 | `{ content, archiveContent?, visibleContent?, sessionId, …; retryRequested?, retryFeedback?, attempt?, maxRetries? }` |
| `agent:turn:after` | 回合终态（四条路径都发；这一轮被 `agent:turn:before` 拦下时不发） | `{ inputs, reply, outcome, error?, sessionId, turnId }`。`outcome ∈ 'replied'｜'silent'｜'aborted'｜'error'`；`error` 只在结局为 `error` 时带，是一句原因 |

钩子用 `hooks.use.middleware` 注册，`hooks` 描述符来自 `@aalis/api-hooks`（见 [api-hooks](../api/api-hooks.md)）。要让 TS 看到这些键，需把 `@aalis/api-agent` 加进依赖。

> **提示词注入不在这条链上**：摘要、语义记忆、用户档案、关系图、技能正文、平台提示等走 `agent:prompt` 贡献点（`contributions.use.contribute`，契约见 [api-contributions](../api/api-contributions.md)），由 plugin-agent 的组装器在 `agent:llm:before` **之前**统一物化。往提示词加内容请用贡献点，本钩子留给改写/截停语义。

## 3. 谁提供 / 谁消费

**提供方**：`@aalis/plugin-agent`。`provides: [agent]`，`provide.use(agent, agentImpl)`，未声明 priority（= 默认 0）。

**消费方**：

- `plugin-gateway`：入站终相 `inbound:dispatch` 调 `agent.use.handleMessage(message)`（每条消息先看 `agent.present`）——**这是 agent 被驱动的主入口**。
- `plugin-session-server`：停止键（`turn/abort`）调 `agent.use.abort(sessionId, { turnId, reason: '停止键', by: 连接身份 })`，只停在跑的一轮；后台页「全部停止」对每个下级会话调 `abort(id, { queued: true, reason: '全部停止', by: 连接身份 })`。agent 不在时回 `unsupported`。
- `plugin-flow-control`：禁言（`setMuted` 时长大于 0）调 `abort(sessionId, { queued: true, reason: '禁言' })`，不交 `by`。
- `plugin-commands`：清消息历史的 `/clear` 把整条 `memory:clear` 链交给 `clearing`（`/clear all` 不给会话 id）。
- `plugin-session-manager`：删会话时把发 `session:deleted` 与清数据两步交给 `clearing([id], …)`。
- `plugin-file-reader` / `plugin-media`：`agent.use.registerPreprocessor(...)`。当前提供者不实现该方法时本次不生效，换到支持的提供者时补上（`packages/api-agent/src/index.ts`）。

**钩子订阅方**：`plugin-persona`（`agent:reply:before`）、`plugin-checkpoint`、`plugin-session-manager`、`plugin-memory-summary`、`plugin-subtask` / `plugin-tool-search` 等。

## 4. 写一个 provider

99% 的需求用**钩子**就够了，无需替换整个服务。只有当你要彻底接管编排逻辑时才自己 provide `agent`。

**最小必须**：`handleMessage`、`abort`、`clearing` 与 `assignModel`。省略 `registerPreprocessor` 则绑定门面在当前提供者上本次不生效。

```ts
import { agent, type AgentService } from '@aalis/api-agent';
import { definePlugin, optional, provide } from '@aalis/core';
import { llm, type ModelRef } from '@aalis/api-llm';
import type { IncomingMessage } from '@aalis/schema-message';

class MyAgent implements AgentService {
  async handleMessage(_message: IncomingMessage): Promise<void> {
    // 入口记下会话管理给这个会话的代号（generationOf），交给自己的通道之前再取一次，变了的放掉、不归档；
    // 跑 input:before → turn:before（默认动作开头归档输入）→ llm:before → 工具循环 → reply:before → turn:after
  }
  abort(
    _sessionId: string,
    _options?: { turnId?: string; queued?: boolean; reason?: string; by?: NonNullable<IncomingMessage['actor']> },
  ): boolean {
    return false;
  }
  async clearing(_sessionIds: readonly string[] | undefined, clear: () => Promise<unknown>): Promise<void> {
    // 先停下这些会话在跑的一轮、放掉排着的并按住它们，等落定再清，清完才放开
    await clear();
  }
  async assignModel(_sessionId: string, _model: ModelRef): Promise<void> {
    throw new Error('不支持给会话指定模型');
  }
}

export default definePlugin({
  name: '@acme/plugin-my-agent',
  provides: [agent],
  uses: { provide, llm: optional(llm) },
  apply({ provide }) {
    provide.use(agent, new MyAgent(), { priority: 50 });
  },
});
```

default agent 用整个 service 注册（不是 per-entry）。自定义 `handleMessage` 必须在一轮开始时生成 `turnId` 并在上述钩子与事件里带上，归档输入时把回合交给 `archiveIncoming`（不交的话连对话回滚删不掉这一轮的输入），在 `agent:turn:after` 之前写这一轮的回合记录（`TurnRecord`，见 [api-agent](../api/api-agent.md#落库与外发的约定)；不写的话会话服务的历史里没有这一轮的结局），必须在四条终态路径都发 `agent:turn:after`，结局为 `error` 时在 `error` 里给一句原因。漏发的话，workflow 的 agent 节点认不到结局、在指令落定时按没开轮失败，子任务不会回报父会话，出错的一轮收口为 completed 而不是 error，`lastReplyAt` 不更新，`lastTurn` 记为 silent，会话服务按 silent 收尾；不给原因的话，会话的 `lastTurn` 没有原因，界面上出错的会话写不出原因。

## 5. 标准消费方式

业务句柄 `agent.use` 是活的，选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。

```ts
if (agent.present) agent.use.abort(sessionId);
```

登记预处理器：

```ts
import { agent } from '@aalis/api-agent';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-my-pre',
  uses: { agent: optional(agent) },
  apply({ agent }) {
    agent.use.registerPreprocessor('my-pre', async (msg, next) => {
      await next();
    });
  },
});
```

门面已把退订挂到本次激活，不必再手写 `lifecycle.use.onDispose`。

**服务缺失**：`agent` 全 optional 依赖。`llm` 缺失会回一条 `[系统]` 前缀诊断消息；`memory` 缺失则无历史；`gateway` 缺失则 fallback 到 `events.use.emit('outbound:message')`（**跳过审计/脱敏/限速/authority 中间件链，仅限测试/嵌入式**）。

**关停**：以激活为单位分 drain / close 两阶段。默认实现在 `lifecycle.use.onDrain` 里停下全部在跑的一轮、放掉排着的（与停止键同一条收尾路径），等它们落定——收尾段 memory / 钩子还在，中止后的交接与放掉的输入写得进去；之后到的输入一律放掉、不开轮；`onDispose` 再停一次，给 drain 超时或未走到收尾兜底。依赖交接放 `onDrain`：根激活若用插件的服务，根 drain 先于插件 close，到根的 `onDispose` 时插件可能已关。llm / memory / gateway 等是普通依赖，消费者整个 close 完提供者才 drain，故本插件 `onDispose` 期间那些依赖仍在。单独 unload / disable / bounce 某个提供者时，本插件若正在用它也会先收尾再关。超时沿用 core 对 `onDrain` 的 `disposeTimeoutMs`，不另加配置键（`packages/plugin-agent/src/index.ts`）。

## 6. 能力 / 风险 → 影响

**ToolCallContext 的参与者**：agent 构造工具上下文时用 api-authority 的 `originTurnOf(这一轮的输入, isOwner)` 拼会话、`platform`、`userId`、`participants` 与 `inbound`：各条输入的 `actor`（没有时是发言者）作授权身份，按身份去重、owner 的各个身份合成一个，`platform`/`userId` 保持会话语义。默认实现还传入 `enabledGroups`、`acceptsImages`（这一轮的模型在模型服务登记了视觉能力时为 `true`；为 `false` 时工具结果里的图不挂到 tool 消息上，模型只读文字结果；media 不在时当轮附件里的图也不交，正文里的图片占位照旧）、回合 `signal`（守卫等审批期间被 abort 的工具不再执行），以及 `turnId` 与每次调用各自的 `callId`；`inbound` 是本回合的 `source`、发起它的那一轮 `fromTurn` 与入站消息的平台消息 id `messageId`。自定义 provider 必须保留参与者语义（同样用 `originTurnOf` 拼），否则系统触发的工具会以错误身份执权。续做（如后台任务结束通知开的一轮）的消息不带发言者与 `actor`，`userId` 取发起它的那一轮的发言者、参与者取那一轮的，执行守卫按那一轮判这一轮的类别；归档与提示词钩子仍按消息本身的 `userId`（没有）。子任务插件在入站回合里派出的任务消息同样不带 `actor`，参与者取派它的那次调用的，执行守卫同样按派它的那一轮判类别，`userId` 是消息本身的 `parent:<父会话 id>`。

**新消息怎么处理（通道层）**：新消息从不打断在跑的一轮：真人消息叠进由真人消息开的那一轮或排在它之后，带来源的注入各自成一轮。规则见 [plugin-agent](../plugins/plugin-agent.md) 的「新消息怎么处理」。

**reply:before 重试协议**：钩子可置 `retryRequested=true` + `retryFeedback` + `maxRetries`；用尽后若仍 `retryRequested` 强制把 `content` 置空。上游吐空流时同样按此重试，只是没有失败输出可回放，只追加反馈消息。

**落库口径**：`content` 是外发内容，`archiveContent` 缺省时等于 LLM 原文、是落库内容，`visibleContent` 缺省时等于 `content`、是可见正文。可见正文与落库内容不同时（如落库的是结构化输出的整串 JSON），agent 把它写进 assistant 消息 metadata 的 `visibleContent` 键（`WellKnownMetadataKeys.VisibleContent`）。

**token 预算契约**：每次 LLM 调用后 emit `token:usage`；监听 `token:request` 在客户端重连时重算快照。

**出站走 gateway**：回复经 `gateway.use.dispatchOutbound`。provider 务必经 gateway，不要直接 emit。

## 7. 边界情形与注意事项

**`abort` 中止不了已经进入 `execute` 的工具**：`AbortSignal` 在 LLM 流式消费、工具循环每次迭代头部，以及流结束标记 / 落库 / 外发之前的提交点被检查；提交点之前被中止的回合不落库、不外发，按 `outcome=aborted` 收尾。一旦进入并行 `tools.use.execute()`，当前在飞的 handler 会执行完毕，副作用照常发生，只是下一轮 LLM 不再发起。默认实现把 `signal` 放进 `ToolCallContext`，工具 handler 可自行尊重它；契约不强制每个工具都中断。

**abort 路径不回滚已完成的工具记录**（有意为之）：删除会让 agent「忘记自己刚做过的有副作用的事」导致下一轮重复调用。真正的 orphan 由 `sanitizeToolCallHistory` 在装载历史时兜底过滤。

**工具链路异常只影响该工具**：同一批并行工具中，某个工具的 `agent:tool:before` / `agent:tool:after` 钩子、守卫或结果处理抛错时，该工具得到一条错误结果（执行前失败为「工具调用失败」；执行后失败为「工具已执行，但结果处理失败」，不回退到原始输出），同批其它工具的结果与整组记录照常落库，回合继续。

## 8. 交叉链接

- [concepts/message-llm-pipeline](../concepts/message-llm-pipeline.md)
- [concepts/service-model](../concepts/service-model.md)
- [concepts/lazy-service-access](../concepts/lazy-service-access.md)
- [concepts/manifest-metadata](../concepts/manifest-metadata.md)
- [concepts/security-model](../concepts/security-model.md)
- [plugins/plugin-authority](../plugins/plugin-authority.md) / [plugins/plugin-tools](../plugins/plugin-tools.md)
- [api/api-events](../api/api-events.md)、[api/api-hooks](../api/api-hooks.md)、[api/api-contributions](../api/api-contributions.md)
- [services/llm](./llm.md)、[services/memory](./memory.md)、[services/message-archive](./message-archive.md)、[services/gateway](./gateway.md)
