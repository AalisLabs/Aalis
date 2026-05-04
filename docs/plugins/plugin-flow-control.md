# @aalis/plugin-flow-control

> 平台无关的消息流控插件 —— 禁言 / 冷却 / 限速 / 闲置触发 / 评分阈值

## 定位

历史上 OneBot 适配器内置了一整套 ChatFlow 状态机，覆盖：消息计数、活跃指数衰减、禁言/冷却/限速窗口、空闲主动触发。该逻辑已抽到本插件，作为 `gateway:inbound` 的中间件 + 一个 `flow-control` 服务，让 CLI / WebUI / 未来其他平台都能复用同一套防 DDoS / 主动开聊机制。

## 注册的服务

| 服务名 | 接口 | 主要方法 |
|---|---|---|
| `flow-control` | `FlowControlService` | `recordIncoming` / `recordReply` / `recordTriggered` / `isMuted` / `isCoolingDown` / `isRateLimited` / `setMuted` / `getStateSnapshot` / `getThreshold` / `rescheduleIdle` |

## 中间件

```
gateway:inbound  priority=900
```

仅对 `sessionType === 'group'` 的入站消息生效（私聊/CLI/WebUI 直接放行，与历史 OneBot ChatFlow 行为一致）。命中以下任一条件即 `shadowArchive` + swallow（不调用 `next()`）：

1. 自禁言期内（`mutedUntil > now`）—— **不**重新调度 idle，避免禁言结束后立即被刷醒
2. 冷却期内（`cooldownUntil > now`）—— 重新调度 idle
3. 限速窗口已耗尽 —— 重新调度 idle

通过闸门后调用 `next()` 进入 `trigger-policy`。

## 闲置触发

`idleTriggerScope` 三档：

- `off`：完全关闭
- `session`：每会话独立 `setTimeout`，到点 `gateway.ingressMessage` 注入一条 `source='idle-trigger'` 消息
- `platform`：跨会话单一 tick，按 `idleTriggerStrategy` 选举一个"最久未联系"的会话主动开聊

注入的消息携带 `triggerType: 'idle'`、`source: 'idle-trigger'`，flow-control / trigger-policy 中间件均会跳过策略判定，直接交给 agent。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | |
| `platforms` | `[]` | 空=所有平台；指定例如 `["onebot"]` 限定生效范围 |
| `fixedInterval` | `5` | 固定间隔触发（每 N 条累计） |
| `activityScoreLower` / `activityScoreUpper` | `0.3` / `0.85` | 动态阈值上下限 |
| `activityDecayMinutes` | `10` | 阈值衰减分钟（自上次回复起） |
| `scoreDecayMinutes` | `0` | 评分自身衰减（0 = 不衰减） |
| `cooldownSeconds` | `10` | 回复后冷却 |
| `muteTimeSeconds` | `60` | 内部禁言默认时长（也作 `setMuted(undefined)` 兜底） |
| `rateLimitWindow` / `rateLimitMaxReplies` | `0` / `10` | 滑动窗口防 DDoS |
| `idleTriggerScope` | `off` | `off` / `session` / `platform` |
| `idleTriggerStrategy` | `all-quiet` | `fixed` / `all-quiet` |
| `idleTriggerMinutes` / `idleTriggerMaxMinutes` | `180` / `1440` | |
| `idleTriggerStyle` | `exponential` | `fixed` / `exponential` |
| `idleTriggerJitter` | `true` | 加 ±10% 抖动 |
| `idleTriggerPrompt` | `''` | 注入消息文本（空则用内置默认） |

## 出站联动

监听 `outbound:message`：仅 `source === 'agent'` 触发 `recordReply`（设置冷却、刷新 idle backoff、推入限速时间戳）。命令 / 系统回复不计入"对话回复"。

## OneBot 适配器协作

适配器仍维护一份本地 `selfMuted: Map<sessionId, untilTs>`（用于 `getSelfMutes()` 工具），但禁言/解禁的实际状态机交给 flow-control：

- `group_ban` notice → `setSelfMute(duration)` → `flow.setMuted(duration, 'onebot')`
- 重连后通过 `get_group_member_info.shut_up_timestamp` 懒查询恢复
- 主动发送的限速 (`checkAndRecordProactiveSend`) 也走 flow-control 的限速桶
