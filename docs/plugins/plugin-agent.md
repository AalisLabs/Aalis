# plugin-agent — 默认对话编排器

**包名**: `@aalis/plugin-agent`  
**源码**: `packages/plugin-agent/src/index.ts`

## 概述

默认的 `AgentService` 实现，负责编排完整的对话流程：组装提示词 → 加载历史 → 收集工具 → 调用 LLM → 工具循环 → 发送回复。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-agent',
  provides: [agent],
  uses: {
    logger,
    config,
    events,
    hooks,
    contributions,
    lifecycle,
    provide,
    services,
    commands: optional(commands),
    tools: optional(tools),
    llm: optional(llm),
    memory: optional(memory),
    persona: optional(persona),
    messageArchive: optional(messageArchive),
    sessionManager: optional(sessionManager),
    platform: optional(platform),
    media: optional(media),
    storage: optional(storage),
    gateway: optional(gateway),
    plugins: optional(pluginsService),
  },
  apply: run,
})
```

`hooks` 与 `contributions` 是 required 服务，分别由 [`@aalis/plugin-hooks`](./plugin-hooks.md) 与 [`@aalis/plugin-contributions`](./plugin-contributions.md) 提供；缺少任一时本插件停在 pending。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultLLM` | llm-ref | — | 默认对话模型：全局默认 LLM。apply 时经 `services.prefer(llm, \`${provider}/${model}\`)` 锁定偏好。会话 / 平台 profile 未覆盖时生效。 |
| `systemPrompt` | textarea | `''` | 行为准则提示词：定义 Agent 的行为准则。当人设插件存在时，身份描述由人设提供，此处仅作为行为指令追加。 |
| `memoryTokenBudget` | number | `4096` | 长期记忆预留 Token：为注入的 system 消息预留的 token 额度，超出时先按比例缩减，极端情况下（阶段 5）仍会删除 |
| `maxToolIterations` | number | `30` | 最大工具迭代：工具调用循环的最大迭代次数 |
| `promptBuildTimeoutMs` | number | `10000` | 提示词贡献构建超时 (ms)：单个 agent:prompt 贡献 build 的等待上限。挂死的构建（如网络检索卡住）超时后本轮缺席、其余照常，避免拖住每次 LLM 调用。0 表示不设限。 |
| `toolResultMaxRatio` | number | `0.15` | 工具结果最大比例：单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断。例如 0.15 表示 15% |
| `trimThresholdRatio` | number | `1` | 裁剪触发比例：裁剪预算 = 上下文长度 × 该比例 − 最大输出 token − 512 安全余量（下限 1024）。本次调用估算输入 token 超过该预算才会对消息列表做内存裁剪（不影响 DB）。默认 1.0 表示用满扣除输出预留后的可用窗口；调低可提前裁剪。压缩触发在会话设置里调：自动压缩线（摘要插件登记）与历史条数上限（本插件登记）。 |

## 会话设置项

本插件在 session-manager 上登记四个会话设置项（[api-session-manager](../api/api-session-manager.md)），各种会话都适用：

| 键 | 字段 | 显眼程度 | 没设置时 |
|---|---|---|---|
| `llm` | `llm-ref`「模型」，只收服务与模型都是非空字符串的 `{ provider, model }`（登记时给的 `validate` 核） | composer（也出现在输入框旁） | 用 llm 服务的偏好（本插件的 `defaultLLM`） |
| `think` | select「深度思考」，存档位 id（非空字符串，`validate` 核） | common | 按模型的默认档 |
| `maxToolIterations` | number「最大工具迭代」，不小于 1 的整数 | advanced | 用本插件配置的 `maxToolIterations` |
| `historyLimit` | number「历史条数上限」，不小于 0 的整数，默认 0；只经继承链实时解析，建子会话时不复制 | advanced | 读全部活跃历史，不按条数压缩 |

「深度思考」的可选项是会话所用模型声明的档位（[api-llm](../api/api-llm.md) 的「深度思考的档位」）：字段的 `dynamicOptions` 是 `llm-thinking`，登记上写 `dependsOn: 'llm'`，界面取可选项时带上「模型」这一项的生效值，模型变了就重取。每一轮里，当前模型有这一档才把它带进请求；没设置、换到了没有这一档的模型或模型不能调时不带，模型服务按它的默认档。设置的界面上，生效的档位当前模型没有时写这一档的名字与「当前模型没有这一档，按默认（<默认档的名字>）」，模型不能调时写「当前模型不能调」。「模型」没设时界面写「跟随服务偏好」（登记的 `unset`）；「最大工具迭代」的默认值是插件配置的 `maxToolIterations`，没设时界面写出这个数。

