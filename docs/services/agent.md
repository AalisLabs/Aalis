# agent 服务（对话回合编排）

> 受众：想替换/扩展对话编排引擎，或想在 LLM 回合的各阶段挂钩子（预处理、改提示、改回复、收尾）的第三方插件作者。

## 1. 一句话定位

`agent` 是**对话回合编排引擎**——接收一条入站消息，组装系统提示 + 历史，调用 `llm`，跑工具调用循环，最终把回复派发出去，并在每个阶段广播 `agent:*` 钩子。

- 服务注册名：`getService<AgentService>('agent')`
- 契约包：`@aalis/plugin-agent-api`（`packages/plugin-agent-api/src/index.ts`）
- 默认实现：`@aalis/plugin-agent`（`packages/plugin-agent/src/index.ts`，类 `DefaultAgent`）

`agent` 是「编排者」而非「能力」：它本身不持有 LLM/记忆/工具，而是按名 `getService` 组合 `llm` / `memory` / `persona` / `tools` / `message-archive` / `session-manager` / `gateway`，全部 optional（缺哪个就降级，见 §6/§7）。

## 2. 契约

`AgentService` 接口（`packages/plugin-agent-api/src/index.ts:51-75`）。注意只有 `handleMessage` 是必须的，其余全为可选方法：

```ts
export interface AgentService {
  /** 处理一条传入消息，完成完整的对话循环（唯一必须实现） */
  handleMessage(message: IncomingMessage): Promise<void>;          // :53
  /** 中止指定会话的当前生成（可选实现） */
  abort?(sessionId: string): void;                                  // :55
  /** 注册输入预处理器；底层挂到 agent:input:before 中间件 */
  registerPreprocessor?(name: string, handler: PreprocessorFn): () => void; // :63
  /** 列出已注册预处理器元信息 */
  getPreprocessors?(): PreprocessorInfo[];                          // :66
  /** Agent 子系统插件分组（供 WebUI Dashboard） */
  getPluginGroups?(): PluginGroupInfo[];                            // :74
}
```

关键类型：

- `PreprocessorFn`（`:34`）：洋葱模型中间件函数 `(message, next) => Promise<void>`；**不调 `next()` 即中断整条管线**（LLM 不会被调用）。
- `useAgent(ctx): ScopedAgentService`（`:155-166`）：领域 helper。`registerPreprocessor` 通过 `ctx.whenService('agent', ...)` 自动延迟到服务就绪；`raw` getter 每次重新 `getService`。**这是注册预处理器的推荐姿势**。
- `TokenUsageEvent` / `TokenUsageBreakdown`（`:178-208`）：每次 LLM 调用后通过 `token:usage` 事件 emit 的 12 桶 prompt 预算快照（见 §6 token 契约）。

`agent:*` 钩子（通过 declaration merging 注入 core 的 `HookContextMap`，`:79-133`）——这是 agent 服务最重要的扩展面，远比直接换 service 常用：

| 钩子 | 触发时机 | data 关键字段 |
|---|---|---|
| `agent:input:before` | 回合最开始，预处理 | `{ message, metadata }`（`:81`）。不调 `next()` → 拦截整条消息 |
| `agent:llm:before` | 每次调 LLM 前（首轮 + 每次工具迭代） | `{ messages, tools, sessionId?, userId?, platform?, triggerType? }`（`:123`）。可改 `messages`/`tools` 注入 system 消息或过滤工具 |
| `agent:llm:after` | 每次 LLM 返回后 | `{ response, messages }`（`:131`） |
| `agent:tool:before` | 每个工具执行前 | `{ name, args, toolCallContext }`（`:92`）。可改 `name`/`args` |
| `agent:tool:after` | 每个工具执行后 | `{ name, result, toolCallContext }`（`:93`）。可改 `result` |
| `agent:reply:before` | 定稿前，回复校验/修复 | `{ content, sessionId, ...; retryRequested?, retryFeedback?, attempt?, maxRetries? }`（`:94-122`）。重试协议见 §6 |
| `agent:turn:after` | 回合终态（四条路径都发） | `{ message, reply, outcome, sessionId, metadata }`（`:85-91`）。`outcome ∈ 'replied'｜'silent'｜'aborted'｜'error'` |

