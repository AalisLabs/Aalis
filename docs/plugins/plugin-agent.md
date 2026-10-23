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
    commands: optional(commands),
    tools: optional(tools),
    llm: optional(llm),
    memory: optional(memory),
    persona: optional(persona),
    messageArchive: optional(messageArchive),
    sessionManager: optional(sessionManager),
    authority: optional(authority),
    platform: optional(platform),
    media: optional(media),
    storage: optional(storage),
    gateway: optional(gateway),
    plugins: optional(pluginsService),
    sessionFields: optional(sessionFields),
    document: optional(ownHostConfig),
    services,
  },
  apply: run,
})
```

`hooks` 与 `contributions` 是 required 服务，分别由 [`@aalis/plugin-hooks`](./plugin-hooks.md) 与 [`@aalis/plugin-contributions`](./plugin-contributions.md) 提供；缺少任一时本插件停在 pending。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `systemPrompt` | textarea | `''` | 行为准则提示词：定义 Agent 的行为准则。当人设插件存在时，身份描述由人设提供，此处仅作为行为指令追加。 |
| `memoryTokenBudget` | number | `4096` | 长期记忆预留 Token：为注入的 system 消息预留的 token 额度，超出时先按比例缩减，极端情况下（阶段 5）仍会删除 |
| `promptBuildTimeoutMs` | number | `10000` | 提示词贡献构建超时 (ms)：单个 agent:prompt 贡献 build 的等待上限。挂死的构建（如网络检索卡住）超时后本轮缺席、其余照常，避免拖住每次 LLM 调用。0 表示不设限。 |
| `toolResultMaxRatio` | number | `0.15` | 工具结果最大比例：单条工具结果占上下文窗口的最大比例 (0~1)，超出则截断。例如 0.15 表示 15% |
| `trimThresholdRatio` | number | `1` | 裁剪触发比例：裁剪预算 = 上下文长度 × 该比例 − 最大输出 token − 512 安全余量（下限 1024）。本次调用估算输入 token 超过该预算才会对消息列表做内存裁剪（不影响 DB）。默认 1.0 表示用满扣除输出预留后的可用窗口；调低可提前裁剪。压缩触发按会话调：自动压缩线（摘要插件的字段）与历史条数上限（本插件的字段）。 |
| `think` | select | 不设 | 深度思考的档位 id；可按会话设，见下文 |
| `maxToolIterations` | number | 不设 | 最大工具迭代；可按会话设，见下文 |
| `historyLimit` | number | `0` | 历史条数上限；可按会话设，见下文 |

## 会话设置项

下面四项是可按会话覆盖的字段（[api-session-settings](../api/api-session-settings.md)），各种会话都适用，能按平台档、平台类型档、场所与单个会话分别设；会话设置不在场时只取插件配置（模型是本插件偏好）里的值：

| 键 | 字段 | 显眼程度 | 门槛 | 没设置时 |
|---|---|---|---|---|
| `llm` | `llm-ref`「模型」，只收服务与模型都是非空字符串的 `{ provider, model }`；指令里写条目 id `<提供者实例 id>/<模型 id>` | composer（也出现在输入框旁） | 1 级 | 跟随服务偏好：用 llm 服务此刻给本插件挑的模型（本插件偏好 > 全局偏好 > 提供者优先级 > 登记先后），界面写「跟随服务偏好（此刻：<模型名>）」 |
| `think` | select「深度思考」，存档位 id | common | 1 级 | 按模型的默认档 |
| `maxToolIterations` | number「最大工具迭代」，不小于 1 的整数，没有默认 | advanced | owner | 不限 |
| `historyLimit` | number「历史条数上限」，不小于 0 的整数，默认 0 | advanced | owner | 发全部活跃历史，不按条数压缩 |

「模型」的全局层不在插件配置里：它是本插件对 llm 服务的本插件偏好（`pluginServicePreferences['@aalis/plugin-agent'].llm`，插件详情「服务偏好」里 agent 的 llm 一行，与「会话默认」全局层的「模型」是同一个值）。本插件没设偏好时跟随全局偏好。手写在本插件配置段里的 `llm` 键不生效，告警一次。

本插件在 `fields()` 里给「模型」交此刻实际在用的值：界面写此刻的模型，建子会话时父会话没设模型的写下这一个。agent 服务的 `assignModel(sessionId, model)` 经读取器的 `set` 写一个会话本会话层的模型，子任务插件给子会话指定模型时调它。

「深度思考」的可选项是会话所用模型声明的档位（[api-llm](../api/api-llm.md) 的「深度思考的档位」）：字段的 `dynamicOptions` 是 `llm-thinking`，声明里写 `dependsOn: 'llm'`，界面取可选项时带上「模型」这一项的生效值（没设时带此刻实际在用的模型），模型变了就重取。每一轮里，当前模型有这一档才把它带进请求；没设置、换到了没有这一档的模型或模型不能调时不带，模型服务按它的默认档。设置的界面上，生效的档位当前模型没有时写这一档的名字与「当前模型没有这一档，按默认（<默认档的名字>）」，模型不能调时写「当前模型不能调」。本插件不另设默认模型、激活时也不碰偏好。「最大工具迭代」没设即不限，界面写「不限」。代价：卡在工具调用里的一轮只能手动停下（新消息不打断在跑的一轮），调用成本随轮数放大；要限的在对应的层设上限。

「历史条数上限」是一个数两种用途：发给模型的会话历史不超过这么多条（真实回合与 `token:request` 的快照都按会话取、同一个读法），装了摘要插件时也是按条数压缩的线，会话的消息到这个条数就全量压缩，不让旧消息悄悄滑出上下文。活跃历史超过它时一次丢掉最早的一半（半条线，向上取整），之后照常累积到这个条数再丢一段，发出的条数在半条线到整条线之间：起点只由活跃条数与条数线算出，两次丢弃之间发出的开头逐字不变，服务商的前缀缓存照样命中；起点落在工具调用组中间时，组首连同它的结果一起丢。丢掉的只是不再发给模型，会话历史本身保留，压缩时照样进摘要。压缩在途或没压成的几轮、不装摘要插件的部署都按这条规则。记忆后端实现了 `countHistory` 时每轮只读起点之后的那一段，没实现时读全部活跃历史再切。0 表示不按条数：发全部活跃历史，只按摘要插件的自动压缩线压缩。默认 0 面向本机使用；在线平台在平台档或平台类型档上设。不装摘要插件的部署没有压缩，默认 0 时每轮发全部活跃历史、输入一路涨到裁剪预算，应在全局层设这一项。

## 指令

本插件注册以下斜杠指令（由 `commands` 服务统一解析）：

| 指令 | 说明 |
|---|---|
| `/model [关键词]` | 列出 / 搜索可用对话模型（分页，`-p <n>` 翻页）；列出的条目 id 就是 `/session.set llm` 的写法 |
| `/persona [关键词]` | 列出 / 搜索可用人设（分页，`-p <n>` 翻页） |

看与改会话的设置（模型、深度思考、人设等）用会话设置插件的 `/session`、`/session.set`、`/session.reset`，见 [plugin-session-settings](./plugin-session-settings.md)。

> 默认模型：会话哪一层都没设模型时，用本插件偏好指向的模型，没设本插件偏好时用全局偏好（设置「系统 › 服务偏好」的 llm 一行，或配置文件的 `servicePreferences.llm`）。生效的偏好指向的模型不在（模型删了、提供者在重载或激活失败）时回合照常用服务落到的模型，每个（偏好，实际用的模型）组合记一条告警，写明是不是本插件偏好。

## 核心流程

1. **`agent:input:before` → `agent:turn:before`**: 前者每条输入一次，做预处理，中间件不调用 `next()` 则这条输入不进一轮；后者是一轮开始，带回合 id、会话与这一轮的输入，中间件不调用 `next()` 则这一轮不跑（不归档、不调模型、不发 `agent:turn:after`），照发流结束标记。它的默认动作开头按先后归档这一轮的输入（`archiveIncoming` 带回合 id 与进入方式 `opened`），以下步骤都在它里面
2. **构建系统提示词**: persona 提示词 + 配置的 `systemPrompt`（无人设时仅 `systemPrompt`），末尾固定追加输入约定块
3. **加载历史**: 按会话设置 `historyLimit` 从 memory 服务读发给模型的那一段（活跃历史超过 N 条时成段丢弃最早的，见「会话设置项」；0 或没设置时读全部活跃历史），跳过不完整的工具调用组与控制类消息。组的结果按调用之后逐毫秒记时间戳，按时间戳读历史的存储（MongoDB、SQLite）会把组写入期间归档的别的消息（插进来的输入、被触发判定或流控吞掉的群聊）排进调用与结果之间，装载时把它们挪到这组之后，保持各自先后
4. **收集工具**: 从 `tools` 服务获取工具定义：无分组的通用工具恒在，带分组的只取这个会话生效的工具分组（plugin-tools 的会话设置 `enabledToolGroups`，经 `sessionGroups` 取；`'*'` 为全部，空列表一个都不取）
5. **执行 Hook 管道**:
   - 组装 `agent:prompt` 贡献 — 记忆 / 摘要 / 技能 / 档案等提示词块按锚位物化进消息列表，单个贡献 build 超过 `promptBuildTimeoutMs` 时本轮缺席
   - `agent:llm:before` — 拦截、修改消息列表或工具列表（如工具搜索过滤、媒体规范化）
   - 插入点：真人消息开的一轮在这里取走待插入的输入（见「新消息怎么处理」），逐条归档（进入方式 `joined`）、追加到消息末尾、挂上各自的图，再增量组装、重跑 `agent:llm:before`，取空为止；格式重试的那几次调用不插
   - `trimMessages()` — 按 token 预算裁剪上下文
   - `chatStream()` — 流式调用 LLM；模型生成工具调用的参数时，每个调用配一个 `callId` 随流式片段的工具调用进度推出（`outbound:stream` 的 `toolCallProgress`），执行它时用同一个
   - 调用返回之后发 `token:usage`（见下文「Token 预算追踪与日志」）；调用抛错时不发
   - `agent:llm:after` — 处理 LLM 响应
   - 工具调用循环（最多会话设置 `maxToolIterations` 次，没设时不限）:
     - `agent:tool:before` → 执行工具 → `agent:tool:after`（中间件写进 `metadata` 的键随这次工具结果落库）
     - 参数不是合法的 JSON 对象（坏 JSON，或顶层是 `null`、数组、原始值）时不执行，把错误作为这次调用的结果回给模型重新生成，错误里带原文的前 200 字；写进本回合消息与存档的那次调用的 `arguments` 换成 `{}`，坏 JSON 不随 assistant 消息落库、下一轮不会被原样发回模型服务；空串按无参处理、原样保留
     - 每次调用都发一对 `tool:execute`（开始与结束）：没有执行就失败的（参数不合法、`agent:tool:before` 出错）同样发，结束带回给模型的错误，会话里的工具卡据此收尾
   - `agent:reply:before` — 后处理回复内容
   - `agent:turn:after` — 消息处理完成通知
6. **保存**: 输入在 `agent:turn:before` 的默认动作开头经 message-archive 归档，元数据记这一轮的回合 id 与进入方式（`TurnId`、`TurnEntry`）；每轮工具调用组（assistant + tool）与最终助手回复经 message-archive 的 `saveMessage` 写入，`metadata.turnId` 是这一轮的回合 id（会话服务据此把存档归回所在的回合，在途回合落了库的消息不重复进历史）；每次工具调用另记这次调用的 `callId`（tool 结果的 `metadata.callId` 与时间线的 `tool_call` 段，没有执行就失败的调用同样记），历史里的工具卡据此与实时推送对上；`agent:tool:after` 中间件写进 `metadata` 的键（如会话服务记下的审批结算）并进 tool 结果的元数据；空回复不保存
7. **发送**: 经 gateway 服务的 `dispatchOutbound` 分发（经过出站中间件链）；gateway 缺失时回退为直接发出 `outbound:message` 事件。回复与回合里发出的 `[错误]`、`[系统]` 提示带这一轮的 `turnId`：平台适配器记回复的投递失败时带上它，提示记成事件标记时同样记下；回复宿主通知时带上通知的 `hostNotice`（只有 `kind`、`id`），通知带 `replyTo` 的另带出站的 `replyTo`，支持引用的平台据此引用起那次工具调用的消息

**会话删除**：收到 `session:deleted` 时停下这个会话在跑的一轮、放掉排着的（不归档），并等它收尾，之后会话管理才清它的数据：删除一个正在跑的会话（WebUI 里删除、删除子任务、清空或删除父会话连带的子会话）时，这一轮当场停下，不再写进记录、不再发出。删除之前进来、之后才完成逐条处理的输入不开轮、不归档；之后同一 id 再来的消息照常开轮。等收尾没有时限：不响应中止的工具会让删除一直等到它返回。

`message-archive` 是可选服务。缺席时对话仍可运行、已有历史仍可读取，但新消息不会写入记忆，当轮发给模型的正文由 Agent 按存档同一份拼法自己拼（`buildIncomingContent`，发送者前缀按 api-message-archive 的 `speakerOf`，判房间类别与 owner 用 `session-manager` 与 `authority`）；Agent 在首次实际需要写入时告警，每次激活最多一次。归档服务恢复后，后续消息自动恢复归档，缺席期间的消息不补写。`create-aalis` 的 minimal 及更完整的模板均包含归档插件。

## 指令类回合

两类入站消息不是任何人的发言，以 system 指令块呈现，不推当前 user 消息，也不推易变上下文与群聊焦点指引：

- **代发任务**（`triggerType: 'proactive'`，如 workflow 的 agent 节点）：以 `[跨会话委派]` 任务块呈现，`metadata.injector` 为 `cross-session-delegation`。
- **宿主通知**（带 `hostNotice`，见 [schema-message](../api/schema-message.md)）：内容为 `[宿主通知]`、宿主正文，再接注入方包好的不可信段（`hostNotice.untrusted`），`metadata.injector` 为 `host-notice`。不可信段只在这一轮出现；归档只留宿主正文，之后的回合从历史里看不到它。

这类回合里历史中有旧的 user 消息，却没有当前 user 消息。`turn-context` 与 `turn-hint` 两个锚位的材料落在指令块之前、全部历史之后，不会插进历史内部（按「最后一条 user 之前」定位会割裂转录，并在只增不改的历史区制造新的缓存断点）；没有指令块时，`turn-hint` 仍落在最后一条 user 之前。

## 新消息怎么处理

新消息从不打断在跑的一轮。每个会话同一时刻最多一轮在跑：

- **叠加**：真人消息（不带 `source`）叠进由真人消息开的、在跑的一轮，不论谁说的、点没点名。插入点是这一轮每次调用模型之前（第一次与每批工具之后），插进来的排在之前那组工具调用之后；她已经在写最后的回复时才到的（最后一次模型调用返回不带工具调用的回复之后）不再插，排到下一轮。插进来的输入前不另加说明块，靠时间与发送者标注；多方房间里插进来被点名的，在它们之前另加一块焦点指引，列出至今被点名的各条（时间与发送者账号），前面那块不改，之后各次请求仍以之前的为前缀。点名按 schema-message 的 `wasAddressed`：真人输入的触发类型为 `direct` 或 `immediate`，没经触发判定的（owner 从 WebUI 往群里发的、跳过触发相位的房间）也算；带来源的注入（定时任务、编排、各种通知）不算，它开的一轮没有焦点指引。工具调用上下文的参与者按每批工具开始那一刻已送进模型的输入算，叠进来的人从下一批起算，已执行的不追溯。
- **排队**：插不进的排队：带来源的注入（定时任务、宿主通知、编排节点、白纸与作品通知、好友申请、空闲开话题、子任务的派发与追问），注入那一轮在跑时来的真人消息，赶上最后回复的真人消息。带来源的注入各自成一轮，不插进别的一轮，别的输入也不插进它那一轮。
- **开轮**：会话空闲时来一条就开一轮。一轮结束后取队首：队首是真人消息时，队里的真人消息按入队先后一起开下一轮，消息前写明「下面几条是你上一轮进行期间到的」（多方房间里这一批全是没点名她的插话时另加「没有需要接的可以不说话」）；队首是注入时只开它。开轮的是这一批里入队最早那条的 `handleMessage`，回合跑在它的异步上下文里（作品通知、编排的 agent 节点据此认出自己那一轮），其余各条等这一轮结束才返回。排着开的那一轮不再过冷却与限速（这些消息到达时已过闸）。
- **设置读一次**：模型、深度思考、工具迭代上限、条数线、工具分组与人设选项在开轮时读一次（按开轮那条的入口平台），插进来的不重读。多方与否取根会话记下的聊天窗口（`originChat.multiParty`），开轮时取一次；会话管理不在或根会话没有出生平台时按不是多方。
- **停下**：停止键只停在跑的一轮：它随即不再收输入，待插入的、排着的与之后到的照常开下一轮；禁言、后台页「全部停止」对子会话、停机连同排队与待插入的一起放掉，放掉的在这个会话在跑的一轮落定之后归档（不带回合 id）；会话删除与清消息历史的 `/clear`（不指定类型或含 `context`）同样连同排队项，放掉的不归档，`/clear` 先停下在跑的一轮、等它落定再清，停下到清完之间到的输入等清完再处理（不开轮，不会回了话又被清掉），`/clear -t vector` 这类不清消息历史的不停。被停下的一轮不落库回复、不外发，结局为 `aborted`，已完成的工具调用组留在历史里。停在工具里的一轮等工具返回才落定：工具调用上下文带这一轮的中止信号，`wait_subtasks`、`workflow_run` 这类等着别处的工具随它不再等、回已中止，不理会它的工具要等到自己返回，这期间排着的不开轮。
- **归档**：输入在进入一轮时归档：开轮的在 `agent:turn:before` 的默认动作开头，插进来的在插入时，都带回合 id 与进入方式；排着的不在历史里，消息的时间标注是进入这一轮的时刻。
- **排着的消息**：事件 `agent:queue` 报这个会话排着与待插入、还没进一轮的输入（按入队先后），入队、进了一轮、被放掉时发。
- **日志**：每条输入交给通道时一行 debug 记去向（`→ 待插入|排队|放掉 #到达序号 session=…`），进了一轮时再记一行（`→ 开轮|插入 #到达序号 session=… turn=…`），之后被放掉的另记「放掉」；没经网关进来的没有序号。每轮结束一行 info（`回合结束 turn=… session=… 结局=… 原因=… 用时=…ms 输入 #… #…`，原因只有被停下的才有），都不记正文与昵称。

