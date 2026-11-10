# plugin-adapter-onebot — OneBot 协议适配器

**包名**: `@aalis/plugin-adapter-onebot`  
**源码**: `packages/plugin-adapter-onebot/src/`

## 概述

OneBot 协议适配器，通过 WebSocket 连接一个或多个 OneBot 实现端（如 go-cqhttp、Lagrange 等），支持 v11/v12 协议自动检测。

Aalis 是 WebSocket 客户端，主动去连实现端，所以实现端要开正向 WebSocket（NapCat 的网络配置里新建「WebSocket 服务器」），把它的地址填进连接的 `url`；实现端设了 token 的，`accessToken` 填同一个。不支持反向 WebSocket，也就是实现端主动连过来的那种（NapCat 里的「WebSocket 客户端」）。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-adapter-onebot',
  provides: [platform],
  uses: {
    storage,
    processService,
    events,
    logger,
    lifecycle,
    config,
    contributions,
    provide,
    llm: optional(llm),
    media: optional(media),
    memory: optional(memory),
    messageArchive: optional(messageArchive),
    flowControl: optional(flowControl),
    hooks: optional(hooks),
    i18n: optional(i18n),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `connections` | array | `[]` | 连接列表：配置一个或多个 OneBot WebSocket 连接 |
| `splitMessage` | object | — | 消息分条发送：启用后，文本将按选中的符号自动拆分为多条消息发送，模拟真人发送习惯 |
| `splitMessage.enabled` | boolean | `false` | 启用：是否启用消息分条发送 |
| `splitMessage.delayPerChar` | number | `50` | 每字延迟 (ms)：按下一条消息的字数计算延迟，单位毫秒/字 |
| `splitMessage.maxDelay` | number | `3000` | 最大延迟 (ms)：分条消息之间的最大延迟上限（毫秒） |
| `splitMessage.patterns` | multiselect | `["。","！","？",".","!","?","\\n"]` | 切割模式：在匹配到这些字符串的位置之后进行切割。每一项是一个完整的字符串：单字符（如 。）就在该字符后切；多字符（如 ". "、".\n"）则要整段匹配到才切。支持转义：\n=换行，\t=制表符，\r=回车，\\=反斜杠。 |
| `forward` | object | — | 合并转发处理：收到 &lt;forward&gt; 消息时如何展开、是否调用图像识别、是否调用 LLM 生成摘要 |
| `forward.enabled` | boolean | `true` | 启用自动展开：关闭后保留原始占位符，由 LLM 自行决定是否调工具读取。 |
| `forward.maxDepth` | number | `3` | 嵌套深度上限：递归展开嵌套合并转发的最大层数（顶层=1）。 |
| `forward.maxNodesPerLevel` | number | `30` | 单层节点上限：每层最多展开多少条节点。超过部分会被截断。 |
| `forward.imageRecognition` | boolean | `true` | 识别内部图片：把转发内的图片送入 media 服务转写为文字描述。需要该服务可用。 |
| `forward.imageRecognitionConcurrency` | number | `8` | 媒体识别并发上限：单条消息的转发展开内允许同时进行的媒体识别（图片/语音/视频）任务数。本地模型部署建议设 1-2：转发批量识别是后台工作，低并发能减少对实时入站识别的挤占（注意这是统计性缓解，不是优先级调度——多条消息各有各的并发额度，模型侧也无插队机制）。 |
| `forward.recognitionMaxItems` | number | `32` | 单条转发媒体识别上限：单条合并转发内最多识别多少个媒体（图片/语音/视频合计）；超出的以 [图片] 等占位符保留，不再消耗模型算力。设为 0 表示不限。 |
| `forward.summarize` | boolean | `true` | 生成摘要：展开后调用 LLM 生成一段摘要，代替原文写进给模型的转发展开，随存档正文进入对话、记忆与向量库；原文保留在缓存。 |
| `forward.summaryLLM` | llm-ref | — | 摘要模型：留空使用默认 LLM 服务；指定后按 (provider, model) 精确定位。建议挑便宜/快的模型。 |
| `forward.summaryMaxChars` | number | `600` | 摘要最大字符数：提示给摘要模型的目标长度上限。模型被允许超出 10% 以保留多人互动结构。输出上限只防失控，取本值的 3 倍、不少于 2048 token；模型在上限处停下时摘要末尾标出截断（「（已在长度上限处截断）」，按全局层的语言），带标记的摘要照常进转发缓存。 |
| `forward.summaryInputLimit` | number | `8000` | 摘要原文输入上限（字符）：喂给摘要模型的原文输入上限；原文超过则前段截断。设为 0 表示不截断（注意超长文本会增加摘要成本）。 |
| `forward.summaryPrompt` | textarea | `''` | 摘要 system prompt（高级，留空使用内置）：留空使用内置默认 prompt（专为保留多人互动结构调优过）。填入非空内容则完全覆盖默认 prompt。 内置默认 prompt 如下（&lt;输出语言&gt; 取全局层（plugin-i18n 的配置）的语言列表的第一项），可作为撰写参考： 你是聊天记录摘要助手。给定一段合并转发的原始内容，用 &lt;输出语言&gt;输出一段含多人互动细节的摘要： - 按时间顺序串联主线，使用“某人：……”或“某人对某人说……”这种紧凑句式保留发言人轮次与互动关系，但不要逐条复述每句寒暄； - 明确点出每位主要参与人的关键发言 / 立场 / 情绪变化，以及他们互相同意、反驳、调侃、追问的点； - 原文里出现的请求 / 指令 / 待执行事项 / 希望机器人代发或转告的内容，必须原文输出并保留具体目标对象 / 群聊 / 要表达的观点； - 图片识别结果、链接、文件名等视觉 / 附件信息也要写进来； - 不要寒暄、不要解释自己、不要使用 markdown 列表或标题；输出单段落纯文本； - 控制在目标字数以内，优先保留互动细节与可引用发言，寒暄/重复信息略去。 |
| `reply` | object | — | 引用消息处理：收到引用回复时如何展开被引用消息链 |
| `reply.maxDepth` | number | `5` | 引用链深度上限：递归获取被引用消息的最大层数。1 = 只读取直接引用；2 = 继续读取直接引用所引用的消息，依此类推。 |
| `attachmentCache` | object | — | 附件本地缓存：入站 / 出站的 image / audio / video / file 统一缓存到 data:/{kind}s/{会话目录}/onebot/，便于人工归档与多轮工具复用；/clear 与删除会话时由本适配器清理 |
| `attachmentCache.maxBytes` | number | `10485760` | 单文件大小上限 (Byte)：超过此尺寸的附件不落盘，保留原 URL（典型场景：长视频）。默认 10 MiB。 |

## 文件结构

| 文件 | 说明 |
|---|---|
| `index.ts` | 主入口，连接管理、事件分发、PlatformAdapter 实现 |
| `types.ts` | 类型定义、`segmentsToText()` 富文本渲染、CQ 字符串→消息段规范化、forward 段解析工具 |
| `v11.ts` | OneBot v11 协议处理器 |
| `v12.ts` | OneBot v12 协议处理器 |
| `attachment-cache.ts` | 入站/出站附件统一落盘缓存（`data:/{kind}s/{会话目录}/onebot/`，含单文件大小上限） |
| `attachments.ts` | 出站附件按文件头分流：能内联的媒体物化为消息段，文件附件与不能内联的媒体物化为上传文件；她回复正文里的媒体标记只发网址的，下载后内联，其余去掉 |
| `forward.ts` | 合并转发展开与摘要信封构造 |
| `forward-expand.ts` | 合并转发自动展开器（缓存、媒体识别、LLM 摘要、默认摘要 prompt） |
| `sent-messages.ts` | 已发送消息记录（供撤回等工具查询） |

## 协议处理

- **v11**: `post_type`/`message_type`，ID 为 number 类型，`send_private_msg`/`send_group_msg`
- **v12**: `type`/`detail_type`，ID 为 string 类型，统一 `send_message`，支持 channel/guild
- **auto**: 连接建立后主动探测，先调用 v11 的 `get_version_info`，成功即采用 v11；失败再调用 v12 的 `get_version`，成功则采用 v12；两者都失败时回退为 v11。协议确定前收到的事件会被丢弃

出站消息带 `replyTo`（被引用消息的平台消息 id，见 [schema-message](../api/schema-message.md#outgoingmessage)）时，只给第一条分条加引用段：v11 写作 `{ type: 'reply', data: { id } }`（id 能转成数字的按数字给），v12 写作 `{ type: 'reply', data: { message_id } }`；正文里模型自己写了 `<reply id>` 标记的，以它为准，不加第二个。现在只有 plugin-agent 回复后台任务的结束通知时带它，引用起那次工具调用的消息。

正文送达时，投递结果带上实现端给的各分条的 `message_id`（`messageIds`，按发送顺序，转成字符串，与入站引用段里的 id 同一写法）；附件的消息段与上传的文件不算在内。

## sessionId 格式

```
onebot:{selfId}:{detailType}:{targetId}
```

示例: `onebot:123456:group:789012`

`detailType` 取 `private`、`group` 或 `channel`；其中 `channel`（v12）的 `targetId` 为 `{guildId}:{channelId}`。

入站消息的 `sessionType` 原样带实现端给的消息类型（v11 的 `message_type`、v12 的 `detail_type`，缺省为 `private`）。适配器声明了 `group`（多方）、`private`（一对一）与 `channel`（多方）三种平台类型（`PlatformAdapter.sessionTypes`），显示名是群聊、私聊、频道（文字对象，带英文）：设置页的平台类型档按读者语言显示，模型看到的会话类型与召回片段取原文；声明以外的类型（如部分 v11 实现扩展的 `guild`）照样带出，会话管理按多方记下并告警。频道消息的 `groupId` 是 `{guildId}:{channelId}`，与会话 ID 的目标段一致。

平台提示（`agent:prompt` 贡献点的 turn-hint 锚位）：会话 ID 里的类型在本插件的声明里是多方（群与频道）时，提醒模型这一轮的历史里有多位群友的发言、留意时间先后；私聊不给。这一轮有一条输入是戳一戳或群文件上传转成的入站时，另说明这条消息是平台事件、不是用户输入的文字：按输入自带的事件种类（`noticeType` 为 `poke`、`group_upload`）认，不看正文，群友打出的像事件的文字不算。

## 多实例与路由

插件可以装多个实例（`reusable`），每个实例的 `connections` 可以带多个机器人账号。适配器实现了平台契约的 `canHandle(sessionId)`：只认会话 ID 里的 `selfId` 属于本实例连接的会话，包括配置里写明 `selfId`、连接还没上来的账号；离线的已知账号照样认领，由发送处报出连接不可用。`@aalis/api-platform` 的 `resolvePlatformBySession`、`sendPlatformMessage`、`callPlatformAction` 因此按账号路由到所属实例，`plugin-tool-onebot` 的合成会话 ID（`onebot:<selfId>:internal:0`）同样按账号路由；session-manager 收录房间时据此记下房间所属的实例（`SessionInfo.originInstance`）。没有实例认得的账号由路由处报错，报错列出各实例已知的账号与连接状态。

出站消息（`outbound:message`）也只由账号所属的实例认领；`getSelfIdentity(sessionId)` 只回答本实例账号的会话，不给会话时只有本实例恰好一个已知账号才回答，`api-platform` 的 `getPlatformSelfIdentity` 取第一个认得这个会话的实例。

## 连接管理

- 支持多连接同时在线
- 自动重连：连接断开后固定 5 秒重试；握手超过 15 秒未完成视为超时并重连
- 鉴权：填了 `accessToken` 的连接在握手请求头里带 `Authorization: Bearer <token>`。实现端拒绝时日志写明原因：握手时直接回 HTTP 状态码的（如 401），记下状态码与响应体（只留开头 4096 个字符）后立即断开，响应体读到上限还不结束或读到一半断了也一样，没到上限又不结束的由 15 秒的连接超时断开，同样记下读到的部分；接受握手后回一条不对应任何请求的失败回执再断开的（如 NapCat 在 token 没填或不对时回 1403「token验证失败」），按 warn 记下返回码与原话。两种都照常 5 秒后重连，token 改对之前一直重试
- Action 请求-响应：每个请求带唯一 echo ID，30 秒超时。结局分三种：实现端回成功；实现端回失败，确定没执行，报错带动作名、返回码与实现端原话，返回码是「不支持该动作」（v11 取 NapCat 的 1404，v12 是规范的 10002）时另标 `unsupported`，调用方只在这时改用别的动作名；超时或回执前断线，结果未知，实现端可能已经执行。发消息与上传文件都不重试：没等到回执的那条可能已经发出，重发会在群里出现两遍、在群文件里留两份
- 客户端心跳：每 30 秒发送一次 WebSocket ping，检查时若距上次收到 pong 或任何消息已超过 40 秒，则主动断开并重连（OneBot 的 heartbeat 元事件不单独处理，只作为普通流量计入）

## 消息入站

两种上报消息格式都支持：实现端的 `message` 既可以是消息段数组，也可以是含 `[CQ:…]` 码的字符串（`message_format=string`）。字符串格式在 v11 入站时先被规范化成消息段数组，之后附件提取、引用回复提取与 `segmentsToText()` 富文本渲染与数组格式共用同一条路径——`<at self>` 标记与 selfId 判定只有一处，CQ 码不会流进下游文本（触发插件的 @ 判定因此只认 `<at self>`）。段类型名与 data 键沿用 v11 段语义（`at.qq`、`image.url`/`file`、`reply.id` 等），参数原样透传。

文字段里能拼成 at、转发与附件引用标记的起始字符换成全角：`<at`、`<forward` 开头的 `<` 换成 `＜`，`| ref:` 里的 `|` 换成 `丨`，其余照原样。相邻的文字段（中间只隔着引用这类不出字的段时也算）连成一串再换，分在两段里的半个标记也认得出。昵称与分享标题同样处理（v12 没有消息段、退回 `alt_message` 时也一样），通知与申请合成的正文里的文件名、戳一戳的人的昵称与验证信息也一样；识别模型写的图片描述（引用消息里查到的、合并转发里识别出的）与转发摘要是模型写的字，图上写着什么就可能写出什么，同样转义。手打的标记因此不算标记：不算点名，不记进 @ 了谁，不当附件引用，也不触发合并转发展开。

适配器不做流控或触发判定：消息事件解析后直接以 `inbound:message` 发出，由生效的触发插件（如 `@aalis/plugin-trigger-policy`）与 `@aalis/plugin-flow-control` 在 `inbound:trigger` / `inbound:flow` 相位决定是否响应。机器人自身的群禁言与解禁事件，以及启动或重连后按 `shut_up_timestamp` 恢复的禁言状态，通过 `flow-control` 服务的 `setMuted` 同步。

好友申请、入群邀请与加群申请（request 事件）合成为 `[系统通知] …` 消息发出，提示 agent 调用对应的 onebot 工具处理：好友申请与入群邀请发往申请人的私聊会话，加群申请发往该群的会话。这些消息带 `source: 'onebot-request'`，属于系统侧注入：不经触发判定，不受回复后冷却约束，禁言与限速照常；在 agent 里各自成一轮，排在同一会话在跑的一轮之后，与真人消息互不打断。待处理的申请按收到它的账号登记（群请求另按申请类型与群号），处理成功才删；工具交来的账号或申请类型对不上、没有这条申请时报错（可能已处理）。合成的消息另带给人看的那句（`IncomingMessage.text`，如「用户 \<id> 向我发出了好友申请」），WebUI 画成通知行，`content` 照旧写给模型。私聊里的入群邀请卡片（只有一个 json 段，应用名 `com.tencent.qun.invite`）与入群邀请事件重复，一律丢掉、记一条 debug，不看之前有没有收到邀请事件；别的卡片照常入站。

戳一戳（v11 的 `notify/poke`、v12 实现扩展的 `detail_type: 'poke'`）统一转为入站消息，正文保留谁戳了谁。另带给人看的通知（`IncomingMessage.text`：「<昵称(id)> 戳了我」，戳别人时「<昵称(id)> 戳了 <昵称(id)>」；群文件上传转成的入站同样带「<昵称(id)> 上传了 <文件名>」），WebUI 画成通知行，正文 `content` 不动。群友戳机器人相当于 @ 机器人，`noticeTargetIsSelf: true`；群友互戳相当于未 @ 的普通互动，该字段为 `false`，仍进入同一条触发判断与流控链路。当前 Laya 模式下两者都由模型决定是否开口，互戳不享受点名消息穿透冷却与限速的待遇；规则触发模式下互戳照常累计入站计数。历史由原有触发/归档流程保存，适配器不另写一份。机器人自己发出的戳一戳属于动作回显，不再开启新回合。

## 附件与图片

入站和出站的图片、语音、视频、文件统一缓存到本适配器在会话媒体目录里的子目录 `data:/{kind}s/{会话目录}/onebot/`（[会话媒体的目录约定](../services/media.md#会话媒体的目录约定)），文件名是内容哈希，扩展名取文件头判定的格式（认不出的为 `.bin`，语音转成 `.wav`），单文件超过 `attachmentCache.maxBytes` 时不落盘、保留原 URL。渲染消息段时，落盘了的媒体与文件直接写成带存储地址的引用（`[图片 | ref:data:/images/…]`），写在这一段的位置，落盘失败的写占位（`[图片]`、`[语音]`、`[视频]`、`[文件]`）；附件的 `data` 也换成这个存储地址。

消息段里能当来源读的只有 `url` 里的网址与 base64 的 data URL。`file`（v12 的 `file_id`）是文件名或实现端的文件 id，只当名字；v11 的语音另把 `file` 交给 `get_record` 换地址、读实现端交回的那个（v12 标准没有这个动作，v12 的语音段一律不换）；写成本机路径、`file://` 或存储地址的都不读：群友能给文件起名，按它读就是让她读本机的文件或 Aalis 的存储。合并转发节点里的媒体段同一条规则。没有可用来源的附件照留、`data` 为空、不落盘，由下游写取不到。

`/clear` 与删除会话经 `memory:clear` 清这个子目录：四种各登记一个清理类型（`image`、`video`、`audio`、`file`），所选类型含哪种就清哪种，会话级清这个会话的，`/clear all` 清各会话的，每种一行结果；多个实例各清一遍，结果合成一行。

适配器不对普通入站图片调用视觉模型。合并转发内的图片在 `forward.imageRecognition` 开启时送 media 服务识别，语音与视频在 media 服务具备相应能力时一并识别。引用消息中的图片只复用 media 服务已有的描述缓存：渲染时按图片段的地址查，在这一段的位置写成 `[图片: 描述]`，查不到时写 `[图片]`。

## 出站正文

出站消息的正文默认按纯文字发：整条一个文字段，不解析标记、不分条。带 `markup` 的（她的回复，见 [schema-message](../api/schema-message.md#outgoingmessage)）才解析：`<at id>` 变成 @，`<image|record|video url>` 变成图片、语音、视频段，`<reply id>` 变成引用，`<face>` 去掉；开了 `splitMessage` 时按切割模式分条，图片单独成条。指令回复、宿主提示与其它插件的文字因此原样显示，群友让指令回显的标记不会变成 @、图片或引用。平台契约的 `sendMessage`（经 `sendPlatformMessage` 直发）同样只发纯文字。

带 `markup` 的正文里，媒体标记的地址是网址的（以 `http:`、`https:` 开头，不计首尾空白、不分大小写），适配器先经 `safeFetch` 下载、按文件头核对，改成 `base64://` 内联再发。解析不了、下载不了（含私网地址被拒）、超过 10 MiB 或内容不是能内联的媒体的标记去掉，文字照发，投递结果报失败。一条回复最多发 10 个媒体：正文里的媒体标记与 plugin-image-sender 把存储地址的标记转成的附件（见下）合计，按发出的先后数（正文在前，附件接在后面），多出的不读、不下载、去掉，投递结果报多出的个数；网址同时最多下载 4 个，按标记的先后排队。各条按顺序发，等到一条发一条：前面的文字不等后面的下载，媒体下载完在原位置发出。地址不是网址的（`file://`、本机路径、存储地址、data URI、正文里写的 `base64://`）一律去掉，不交给实现端，投递结果同样报失败，所有会话一样。去掉是在解析出的消息段上去掉：两边的文字照旧是文字，拼不出新的标记；图片本来单独成条，去掉后它前后的文字仍各是一条。存储里的媒体要装 plugin-image-sender，由它在网关派发前转成附件（见 [media 服务的「出站转换」](../services/media.md#媒体判据)），附件照下面「出站附件」的规则发出；它只摘掉转成了附件的标记，没转成的存储地址（过不了媒体判据、读不出、不是对应媒体）、别的写法与它摘掉标记后两边文字拼成的新标记都留在正文里，按这里的规则处理，存储地址的去掉、投递报失败。

附件物化出的消息段在正文之后各自单独成一条发出，不拼成标记再解析，不受 `markup` 影响，也不经上面对正文媒体标记的过滤。

## 出站附件

出站附件的内容读出后以 `base64://` 交给实现端，走 WebSocket 隧道：实现端在容器里（如 Docker 里的 NapCat）时读不到宿主路径，这是最稳的形态。storage URI 先量大小再读，超过 10 MiB 的不整份读进内存；一条消息的附件同时最多读或下载 4 个，按先后排队。

- **图片、语音、视频**：先按文件头认格式（格式签名在 [`@aalis/util-file-signature`](../utils/README.md)，与 `send_attachment` 的白名单是同一份），再分三路。实现端能内联的格式（图片 PNG、JPEG、GIF、WebP；语音 WAV、MP3、OGG、FLAC、AMR、SILK、M4A；视频 MP4、MOV、WebM）内联为消息段；认得出、但不能内联的媒体（BMP、AVIF、HEIC 图片，MKV、AVI 视频，以及与附件 `kind` 不符的媒体）改经文件上传，规则同下面的文件附件，没有名字时群文件名为类型加格式（如 `image.bmp`）；都认不出的拒发并记 warn。主体是 owner 的一轮里 `send_attachment` 能取不属于任何会话的任意可读 storage URI（见[媒体判据](../services/media.md#媒体判据)），不核对的话任意可读文件（如含密钥的配置）能冒充媒体发出。能内联、但超过 10 MiB 的网址附件拒发，原网址不交给实现端去拉（实现端再拉一次不经 SSRF 判定），所有会话一样；超过 10 MiB 的 storage 文件退回宿主的 `file://` 路径，实现端读不到时发不出，日志里会说明：实现端在容器里（如 Docker 里的 NapCat）读不到宿主路径，超过 10 MiB 的本机文件因此发不出去，这是送达方式的限制，要发更大的文件得让实现端与 Aalis 共享文件系统。storage 文件退回宿主路径之前同样按文件头核对（按字节区间读出开头 4 KiB，不整份读进内存），超过 10 MiB 又不能内联的不发。`send_attachment` 交来的是 storage URI，大文件照样经这道核对；附件本来就是 `file://` 或本机绝对路径（只有插件代码直接发出的附件是这种形态）、又没能落盘的，原样交给实现端，不经核对。
- **文件**（`kind: 'file'`）与改走上传的媒体：不走消息段。在文字与消息段发出之后逐个上传：群会话调 `upload_group_file`，私聊调 `upload_private_file`。`file` 只用 `base64://`；超过 10 MiB 的网址与 storage 文件、原样透传的 `file://` 一律拒发并记 warn。群文件里显示的文件名去掉 `/` 与 `\`，文件附件没有名字时用 `file`。v12 连接不支持文件上传，按失败处理。
- **投递失败回报**：由 agent 发出（`source: 'agent'`）的消息，文字发送、正文媒体标记（下载失败或地址不是网址而去掉）、附件物化（含文件头不符的拒发）或文件上传任何一处失败，都往会话记忆写一条 `outbound-delivery-failed`（`WellKnownKinds.OutboundDeliveryFailed`）系统记录，每条出站消息至多一条，agent 下一轮能看到并重发。投递结果的原因是文字对象：各条取报错的原话、不带错误名前缀，确定没发出的多条连成一句（原文以「；」，英文以「; 」）。记录的 `metadata` 带 `error`（与投递结果同一句原因）与这条消息的 `turnId`（一轮的回复）或 `callId`（经工具发出的），会话服务据此在历史里给那一轮的回复标「未发出」。发消息与上传文件没等到回执的（超时或回执前断线）单独说明：实现端可能已经收下，记录写明结果未知、不要重发，`metadata` 的 `unconfirmed` 列出这几项（如「消息（第 2 条）」「文件 a.html」），投递结果同样返回失败但附带这句提示。有这种项时投递结果就另带 `unconfirmed: true`（见 [schema-message](../api/schema-message.md)），发起方据此不重发、也不劝模型重发。正文各条与附件的消息段当一串逐条发出，一条没发成就停、后面的不发：正文没发出时，后面的图片等附件消息段也不发，上传的文件照常各自上传。前面已经发出的，投递结果另带 `sentPieces`（已发出的条数），原因只写停下那一条的原话（那一条没等到回执时它记进结果未知的名单，后面还有没发的写从第几条起没发出），记录带同一个条数（`metadata` 的 `sentPieces`），写明前几条已经发出、不要整条重发（后面还有没发的时写明从第几条起补），停在最后一条、这一条结果未知时同样，同一条消息里另有确定没发出的附件或文件时另说一句，会话服务据此标「只发出了前 K 条：<原因>」；送达快照（`outbound:delivered`）只带已发出的附件。

文件上传经适配器的非标准扩展方法 `uploadFile(sessionId, file, name)` 完成，它不在 `@aalis/api-platform` 契约里。

## 合并转发原文

展开不写进入站消息的正文：正文在转发处留 `<forward id="…">[合并转发消息]</forward>`，展开（信封）与给界面的事实（条数、前 8 个参与者与没列出的人数、摘要或截断的原文）放进入站消息的 `forwards`，存档拼回原位，模型看到的与展开写在正文里一样；关掉展开时照样交一项、展开就是占位。点名、禁言关键词与 @ 只看正文，转发里的不算（见 [schema-message](../api/schema-message.md) 的 `forwards`）。

展开只认实现端给的 forward 段：顶层取消息里的 forward 段，嵌套取转发节点内容里的 forward 段，正文与节点文字里手打的标记不触发拉取；一条消息有几个 forward 段就展开几个。转发节点的文字、分享标题与昵称，识别出的图片描述、摘要与顶层拉取失败时实现端的原话，写进原文与信封前与入站文字段同样转义。

合并转发展开后，完整原文在内存里缓存 1 小时，有 memory 服务时同时写入记忆元数据（namespace `onebot:forward`，key 为转发 id），每个收到的转发 id 都在同一份缓存里记下收到它的会话，不论展开没展开、拉没拉到：关掉展开的、展开时拉不到的、什么也没展开出来的与嵌套在里面的（含超过深度没展开的）也一样（按收到的先后，别的会话再收到同一条时补上，展开过的外层再被别的会话收到时连同嵌套的一并补上；持久化层里没记会话的条目读回时按空的算）。`get_forward_msg` 先查内存、再查持久化层：展开过的交回原文、摘要与收到它的会话；没展开过的交回收到它的会话与按 v11 标准的参数名 `id` 向实现端现拉（NapCat 也收它）的办法，由 `onebot_get_forward_msg` 按这些会话过取别的会话的规则、过了才拉，拉不到时报实现端原话；从没收到过的会话为空，工具判不出、不拉。展开时顶层拉不到的，信封写「拉取失败」与实现端原话，条目里不带展开结果，之后的 `get_forward_msg` 照常重新拉；实现端回了成功却什么也没展开出来的（数据为空或没有节点）同样不带展开结果、不调摘要，信封照常写出那一行；嵌套的拉不到写「拉取失败」一行，原话记 warn。展开过的条目还带两个截断标志（嵌套超过深度上限、节点超过单层上限）与没列出的参与人数，缓存命中时重建的信封与 `onebot_get_forward_msg` 的结果照样注明截断与没列出的人数。持久化条目保留 7 天，由后续写入惰性回收，每小时至多扫描一次。

原文是聊天内容，以 `context` 类型参与 `memory:clear`：全局清理（`/clear all` 不带类型或含 `context`）时清空持久化条目与内存缓存。条目记下的会话只用于取用判定，会话级 `/clear` 不动它，靠 7 天回收。多个适配器实例共用同一 namespace、各有一份内存缓存，清理时每个实例都清自己的缓存，回显合并为一条。
