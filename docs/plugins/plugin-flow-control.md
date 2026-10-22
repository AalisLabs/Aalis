# @aalis/plugin-flow-control

> 平台无关的节流硬闸 —— 禁言 / 回复后冷却 / 限速

## 定位

只回答"现在能不能说"：会话处于禁言期、回复后冷却期或限速窗口已满时，把消息挡下。"要不要开口"（@、名字、计数与评分、闲置主动开口）由生效的触发插件（见 [trigger 服务](../services/trigger.md)，如 [plugin-trigger-policy](./plugin-trigger-policy.md)）决定，本插件不参与。

逻辑实现为 `inbound:flow` 相位的 handler 与 `flow-control` 服务，不依赖具体平台。「生效范围」`audience`（api-gateway 的 `REPLY_AUDIENCE_FIELD`：不生效、多方房间、一对一房间、全部房间，默认多方房间）决定哪些房间受冷却与限速约束：入站过闸与回复记账都只对生效范围内的房间，闲置选会话读的是这份记账，因此同样只对它们生效；禁言不看生效范围。生效范围只按聊天窗口的多方标记判，onebot 的群与频道都是多方房间，默认就受管；WebUI、终端与子任务没有聊天窗口，不是房间（子任务的输出交回父会话、不直接发到房间，所以也不按根会话的房间算），不在任何生效范围里。房间类别为 `owner-only` 的会话（owner 自己的会话）入站不经本相位：plugin-gateway 跳过它（[结构性放行](./plugin-gateway.md#结构性放行)）。生效范围与三个参数都可按会话覆盖（见「配置」）。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-flow-control',
  provides: [flowControl],
  uses: {
    logger,
    events,
    hooks,
    lifecycle,
    config,
    provide,
    storage: optional(storage),
    messageArchive: optional(messageArchive),
    sessionManager: optional(sessionManager),
    sessionFields: optional(sessionFields),
    document: optional(ownHostConfig),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 注册的服务

| 服务名 | 接口 | 方法 |
|---|---|---|
| `flow-control` | `FlowControlService`（来自 `@aalis/api-flow-control`） | `isMuted` / `isCoolingDown` / `isRateLimited` / `setMuted` |

## 接入相位

```
inbound:flow   （由 plugin-gateway 在 inbound:trigger 之后、inbound:dispatch 之前触发）
```

进入本相位时，生效的触发插件已判定要开口并写好 `message.triggerType`。处理顺序：

1. 会话处于禁言期 → 吞掉。不看生效范围、不看来源：闲置触发、定时任务注入的消息在禁言期同样不说话。禁言状态只由禁言关键词或平台禁言事件针对具体会话写入，生效范围之外的会话不会被误伤。
2. 从别的平台往房间里插话（owner 从 WebUI 往群里发）→ `next()` 放行，不进冷却与限速。判法与触发插件相同，调 api-session-manager 的 `fromElsewhere`：没有 `source`、入口平台与房间（子会话取根会话）的出生平台不同；会话管理缺席时判不出，按否。
3. 不在生效范围内 → `next()` 放行。没有 `source` 的入站（真人消息）按网关算的聊天窗口（`InboundPhaseData.chat`）判；带 `source` 的内部注入（闲置触发、定时任务、workflow）没有它，与回复记账同一口径：先取会话管理记下的出生平台与聊天窗口，没有再用流控状态里记下的（见「出站联动」）。所以 bot 在某个群的限速窗口已满时，发往该群的内部注入同样被第 5 步挡下。生效范围按这个会话现读：同一个群在场所层设了别的生效范围，就按那一层。
4. 记录会话的平台与多方标记。
5. `triggerType !== 'immediate'` 时，冷却期内或限速窗口已满 → 吞掉。被 @、戳一戳、叫名字（`immediate`）穿透冷却与限速。带 `source` 的内部注入（闲置触发、定时任务、workflow）不过冷却，定时提醒等不会被回复后冷却静默吞掉，但仍受限速约束；真人消息由平台适配器投递，不设 `source`。
6. `next()` 进入 dispatch。

被吞掉的消息在加载了 `message-archive` 时做影子归档（shadow archive），下次触发时作为上下文；闲置触发的合成提示不归档。

## 出站联动

监听 `outbound:message`：`source === 'agent'` 的出站消息（与带宿主通知的系统回复）对**生效范围内**的房间记一次回复——按这个会话此刻的参数设置冷却（`cooldownSeconds > 0` 时）并记入限速时间戳。窗口先取会话管理记下的出生平台与聊天窗口，不看出站消息的平台；会话管理缺席或会话没有记录时用流控状态里记下的（真人消息经过本相位时记下）。结果只写进本插件的会话状态，不回写消息。入站带 `source` 的内部注入与这里同一口径（见「接入相位」第 3 步）。没有聊天窗口的会话（WebUI、终端、子任务）不是房间，不计入。因此默认的多方房间下，定时任务、workflow 发往群的回复照常计入（平台写成 `internal` 的定时任务也一样，按会话记下的出生平台算）；发往私聊或 WebUI 的不计入；别人的私聊需要限制时把那一层的生效范围设成一对一房间或全部房间。命令回复与系统回复不计入。

冷却与限速按真实回复计，不按"判定放行"计。trigger-policy 在判定放行时即复位计数，放行后若恰好处于冷却或限速期，这次触发作废。

从 WebUI 往群里插话（owner 的插话）不受这个群的冷却与限速约束（「接入相位」第 2 步）；插话得到的回复照常记一次回复，此后群里的消息照旧受冷却与限速。

## 禁言

- `setMuted(sessionId, sec, platform)`：`sec > 0` 禁言到 `now + sec`，`sec <= 0` 解除。会话尚无状态时须给出 `platform` 才会建立状态。
- 调用方：触发插件命中禁言关键词时；OneBot 适配器收到 bot 自身被禁言/解禁的 notice，或重连后按 `shut_up_timestamp` 恢复时。
- 禁言状态落盘到 `data:/flow-control-mutes.json`，重启后恢复未过期的禁言。冷却与限速是秒级短期状态，不落盘。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `audience` | select | `'multiParty'` | 生效范围：`off` 不生效、`multiParty` 多方房间、`oneToOne` 一对一房间、`all` 全部房间 |
| `cooldownSeconds` | number | `10` | 回复后冷却（秒） |
| `rateLimitWindow` | number | `0` | 限速窗口（秒，0=关闭） |
| `rateLimitMaxReplies` | number | `10` | 窗口内最大回复数 |

四项都是可按会话覆盖的字段（[api-session-settings](../api/api-session-settings.md)），只适用于房间，只有 owner 能改：全局层是这里的插件配置，另可按平台档、平台类型档、群（场所）与单个会话设，例如在 onebot 的 `private` 平台类型档上把生效范围设成一对一房间、冷却设成 10 秒。每条消息按会话现读，改了不重载插件，下一条消息起生效。会话设置不在场时只取插件配置里的值。

## 状态清理

会话状态每天扫描一次：无挂起禁言/冷却且 30 天未见（入站过闸或 agent 回复）的会话被删除。

## 已知局限

本相位吞掉消息时不通知发起方，由此有以下局限：

- 定时任务的消息被禁言或限速吞掉时，plugin-scheduler 仍把这次运行记为成功（`lastResult`），WebUI 上看不出提醒没有发出；被吞的消息只做影子归档，不重试。
- plugin-workflow 的 agent 节点把指令发往目标会话后等回复。目标会话处于禁言期，或在生效范围内且限速窗口已满时，指令被吞掉，节点等到 `timeoutSeconds` 超时才失败；等待期间同一会话若有其它回合结束（例如有人 @ bot，immediate 穿透限速），节点会把那次回复当作自己的结果（按 sessionId 捕获回合结束，是 workflow 引擎原有的做法）。
- trigger-policy 的 session 档闲置触发到点时只查禁言与自己是否生效（禁言期或不生效时跳过、不翻倍）。闲置提示被限速吞掉时，`exponential` 风格下退避照样翻倍。
- 禁言只在入站把关，挡的是禁言之后才开始的回合。命中禁言关键词时 agent 若正在为同一会话生成回复（例如有人刚 @ 过 bot），这条回复照常发出：命中关键词的那条在触发相位就被吞掉，不会中止在途回合，出站方向也不查禁言。平台禁言下适配器本来发不出去，不受影响。
