# @aalis/plugin-trigger-policy

> 平台无关的开口判定 —— `inbound:trigger` 相位宿主 + 规则判定（@ 提及 / 戳一戳 / 名字命中 / 计数 / 评分阈值）+ 禁言关键词 / 闲置主动开口

## 定位

回答"这条消息要不要让 agent 开口"。本插件是 `inbound:trigger` 相位的宿主：持有每会话的计数、活跃指数与闲置调度状态，处理作用域、禁言、禁言关键词与点名识别，再把"开不开口"交给 [`trigger` 服务](../services/trigger.md)的提供者逐个判定，放行时标记 `triggerType`。本插件自带规则提供者（点名 / 计数 / 评分）兜底；判定模型等其它提供者可以更高优先级登记在它前面。放行之后能不能说（禁言、冷却、限速）由下一相位的 [plugin-flow-control](./plugin-flow-control.md) 把关。

## 插件声明

```ts
export default definePlugin({
  name: '@aalis/plugin-trigger-policy',
  provides: [trigger],
  uses: {
    logger,
    events,
    hooks,
    lifecycle,
    config,
    provide,
    gateway,
    trigger: optional(trigger),
    flowControl: optional(flowControl),
    persona: optional(persona),
    messageArchive: optional(messageArchive),
    media: optional(media),
  },
  apply(caps) { /* 见源码 */ },
});
```

本插件登记 `trigger` 服务的规则提供者（标签「规则（计数/评分）」，优先级 0），并以 optional 声明 `trigger` 本身：宿主经它按序问全部提供者，写 required 会把激活闸架在自己的产出上。`flow-control` 缺席时不设禁言：禁言关键词照样吞掉当条消息，但不会写入禁言期。`media` 缺席时，提供者要附件描述也拿不到。

## 接入相位

```
inbound:trigger   （由 plugin-gateway 在 inbound:command 之后、inbound:flow 之前触发）
```

判定流程：

1. 带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）→ `next()` 跳过策略：不计数，不改写 `triggerType`（委派的 `proactive` 原样保留）。真人消息由平台适配器投递，不设 `source`。
2. 不在作用域内 → `next()` 放行。作用域判断先于禁言关键词，避免群聊的禁言关键词作用到 WebUI、私聊等不在作用域内的会话。
3. 会话处于禁言期（`flow.isMuted`）→ 本会话计数与活跃指数清零，`next()` 交给 flow 相位吞掉。禁言期内的消息不累计计数，也不再识别禁言关键词（不会缩短平台禁言）。平台禁言只能在这一步清零：平台禁言期内若一条消息都没有，禁言前攒下的计数保留到解禁后。
4. 命中禁言关键词 → `flow.setMuted(sessionId, muteTimeSeconds, platform)`，本会话计数与活跃指数当场清零 → 影子归档 → 吞掉。戳一戳通知跳过这一步：其正文是合成文案，内嵌戳者昵称，与名字检测同理不当发言评估。
5. 记入站：评分衰减、计数 +1、评分增量、用户交互次数、最近消息时间；闲置退避复位为 1，并按这次真人活动重排 session 档闲置触发。
6. 识别点名（addressed）：戳一戳按 `triggerOnPoke`；其余消息按 `triggerOnAt`（@ 自己）与名字检测（`triggerNames` 与人设名字）。`triggerOnPoke` 关闭时戳一戳不算点名，也不做 @ / 名字检测。
7. 按 `trigger.all()` 的顺序（偏好 > 优先级 > 注册顺序）逐个问提供者，每次限时 `decisionTimeoutMs`；返回 null、抛错、超时都算弃权，转问下一个，第一个给出结论的说了算。规则提供者：点名即开口，否则按 `intervalMode` 判定计数与活跃指数是否达标；它只读状态，不弃权。每次判定记一行判定日志（见「触发提供者」）。
8. 开口（无论哪个提供者）：计数与活跃指数清零、记录触发时间；点名的写 `triggerType = 'immediate'`，否则写 `'interval'`；`next()`。`interval` 在多人会话且消息未带 `actor` 时回填无主体授权身份 `actor = selfInitiatedActor(platform)`：interval 回合没有主发言者，撞上阈值的那条消息的发言者不应决定 AI 自发行为的工具权限，authority 按默认等级裁决、不视为 owner，其白名单与会话授予也不替无主体回合解围。私聊纳入作用域后其 interval 只是频率闸，发言者仍是主体，不回填。不开口：影子归档后吞掉。