钩子用 `ctx.middleware(hook, fn)` 注册（`packages/core/src/context.ts:460`）；要让 TS 看到这些键的类型，需把 `@aalis/plugin-agent-api` 加进依赖或 side-effect import 一次（`packages/plugin-agent-api/src/index.ts:6-7`）。

## 3. 谁提供 / 谁消费

**提供方**：`@aalis/plugin-agent`（唯一默认实现）。注册见 `packages/plugin-agent/src/index.ts:1712-1714`：`ctx.provide('agent', agentImpl)`，未声明 priority（= `Backend` 0）。

**消费方（典型且真实）**：

- `plugin-gateway`（`packages/plugin-gateway/src/index.ts:52`）：入站终相 `inbound:dispatch` 调 `agent.handleMessage(message)`——**这是 agent 被驱动的主入口**。前置相位（command/flow/trigger）任一 swallow 即不进 dispatch（`:43-49`）。
- `plugin-webui-server`（`packages/plugin-webui-server/src/index.ts:1048-1049`）：收到 WS `abort` 消息时调 `agent?.abort(sessionId)`。
- `plugin-file-reader`（`packages/plugin-file-reader/src/index.ts:772-780`）：`useAgent(ctx).registerPreprocessor('file-reader', ...)` 注册文件读取预处理器，降级见 §5。
- `plugin-media`（`packages/plugin-media/src/index.ts:350-354`）：`useAgent(ctx).registerPreprocessor('media', ...)` 注册图片/音视频识别预处理器。

**钩子订阅方（不直接拿 service，只挂 `agent:*` 中间件）**：`plugin-persona`（`agent:reply:before` 做 outputFormat 解析/修复，`packages/plugin-persona/src/index.ts:647`）、`plugin-checkpoint`（`input:before`/`turn:after` 维护回合生命周期，`packages/plugin-checkpoint/src/index.ts:171,179`）、`plugin-session-manager`（`turn:after` 把根会话收口为 `completed`，`packages/plugin-session-manager/src/index.ts:991`）、`plugin-memory-summary`（`agent:llm:before` 注入摘要、`agent:turn:after` 触发压缩，`packages/plugin-memory-summary/src/index.ts:370,412`）、`plugin-memory-vector` / `plugin-skills` / `plugin-subtask` / `plugin-tool-search` 等。

## 4. 写一个 provider

99% 的需求用**钩子**就够了（§2 表），无需替换整个服务。只有当你要彻底接管编排逻辑（如换成完全不同的 agent loop）时才自己 provide `agent`。

**最小必须**：只需 `handleMessage`。其余方法都标 `?`，可全部省略——但省略 `abort` 则前端「停止生成」失效，省略 `registerPreprocessor` 则 `useAgent().registerPreprocessor` 静默降级为 no-op（消费方应自行 fallback 到 `ctx.middleware('agent:input:before', ...)`，见 §5）。

**双源元数据必须同步写** `package.json` 的 `aalis.service`（参考 `packages/plugin-agent/package.json`）：

```jsonc
"aalis": {
  "service": {
    "provides": ["agent"],
    // agent 把 llm/memory/persona/... 全列为 optional：缺失时降级而非阻断激活
    "optional": ["llm", "memory", "persona", "message-archive", "platform"]
  }
}
```

并在源码导出 `export const provides = ['agent']` 与 `export const inject = { optional: [...] }`（`packages/plugin-agent/src/index.ts:1635-1639`）。两套元数据各自独立、缺一不可，详见 [manifest-metadata](../concepts/manifest-metadata.md)。

可编译最小骨架：

```ts
import type { Context } from '@aalis/core';
import { ServicePriority } from '@aalis/core';
import type { AgentService } from '@aalis/plugin-agent-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';

export const name = '@acme/plugin-my-agent';
export const provides = ['agent'];
export const inject = { optional: ['llm', 'memory', 'tools', 'persona', 'gateway'] };

class MyAgent implements AgentService {
  constructor(private ctx: Context) {}
  async handleMessage(message: IncomingMessage): Promise<void> {
    // 跑你自己的 input:before → llm:before → 工具循环 → reply:before → turn:after，
    // 强烈建议复刻这套钩子序列，否则 persona/checkpoint/session-manager/memory-summary 全部失灵。
    // ...
  }
  // 可选；不实现则前端 abort 无效
  abort(_sessionId: string): void {}
}

export function apply(ctx: Context): void {
  // 想盖过默认 agent 用 Override(50)；同名按 preference > priority > 注册序定胜者
  ctx.provide('agent', new MyAgent(ctx), { priority: ServicePriority.Override });
}
```

