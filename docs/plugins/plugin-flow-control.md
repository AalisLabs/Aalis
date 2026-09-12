# @aalis/plugin-flow-control

> 平台无关的消息流控插件 —— 禁言 / 冷却 / 限速 / 闲置触发 / 评分阈值

## 定位

ChatFlow 状态机提供：消息计数、活跃指数衰减、禁言/冷却/限速窗口、空闲主动触发。逻辑实现为 `inbound:flow` 相位的 handler 与 `flow-control` 服务，不依赖具体平台；是否对某个平台或会话类型生效，由 `scopes` / `overrides` 决定。默认只覆盖 `*:group`；CLI、WebUI 等不区分会话类型的平台，需要在 `scopes` 中另加 `cli`、`webui` 或 `*`。

## 注册的服务

| 服务名 | 接口 | 主要方法 |
|---|---|---|
| `flow-control` | `FlowControlService`（来自 `@aalis/api-flow-control`） | `ensureState` / `recordIncoming` / `recordReply` / `recordTriggered` / `isMuted` / `isCoolingDown` / `isRateLimited` / `setMuted` / `getStateSnapshot` / `getThreshold` / `rescheduleIdle` |

## 接入相位

```
inbound:flow   （由 plugin-gateway 在 inbound:command 之后、inbound:trigger 之前触发）
```

仅对命中 `scopes`（或任一 `overrides[].scope`）的入站消息生效，未命中的会话直接放行；默认 `*:group` 与历史 OneBot ChatFlow 行为一致。对命中作用域的消息先执行 `recordIncoming`（计数、活跃指数照常累加），再依次检查以下三道闸门。命中任一条即吞掉消息、不调用 `next()`；若加载了 `message-archive`，被吞的消息会归档（shadow archive），供下次触发时作为上下文：

1. 自禁言期内（`mutedUntil > now`）—— **不**重新调度 idle，避免禁言结束后立即被闲置触发唤醒
2. 冷却期内（`cooldownUntil > now`）—— 重新调度 idle
3. 限速窗口已耗尽 —— 重新调度 idle

通过闸门后调用 `next()` 进入 `trigger-policy`。

## 闲置触发

`idleTriggerScope` 三档：

- `off`：完全关闭
- `session`：每会话独立 `setTimeout`，到点 `gateway.ingressMessage` 注入一条 `source='idle-trigger'` 消息
- `platform`：跨会话共用一个定时器。`idleTriggerStrategy` 决定触发时机：`all-quiet` 在所有会话都静默满 `idleTriggerMinutes` 后触发，`fixed` 每隔 `idleTriggerMinutes` 触发一次。到点后，在不处于禁言、冷却或限速已满状态的会话中，选最久没有活动的一个注入闲置触发消息

注入的消息携带 `triggerType: 'idle'`、`source: 'idle-trigger'`，flow-control / trigger-policy 中间件均会跳过策略判定，直接交给 agent。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 生效作用域：格式 platform:sessionType，支持通配 *；onebot:group / onebot:* / *:group / *。默认 *:group 与历史 OneBot 行为一致。 |
| `fixedInterval` | number | `5` | 固定间隔（每 N 条触发） |
| `activityScoreLower` | number | `0.3` | 活跃指数下限 |
| `activityScoreUpper` | number | `0.85` | 活跃指数上限 |
| `activityDecayMinutes` | number | `10` | 阈值衰减分钟 |
| `scoreDecayMinutes` | number | `0` | 评分衰减分钟（0=不衰减） |
| `cooldownSeconds` | number | `10` | 回复后冷却（秒） |
| `rateLimitWindow` | number | `0` | 限速窗口（秒，0=关闭） |
| `rateLimitMaxReplies` | number | `10` | 窗口内最大回复数 |
| `idleTriggerScope` | select | `'off'` | 闲置触发范围 |
| `idleTriggerStrategy` | select | `'all-quiet'` | 闲置触发策略 |
| `idleTriggerMinutes` | number | `180` | 闲置触发分钟 |
| `idleTriggerStyle` | select | `'exponential'` | 闲置触发风格 |
| `idleTriggerMaxMinutes` | number | `1440` | 闲置触发上限分钟 |
| `idleTriggerJitter` | boolean | `true` | 闲置触发抖动 |
| `idleTriggerPrompt` | string | `''` | 闲置触发系统提示 |
| `overrides` | array | `[]` | 分作用域覆盖：每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。最具体匹配优先（targetId &gt; sessionType &gt; platform &gt; 通配）。例：scope="*:private", cooldownSeconds=10 让所有平台私聊单独 10s 冷却，其他字段继续走默认。 |

## 出站联动

监听 `outbound:message`：只有 `source === 'agent'` 且该会话已存在流控状态（通常意味着曾经过 `inbound:flow` 闸门）的出站消息才会调用 `recordReply`，依次执行：设置冷却（`cooldownSeconds > 0` 时）、把 idle 退避重置为 1、记录限速时间戳、重新调度会话级闲置触发。命令回复和系统回复不计入。

## OneBot 适配器协作

适配器仍维护一份本地 `selfMuted: Map<sessionId, untilTs>`（用于 `getSelfMutes()` 工具），但禁言/解禁的实际状态机交给 flow-control：

- bot 自身被禁言/解禁的 notice（v11 `group_ban`，v12 `group_member_ban` / `group_member_unban`）→ `setSelfMute(sessionId, duration)` → `flow.setMuted(sessionId, duration, 'onebot')`；解禁时时长传 0，禁言时长未知时按 60 秒计
- 重连后通过 `get_group_member_info.shut_up_timestamp` 懒查询恢复
- 主动发送的限速 (`checkAndRecordProactiveSend`) 也走 flow-control 的限速桶
