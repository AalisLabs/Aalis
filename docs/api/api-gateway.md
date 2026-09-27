# api-gateway — 消息流编排中枢契约

**包名**: `@aalis/api-gateway`  
**源码**: `packages/api-gateway/src/index.ts`  
**实现**: `@aalis/plugin-gateway`

## 概述

Gateway 是 Aalis 的运行时编排中枢，负责：

- **入站**：监听 `inbound:message` 事件，按 `INBOUND_PHASE_ORDER` 顺序串行触发五个相位的钩子链：
  ```
  inbound:confirm → inbound:command → inbound:trigger → inbound:flow → inbound:dispatch
  ```
  任一相位 handler 不调用 `next()` 即"吞掉"消息，后续相位不再触发。`inbound:trigger` 判定要不要开口并写 `triggerType`，`inbound:flow` 按禁言、冷却、限速把关（`immediate` 穿透冷却与限速）。`inbound:dispatch` 默认动作是调用 `agent.handleMessage(message)`。
- **出站**：提供 `dispatchOutbound()` 接口，运行 `outbound:dispatch` 钩子链；默认动作是 emit `outbound:message` 给平台 adapter。

## 关键类型

```ts
interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  agent: AgentService | undefined;
}
```

五个入站相位的 payload 都是 `InboundPhaseData`，**同一消息在各相位间共享同一对象引用**——可以在 command 相位写入 metadata 让 trigger 读到。

## 会话作用域匹配

按会话作用域生效的相位插件（flow-control、trigger-policy）共用的纯函数。作用域写作 `platform:sessionType[:targetId]`，每段可写 `*` 或省略（均为通配）；插件配置约定 `scopes`（生效名单）与 `overrides`（分作用域覆盖，每项带 `scope` 与要覆盖的字段），写一条 override 即视为启用该作用域。`inferSessionScope` 用于消息上没有 sessionType 的场合（定时任务、workflow 等合成回合）：会话 ID 的四段约定来自适配器（如 OneBot），不是框架契约（框架只约定前缀，见下文「出生平台解析」），推断结果只供调用方自己判断，不要写回消息（flow-control 用它给回复记账、给入站不带会话类型的内部注入判作用域，persona 用它写提示词里的会话类型）。

```ts
/** 群聊取 groupId，私聊取 userId，其他为空串 */
function extractTargetId(message: Pick<IncomingMessage, 'sessionType' | 'groupId' | 'userId'>): string;
/**
 * 按 `<platform>:<self>:<type>:<target>` 约定从会话 ID 推断会话类型与 targetId；只认前缀等于 platform 的 id，
 * 子任务会话（含 `::`）与不符合约定的 id 返回 undefined；targetId 与 extractTargetId 同口径（频道为空串）
 */
function inferSessionScope(platform, sessionId): { sessionType: 'group' | 'private' | 'channel'; targetId: string } | undefined;
/** 是否命中 scopes 或任一 overrides[].scope */
function isScopeEnabled(cfg: { scopes; overrides }, platform, sessionType, targetId?): boolean;
/** 取命中且最具体的一项 override 按键叠加到 base（跳过 scope 与 undefined）；具体度 targetId > sessionType > platform */
function resolveEffectiveConfig<T extends { overrides }>(base: T, platform, sessionType, targetId?): T;
```

## 出生平台解析

`resolveSessionOrigin` 按会话 ID 推出房间会话的出生平台与受众。session-manager 用它选平台档、给会话列表分区、收录 IM 房间，persona 用它取会话环境，agent 用它给 `token:request` 的快照兜底平台，memory-history、memory-vector 与 tool-session 用它取跨会话召回的当前平台。它是同步纯函数，只看 ID，不查已注册的适配器：适配器没加载时结果不变。

```ts
interface SessionOrigin {
  /** 出生平台：会话 ID（子任务取第一个 `::` 之前）第一个 `:` 之前的一段 */
  platform: string;
  /** 类型段为 private 的是私聊；group、channel 与不认识的类型段一律按群 */
  audience: 'group' | 'private';
}
function resolveSessionOrigin(sessionId: string): SessionOrigin | undefined;
```

判法：先截掉第一个 `::` 及之后的部分（子任务 `<父会话>::<后缀>` 按父会话算），再取第一个 `:` 之前的一段作为出生平台；截掉之后不含 `:`、或以 `:` 开头的 ID 不是房间，返回 undefined。受众看第三段，只有 `private` 算私聊，其余（含缺失的类型段）按群算。不要求四段：只要 ID 以 `<平台名>:` 开头就能认出平台。

| 会话 ID | 结果 |
|---|---|
| `onebot:<self>:group:<群号>` | `{ platform: 'onebot', audience: 'group' }` |
| `onebot:<self>:private:<QQ号>` | `{ platform: 'onebot', audience: 'private' }` |
| `onebot:<self>:channel:<频道组>:<频道>` | `{ platform: 'onebot', audience: 'group' }` |
| `onebot:<self>:group:<群号>::<8位>` | 与父会话相同 |
| `session-<8位>`、`webui-default`、`cli-default`、`mcp-server`、`workflow::<runId>::<nodeId>` | `undefined` |

它依赖的会话 ID 约定写在 api-platform 的 `PlatformAdapter.canHandle` 说明里（见 [platform 服务](../services/platform.md)）：多人房间的会话 ID 以 `<平台名>:` 开头；非房间的内部会话 ID 不含单冒号，要分段用 `::`。返回 undefined 的会话由调用方按入口平台处理。

与 `inferSessionScope` 回答的问题不同，两者不互相替代：`inferSessionScope` 回答会话自己在触发与流控的作用域里算群、私聊还是频道，只认前缀等于传入平台且符合四段约定的 ID，子任务返回 undefined；`resolveSessionOrigin` 回答房间属于哪个平台、面向哪类受众，子任务按父会话算。

## 服务接口

```ts
interface GatewayService {
  ingressMessage(message: IncomingMessage): Promise<void>;     // 主动注入入站
  dispatchOutbound(message: OutgoingMessage): Promise<void>;   // 出站派发
}
```

## 事件（AalisEvents）

```ts
'gateway:phase:done': [{
  phase: string;
  reachedEnd: boolean;      // true=链走到底；false=被 swallow
  durationMs: number;
  sessionId: string;
  platform: string;
}]
```

供遥测插件订阅，主流程对 observer 异常零容忍——observer 报错不影响入站处理。

## 典型用法

```ts
import { gateway } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-gateway',
  uses: { gateway, hooks },
  apply({ gateway, hooks }) {
    hooks.middleware('inbound:trigger', async (data, next) => {
      if (data.message.triggerType === 'idle') {
        data.metadata.injectedReason = 'idle-followup';
      }
      await next();
    });
    void gateway.current?.dispatchOutbound({
      content: '系统通知：xxx',
      sessionId: 'demo',
      source: 'system',
    });
  },
});
```

## 实现者

- [@aalis/plugin-gateway](../plugins/plugin-gateway.md)

## 相关

- 入站消息类型见 [schema-message](./schema-message.md)
- 业务层**不应**再直接 `events.emit('outbound:message')` —— 改用 `dispatchOutbound` 走钩子链