## 工具调用上下文

工具循环每批工具构造 `ToolCallContext` 时，会话、`platform`、`userId`、`participants` 与 `inbound` 取 api-authority 的 `originTurnOf`（这一轮此刻已送进模型的输入，owner 的各个身份按权限服务的 `isOwner` 合成一个参与者，取最先进来的那一个，权限服务不在时按字面身份）：`inbound` 为 `{ source, fromTurn, messageId }`，真人消息的 `source` 为 `undefined`，内部注入为注入方标识；续做带着起它的那一轮（`fromTurn`）；`messageId` 是这一轮最近一条输入的平台消息 id，转到后台的调用结束时，结束通知据它引用这条消息。全仓只有这里填写它，工具据此正向判断「这次调用来自由入站消息驱动的回合」，执行守卫据此判发起回合的类别（见 [api-tools](../api/api-tools.md) 与 [plugin-authority](./plugin-authority.md)）。授权身份按参与者裁决（各条输入的 `actor`，没有时是发言者）。`userId` 是各条输入的物理发言者相同时的那一位，不同时没有；续做的通知不带它，取起它的那一轮的发言者，参与者同样取那一轮的。起它的那一轮不进归档，也不进提示词贡献视图的输入。

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

每次模型调用之后（首次调用、工具循环里的每次调用、格式重试），Agent 发出一条 `token:usage`，调用抛错的那次不发。`used` 取模型服务返回的这次调用的输入 token，没有返回或不是正的有限数时取按发出的消息与工具定义的估算；各项拆分按发出的（裁剪之后的）消息估算。`trimmed` 标出本回合到这次调用为止经过了硬裁剪（某次调用组装后的估算超过裁剪预算；首次调用裁剪过的列表是之后各次调用的底稿，有过一次本回合之后各次都算）；`untrimmedHistory` 是按没经过硬裁剪的列表估算的历史与工具结果；`historyMessages` 是这一轮开头会话的活跃历史条数（含条数线之外、没发给模型的部分）加本回合到这次调用为止追加的工具调用与结果，与硬裁剪无关。硬裁剪删了消息时记一行 info 日志，带会话 id 与前后条数。

收到 `token:request`（plugin-session-server 在客户端订阅会话、或手动压缩完成后发出）时，按当前会话组一份快照：历史与真实回合同一个读法，过同样的硬裁剪（不记日志），`used` 为估算，`historyMessages` 是活跃历史条数，不带 `turnId`。快照与真实回合用同一个预算公式，系统提示也按同一份会话设置（人设覆盖、结构化输出开关、额外提示）构建。

`token:request` 的 `platform` 是调用方的入口平台，可以不填（plugin-session-server 对房间不填，其余会话填连接的平台）。快照用的平台按以下顺序取：请求显式带的 `platform`；会话管理记下的出生平台（`originPlatform`，子会话取根会话的，不从会话 id 推）；`webui`。这个平台除了给没有出生平台的会话选平台档，还是提示词贡献方的「当前平台」（按平台取跨会话内容），所以 IM 房间的快照按房间的平台算，不按 webui 算。

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

