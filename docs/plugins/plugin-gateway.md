# @aalis/plugin-gateway

> 消息流网关 —— Aalis 运行时的入站 / 出站编排中枢

## 定位

Core 不再内置默认的消息路由逻辑。`plugin-gateway` 提供 `gateway` 服务，在 `inbound:message` 事件上挂接一条洋葱模型的中间件链 `gateway:inbound`，并暴露 `dispatchOutbound()` 接口运行 `gateway:outbound` 链。所有"对消息流的横切关注"——命令拦截、流控、触发策略、脱敏、限速、审计——都应通过中间件参与。

## 注册的服务

| 服务名 | 接口 | 说明 |
|---|---|---|
| `gateway` | `GatewayService` | `ingressMessage(msg)` / `dispatchOutbound(msg)` |

## 提供的钩子

| 钩子名 | 数据 | 默认动作 |
|---|---|---|
| `gateway:inbound` | `{ message, metadata, agent }` | `agent.handleMessage(message)`；agent 缺失时回兜底回复 |
| `gateway:outbound` | `{ message, metadata }` | `ctx.emit('outbound:message', message)` |

## 中间件优先级约定

| 优先级 | 中间件 | 行为 |
|---|---|---|
| 1000 | `plugin-commands` | 命令命中则执行并 `dispatchOutbound`，**不 `next()`** 中断 |
| 900 | `plugin-flow-control` | 仅群会话：禁言/冷却/限速时 `shadowArchive` + swallow |
| 700 | `plugin-trigger-policy` | mute 关键词、@ 提及、计数/评分判定，决定是否 `next()` |
| 0 | (default) | `agent.handleMessage(message)` |

> 自定义中间件请使用 `ctx.middleware('gateway:inbound', fn, priority)`。  
> **不调用 `next()` 即中断整个管道**（包括默认 agent 派发）。

## 与 `inbound:message` / `outbound:message` 事件的关系

- 平台适配器仍以 `ctx.emit('inbound:message', msg)` 提交入站消息；gateway 监听该事件并把它送进中间件链。
- 适配器仍以 `ctx.on('outbound:message', ...)` 接收最终发送指令；gateway 在 `dispatchOutbound` 末尾 `emit` 该事件。
- 业务侧（agent / commands / scheduler 等）应改用 `gateway.dispatchOutbound(msg)` 而非直接 `emit('outbound:message')`，以便经过 `gateway:outbound` 链。

## 应用入口要求

```ts
new App({ requiredServices: ['gateway'] });
```

否则 core 启动时会因缺少 `gateway` 服务而报警告，且没有任何路径会处理入站消息。

## 配置项

无。该插件不消费任何配置。