「历史条数上限」是一个数两种用途：一轮最多从记忆读进这么多条会话历史（真实回合与 `token:request` 的快照都按会话取），装了摘要插件时也是按条数压缩的线，会话的消息到这个条数就全量压缩，不让旧消息悄悄滑出上下文；压缩在途或没压成的几轮里，它是每轮历史条数的上限。0 表示不按条数：读全部活跃历史，只按摘要插件的自动压缩线压缩。默认 0 面向本机使用；在线平台在平台档或平台受众条目上设。不装摘要插件的部署没有压缩，默认 0 时每轮读全部活跃历史、输入一路涨到裁剪预算，应在全局默认上设这一项。

## 指令

本插件注册以下斜杠指令（由 `commands` 服务统一解析）：

| 指令 | 说明 |
|---|---|
| `/model [关键词]` | 列出 / 搜索可用对话模型（分页，`-p <n>` 翻页） |
| `/persona [关键词]` | 列出 / 搜索可用人设（分页，`-p <n>` 翻页） |
| `/session` | 查看当前对话生效的模型 / 人设 / 深度思考 / 名称，及各自的来源 |
| `/session.set` | 设定**会话级**覆盖（持久化，重启不丢） |
| `/session.reset` | 复位会话级覆盖：默认清模型 + 人设 + 深度思考，`-m`/`-p`/`-t` 单独清对应项（显示名不在此列） |

`/session` 对模型、人设、深度思考各给一行：生效值与来源。来源是「会话覆盖」「父会话」「平台档 `<平台>`」「平台档 `<平台>`（私聊）」「平台档 `<平台>`（群）」或「默认」，后两种平台档来源表示值来自该平台只对私聊或只对群生效的受众条目。会话自己有覆盖时，另起一行列出被覆盖的继承值与它的来源；被更高层遮住的下层值不列出。继承值与来源取自 session-manager 的 `resolveInheritance`，与实际回合同一口径：IM 房间按出生平台与受众选档，从 WebUI 对某个群执行 `/session`，显示的是这个群所在平台的档。

```
会话: <会话名>
模型: <provider>/<model>  [来源: 平台档 onebot]
人设: <人设卡>  [来源: 会话覆盖]
  被覆盖的继承值: <群人设>  [来源: 平台档 onebot（群）]
深度思考: (默认)  [来源: 默认]
  当前模型的档位：off（关）、high（高）、auto（自动）、max（最高），默认 auto
```

深度思考那一行之后另起一行写这一轮会用的模型的档位与默认档；生效的档位它没有时接着写「当前模型没有这一档，按默认」，模型不能调时只写「当前模型不能调」。

`/session.set` 的选项：

| 选项 | 值 | 说明 |
|---|---|---|
| `-m` | `provider/model` | 模型引用，即 LLM entry 的 contextId；用 `/model` 列出可选值 |
| `-p` | 人设卡名 | 不含后缀 |
| `-t` | 档位 id | 深度思考的档位，按这一轮会用的模型（同时给了 `-m` 时按新模型）校验：模型没有这一档时列出可选的档位，模型不能调时拒绝，都不写入 |
| `-n` | 显示名 | 会话显示名称 |

```
/session.set -m @aalis/plugin-llm-openai:main/gpt-4o -p catgirl
/session.set -p strict-reviewer
/session.set -t off
/session.set -n 深夜助手
```

> 全局默认模型由本插件的 `defaultLLM` 配置项决定；会话级设置优先于它。

## 核心流程

