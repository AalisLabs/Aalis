# @aalis/plugin-flow-control

> 平台无关的节流硬闸 —— 禁言 / 回复后冷却 / 限速

## 定位

只回答"现在能不能说"：会话处于禁言期、回复后冷却期或限速窗口已满时，把消息挡下。"要不要开口"（@、名字、计数与评分、闲置主动开口）由 [plugin-trigger-policy](./plugin-trigger-policy.md) 决定，本插件不参与。

逻辑实现为 `inbound:flow` 相位的 handler 与 `flow-control` 服务，不依赖具体平台。`scopes`（以及写了 override 即视为启用的作用域）决定哪些会话受冷却与限速约束：入站过闸与回复记账都只对作用域内会话，委派闸门与闲置选会话读的是这份记账，因此同样只对作用域内会话生效；禁言不看作用域。默认 `*:group`；默认作用域不含 WebUI/CLI（它们的消息不带会话类型），如需纳入，在 `scopes` 里显式添加（如 `webui`、`cli` 或 `*`）。`overrides` 里的数值按会话记录的 sessionType / targetId 匹配。

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

进入本相位时，trigger-policy 已判定要开口并写好 `message.triggerType`。处理顺序：

1. 会话处于禁言期 → 吞掉。不看作用域、不看来源：闲置触发、跨会话委派、定时任务注入的消息在禁言期同样不说话。禁言状态只由禁言关键词或平台禁言事件针对具体会话写入，作用域之外的会话不会被误伤。
2. 不在作用域内 → `next()` 放行。带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）不带会话类型，与回复记账同一口径：先用会话已记下的平台与类型，没有再按会话 ID 约定推断（见「出站联动」）。所以默认 `*:group` 下，bot 在某个群的限速窗口已满时（此时会话已记下群类型），发往该群的内部注入同样被第 4 步挡下。其余消息按消息自身的 platform / sessionType / targetId 判，包括 WebUI、CLI 发进平台会话的真人消息：它们不带会话类型，默认 `*:group` 下在作用域外。
3. 记录会话元数据（platform / sessionType / targetId，推断出的同样记下，供分作用域覆盖匹配）。
4. `triggerType !== 'immediate'` 时，冷却期内或限速窗口已满 → 吞掉。被 @、戳一戳、叫名字（`immediate`）穿透冷却与限速。带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）不过冷却，定时提醒等不会被回复后冷却静默吞掉，但仍受限速约束；真人消息由平台适配器投递，不设 `source`。
5. `next()` 进入 dispatch。

被吞掉的消息在加载了 `message-archive` 时做影子归档（shadow archive），下次触发时作为上下文；闲置触发的合成提示不归档。

## 出站联动

监听 `outbound:message`：`source === 'agent'` 的出站消息对**作用域内**会话记一次回复——按该会话的有效配置设置冷却（`cooldownSeconds > 0` 时）并记入限速时间戳。作用域按会话已记下的平台、sessionType、targetId 判。会话没有流控状态（例如重启后没人说话的群、消息都被 trigger 吞掉的群），或只有缺会话类型的状态（例如只有禁言记录的群）时，按会话 ID 的 `<platform>:<self>:<type>:<target>` 约定推断类型与目标（平台也先用状态里记下的）：只认前缀等于平台名的 id，子任务会话（`<父会话 id>::<uuid>`）不推断；目标与入站同口径，群取群号、私聊取对方 id，频道为空。推断结果只写进本插件的会话状态，用于回复记账与分作用域覆盖，不回写消息。入站带 `source` 的内部注入判作用域与这里同一口径（见「接入相位」第 2 步）。会话 ID 不符合约定的（如 WebUI、CLI）类型未知，只有会话类型段为通配的作用域（如 `onebot:*`、`*`）命中。因此默认 `*:group` 下，委派、定时任务发往群的回复照常计入，前提是状态里记下的平台（没有则用出站平台）与会话 ID 前缀一致（WebUI 与配置文件里建的定时任务平台默认是 `internal`，发往没有流控状态的群时不推断、不计）；发往私聊或 WebUI 的不计入，委派闸门对它们不设限，需要限制时在 `scopes` 里纳入。命令回复与系统回复不计入。

冷却与限速按真实回复计，不按"判定放行"计。trigger-policy 在判定放行时即复位计数，放行后若恰好处于冷却或限速期，这次触发作废。

分作用域覆盖按会话的 sessionType / targetId 匹配，这两项来自经过本相位的入站消息，或按会话 ID 约定的推断（入站带 `source` 的内部注入与回复记账）。两处都得不到的会话（从未有真人消息经过本相位、会话 ID 又不符合约定，如仅经委派抵达的 WebUI 会话）没有这两项，按类型或目标写的覆盖对其不生效，冷却与限速走顶层配置。

## 禁言

- `setMuted(sessionId, sec, platform)`：`sec > 0` 禁言到 `now + sec`，`sec <= 0` 解除。会话尚无状态时须给出 `platform` 才会建立状态。
- 调用方：trigger-policy 命中禁言关键词时；OneBot 适配器收到 bot 自身被禁言/解禁的 notice，或重连后按 `shut_up_timestamp` 恢复时。
- 禁言状态落盘到 `data:/flow-control-mutes.json`，重启后恢复未过期的禁言。冷却与限速是秒级短期状态，不落盘。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 冷却与限速只对作用域内会话生效：入站过闸与回复记账都看它（委派闸门、闲置选会话读的是这份记账）；禁言不看作用域。格式 platform:sessionType，支持通配 *；onebot:group / onebot:* / *:group / *。默认作用域不含 WebUI/CLI，如需纳入，在这里显式添加。 |
| `cooldownSeconds` | number | `10` | 回复后冷却（秒） |
| `rateLimitWindow` | number | `0` | 限速窗口（秒，0=关闭） |
| `rateLimitMaxReplies` | number | `10` | 窗口内最大回复数 |
| `overrides` | array | `[]` | 分作用域覆盖：每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段（`cooldownSeconds` / `rateLimitWindow` / `rateLimitMaxReplies`）；字段留空（或不填）= 沿用上方默认。最具体匹配优先（targetId &gt; sessionType &gt; platform &gt; 通配）。例：scope="*:private", cooldownSeconds=10 让所有平台私聊单独 10s 冷却。类型与目标都未知的会话不吃按类型或目标写的覆盖，见「出站联动」。 |

评分类字段（`fixedInterval` / `activityScore*` / `*DecayMinutes`）与闲置触发字段（`idleTrigger*`）已移到 trigger-policy，迁移方法见根目录 `CHANGELOG.md`。

## 状态清理

会话状态每天扫描一次：无挂起禁言/冷却且 30 天未见（入站过闸或 agent 回复）的会话被删除。

## 已知局限

本相位吞掉消息时不通知发起方，由此有以下局限：

- 定时任务的消息被禁言或限速吞掉时，plugin-scheduler 仍把这次运行记为成功（`lastResult`），WebUI 上看不出提醒没有发出；被吞的消息只做影子归档，不重试。
- plugin-workflow 的 agent 节点把指令发往目标会话后等回复。目标会话处于禁言期，或落在作用域内且限速窗口已满时，指令被吞掉，节点要等满 `timeoutSeconds` 才失败。
- trigger-policy 的 session 档闲置触发到点时只查禁言（禁言期跳过、不翻倍）。闲置提示被限速吞掉时，`exponential` 风格下退避照样翻倍。