> 注意：default agent 用整个 service 注册（不是 per-entry），因为「当前只有一个 agent 在跑」。若你确有多 agent 同存需求才考虑 `entryId '${ctx.id}/${sub}'` 的 per-entry provide（见 [service-model](../concepts/service-model.md)）。

**契约义务**：自定义 `handleMessage` 必须在四条终态路径（replied / silent / aborted / error）都发 `agent:turn:after`——否则 `session-manager` 永远把会话停在 `active`（"进行中"）、`checkpoint` 回合永不关闭（泄漏）。默认实现在 `:903`（正常）、`:940`（aborted）、`:963`（error）兑现此契约。

## 5. 标准消费姿势

**惰性获取，绝不缓存**（provider bounce 会让旧引用失效，见 [lazy-service-access](../concepts/lazy-service-access.md)）：

```ts
const agent = ctx.getService<AgentService>('agent');
if (agent?.abort) agent.abort(sessionId);  // 可选方法先判存在
```

**注册预处理器**——用 `useAgent`，它自带延迟订阅 + bounce 重挂，并把 dispose 挂到 `ctx.onDispose`（**必须**，否则插件 reload 时旧中间件残留在 agent.ctx 上重复执行，`packages/plugin-media/src/index.ts:347-354`）：

```ts
import { useAgent } from '@aalis/plugin-agent-api';
const dispose = useAgent(ctx).registerPreprocessor('my-pre', async (msg, next) => {
  // 改 msg.content / 解析附件……不调 next() = 拦截整条消息
  await next();
});
ctx.onDispose(dispose);
```

**实现不支持 `registerPreprocessor` 时的降级**——`file-reader` 的范式（`packages/plugin-file-reader/src/index.ts:772-780`）：探测 `agent.registerPreprocessor` 是否存在，缺失则直接 `ctx.middleware('agent:input:before', ...)`。

**服务缺失**：`agent` 全 optional 依赖，自身可激活但运行期降级——`llm` 缺失会直接回 `[系统] LLM 服务不可用`（`packages/plugin-agent/src/index.ts:422-431`）；`memory` 缺失则无历史；`gateway` 缺失则 fallback 到 `ctx.emit('outbound:message')`（**跳过审计/脱敏/限速/authority 中间件链，仅限测试/嵌入式**，`:1618-1626`）。

## 6. 能力 / 风险 → 影响

**ToolCallContext 的 actor 优先**：agent 构造工具上下文时优先用 `incoming.actor?.{userId,platform}`，fallback 才到 `incoming.userId/platform`（`packages/plugin-agent/src/index.ts:481-486`）。这让 scheduler/idle/proactive 触发的 AI 走**创建者的 authority**（而非匿名 `defaultAuthority`）。自定义 provider 必须保留此语义，否则系统触发的工具会以错误身份执权。工具侧的风险等级 → minLevel 鉴权由 `tools` 服务在 `execute` 内做，见 [core/tools](../core/tools.md) 与 [core/authority](../core/authority.md)。

**reply:before 重试协议**（`agent:reply:before`，`packages/plugin-agent-api/src/index.ts:94-122`，消费方 `plugin-persona` `packages/plugin-persona/src/index.ts:819-850`）：钩子可置 `retryRequested=true` + `retryFeedback` + `maxRetries` 让 agent 重新请求 LLM；agent 按 `maxRetries` 循环（`packages/plugin-agent/src/index.ts:788-827`），用尽后若仍 `retryRequested` 强制把 `content` 置空避免坏内容外发（`:831-837`）。自定义 provider 若不实现重试循环，persona 的 outputFormat 校验将失效。