1. **`agent:input:before`**: 消息预处理 / 拦截；中间件不调用 `next()` 则以下步骤（含 LLM 调用）均不执行
2. **构建系统提示词**: persona 提示词 + 配置的 `systemPrompt`（无人设时仅 `systemPrompt`），末尾固定追加输入约定块
3. **加载历史**: 按会话设置 `historyLimit` 从 memory 服务读最近的 N 条消息（0 或没设置时读全部活跃历史），跳过不完整的工具调用组与控制类消息
4. **收集工具**: 从 `tools` 服务获取工具定义：无分组的通用工具恒在，带分组的只取会话生效配置 `enabledToolGroups` 列出的分组（`'*'` 为全部，未配置则一个都不取）
5. **执行 Hook 管道**:
   - 组装 `agent:prompt` 贡献 — 记忆 / 摘要 / 技能 / 档案等提示词块按锚位物化进消息列表，单个贡献 build 超过 `promptBuildTimeoutMs` 时本轮缺席
   - `agent:llm:before` — 拦截、修改消息列表或工具列表（如工具搜索过滤、媒体规范化）
   - `trimMessages()` — 按 token 预算裁剪上下文
   - `chatStream()` — 流式调用 LLM；模型生成工具调用的参数时，每个调用配一个 `callId` 随流式片段的工具调用进度推出（`outbound:stream` 的 `toolCallProgress`），执行它时用同一个
   - 调用返回之后发 `token:usage`（见下文「Token 预算追踪与日志」）；调用抛错时不发
   - `agent:llm:after` — 处理 LLM 响应
   - 工具调用循环（最多 `maxToolIterations` 次）:
     - `agent:tool:before` → 执行工具 → `agent:tool:after`（中间件写进 `metadata` 的键随这次工具结果落库）
     - 参数不是合法的 JSON 对象（坏 JSON，或顶层是 `null`、数组、原始值）时不执行，把错误作为这次调用的结果回给模型重新生成，错误里带原文的前 200 字；写进本回合消息与存档的那次调用的 `arguments` 换成 `{}`，坏 JSON 不随 assistant 消息落库、下一轮不会被原样发回模型服务；空串按无参处理、原样保留
     - 每次调用都发一对 `tool:execute`（开始与结束）：没有执行就失败的（参数不合法、`agent:tool:before` 出错）同样发，结束带回给模型的错误，会话里的工具卡据此收尾
   - `agent:reply:before` — 后处理回复内容
   - `agent:turn:after` — 消息处理完成通知
6. **保存**: 用户消息在回合开始时经 message-archive 归档；每轮工具调用组（assistant + tool）与最终助手回复经 message-archive 的 `saveMessage` 写入，`metadata.turnId` 是这一轮的回合 id（会话服务据此把存档归回所在的回合，在途回合落了库的消息不重复进历史）；每次工具调用另记这次调用的 `callId`（tool 结果的 `metadata.callId` 与时间线的 `tool_call` 段，没有执行就失败的调用同样记），历史里的工具卡据此与实时推送对上；`agent:tool:after` 中间件写进 `metadata` 的键（如会话服务记下的审批结算）并进 tool 结果的元数据；空回复不保存
7. **发送**: 经 gateway 服务的 `dispatchOutbound` 分发（经过出站中间件链）；gateway 缺失时回退为直接发出 `outbound:message` 事件。回复的出站消息带这一轮的 `turnId`，平台适配器记投递失败时带上它；回复宿主通知时带上通知的 `hostNotice`（只有 `kind`、`id`），通知带 `replyTo` 的另带出站的 `replyTo`，支持引用的平台据此引用起那次工具调用的消息

`message-archive` 是可选服务。缺席时对话仍可运行、已有历史仍可读取，但新消息不会写入记忆；Agent 在首次实际需要写入时告警，每次激活最多一次。归档服务恢复后，后续消息自动恢复归档，缺席期间的消息不补写。`create-aalis` 的 minimal 及更完整的模板均包含归档插件。

## 指令类回合

两类入站消息不是任何人的发言，以 system 指令块呈现，不推当前 user 消息，也不推易变上下文与群聊焦点指引：

- **代发任务**（`triggerType: 'proactive'`，如 workflow 的 agent 节点）：以 `[跨会话委派]` 任务块呈现，`metadata.injector` 为 `cross-session-delegation`。
- **宿主通知**（带 `hostNotice`，见 [schema-message](../api/schema-message.md)）：内容为 `[宿主通知]`、宿主正文，再接注入方包好的不可信段（`hostNotice.untrusted`），`metadata.injector` 为 `host-notice`。不可信段只在这一轮出现；归档只留宿主正文，之后的回合从历史里看不到它。

