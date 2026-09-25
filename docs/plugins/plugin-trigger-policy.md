# @aalis/plugin-trigger-policy

> 平台无关的群聊触发策略 —— @ 提及 / 名字命中 / 关键词禁言 / 计数 / 评分阈值

## 定位

回答的是"这条消息要不要让 agent 接管？"这个问题。基于 `flow-control` 暴露的会话快照，结合自身的 @ / 名字 / 关键词检测，决定 swallow 还是放行（并标记 `triggerType`）。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-trigger-policy',
  provides: [triggerPolicy],
  uses: {
    logger,
    hooks,
    config,
    provide,
    gateway,
    flowControl: optional(flowControl),
    persona: optional(persona),
    messageArchive: optional(messageArchive),
  },
  apply(caps) { /* 见源码 */ },
});
```

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

0. 内部消息（`source === 'idle-trigger'`）→ `next()` 跳过策略
1. 不在 `scopes` / `overrides` 作用域内 → `next()` 直接放行（先判作用域再判行为，群里的 mute 关键词不会波及私聊、WebUI 等作用域外会话）
2. mute 关键词命中（按生效配置）→ `flow.setMuted(eff.muteTimeSeconds)` → `flow.rescheduleIdle` → `shadowArchive` → swallow
3. `decide(message)`：
   - `immediate`（@ 自己 / 名字命中）→ `flow.recordTriggered` → 设 `triggerType='immediate'` → `next()`
   - `interval`（达到 `intervalMode` 判定）→ `flow.recordTriggered` → 设 `triggerType='interval'`，并回填无主体授权身份 `actor = selfInitiatedActor(platform)`（多人会话且消息未带 actor 时；私聊纳入 scope 后其 interval 只是频率闸，发言者仍是主体，不回填）→ `next()`。interval 回合没有主发言者，撞上阈值的那条消息的发言者不应决定 AI 自发行为的工具权限：authority 按默认等级裁决、不视为 owner，其白名单与会话授予也不替无主体回合解围
   - `swallow`（未达阈值）→ `shadowArchive` → 不 `next()`

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 生效作用域：格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认 *:group。 |
| `intervalMode` | select | `'both'` | 间隔模式 |
| `triggerOnAt` | boolean | `true` | 检测 @ 提及 |
| `triggerOnPoke` | boolean | `true` | 戳一戳直触发：戳一戳等注意力动作视同 @ 即时触发；关闭后此类动作落回正常意愿评估，不强制回复。 |
| `triggerNames` | string | `''` | 触发名别名（逗号分隔） |
| `muteKeywords` | string | `''` | 禁言关键词（逗号分隔） |
| `muteTimeSeconds` | number | `60` | 禁言关键词命中时长（秒） |
| `overrides` | array | `[]` | 分作用域覆盖：每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。写一条 override 自动启用该 scope。 |

## 与 persona 的协作

- `getBotNames()` 自动合并 `persona.getPersonaName()` + `persona.getNickNames()`——角色卡里
  声明的名字/昵称无需在触发名里重复配置。
- mute 关键词**不**合并 persona：统一由本插件配置下发（单一来源，避免角色卡措辞
  意外成为禁言开关）。
