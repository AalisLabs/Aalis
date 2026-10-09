# @aalis/plugin-gateway

> 消息流网关 —— Aalis 运行时的入站 / 出站编排中枢

## 定位

Core 不再内置默认的消息路由逻辑。`plugin-gateway` 提供 `gateway` 服务，在 `inbound:message` 事件上按 `INBOUND_PHASE_ORDER` 顺序串行调度四个**命名生命周期相位**，并暴露 `dispatchOutbound()` 接口运行 `outbound:dispatch` 钩子链。所有"对消息流的横切关注"——命令拦截、流控、触发策略、脱敏、限速、审计——都应通过相位中间件参与。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-gateway',
  provides: [gateway],
  uses: {
    events,
    hooks,
    logger,
    provide,
    agent: optional(agent),
    sessionManager: optional(sessionManager),
    authority: optional(authority),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 注册的服务

| 服务名 | 接口 | 说明 |
|---|---|---|
| `gateway` | `GatewayService` | `ingressMessage(msg)` / `dispatchOutbound(msg)` |

## 入站生命周期相位

入站消息按下表顺序执行；任一相位中某个 handler 不调用 `next()` 即视为"已处理"，整个管道立即停止（不再进入后续相位）。

| 相位（钩子键） | 数据 | 占据者 | 默认动作 |
|---|---|---|---|
| `inbound:command` | `InboundPhaseData` | plugin-commands | （无）|
| `inbound:trigger` | `InboundPhaseData` | 生效的触发插件（如 plugin-trigger-policy） | （无）|
| `inbound:flow` | `InboundPhaseData` | plugin-flow-control | （无）|
| `inbound:dispatch` | `InboundPhaseData` | — | `agent.handleMessage(message)`；agent 缺失时兜底回复 |

`inbound:command` 排在最前：指令意图确认的回复（发出者本人对确认提示的下一条消息）在这里命中后被吞掉，不进入后续相位，也就不会触发 agent 对在途生成的中止。

`InboundPhaseData = { message: IncomingMessage; metadata: Record<string, unknown>; agent: AgentService | undefined }`

同一相位内多个 handler 按 **注册顺序** 执行 Koa 风格洋葱模型，无优先级数字。

## 结构性放行

受众只有 owner 的会话跳过 `inbound:trigger` 与 `inbound:flow`，`inbound:command` 之后直接进 `inbound:dispatch`。判据是会话的房间类别（api-session-manager 的 `roomClass`，子会话取根会话的）为 `owner-only`：

- 跳过：WebUI 与终端建的会话（不论在哪个工作区，含项目会话）、owner 已登记的 IM 身份的一对一私聊，以及它们的子会话；
- 照常走全部相位：群与别人的私聊（含 owner 从 WebUI 往里插话）、`internal` 会话（`mcp-server`、编排与定时任务的会话、按 ID 建档的会话）。

受众只有 owner 时没有「要不要开口」的问题，也没有刷屏要限：触发判定、禁言关键词与自禁言、触发插件的计数与闲置话题、禁言期的吞噬、冷却与限速对这些会话一律不起作用，与触发插件和流控的作用域配置无关。跳过的是整个相位：挂在这两个相位上的中间件（触发插件、流控与第三方的）都收不到这些消息，触发插件与流控不需要知道这件事；审计、脱敏等要覆盖这些会话的中间件挂 `inbound:command`（全部入站）或 `inbound:dispatch`（交给 agent 的入站）。跳过触发后消息不带 `triggerType`，agent 按直接对话处理。出站不变：作用域覆盖到这些会话时流控照样记回复冷却，只是它们的入站不经流控，记了也不起作用。

房间类别在 `inbound:command` 之后才判：IM 房间的第一条消息由会话管理在同一个入站事件上收录，判早了这个房间可能还不在会话表里。owner 谓词取 authority 的 `isOwner`。会话管理不在时判不出房间类别，全部照常走；authority 不在时没有人是 owner：owner 的 IM 私聊按 `room` 照常走全部相位，WebUI 与终端的会话（带创建来源）照样跳过。

放行按每条入站当时的房间类别判，不回头清理触发插件已建的状态。会话在 [trigger-policy](./plugin-trigger-policy.md) 建过状态之后才变成 `owner-only` 的（owner 先在 IM 私聊里说过话、之后才登记为 owner；会话管理就绪之前到达的 owner 私聊），这份状态与闲置定时器留到它停用或进程重启，其间闲置话题到点照常经网关注入，注入同样跳过两个相位直达 agent。

## 出站钩子

| 钩子键 | 数据 | 默认动作 |
|---|---|---|
| `outbound:dispatch` | `{ message, metadata }` | `events.emit('outbound:message', message)` |

## 自定义扩展

```ts
import { INBOUND_PHASE } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { definePlugin } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-gateway-mw',
  uses: { hooks },
  apply({ hooks }) {
    hooks.middleware(INBOUND_PHASE.COMMAND, async (data, next) => {
      await next();
    });
    hooks.middleware('outbound:dispatch', async (data, next) => {
      data.message.content = redact(data.message.content);
      await next();
    });
  },
});
```

## 遥测事件

每个 inbound 相位执行结束后 emit `gateway:phase:done`；结构性放行跳过的相位不运行，也不发这个事件：

```ts
events.on('gateway:phase:done', ({ phase, reachedEnd, durationMs, sessionId, platform }) => {
  void phase;
  void reachedEnd;
  void durationMs;
  void sessionId;
  void platform;
});
```

`reachedEnd: false` 表示该相位被 swallow，整条管道在该相位终止。

## 与 `inbound:message` / `outbound:message` 事件的关系

- 平台适配器仍以 `events.emit('inbound:message', msg)` 提交入站消息；gateway 监听该事件并把它送进相位链。
- 适配器仍以 `events.on('outbound:message', ...)` 接收最终发送指令；gateway 在 `dispatchOutbound` 末尾 `emit` 该事件。
- 业务侧（agent / commands / scheduler 等）应改用 `gateway.require().dispatchOutbound(msg)`（或先判 `gateway.current`）而非直接 `events.emit('outbound:message')`，以便经过 `outbound:dispatch` 链。

## 应用入口要求

完整发行应加载 `@aalis/plugin-gateway`（提供 `gateway` 服务）。core 没有入站路由兜底：不加载 gateway 时 `inbound:message` 无人消费，消息被静默丢弃。

本插件 required `hooks`，还须装上其提供者 [`@aalis/plugin-hooks`](./plugin-hooks.md)；缺少时本插件停在 pending，启动日志报「依赖未满足，未激活：缺少服务 hooks（没有已装的插件提供）」。

## 配置项

无。该插件不消费任何配置。
