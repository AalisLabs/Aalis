# @aalis/plugin-trigger-policy

> 平台无关的群聊触发策略 —— @ 提及 / 名字命中 / 关键词禁言 / 计数 / 评分阈值

## 定位

回答的是"这条消息要不要让 agent 接管？"这个问题。基于 `flow-control` 暴露的会话快照，结合自身的 @ / 名字 / 关键词检测，决定 swallow 还是放行（并标记 `triggerType`）。

## 注册的服务

| 服务名 | 接口 | 说明 |
|---|---|---|
| `trigger-policy` | `TriggerPolicyService` | `decide(message)` / `getBotNames()` / `detectMuteKeyword(content)` |

## 接入相位

```
inbound:trigger   （由 plugin-gateway 在 inbound:flow 之后、inbound:dispatch 之前触发）
```

依赖 `flow-control` 的状态快照：进入此相位意味着已经通过冷却/限速闸门。

判定流程：

1. mute 关键词命中 → 调 `flow.setMuted(cfg.muteTimeSeconds)` → `shadowArchive` → swallow
2. 非群会话 → `next()` 直接放行
3. `decide(message)`：
   - `immediate`（@ 自己 / 名字命中）→ `flow.recordTriggered` → 设 `triggerType='immediate'` → `next()`
   - `interval`（达到 `intervalMode` 判定）→ `flow.recordTriggered` → 设 `triggerType='interval'` → `next()`
   - `swallow`（未达阈值）→ `shadowArchive` → 不 `next()`

> 内部消息 (`source === 'idle-trigger'`) 一律 `next()` 跳过策略。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `scopes` | `['*:group']` | 生效作用域，`platform:sessionType` 支持通配；写一条 override 即自动启用该 scope |
| `overrides` | `[]` | 按 scope 覆盖下列任一字段（数组元素含 `scope` + 覆盖项） |
| `intervalMode` | `both` | `fixed`(按计数) / `dynamic`(按评分阈值) / `both`(任一满足) |
| `triggerOnAt` | `true` | 检测 `<at>` / `[CQ:at]` / `@xxx` |
| `triggerOnPoke` | `true` | 戳一戳等注意力动作（noticeType=poke）视同 @ 即时触发；关闭后落回正常意愿评估 |
| `triggerNames` | `''` | 触发名别名（逗号分隔）；自动追加 persona name + nickNames |
| `muteKeywords` | `''` | 禁言关键词（逗号分隔）；仅取本配置，不合并 persona |
| `muteTimeSeconds` | `60` | 关键词命中时通知 flow-control 的禁言时长 |

## 与 persona 的协作

- `getBotNames()` 自动合并 `persona.getPersonaName()` + `persona.getNickNames()`——角色卡里
  声明的名字/昵称无需在触发名里重复配置。
- mute 关键词**不**合并 persona：统一由本插件配置下发（单一来源，避免角色卡措辞
  意外成为禁言开关）。