点名识别抛错（例如名字检测调用的 persona 提供者异常）时记 warn 并放行，不写 `triggerType`，由 flow 相位按普通消息把关。全部提供者弃权时同样失败放行，按点名定类别；规则提供者在场，正常不会出现。

计数在判定放行时即复位。放行后若被 flow 相位的冷却或限速吞掉，这次触发作废，动态阈值也回到上限；冷却通常只有十秒量级，这期间再次攒够阈值的概率很低，因此不做预判。

## 触发提供者

"开不开口"由 [`trigger` 服务](../services/trigger.md)的提供者判定，本插件是它唯一的调用方。

**截止时间**：每个提供者限时 `decisionTimeoutMs`（默认 2000 毫秒），超时按弃权处理。宿主放弃后不取消提供者手里的请求，提供者应自带更短的超时。

**附件识别**：提供者要看附件描述时调用 `awaitAttachmentDescriptions()`。消息带附件、尚无描述且 `media` 在场时，宿主启动一次识别（`media.processMessage`，同一条消息只启动一次）并最多等 `mediaWaitMs`（默认 8000 毫秒）；等待的时间不计入截止时间，超时照常判定、识别在后台继续。识别一旦启动，无论开口还是吞掉，宿主都等它跑完再往下传或归档，agent 预处理器与归档直接用写好的描述，不再识别第二遍；这段等待原本发生在预处理器或归档里，总耗时不变。规则提供者不看附件，只有规则判定时图片消息的判定不等识别。

**判定日志**：每条判定一行 debug 日志，不含消息正文：

```
[trigger] 判定 | session=<会话> | 决定者=<label> | speak=<true|false> | addressed=<true|false> | reason=<reason>[ | score=<score>] | 耗时=<n>ms[ | 弃权=<label>(弃权|超时|出错),…]
```

规则提供者的 reason 形如 `计数=3/5 指数=0.412 (阈值=0.850)`，点名时为 `点名`。

**判定模型在位时各配置项的含义**：

- `triggerOnAt` / `triggerOnPoke` / `triggerNames`：只决定是否"被点名"，进而决定开口后的类别（`immediate` / `interval`）与授权主体，不决定开不开口——被点名的消息也由模型判定。
- `intervalMode` / `fixedInterval` / `activityScore*` / `*DecayMinutes`：只在模型弃权、回落到规则提供者时生效。计数与活跃指数照常累计，任何提供者开口都清零。
- `scopes` / `overrides` / `muteKeywords` / `muteTimeSeconds` / `idleTrigger*`：照常由宿主执行，与谁判定无关。

**回滚到规则判定**：在 WebUI 服务页把 `trigger` 的偏好切到「规则（计数/评分）」，即时生效——规则提供者排到最前，它不弃权，模型不再被问。手改 `aalis.config.yaml` 的 `servicePreferences` 只在启动时读取，需重启才生效。

## 计数与评分

- 每条入站计数 +1；活跃指数增加 `1 / fixedInterval`，同一用户交互越多权重越高（上限 1.5 倍）。`scoreDecayMinutes > 0` 时活跃指数按距上一条消息的时间线性衰减。
- 动态阈值在 `activityScoreLower` 与 `activityScoreUpper` 之间：刚触发时为上限，随距上次触发的时间在 `activityDecayMinutes` 内线性降到下限。
- `intervalMode`：`fixed` 只看计数是否达到 `fixedInterval`；`dynamic` 只看活跃指数是否达到当前阈值；`both` 任一满足即可。`scoreDecayMinutes = 0` 且 `activityScoreUpper ≤ 1` 时，计数达标必然伴随活跃指数达标，`both` 与 `dynamic` 等价。