这类回合里历史中有旧的 user 消息，却没有当前 user 消息。`turn-context` 与 `turn-hint` 两个锚位的材料落在指令块之前、全部历史之后，不会插进历史内部（按「最后一条 user 之前」定位会割裂转录，并在只增不改的历史区制造新的缓存断点）；没有指令块时，`turn-hint` 仍落在最后一条 user 之前。

回合按「会话 + `source`」分道，同一道的新消息中止旧回合，不同道互不打断，宿主通知也从不打断别的回合。唯一的例外是本人说话打断通知回合：延续某次工具调用身份的宿主通知（带 `hostNotice.callerUserId`，如后台任务结束通知）开的回合，在同一会话收到 `userId` 等于 `callerUserId` 的真人消息（不带 `source`）时被中止，本人说话就停得下她自己开的一轮；别人的消息、不延续任何人身份的通知（白纸等）开的回合都不受影响。

## 工具调用上下文

工具循环构造 `ToolCallContext` 时填写 `inbound: { source: incoming.source, callerUserId: incoming.hostNotice?.callerUserId, messageId: incoming.messageId }`：真人消息的 `source` 为 `undefined`，内部注入为注入方标识；延续某次工具调用的宿主通知另带那次调用的发言者；`messageId` 是入站消息的平台消息 id，转到后台的调用结束时，结束通知据它引用这条消息。全仓只有这里填写它，工具据此正向判断「这次调用来自由入站消息驱动的回合」，执行守卫据此判发起回合的类别（见 [api-tools](../api/api-tools.md) 与 [plugin-authority](./plugin-authority.md)）。授权身份仍按 `actor` 裁决。`userId` 取入站消息的 `userId`，宿主通知不带它，延续某次工具调用的通知取 `hostNotice.callerUserId`；`callerUserId` 不进归档，也不作为提示词钩子的 `userId`。

## 上下文裁剪算法

估算 token 超过预算（上下文长度 × `trimThresholdRatio` − 最大输出 token − 512，下限 1024）时，`trimMessages()` 按下表各阶段依次裁剪，任一阶段后回到预算内即停止。

### 保护规则

- 首条系统消息（主提示词）— 永不删除
- 最新用户消息（当前任务上下文）— 永不删除
- 最后一组工具调用（assistant + tool 成组）— 永不删除
- 首条之后的注入系统消息（贡献块、易变上下文等）合计按 `memoryTokenBudget` 预留；超出时先在阶段 1 按比例缩减，阶段 5 作为最后手段删除

### 裁剪阶段

| 阶段 | 操作 | 说明 |
|---|---|---|
| 1 | 缩减注入的系统消息 | 首条与末条之间的 system 消息合计超过 `memoryTokenBudget` 时按比例截短，每条最少保留 200 字符 |
| 2 | 截断过长工具输出 | >1500 字符 → 保留前 500 字符 |
| 2.5 | 精简思考内容 | 超过 200 字符的 `reasoningContent` 从旧到新截断：旧条保留 200 字符，最新一条保留 400 字符（只截断不删除） |
| 3 | 摘要旧工具调用组 | 除最后一组外，压缩为 `[历史工具调用] 工具名 → 结果前 100 字符` 形式的单条 assistant 消息（仅在确实节省 token 时） |
| 4 | 删除最旧非系统消息 | 跳过受保护消息，assistant + tool 成组删除 |
| 5 | 删除注入的系统消息 | 最后手段 |

### 压缩后延续提示

阶段 4 之后仍超预算时进入阶段 5；此路径结束时若消息总数比裁剪前少 6 条及以上，在最后一条用户消息之后注入一条系统提示：

> [系统提示] 由于上下文长度限制，部分历史消息已被压缩或移除。请基于当前可见的上下文和最新用户请求继续完成任务，不要因为看不到之前的细节而停止工作。如果你之前有正在执行的多步骤任务或计划，请查看对话摘要和 todo-list 工具确认当前进度，然后继续未完成的步骤。

该提示防止模型因丢失上下文而放弃正在进行的任务。

## 扩展点

其他插件可通过 `agent:*` 中间件钩子拦截或修改各阶段，通过 `agent:prompt` 贡献点向提示词注入内容，也可以用 `registerPreprocessor` 注册输入预处理器，都无需修改 Agent 代码。钩子键与预处理器见 [api-agent](../api/api-agent.md)，钩子机制见 [api-hooks](../api/api-hooks.md)，贡献点见 [api-contributions](../api/api-contributions.md)。

