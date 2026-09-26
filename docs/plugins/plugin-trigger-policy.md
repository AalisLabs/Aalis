# @aalis/plugin-trigger-policy

> 平台无关的开口判定 —— 禁言关键词 / @ 提及 / 戳一戳 / 名字命中 / 计数 / 评分阈值 / 闲置主动开口

## 定位

回答"这条消息要不要让 agent 开口"。本插件持有每会话的计数、活跃指数与闲置调度状态，结合 @ / 名字 / 关键词检测决定吞掉还是放行，并在放行时标记 `triggerType`。放行之后能不能说（禁言、冷却、限速）由下一相位的 [plugin-flow-control](./plugin-flow-control.md) 把关。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-trigger-policy',
  uses: {
    logger,
    events,
    hooks,
    lifecycle,
    config,
    gateway,
    flowControl: optional(flowControl),
    persona: optional(persona),
    messageArchive: optional(messageArchive),
  },
  apply(caps) { /* 见源码 */ },
});
```

本插件不注册服务。`flow-control` 缺席时不设禁言：禁言关键词照样吞掉当条消息，但不会写入禁言期。

## 接入相位

```
inbound:trigger   （由 plugin-gateway 在 inbound:command 之后、inbound:flow 之前触发）
```

判定流程：

1. `source === 'idle-trigger'` → `next()` 跳过策略。
2. 不在作用域内 → `next()` 放行。作用域判断先于禁言关键词，避免群聊的禁言关键词作用到 WebUI、私聊等不在作用域内的会话。
3. 会话处于禁言期（`flow.isMuted`）→ 本会话计数与活跃指数清零，`next()` 交给 flow 相位吞掉。禁言期内的消息不累计计数，也不再识别禁言关键词（不会缩短平台禁言）；关键词禁言与平台禁言都在这一步覆盖。
4. 命中禁言关键词 → `flow.setMuted(sessionId, muteTimeSeconds, platform)` → 影子归档 → 吞掉。戳一戳通知跳过这一步：其正文是合成文案，内嵌戳者昵称，与名字检测同理不当发言评估。
5. 记入站：评分衰减、计数 +1、评分增量、用户交互次数、最近消息时间；闲置退避复位为 1，并按这次真人活动重排 session 档闲置触发。
6. 判定：
   - `immediate`：戳一戳（`triggerOnPoke` 开启时）、@ 自己、名字命中。`triggerOnPoke` 关闭时戳一戳落回下面的意愿评估，且不做 @ / 名字检测。
   - `interval`：按 `intervalMode` 判定达标。
   - `swallow`：未达标。
7. `immediate` / `interval`：计数与活跃指数清零、记录触发时间，写 `triggerType`，`next()`。`interval` 在多人会话且消息未带 `actor` 时回填无主体授权身份 `actor = selfInitiatedActor(platform)`：interval 回合没有主发言者，撞上阈值的那条消息的发言者不应决定 AI 自发行为的工具权限，authority 按默认等级裁决、不视为 owner，其白名单与会话授予也不替无主体回合解围。私聊纳入作用域后其 interval 只是频率闸，发言者仍是主体，不回填。`swallow`：影子归档后吞掉。

判定过程抛错（例如名字检测调用的 persona 提供者异常）时记 warn 并放行，不写 `triggerType`，由 flow 相位按普通消息把关。

计数在判定放行时即复位。放行后若被 flow 相位的冷却或限速吞掉，这次触发作废，动态阈值也回到上限；冷却通常只有十秒量级，这期间再次攒够阈值的概率很低，因此不做预判。

## 计数与评分

- 每条入站计数 +1；活跃指数增加 `1 / fixedInterval`，同一用户交互越多权重越高（上限 1.5 倍）。`scoreDecayMinutes > 0` 时活跃指数按距上一条消息的时间线性衰减。
- 动态阈值在 `activityScoreLower` 与 `activityScoreUpper` 之间：刚触发时为上限，随距上次触发的时间在 `activityDecayMinutes` 内线性降到下限。
- `intervalMode`：`fixed` 只看计数是否达到 `fixedInterval`；`dynamic` 只看活跃指数是否达到当前阈值；`both` 任一满足即可。`scoreDecayMinutes = 0` 且 `activityScoreUpper ≤ 1` 时，计数达标必然伴随活跃指数达标，`both` 与 `dynamic` 等价。

## 闲置触发

`idleTriggerScope` 三档：

- `off`：关闭。
- `session`：每会话一个定时器，真人消息到来时按当前退避重排。到点时会话处于禁言期则跳过并按原退避重排；否则 `gateway.ingressMessage` 注入一条 `source='idle-trigger'` 消息，`exponential` 风格下退避翻倍（上限 `idleTriggerMaxMinutes`）。只有真人消息复位退避，agent 回复（包括回复闲置提示）不复位。
- `platform`：跨会话共用一个定时器。`idleTriggerStrategy` 决定触发时机：`all-quiet` 在所有会话都静默满 `idleTriggerMinutes` 后触发，`fixed` 每隔 `idleTriggerMinutes` 触发一次。到点后，在不处于禁言、冷却或限速已满状态的会话中，选最近活动最早的一个注入闲置触发消息。候选还要过分作用域覆盖：该会话有效配置的 `idleTriggerScope` 不是 `platform`（被单独关成 `off` 或改成 `session`）就跳过，提示词也按候选会话的有效 `idleTriggerPrompt` 取。节奏只看顶层配置，`idleTriggerMinutes` 与 `idleTriggerStrategy` 在 `platform` 档下不吃分作用域覆盖。每轮之间至少隔一个阈值量级（`idleTriggerMinutes`，下限 60 秒）。进程内还没有任何活动记录时，以启动时刻为静默起点。

会话的"最近活动"取真人消息与 bot 开口中较晚者；bot 开口指 agent 的真实回复或闲置注入本身。因此 agent 对闲置提示沉默时，刚被注入的会话在下一轮也不会再次当选。

注入的消息携带 `triggerType: 'idle'`、`source: 'idle-trigger'`：本相位跳过策略判定，flow 相位只做禁言检查。

## 出站联动

监听 `outbound:message`：`source === 'agent'` 且本插件持有该会话状态时，记为 bot 开口并重排 session 档闲置触发，不复位闲置退避。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 生效作用域：格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。 |
| `intervalMode` | select | `'both'` | 间隔模式：`fixed` / `dynamic` / `both` |
| `triggerOnAt` | boolean | `true` | 检测 @ 提及 |
| `triggerOnPoke` | boolean | `true` | 戳一戳直触发：戳一戳等注意力动作视同 @ 即时触发；关闭后此类动作落回正常意愿评估，不强制回复。 |
| `triggerNames` | string | `''` | 触发名别名（逗号分隔） |
| `muteKeywords` | string | `''` | 禁言关键词（逗号分隔） |
| `muteTimeSeconds` | number | `60` | 禁言关键词命中时长（秒） |
| `fixedInterval` | number | `5` | 固定间隔（每 N 条触发） |
| `activityScoreLower` | number | `0.3` | 活跃指数阈值下限 |
| `activityScoreUpper` | number | `0.85` | 活跃指数阈值上限 |
| `activityDecayMinutes` | number | `10` | 阈值衰减分钟 |
| `scoreDecayMinutes` | number | `0` | 评分衰减分钟（0=不衰减） |
| `idleTriggerScope` | select | `'off'` | 闲置触发范围 |
| `idleTriggerStrategy` | select | `'all-quiet'` | 闲置触发策略（platform 档） |
| `idleTriggerMinutes` | number | `180` | 闲置触发分钟 |
| `idleTriggerStyle` | select | `'exponential'` | 闲置触发风格（session 档） |
| `idleTriggerMaxMinutes` | number | `1440` | 闲置触发上限分钟 |
| `idleTriggerJitter` | boolean | `true` | 闲置触发抖动（±10%，不低于 60 秒） |
| `idleTriggerPrompt` | string | `''` | 闲置触发系统提示（留空用内置提示） |
| `overrides` | array | `[]` | 分作用域覆盖：每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。写一条 override 自动启用该 scope。 |

计数、评分与闲置触发字段原属 flow-control，字段名与默认值不变，迁移方法见根目录 `CHANGELOG.md`。

## 状态清理

会话状态每天扫描一次：没有闲置定时器、且真人消息与 bot 开口都在 30 天以前的会话被删除。

## 与 persona 的协作

- 名字检测自动合并 `persona.getPersonaName()` 与 `persona.getNickNames()`，角色卡里声明的名字、昵称无需在触发名里重复配置。
- 禁言关键词**不**合并 persona：统一由本插件配置下发，避免角色卡措辞意外成为禁言开关，也避免进程级单例 persona 跨平台泄漏。
