# api-gateway — 消息流编排中枢契约

**包名**: `@aalis/api-gateway`  
**源码**: `packages/api-gateway/src/index.ts`  
**实现**: `@aalis/plugin-gateway`

## 概述

Gateway 是 Aalis 的运行时编排中枢，负责：

- **入站**：监听 `inbound:message` 事件，会话管理在场时先等它收录这条入站（api-session-manager 的 `recordInbound`），再按 `INBOUND_PHASE_ORDER` 顺序串行触发四个相位的钩子链：
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
  chat?: ChatScope;   // 这条入站所在的聊天窗口；带 source 的内部注入没有
}
```

四个入站相位的 payload 都是 `InboundPhaseData`，**同一消息在各相位间共享同一对象引用**——可以在 command 相位写入 metadata 让 trigger 读到。

`chat` 由网关对没有 `source` 的入站按这个平台适配器的类型声明算一次（`chatScopeOf`），平台服务缺席时按没声明类型算（`private` 与不带类型名的按一对一，其余按多方）；带 `source` 的内部注入没有。回复策略按它的多方标记判生效范围。

## 回复策略的生效范围

回复策略三个插件（plugin-trigger-policy、plugin-trigger-laya、plugin-flow-control）共用的一个字段与它的判定：

```ts
/** 「生效范围」字段：插件写 audience: { ...REPLY_AUDIENCE_FIELD, session: { appliesTo: ['room'], prominence: 'common' } } */
const REPLY_AUDIENCE_FIELD: SchemaField;   // select：off 不生效、multiParty 多方房间（默认）、oneToOne 一对一房间、all 全部房间
/** 这个聊天窗口在不在生效范围里 */
function audienceIncludes(audience: string, multiParty: boolean): boolean;
```

生效范围只按聊天窗口的多方标记判，不按平台与类型名：onebot 的频道也是多方房间，默认就受管；WebUI 与终端的会话没有聊天窗口，不在任何生效范围里。参数（冷却、阈值等）是各插件可按会话覆盖的字段，按平台档、平台类型档、场所与会话设（[api-session-settings](./api-session-settings.md)）。

## 聊天窗口

`chatScopeOf` 是入站消息所在聊天窗口的解析：平台取 `message.platform`；类型名与多方标记按这个平台的类型声明解析（api-platform 的 `sessionTypesOf` 与 `resolveSessionType`：不带类型名时，平台声明了多方类型的按其中第一个、多方，没声明或只有一对一类型的按 `private`、一对一；声明里没有的类型名按多方并标出 `undeclared`）；目标按多方标记取，多方取 `groupId`、一对一取 `userId`。OneBot 的临时会话在私聊消息上也带群号，所以目标按类型取，不按消息上有没有 `groupId` 取。session-manager 收录 IM 房间时用它记下聊天窗口。

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
```

## 窗口键

`windowKey` 拼出聊天窗口的键 `平台:类型:目标`；session-manager 拿它作场所的窗口键（见 [会话管理](../services/session-manager.md) 的「场所」）。键里不含机器人账号：同一个群里几个账号的会话是同一个窗口。平台名与类型名按约定不含 `:`；适配器发出不合约定的名字时，前两段里的 `%` 与 `:` 转义成 `%25`、`%3A`，不同的窗口不会拼成同一个键。目标可以含 `:`（OneBot 频道的目标是 `<频道组>:<频道>`），原样放在最后。`parseWindowKey` 拆键时还原前两段的转义，目标取第二个 `:` 之后的全部，不到三段时返回 undefined。

```ts
function windowKey(window: { platform: string; type: string; targetId: string }): string;
function parseWindowKey(key: string): { platform: string; type: string; targetId: string } | undefined;
```

| 聊天窗口 | 键 |
|---|---|
| OneBot 群 `<群号>` | `onebot:group:<群号>` |
| OneBot 私聊，对端 `<对端>` | `onebot:private:<对端>` |
| OneBot 频道 | `onebot:channel:<频道组>:<频道>` |

会话的出生平台与聊天窗口是会话记录上的字段（`originPlatform`、`originChat`），IM 房间建档时按入站消息记下，读方一律读字段，不从会话 ID 推。

## 服务接口

```ts
interface GatewayService {
  ingressMessage(message: IncomingMessage): Promise<void>;     // 主动注入入站，这条输入落定时返回
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
    hooks.use.middleware('inbound:trigger', async (data, next) => {
      if (data.message.triggerType === 'idle') {
        data.metadata.injectedReason = 'idle-followup';
      }
      await next();
    });
    void gateway.use.dispatchOutbound({
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
- 业务层**不应**再直接 `events.use.emit('outbound:message')` —— 改用 `dispatchOutbound` 走钩子链