## 模型调用的记账

每次调用模型时在请求里带上会话 id 与用途：子会话里的回合是「子任务」，其余是「对话」。服务商据此发 `llm:usage`，见 [api-llm 的记账](../api/api-llm.md#记账)。

## Token 预算追踪与日志

每次模型调用之后（首次调用、工具循环里的每次调用、格式重试），Agent 发出一条 `token:usage`，调用抛错的那次不发。`used` 取模型服务返回的这次调用的输入 token，没有返回或不是正的有限数时取按发出的消息与工具定义的估算；各项拆分按发出的（裁剪之后的）消息估算。`trimmed` 标出本回合到这次调用为止经过了硬裁剪（某次调用组装后的估算超过裁剪预算；首次调用裁剪过的列表是之后各次调用的底稿，有过一次本回合之后各次都算）；`untrimmedHistory` 是按没经过硬裁剪的列表估算的历史与工具结果；`historyMessages` 是这一轮开头读进的历史条数加本回合到这次调用为止追加的工具调用与结果，与硬裁剪无关。硬裁剪删了消息时记一行 info 日志，带会话 id 与前后条数。

收到 `token:request`（plugin-session-server 在客户端订阅会话、或手动压缩完成后发出）时，按当前会话组一份快照：历史按会话的条数线读，过同样的硬裁剪（不记日志），`used` 为估算，`historyMessages` 是读进的条数，不带 `turnId`。快照与真实回合用同一个预算公式，系统提示也按同一份会话配置（人设覆盖、结构化输出开关、额外提示）构建。

`token:request` 的 `platform` 是调用方的入口平台，可以不填（plugin-session-server 对房间不填，其余会话填连接的平台）。快照用的平台按以下顺序取：请求显式带的 `platform`；会话的出生平台（api-gateway 的 `resolveSessionOrigin`，即 IM 房间 id 的前缀）；`webui`。这个平台除了给没有出生平台的会话选平台档，还是提示词贡献方的「当前平台」（按平台取跨会话内容），所以 IM 房间的快照按房间的平台算，不按 webui 算。

```ts
'token:usage': [{
  sessionId, turnId /* 快照不带 */, platform, contextWindow, maxTokens, tokenBudget,
  used, usageRatio, trimmed, untrimmedHistory, historyMessages,
  breakdown: {
    system, persona, memorySummary, memoryVector, skills, platform,
    subtask, systemOther, history, toolResults, toolDefs, reservedForReply,
    injectors, // Record<string, number>：systemOther 按注入者细分的明细，键是注入者的全局键「插件实例 id/局部 id」
  },
  parts: [ // 拆分表：按显示的次序，带显示名
    { label: '历史消息', tokens }, { label: '工具结果', tokens }, { label: '工具定义', tokens },
    { label: '人设', tokens }, { label: '对话摘要', tokens }, { label: '向量记忆', tokens },
    { label: '技能', tokens }, { label: '平台提示', tokens }, { label: '子任务', tokens },
    { label: '其余系统提示', tokens, injectors },
  ],
}]
```

消费者：

- [plugin-session-server](./plugin-session-server.md) → 会话协议的 `usage` 条目（取 `parts`）
- [plugin-memory-summary](./plugin-memory-summary.md) → 回合结束时按这一轮最后一条用量判定自动压缩
- [plugin-prompt-budget](./plugin-prompt-budget.md) → AI 自查工具 `prompt_budget_info`

Agent 自身额外维护一个**节流日志记录器**：

- 状态：`sessionId → { count, lastRatioBucket }`
- 触发条件（满足任一即打印）：
  - `usageRatio` 所处区间（< 0.5 / 0.5–0.7 / 0.7–0.85 / ≥ 0.85）与上次不同时（含回落与会话首次）
  - 每 10 轮强制打印一次
- 标签：`OK / INFO / WARN / CRITICAL`，与 `prompt_budget_info` 工具阈值对齐

日志样例：

```
[token-usage:WARN] <sessionId> 23104/32000 (72.2%) sys=6100(persona=2300 mem=1800 skills=900 subtask=0 other=1100) hist=8901 tools=5400+2703def reserve=4096
```

CLI 与文件日志中也能看到预算消耗，无需打开 WebUI。