**token 预算契约**（`token:usage` / `token:request` 事件，`packages/plugin-agent-api/src/index.ts:211-218`）：agent 每次 LLM 调用后 emit `token:usage`（12 桶 breakdown，`packages/plugin-agent/src/index.ts:1200-1224`）；并监听 `token:request` 在客户端重连时重算快照（`:1819-1869`）。消费方：`plugin-webui-server`（面板）、`plugin-memory-summary`（预压缩触发）。

**出站走 gateway**：回复经 `dispatchOutbound` → `gateway.dispatchOutbound`，由 gateway 中间件链做审计/脱敏/限速/authority（[security-model](../concepts/security-model.md)）。provider 务必经 gateway，不要直接 emit。

> agent 不碰 storage URI / safeFetch——那是 storage / 工具插件的边界（见 [storage-uri-grammar](../concepts/storage-uri-grammar.md)）。

## 7. 边界与坑（审计标注）

**`abort(sessionId)` 用 `startsWith` 误匹配兄弟 session 的 lane**：`abort` 遍历 `activeControllers`，对 key 做 `startsWith(`${sessionId}::`)` 匹配（`packages/plugin-agent/src/index.ts:129-134`）。lane key = `${sessionId}::${source}`（`:118-123`），同一 session 不同来源（user / scheduler / proactive）是独立 lane，互不打断——`abort('S')` 会一次性中止 `S` 的**所有** lane，这是设计如此。但若存在 sessionId 互为前缀的子会话/分身命名（如 `S` 与 `S::sub`、或某些前缀重叠的 ID 方案），`startsWith` 可能误伤——前端「停止生成」的语义被限定为「按整个 sessionId 前缀停」，provider/调用方需保证 sessionId 不互为前缀，否则会中止到不该中止的 lane。

**`abort` 中止不了执行中的工具**：`AbortSignal` 只在 LLM 流式消费（`:226-230`）和工具循环每次迭代头部（`:580`）被检查。一旦进入 `Promise.all(toolCalls.map(...))` 的并行工具执行（`:605-669`），**当前在飞的 `tools.execute()` 不会被打断**——它会跑完，副作用照常发生（戳一戳/发消息/调度），只是下一轮 LLM 不再发起。自定义 provider 若想真正可中断工具，需把 `signal` 透传进 `ToolService.execute`（当前契约未强制）。

**abort 路径不回滚已完成的工具记录**（有意为之，`:910-922`）：早期版本会用 `turnPersistedTimestamps` 删掉本轮中间消息，但 `saveToolCallGroup` 只在并行工具全部完成后整组写入（`:1508-1522`），catch 进不来；删除会让 agent「忘记自己刚做过的有副作用的事」导致下一轮重复调用。真正的 orphan（assistant tool_calls 缺 tool result）由 `sanitizeToolCallHistory` 在装载历史时兜底过滤（`:1524-1567`）。

**`getPluginGroups()` 硬编码子系统服务集**：只纳入 `llm/memory/persona/message-archive`（`:187`），不含 `platform`（平台是独立子系统）。新增 agent 域能力服务不会自动进 Dashboard 分组。

## 8. 交叉链接

- [concepts/message-llm-pipeline](../concepts/message-llm-pipeline.md) — 入站消息 → LLM 的完整管线（agent 是其编排中枢）
- [concepts/service-model](../concepts/service-model.md) — 按名 DI、preference > priority > 注册序定胜者、per-entry provide
- [concepts/lazy-service-access](../concepts/lazy-service-access.md) — 为什么每次用都要重新 getService
- [concepts/manifest-metadata](../concepts/manifest-metadata.md) — `aalis.service` 与 `provides`/`inject` 双源
- [concepts/security-model](../concepts/security-model.md) — 出站审计/脱敏边界、actor 授权身份
- [core/authority](../core/authority.md) / [core/tools](../core/tools.md) — 工具风险 → minLevel 鉴权（agent 通过 ToolCallContext 传 actor 身份）
- [core/events](../core/events.md) — `ctx.middleware` / 钩子链语义
- [services/llm](./llm.md)、[services/memory](./memory.md)、[services/message-archive](./message-archive.md)、[services/gateway](./gateway.md) — agent 的下游被编排服务（`tools`/`persona`/`session-manager` 见各自契约包 `-api`）
