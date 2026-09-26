# @aalis/plugin-flow-control

> 平台无关的节流硬闸 —— 禁言 / 回复后冷却 / 限速

## 定位

只回答"现在能不能说"：会话处于禁言期、回复后冷却期或限速窗口已满时，把消息挡下。"要不要开口"（@、名字、计数与评分、闲置主动开口）由 [plugin-trigger-policy](./plugin-trigger-policy.md) 决定，本插件不参与。

逻辑实现为 `inbound:flow` 相位的 handler 与 `flow-control` 服务，不依赖具体平台。冷却与限速只对命中 `scopes` / `overrides` 的会话生效，默认只覆盖 `*:group`；CLI、WebUI 等不区分会话类型的平台，需要在 `scopes` 中另加 `cli`、`webui` 或 `*`。禁言不受作用域限制。

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
2. `source === 'idle-trigger'` 或不在作用域内 → `next()` 放行。
3. 记录会话元数据（platform / sessionType / targetId，供分作用域覆盖匹配）。
4. `triggerType !== 'immediate'` 时，冷却期内或限速窗口已满 → 吞掉。被 @、戳一戳、叫名字（`immediate`）穿透冷却与限速。
5. `next()` 进入 dispatch。

被吞掉的消息在加载了 `message-archive` 时做影子归档（shadow archive），下次触发时作为上下文；闲置触发的合成提示不归档。

## 出站联动

监听 `outbound:message`：`source === 'agent'` 的出站消息对**任意会话**记一次回复——按该会话的有效配置设置冷却（`cooldownSeconds > 0` 时）并记入限速时间戳。委派到私聊等从未经过入站闸门的目标，其回复同样计入限速。命令回复与系统回复不计入。

冷却与限速按真实回复计，不按"判定放行"计。trigger-policy 在判定放行时即复位计数，放行后若恰好处于冷却或限速期，这次触发作废。

## 禁言

- `setMuted(sessionId, sec, platform)`：`sec > 0` 禁言到 `now + sec`，`sec <= 0` 解除。会话尚无状态时须给出 `platform` 才会建立状态。
- 调用方：trigger-policy 命中禁言关键词时；OneBot 适配器收到 bot 自身被禁言/解禁的 notice，或重连后按 `shut_up_timestamp` 恢复时。
- 禁言状态落盘到 `data:/flow-control-mutes.json`，重启后恢复未过期的禁言。冷却与限速是秒级短期状态，不落盘。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 冷却与限速的生效范围：格式 platform:sessionType，支持通配 *；onebot:group / onebot:* / *:group / *。禁言不受此项限制。 |
| `cooldownSeconds` | number | `10` | 回复后冷却（秒） |
| `rateLimitWindow` | number | `0` | 限速窗口（秒，0=关闭） |
| `rateLimitMaxReplies` | number | `10` | 窗口内最大回复数 |
| `overrides` | array | `[]` | 分作用域覆盖：每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段（`cooldownSeconds` / `rateLimitWindow` / `rateLimitMaxReplies`）；字段留空（或不填）= 沿用上方默认。最具体匹配优先（targetId &gt; sessionType &gt; platform &gt; 通配）。例：scope="*:private", cooldownSeconds=10 让所有平台私聊单独 10s 冷却。 |

评分类字段（`fixedInterval` / `activityScore*` / `*DecayMinutes`）与闲置触发字段（`idleTrigger*`）已移到 trigger-policy，迁移方法见根目录 `CHANGELOG.md`。

## 状态清理

会话状态每天扫描一次：无挂起禁言/冷却且 30 天未见（入站过闸或 agent 回复）的会话被删除。
