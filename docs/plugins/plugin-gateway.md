# @aalis/plugin-gateway

> 消息流网关 —— Aalis 运行时的入站 / 出站编排中枢

## 定位

Core 不再内置默认的消息路由逻辑。`plugin-gateway` 提供 `gateway` 服务，在 `inbound:message` 事件上按 `INBOUND_PHASE_ORDER` 顺序串行调度四个**命名生命周期相位**，并暴露 `dispatchOutbound()` 接口运行 `outbound:dispatch` 钩子链。所有"对消息流的横切关注"——命令拦截、流控、触发策略、脱敏、限速、审计——都应通过相位中间件参与。

## 注册的服务

| 服务名 | 接口 | 说明 |
|---|---|---|
| `gateway` | `GatewayService` | `ingressMessage(msg)` / `dispatchOutbound(msg)` |

## 入站生命周期相位

入站消息按下表顺序执行；任一相位中某个 handler 不调用 `next()` 即视为"已处理"，整个管道立即停止（不再进入后续相位）。

| 相位（钩子键） | 数据 | 占据者 | 默认动作 |
|---|---|---|---|
| `inbound:command` | `InboundPhaseData` | plugin-commands | （无）|
| `inbound:flow` | `InboundPhaseData` | plugin-flow-control | （无）|
| `inbound:trigger` | `InboundPhaseData` | plugin-trigger-policy | （无）|
| `inbound:dispatch` | `InboundPhaseData` | — | `agent.handleMessage(message)`；agent 缺失时兜底回复 |

`InboundPhaseData = { message: IncomingMessage; metadata: Record<string, unknown>; agent: AgentService | undefined }`

同一相位内多个 handler 按 **注册顺序** 执行 Koa 风格洋葱模型，无优先级数字。

## 出站钩子

| 钩子键 | 数据 | 默认动作 |
|---|---|---|
| `outbound:dispatch` | `{ message, metadata }` | `ctx.emit('outbound:message', message)` |

## 自定义扩展

```ts
import { INBOUND_PHASE } from '@aalis/core';

// 接入命令相位末尾
ctx.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
  // 自定义逻辑；调用 next() 继续，不调用即终止整个入站管道
  await next();
});

// 出站脱敏
ctx.middleware('outbound:dispatch', async (data, next) => {
  data.message.content = redact(data.message.content);
  await next();
});
```

## 遥测事件

每个 inbound 相位执行结束后 emit `gateway:phase:done`：

```ts
ctx.on('gateway:phase:done', ({ phase, reachedEnd, durationMs, sessionId, platform }) => {
  // 记录耗时 / 统计 swallow 率 / 追踪流转路径
});
```

`reachedEnd: false` 表示该相位被 swallow，整条管道在该相位终止。

## 与 `inbound:message` / `outbound:message` 事件的关系

- 平台适配器仍以 `ctx.emit('inbound:message', msg)` 提交入站消息；gateway 监听该事件并把它送进相位链。
- 适配器仍以 `ctx.on('outbound:message', ...)` 接收最终发送指令；gateway 在 `dispatchOutbound` 末尾 `emit` 该事件。
- 业务侧（agent / commands / scheduler 等）应改用 `gateway.dispatchOutbound(msg)` 而非直接 `emit('outbound:message')`，以便经过 `outbound:dispatch` 链。

## 应用入口要求

完整发行应加载 `@aalis/plugin-gateway`（提供 `gateway` 服务）。

否则 core 启动时会因缺少 `gateway` 服务而启用 fallback 路由（直接派发到 agent，不经过相位链）；该 fallback 仅适合最小化场景。

## 配置项

无。该插件不消费任何配置。
