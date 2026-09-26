# @aalis/plugin-trigger-policy

> 平台无关的开口判定 —— 规则触发插件（@ 提及 / 戳一戳 / 名字命中 / 计数 / 评分阈值）+ 禁言关键词 / 闲置主动开口

## 定位

回答"这条消息要不要让 agent 开口"。本插件是一个触发插件（见 [`trigger` 服务](../services/trigger.md)）：持有每会话的计数、活跃指数与闲置调度状态，在 `inbound:trigger` 相位处理作用域、禁言、禁言关键词、点名识别与规则判定，放行时标记 `triggerType`。它只在自己是 `trigger` 服务的胜者（生效的触发插件）时判定；与模型触发插件 `@aalis/plugin-trigger-laya` 二选一。放行之后能不能说（禁言、冷却、限速）由下一相位的 [plugin-flow-control](./plugin-flow-control.md) 把关。

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
    sessionManager: optional(sessionManager),
    messageArchive: optional(messageArchive),
  },
  apply(caps) { /* 见源码 */ },
});
```

本插件向 `trigger` 服务提供自己的实例（标签「规则（计数/评分）」，优先级 0），并以 optional 声明 `trigger` 本身：经它判断自己是不是生效的触发插件，写 required 会把激活闸架在自己的产出上。`flow-control` 缺席时不设禁言：禁言关键词照样吞掉当条消息，但不会写入禁言期。`session-manager` 用来按会话取人设的名字（见「与 persona 的协作」），缺席时取全局默认的卡。

## 接入相位

```
inbound:trigger   （由 plugin-gateway 在 inbound:command 之后、inbound:flow 之前触发）
```

判定流程（同步完成：记入站、判定、清零在同一拍做完，放行顺序即到达顺序）：

0. 本插件不是生效的触发插件（`trigger` 服务的胜者另有其人）→ `next()`，什么都不做：不计数、不识别、不归档。胜者每次入站只取一次，判定途中切换偏好不会让同一条消息被判两次。
1. 带 `source` 的内部注入（闲置触发、定时任务、workflow、跨会话委派）→ `next()` 跳过策略：不计数，不改写 `triggerType`（委派的 `proactive` 原样保留）。真人消息由平台适配器投递，不设 `source`。
2. 不在作用域内 → `next()` 放行。作用域判断先于禁言关键词，避免群聊的禁言关键词作用到 WebUI、私聊等不在作用域内的会话。
3. 会话处于禁言期（`flow.isMuted`）→ 本会话计数与活跃指数清零，记为真人活动（见第 5 步），`next()` 交给 flow 相位吞掉。禁言期内的消息不累计计数，也不再识别禁言关键词（不会缩短平台禁言）。平台禁言只能在这一步清零：平台禁言期内若一条消息都没有，禁言前攒下的计数保留到解禁后。本插件还没有该会话的状态时（如平台禁言先于任何消息）照样建立。
4. 命中禁言关键词 → `flow.setMuted(sessionId, muteTimeSeconds, platform)`，本会话计数与活跃指数当场清零，记为真人活动 → 影子归档 → 吞掉。戳一戳通知跳过这一步：其正文是合成文案，内嵌戳者昵称，与名字检测同理不当发言评估。
5. 记入站：评分衰减、计数 +1、评分增量、用户交互次数；记为真人活动：更新最近消息时间，闲置退避复位为 1，并从这条消息起重排 session 档闲置触发。
6. 识别点名：戳一戳按 `triggerOnPoke`；其余消息按 `triggerOnAt`（@ 自己）与名字检测（`triggerNames` 与全部已登记人设按本会话取的名字、昵称）。`triggerOnPoke` 关闭时戳一戳不算点名，也不做 @ / 名字检测。
7. 判定：点名直接开口；否则按 `intervalMode` 看此刻的计数与活跃指数是否达标。记一行判定日志（见下）。
8. 开口：计数与活跃指数清零、记录触发时间；点名的写 `triggerType = 'immediate'`，否则写 `'interval'`；`next()`。`interval` 在多人会话且消息未带 `actor` 时回填无主体授权身份 `actor = selfInitiatedActor(platform)`：interval 回合没有主发言者，撞上阈值的那条消息的发言者不应决定 AI 自发行为的工具权限，authority 按默认等级裁决、不视为 owner，其白名单与会话授予也不替无主体回合解围。私聊纳入作用域后其 interval 只是频率闸，发言者仍是主体，不回填。不开口：影子归档后吞掉。

某个人设提供者读名字抛错时，名字检测只跳过它的名字，照常判定，记一条 warn（同一提供者同一原因只记一次）：

```
[trigger] 人设「<提供者>」读名字失败，点名识别跳过它的名字: <错误>
```

判定是同步的，同一会话接连到达的消息按到达顺序逐条判定：`intervalMode` 为 `fixed`、`fixedInterval` 为 2 时，同一时刻到达的 4 条放行第 2、4 条（默认的 `both` 下第 1 条的活跃指数已达下限，放行第 1、3 条）。

计数在判定放行时即复位。放行后若被 flow 相位的冷却或限速吞掉，这次触发作废，动态阈值也回到上限；冷却通常只有十秒量级，这期间再次攒够阈值的概率很低，因此不做预判。

**判定日志**：每条判定一行 debug 日志，不含消息正文：

```
[trigger] 判定 | session=<会话> | speak=<true|false> | addressed=<true|false> | reason=<reason>
```

`reason` 形如 `计数=3/5 指数=0.412 (阈值=0.850)`，点名时为 `点名`。

## 与模型触发插件二选一

本插件与仓库内的私有插件 `@aalis/plugin-trigger-laya`（经本机侧车由 Laya 模型判定，不发布到 npm，说明见 `packages/plugin-trigger-laya/README.md`）都是完整的触发插件，由 `trigger` 服务的胜者决定哪个生效（偏好 > 优先级 > 注册顺序）。两个都启用、没有偏好时本插件生效（Laya 的默认优先级 -10 低于本插件的 0）；偏好指向 Laya 时 Laya 生效，本插件对每条消息直接放行，计数与闲置都停下。切换方式：

- **切到 Laya**：在配置文件的 `servicePreferences` 写 `trigger: "@aalis/plugin-trigger-laya"`，或在 WebUI 服务页把 `trigger` 的偏好切到「Laya 模型」（即时生效）。
- **切到规则判定（即时）**：WebUI 服务页把 `trigger` 的偏好切到「规则（计数/评分）」，下一条消息起由本插件判定。
- **停用 Laya**：下一条消息起由本插件接手。
- 手改 `aalis.config.yaml` 的 `servicePreferences` 只在启动时读取，需重启才生效。

本插件的计数、活跃指数与闲置活动时间只统计它生效时经过的消息与 bot 回复；从不生效切回生效时，计数接着它上次生效时的状态算。

## 计数与评分

- 每条入站计数 +1；活跃指数增加 `1 / fixedInterval`，同一用户交互越多权重越高（上限 1.5 倍）。`scoreDecayMinutes > 0` 时活跃指数按距上一条消息的时间线性衰减。
- 动态阈值在 `activityScoreLower` 与 `activityScoreUpper` 之间：刚触发时为上限，随距上次触发的时间在 `activityDecayMinutes` 内线性降到下限。
- `intervalMode`：`fixed` 只看计数是否达到 `fixedInterval`；`dynamic` 只看活跃指数是否达到当前阈值；`both` 任一满足即可。`scoreDecayMinutes = 0` 且 `activityScoreUpper ≤ 1` 时，计数达标必然伴随活跃指数达标，`both` 与 `dynamic` 等价。

## 闲置触发

闲置触发只在本插件生效时开口：到点时它不是生效的触发插件就跳过，不注入，也不记为 bot 开口（session 档按原退避重排）。

`idleTriggerScope` 三档：

- `off`：关闭。
- `session`：每会话一个定时器，真人消息到来时退避复位为 1 并重排。到点时会话处于禁言期则跳过并按原退避重排；否则 `gateway.ingressMessage` 注入一条 `source='idle-trigger'` 消息，`exponential` 风格下退避翻倍（上限 `idleTriggerMaxMinutes`）。只有真人消息复位退避，agent 回复（包括回复闲置提示）不复位。
- `platform`：跨会话共用一个定时器。`idleTriggerStrategy` 决定触发时机：`all-quiet` 在所有会话都静默满 `idleTriggerMinutes` 后触发，`fixed` 每隔 `idleTriggerMinutes` 触发一次。到点后，在不处于禁言、冷却或限速已满状态的会话中，选最近活动最早的一个注入闲置触发消息。候选还要过分作用域覆盖：该会话有效配置的 `idleTriggerScope` 不是 `platform`（被单独关成 `off` 或改成 `session`）就跳过，提示词也按候选会话的有效 `idleTriggerPrompt` 取。节奏只看顶层配置，`idleTriggerMinutes` 与 `idleTriggerStrategy` 在 `platform` 档下不吃分作用域覆盖。每轮之间至少隔一个阈值量级（`idleTriggerMinutes`，下限 60 秒）。进程内还没有任何活动记录时，以启动时刻为静默起点。

会话的"最近活动"取真人消息与 bot 开口中较晚者；bot 开口指 agent 的真实回复或闲置注入本身。因此 agent 对闲置提示沉默时，刚被注入的会话在下一轮也不会再次当选。禁言期内的真人消息与命中禁言关键词的那条同样算真人活动，只是不计数（判定流程第 3、4 步）：session 档从这条消息起重排、退避复位为 1，platform 档的静默计时与挑选候选看的最近活动也随之更新。

注入的消息携带 `triggerType: 'idle'`、`source: 'idle-trigger'`：本相位跳过策略判定；flow 相位对它不查回复后冷却，禁言照常生效，会话落在 flow-control 作用域内时限速也照常生效（消息不带会话类型，flow-control 按会话已记下的类型或会话 ID 约定推断判作用域，默认 `*:group` 下发往群的闲置提示在限速窗口已满时被吞，闲置提示不做影子归档）。

## 出站联动

监听 `outbound:message`：`source === 'agent'`、本插件生效且持有该会话状态时，记为 bot 开口并重排 session 档闲置触发，不复位闲置退避。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `scopes` | multiselect | `["*:group"]` | 生效作用域：格式 platform:sessionType，支持通配 *；onebot:group / *:group / onebot:* / *。默认作用域不含 WebUI/CLI，如需纳入，在这里显式添加。 |
| `intervalMode` | select | `'both'` | 间隔模式：`fixed` / `dynamic` / `both` |
| `triggerOnAt` | boolean | `true` | 检测 @ 提及：@ 自己算被点名，点名直接开口，回合记为 immediate |
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

- 名字检测（`@aalis/api-trigger` 的 `createBotNames` 与 `isAddressed`）自动合并全部已登记人设的 `getPersonaName()` 与 `getNickNames()`，角色卡里声明的名字、昵称无需在触发名里重复配置。人设按会话取，与 agent 同一取法：session-manager 解析本会话的配置，其中的 `persona`（会话用的角色卡）传给这两个方法；会话改用别的角色卡时，算点名的是那张卡的名字、昵称，主卡的不算，别的会话不受影响。session-manager 缺席时取全局默认的卡。同时装了多个人设插件时，叫其中任何一个的名字都算点名。
- 禁言关键词**不**合并 persona：统一由本插件配置下发，避免角色卡措辞意外成为禁言开关，也避免进程级单例 persona 跨平台泄漏。
