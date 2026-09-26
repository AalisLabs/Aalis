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

按会话作用域生效的相位插件（flow-control、trigger-policy）共用的纯函数。作用域写作 `platform:sessionType[:targetId]`，每段可写 `*` 或省略（均为通配）；插件配置约定 `scopes`（生效名单）与 `overrides`（分作用域覆盖，每项带 `scope` 与要覆盖的字段），写一条 override 即视为启用该作用域。`inferSessionScope` 用于消息上没有 sessionType 的场合（定时任务、委派等合成回合）：会话 ID 的这一约定来自适配器（如 OneBot），不是框架契约，推断结果只供调用方自己判断，不要写回消息（flow-control 用它给回复记账、给入站不带会话类型的内部注入判作用域，persona 用它写提示词里的会话类型）。

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