## 闲置触发

`idleTriggerScope` 三档：

- `off`：关闭。
- `session`：每会话一个定时器，真人消息到来时退避复位为 1 并重排。到点时会话处于禁言期则跳过并按原退避重排；否则 `gateway.ingressMessage` 注入一条 `source='idle-trigger'` 消息，`exponential` 风格下退避翻倍（上限 `idleTriggerMaxMinutes`）。只有真人消息复位退避，agent 回复（包括回复闲置提示）不复位。
- `platform`：跨会话共用一个定时器。`idleTriggerStrategy` 决定触发时机：`all-quiet` 在所有会话都静默满 `idleTriggerMinutes` 后触发，`fixed` 每隔 `idleTriggerMinutes` 触发一次。到点后，在不处于禁言、冷却或限速已满状态的会话中，选最近活动最早的一个注入闲置触发消息。候选还要过分作用域覆盖：该会话有效配置的 `idleTriggerScope` 不是 `platform`（被单独关成 `off` 或改成 `session`）就跳过，提示词也按候选会话的有效 `idleTriggerPrompt` 取。节奏只看顶层配置，`idleTriggerMinutes` 与 `idleTriggerStrategy` 在 `platform` 档下不吃分作用域覆盖。每轮之间至少隔一个阈值量级（`idleTriggerMinutes`，下限 60 秒）。进程内还没有任何活动记录时，以启动时刻为静默起点。

会话的"最近活动"取真人消息与 bot 开口中较晚者；bot 开口指 agent 的真实回复或闲置注入本身。因此 agent 对闲置提示沉默时，刚被注入的会话在下一轮也不会再次当选。

注入的消息携带 `triggerType: 'idle'`、`source: 'idle-trigger'`：本相位跳过策略判定；flow 相位对它不查回复后冷却，禁言照常生效，会话落在 flow-control 作用域内时限速也照常生效。

## 出站联动

监听 `outbound:message`：`source === 'agent'` 且本插件持有该会话状态时，记为 bot 开口并重排 session 档闲置触发，不复位闲置退避。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 生效作用域：格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认作用域不含 WebUI/CLI，如需纳入，在这里显式添加。 |
| `intervalMode` | select | `'both'` | 间隔模式：`fixed` / `dynamic` / `both` |
| `triggerOnAt` | boolean | `true` | 检测 @ 提及（决定是否被点名，见「触发提供者」） |
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
| `decisionTimeoutMs` | number | `2000` | 每个触发提供者的判定截止时间（毫秒），超时按弃权；等附件识别的时间不计入。只看顶层，不进 `overrides` |
| `mediaWaitMs` | number | `8000` | 提供者要附件描述时等识别的上限（毫秒），超时照常判定。只看顶层，不进 `overrides` |
| `overrides` | array | `[]` | 分作用域覆盖：每项 {scope: "platform:sessionType[:targetId]", ...} 仅在该 scope 命中时覆盖列出的字段；字段留空（或不填）= 沿用上方默认，不会被覆盖为 0/空。写一条 override 自动启用该 scope。 |

计数、评分与闲置触发字段原属 flow-control，字段名与默认值不变，迁移方法见根目录 `CHANGELOG.md`。

## 状态清理

会话状态每天扫描一次：没有闲置定时器、且真人消息与 bot 开口都在 30 天以前的会话被删除。

## 与 persona 的协作

- 名字检测自动合并 `persona.getPersonaName()` 与 `persona.getNickNames()`，角色卡里声明的名字、昵称无需在触发名里重复配置。
- 禁言关键词**不**合并 persona：统一由本插件配置下发，避免角色卡措辞意外成为禁言开关，也避免进程级单例 persona 跨平台泄漏。
