# plugin-gateway-api — 消息流编排中枢契约

**包名**: `@aalis/plugin-gateway-api`  
**源码**: `packages/plugin-gateway-api/src/index.ts`  
**实现**: `@aalis/plugin-gateway`

## 概述

Gateway 是 Aalis 的运行时编排中枢，负责：

- **入站**：监听 `inbound:message` 事件，按以下相位顺序串行触发钩子链：
  ```
  inbound:command → inbound:flow → inbound:trigger → inbound:dispatch
  ```
  任一相位 handler 不调用 `next()` 即"吞掉"消息，后续相位不再触发。`inbound:dispatch` 默认动作是调用 `agent.handleMessage(message)`。
- **出站**：提供 `dispatchOutbound()` 接口，运行 `outbound:dispatch` 钩子链；默认动作是 emit `outbound:message` 给平台 adapter。

## 关键类型

```ts
interface InboundPhaseData {
  message: IncomingMessage;
  metadata: Record<string, unknown>;
  agent: AgentService | undefined;
}
```

四个入站相位的 payload 都是 `InboundPhaseData`，**同一消息在四相位间共享同一对象引用**——可以在 command 相位写入 metadata 让 trigger 读到。

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
// 自定义触发器：群聊中 idle 5 分钟后注入一条 "继续？" 消息
ctx.useHook('inbound:trigger', async (data, next) => {
  if (data.message.triggerType === 'idle') {
    data.metadata.injectedReason = 'idle-followup';
  }
  await next();
});

// 主动发起出站
await gateway.dispatchOutbound({
  content: '系统通知：xxx',
  sessionId,
  source: 'system',
});
```

## 实现者

- [@aalis/plugin-gateway](../plugins/plugin-gateway.md)

## 相关

- 入站消息类型见 [plugin-message-api](./plugin-message-api.md)
- 业务层**不应**再直接 `emit('outbound:message')` —— 改用 `dispatchOutbound` 走钩子链
