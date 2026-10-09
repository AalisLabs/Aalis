# api-gateway — 消息流编排中枢契约

**包名**: `@aalis/api-gateway`  
**源码**: `packages/api-gateway/src/index.ts`  
**实现**: `@aalis/plugin-gateway`

## 概述

Gateway 是 Aalis 的运行时编排中枢，负责：

- **入站**：监听 `inbound:message` 事件，按 `INBOUND_PHASE_ORDER` 顺序串行触发四个相位的钩子链：
  ```
  inbound:command → inbound:trigger → inbound:flow → inbound:dispatch
  ```
  任一相位 handler 不调用 `next()` 即"吞掉"消息，后续相位不再触发。`inbound:trigger` 判定要不要开口并写 `triggerType`，`inbound:flow` 按禁言、冷却、限速把关（`immediate` 穿透冷却与限速）。`inbound:dispatch` 默认动作是调用 `agent.handleMessage(message)`。默认实现 plugin-gateway 对房间类别为 `owner-only` 的会话（owner 自己的会话）跳过 `inbound:trigger` 与 `inbound:flow`（插件页「结构性放行」）。
- **出站**：提供 `dispatchOutbound()` 接口，运行 `outbound:dispatch` 钩子链；默认动作是 emit `outbound:message` 给平台 adapter。

## 关键类型

```ts
interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  agent: AgentService | undefined;
}
```

四个入站相位的 payload 都是 `InboundPhaseData`，**同一消息在各相位间共享同一对象引用**——可以在 command 相位写入 metadata 让 trigger 读到。

## 会话作用域匹配

按会话作用域生效的相位插件（flow-control、trigger-policy）共用的纯函数。作用域写作 `platform:sessionType[:targetId]`，每段可写 `*` 或省略（均为通配）；插件配置约定 `scopes`（生效名单）与 `overrides`（分作用域覆盖，每项带 `scope` 与要覆盖的字段），写一条 override 即视为启用该作用域。消息上没有类型名的场合（定时任务、workflow 等合成回合）不从会话 ID 推断，改读会话记下的聊天窗口（session-manager 的 `originChat`，见 [会话管理](../services/session-manager.md)）。

`chatScopeOf` 是入站消息所在聊天窗口的解析：平台取 `message.platform`；类型名与多方标记按这个平台的类型声明解析（api-platform 的 `sessionTypesOf` 与 `resolveSessionType`：不带类型名按 `private`、一对一，声明里没有的类型名按多方并标出 `undeclared`）；目标按多方标记取，多方取 `groupId`、一对一取 `userId`。OneBot 的临时会话在私聊消息上也带群号，所以目标按类型取，不按消息上有没有 `groupId` 取。session-manager 收录 IM 房间时用它记下聊天窗口。

```ts
interface ChatScope {
  platform: string;
  type: string;         // 平台类型名
  multiParty: boolean;  // 安全判断只认它，不认类型名
  undeclared: boolean;  // 类型名不在平台的声明里（已按多方处理），调用方据此告警
  targetId: string;     // 多方为群号，一对一为对端账号；消息上没有时为空串
}
function chatScopeOf(
  message: Pick<IncomingMessage, 'platform' | 'sessionType' | 'groupId' | 'userId'>,
  types: readonly SessionTypeDecl[],
): ChatScope;
/** 群聊取 groupId，私聊取 userId，其他为空串 */
function extractTargetId(message: Pick<IncomingMessage, 'sessionType' | 'groupId' | 'userId'>): string;
/** 是否命中 scopes 或任一 overrides[].scope */
function isScopeEnabled(cfg: { scopes; overrides }, platform, sessionType, targetId?): boolean;
/** 取命中且最具体的一项 override 按键叠加到 base（跳过 scope 与 undefined）；具体度 targetId > sessionType > platform */
function resolveEffectiveConfig<T extends { overrides }>(base: T, platform, sessionType, targetId?): T;
```

## 出生平台解析

`resolveSessionOrigin` 按会话 ID 推出房间会话的出生平台与受众。只有 session-manager 还用它选平台档、推会话种类与受众；别处要出生平台的（权限的房间判定、`token:request` 的快照、跨会话召回的当前平台等）都读会话记录上的字段。会话记录上的出生平台（`originPlatform`）不从它来：那是 IM 房间建档时按入站消息记下的字段。它是同步纯函数，只看 ID，不查已注册的适配器：适配器没加载时结果不变。

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
