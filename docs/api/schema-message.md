# schema-message — 平台消息数据契约

**包名**: `@aalis/schema-message`  
**源码**: `packages/schema-message/src/index.ts`  
**实现**: 由各 adapter 直接 emit；本包不提供 service

## 概述

定义 `IncomingMessage` / `OutgoingMessage` / `StreamChunkMessage` 以及 LLM 协议层 `Message` —— Aalis 平台 adapter 层（OneBot / WebUI / CLI）与编排层之间的消息边界。平台语义（Incoming/Outgoing）与 LLM 协议层 `Message` 同包、严格区分。

## IncomingMessage 关键字段

```ts
interface IncomingMessage {
  content: string;
  sessionId: string;
  platform: string;
  userId?: string;
  nickname?: string;
  images?: string[];                   // base64 或 URL
  files?: Array<{ name; data; mimeType? }>;
  attachmentOrder?: Array<'image' | 'file'>;
  sessionType?: 'group' | 'private' | 'channel';
  source?: string;                     // 系统侧注入者标识；真人消息不设。带 source 即内部注入（不经触发策略、不过冷却），并用于并发隔离
  groupName?: string;
  groupId?: string;
  replyTo?: { messageId; content?; userId?; nickname? };
  noticeType?: string;                 // 非消息事件，如 poke / group_upload
  noticeTargetIsSelf?: boolean;        // poke 是否指向机器人；false 按未点名互动判断，省略沿用戳机器人的语义
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
  hostNotice?: {                       // 宿主撰写的事件通知，见下文
    kind: string;
    id?: string;
    untrusted?: string;
    callerUserId?: string;
    replyTo?: string;
    facts?: Record<string, string | number>;
  };
  // 内部字段（preprocessor 写入）
  _imageDescriptions?: string[];
  _imageRecognitionInfo?: { imageCount; successCount; descriptions; transformedContent };
  _fileDescriptions?: string[];
}
```

### triggerType 语义

| 值 | 含义 |
|---|---|
| `direct` | 私聊或单一用户直连，userId 是主发言者 |
| `immediate` | 群聊被 @/名字主动触发 |
| `interval` | 群聊因频率/活跃度被动触发，userId 仅是"最后一条" |
| `idle` | 空闲自动触发，无 userId |
| `proactive` | 系统代发给 agent 的任务指令，如 workflow 的 agent 节点；content 是任务描述而非用户消息 |

真人消息的 `triggerType` 由 `inbound:trigger` 相位生效的触发插件写入（`immediate` / `interval`），平台适配器不设置；`idle`、`proactive` 由注入方自带。flow 相位对 `immediate` 不查回复后冷却与限速，入站消息上预设的 `immediate` 在触发插件的作用域外（或没装触发插件时）会原样生效。

### 宿主通知（hostNotice）

`hostNotice` 标记一条由宿主撰写的事件通知，它不是任何人的发言（如白纸枢纽的任务完成通知）。注入方的约定：

- 必须同时设 `source`；不设 `userId`、`nickname`、`sessionType`、`triggerType`。
- 身份：不延续某次调用的通知（如白纸的完成通知），`actor` 用 `selfInitiatedActor(platform)`，不设 `callerUserId`。延续某次工具调用的通知（如 plugin-tools 执行器的后台任务结束通知）沿用那次调用的身份、不高于它：`platform` 同那次调用，`actor` 取那次调用的有效授权身份 `actor ?? { platform, userId }`（都没有时仍为 `selfInitiatedActor`），`callerUserId` 为那次调用的 `userId`。允许延续身份的注入方要在 `test/architecture/host-notice-identity.test.ts` 登记，现在只有后台任务结束通知一处。
- `replyTo` 是回复这条通知时要引用的平台消息 id，取自起那次调用的入站消息（`ToolCallContext.inbound.messageId`）；入站消息没有平台消息 id 的不设。plugin-agent 回复时把它带进出站消息的 `replyTo`。
- `kind` 是通知的子类（如 `'paper-task'`），`id` 是注入方生成的通知标识，供日志与注入方自己的记录对位；`id` 的含义随 `kind`，如后台任务结束通知的是任务 id。
- `facts` 是给界面的事实：扁平的键值，键由定义这个 `kind` 的契约约定（如 [api-tools 的结束通知](./api-tools.md#结束通知)）。界面认得的 `kind` 据此画成状态，写给模型的 `content` 不给人看；`facts` 不进模型的上下文。
- 宿主撰写的行一律放在 `content` 里。`untrusted` 放注入方已用 `wrapUntrustedContent`（`@aalis/api-tools`）包好的不可信段，如远端代理的说明，放在最后。
- `callerUserId` 不是发言者：plugin-agent 只用它填这一轮工具调用上下文的 `userId`（工具眼里是谁在调）与 `inbound.callerUserId`（执行守卫据此判这一轮是不是 owner 链的延续），并让这位用户在同一会话发来的真人消息中止这一轮；归档、用户档案、关系与提示词钩子都不看它。

第一方各插件对它的处理：

- plugin-agent 以一条 system 消息呈现，内容为 `[宿主通知]`、`content`，再接 `untrusted`；不推当前 user 消息。工具调用上下文的 `userId` 取 `callerUserId`（见上）。
- plugin-message-archive 归档为 `role: 'notice'`、`kind: 'host-notice'`，元数据按登记的键记子类、`id` 与 `facts`（`HostNoticeKind`、`HostNoticeId`、`HostNoticeFacts`）；只归档 `content`，`untrusted`、`callerUserId` 与 `replyTo` 不写进消息也不写进 metadata。之后的回合从历史里只看得到宿主正文。
- 不进向量记忆，不计入关系图与用户档案的抽取计数，也不出现在它们的抽取窗口与记忆扩窗里；plugin-memory-history 的跨会话注入与 `recent_messages` 不带别的会话的宿主通知（见下文 `DIRECTIVE_KINDS`）。

带 `source` 的消息不经触发判定、不查回复后冷却，禁言与限速照常：禁言期被吞掉的通知经影子归档落成 notice，同样不含 `untrusted`。

## OutgoingMessage

```ts
interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  hostNotice?: { kind: string; id?: string }; // 最终通知关联，工具中途发消息不带
  replyTo?: string;                   // 引用回复：被引用消息的平台消息 id
  source?: 'agent' | 'system' | 'command';
  callId?: string;                    // 由工具调用发出时，那次调用的 id
  turnId?: string;                    // agent 一轮的回复：这一轮的 id
  modelInfo?: { provider?: string; model?: string; promptTokens?: number; completionTokens?: number };
  delivery?: Promise<{ ok: true } | { ok: false; error: string; unconfirmed?: true }>;
}
```

出站消息只带要发出去的正文与附件，不带思考与工具时间线：平台适配器只发正文；要展示思考与工具调用的客户端经会话协议拿（流式片段与 `reasoning` 条目），存档的 `Message` 照旧带 `reasoningContent` 与 `segments`。

`source='agent'` 表示由 AI 生成，可被分条延迟发送以模拟自然节奏；其它来源默认整条立即发送。

`modelInfo` 是 agent 一轮的回复由哪个模型生成与这一轮的 token（`promptTokens` 取回复定稿时的上下文，`completionTokens` 是这一轮各次调用的输出之和），agent 存档时把同一份写进这条 assistant 消息的元数据（登记的键 `ModelInfo`，见下文「存档元数据的键」），会话服务据此在实时推送与回看历史里标出回复的模型与 token。需要总数时取两项之和；用时由会话协议时间线条目各自的时刻（`at`）算出。

`replyTo` 是被引用消息的平台消息 id。支持引用的适配器把引用加在这条消息的第一条分条前（OneBot v11、v12 各按自己的消息段写法，正文里模型已写了引用标记的不再加第二个），其余适配器忽略。现在只有 plugin-agent 回复带 `replyTo` 的宿主通知时带上它。

`callId` 是发出这条消息的那次工具调用的 id（`ToolCallContext.callId`），如 `send_attachment` 发的附件。会话的客户端据此把消息挂到对应的工具卡上；平台收下后，房间里的工具卡标「已发到群」。

`turnId` 是 agent 一轮的回复所在回合的 id。平台适配器记投递失败（`WellKnownKinds.OutboundDeliveryFailed`）时把 `turnId` 或 `callId` 连同原因写进记录的元数据（登记的键 `TurnId`、`CallId`、`DeliveryError`），会话服务回看历史时据此标出哪条没发出。

`delivery` 是进程内的投递回执，不序列化、不持久化。目标适配器在出站监听器中同步填写；发起方等 `outbound:message` 广播结束后再等它。没有回执表示未确认，不能声称发送成功。Promise 始终 resolve；OneBot 成功表示平台接口确认接受；WebUI 自己的会话以会话历史为收件箱，成功表示已经写进会话历史（打开着的页面经会话服务推送，没打开的打开时从历史看到），存档服务不在场或写入失败都算失败；CLI 成功表示已在终端写出（附件写一行说明）。均不表示人已阅读。WebUI 镜像查看其他平台会话时不得认领或覆盖目标平台的回执。

失败回执带 `unconfirmed: true` 时表示请求已经发出、只是没等到平台确认，消息可能已经送达（如 OneBot 文件上传超时）；发起方不得自动重发，也不得劝模型重发。适配器只在失败全部属于这种情况时才带它，夹着确定没发出的部分时按普通失败报。没有这个标记的失败才是确定没送达。

发起方用 `awaitDelivery(delivery, signal)` 等回执：回合中止或等满 `DELIVERY_WAIT_MS`（90 秒）时返回 `undefined`，只表示未确认，不表示没发出（适配器的发送不随之取消），应告诉模型「结果未确认，请勿重发」。

`outbound:delivered` 在传输确认后发出，携带成功附件的快照；部分失败不包含失败附件。附件归档监听此事件，识图仍在后台处理；`outbound:message` 是发送请求，不能用它判断送达。

宿主通知可在入站的 `hostNotice` 中设 `reportOnly: true`：Agent 保留人设与对话，移除本轮请求中的历史工具协议，明确要求直接转述宿主结果，不暴露或执行工具。误调用工具、空回复或遗漏正文链接先纠正，与人设格式纠正共用重试预算（至少一次），用尽才由注入方兜底。客户端只收到校验后的正文，不流出生成中或失败轮的原文。模型失败通过 `agent:turn:after` 的 `error` 结果报告，不向会话发通用错误提示。需要工具后续行动的通知不设置此项。最终转述与宿主兜底的出站 `hostNotice` 只携带 `kind`、`id`，不携带入站的不可信说明或调用者身份；它用于关联派发，不代表平台送达。

## 事件（AalisEvents）

```ts
'inbound:message':           [message: IncomingMessage]
'inbound:message:archived':  [message: IncomingMessage]   // 已写入 memory
'outbound:message':          [message: OutgoingMessage]
'outbound:delivered':        [message: OutgoingMessage]
'outbound:stream':           [chunk: StreamChunkMessage]
```

`StreamChunkMessage` 带 `turnId`：所在回合的 id，由 agent 在回合开始时生成，同一轮的工具调用、用量与回合结束带同一个（见 [api-agent](./api-agent.md#回合-id)）。一轮的最后一个片段是 `done: true`，消息在 `agent:input:before` 被拦下时也会发这一片。

模型生成工具调用的参数时，片段带 `toolCallProgress { index, name, charsAccumulated, callId }`：`index` 是这次模型回复里的第几个调用，`charsAccumulated` 是已生成的参数字数，`callId` 是 agent 给这次调用配的 id，与之后执行它的 `tool:execute` 的 `callId` 相同，同一个调用的几次进度 `callId` 不变。会话服务据此在参数生成期间就给出工具卡。

## 工具函数（runtime exports）

```ts
getSenderLabel(nickname?: string, userId?: string): string | undefined;
prefixSender(content: string, nickname?: string, userId?: string): string;
getMessageName(userId?: string): string | undefined;
buildIncomingContent(incoming: IncomingMessage): string;
outboundMediaMessage(kind: 'image' | 'audio' | 'video' | 'file', ref: string, desc?: string): Message;
```

前三个用于在 LLM messages 里把发言者前缀化（群聊场景必要）。`buildIncomingContent` 把入站消息拼成归档文本（发送者前缀、引用回复、附件描述），归档与触发判定共用同一份拼法；归档文本是给模型看的，发言人自己写的话与附件清单另记在元数据里（见下文）。`outboundMediaMessage` 是发出的图片、音频、视频与文件归档进会话历史的写法：一条 assistant 消息，`kind` 为 `outbound-image` / `outbound-audio` / `outbound-video` / `outbound-file`，正文是附件引用占位符（如 `[音频: 描述 | ref:data:/audio/a.mp3]`；文件的描述位记文件名，如 `[文件: 主页.html | ref:paper:/…]`），时间戳与 `metadata` 由调用方补上。

## 存档元数据的键

`Message.metadata` 是开放字典。`WellKnownMetadataKeys` 登记由一方写入、另一方读取的键：写方与会话服务引用常量，第三方的 agent、存档与平台适配器照着写，读历史的一方（会话服务回看历史等）才还原得出说话人、文件、回复的模型与 token、工具卡的归组。

| 常量 | 键 | 谁写、写在哪 | 形状 | 谁读 |
|---|---|---|---|---|
| `VisibleContent` | `visibleContent` | agent：落库的回复是结构化输出的信封时，写解码后的可见正文 | 字符串，只在与 `content` 不同时写 | 检索、摘要等按语义读历史的一方，读不到退回 `content` |
| `SpokenContent` | `spokenContent` | 存档：提问里发言人自己写的话（入站消息的 `content`） | 字符串，可以是空串；只在与归档文本不同时写 | 会话服务给出提问条目的正文 |
| `Attachments` | `attachments` | 存档：提问带的附件 | `ArchivedAttachment[]`，按入站顺序；没有附件时不写 | 会话服务把文件还原成卡片、图片等按地址显示 |
| `Platform`、`UserId`、`Nickname` | `platform`、`userId`、`nickname` | 存档写入站消息的说话人；agent 给她自己的回复写这一轮的平台与她在那里的账号、昵称 | 字符串 | 会话服务标说话人与是不是 owner；向量记忆、用户档案与关系等 |
| `Source` | `source` | 存档写入站消息的 `source`（内部注入的来源，真人发言没有）；插件自己写的记录（发出的附件、投递失败）写插件的名字 | 字符串 | 会话服务标出提问是不是内部注入的 |
| `HostNoticeKind` | `hostNoticeKind` | 存档：宿主通知的子类（`hostNotice.kind`） | 字符串 | 会话服务给出通知条目的种类 |
| `HostNoticeId`、`HostNoticeFacts` | `hostNoticeId`、`hostNoticeFacts` | 存档：宿主通知的 `id` 与给界面的事实（`hostNotice.id`、`hostNotice.facts`），有才写 | 字符串；扁平的键值（值是字符串或数） | 会话服务给出通知条目的 `noticeId` 与 `facts` |
| `TurnId` | `turnId` | agent 写在这一轮落库的回复与工具结果上；平台适配器写在一轮回复的投递失败记录上 | 字符串 | 会话服务把存档归回回合、标出哪一轮的回复没发出 |
| `CallId` | `callId` | agent 写在工具结果上；平台适配器写在经工具发出的消息的投递失败记录上 | 字符串，即 `ToolCallContext.callId` | 会话服务把历史里的工具卡对回实时推送 |
| `ModelInfo` | `modelInfo` | agent 写在这一轮最后的回复上 | 同 `OutgoingMessage.modelInfo` | 会话服务标在回复条目上 |
| `SentRef`、`SentName` | `ref`、`name` | 归档发出的附件的一方（`outboundMediaMessage` 记的那条）：原样的地址与文件名 | 字符串 | 会话服务还原发出的附件：占位符里的地址遇到「]」会截断、描述位的「]」「\|」换成了全角，优先取这两个键 |
| `DeliveryError` | `error` | 平台适配器写在投递失败记录（`OutboundDeliveryFailed`）上：与投递结果同一句的原因 | 字符串 | 会话服务写出回复为什么没发出 |

```ts
interface ArchivedAttachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  name?: string;   // 入站附件带的文件名
  ref?: string;    // 地址：存储地址（<根>:/路径）或网址
}
```

附件的 `data` 不是地址时（内联数据、本机路径），存档取预处理器给这个附件写的描述里用 `formatAttachmentRef` 写的同种附件的引用作地址：预处理器把附件落盘后，在描述里这样写出落盘的位置，读历史的一方就能显示它。存档怎么取地址见 [plugin-message-archive](../plugins/plugin-message-archive.md)。

会话服务读历史只认登记的键，会话服务自己经 `agent:tool:after` 写进工具结果元数据的几个（审批结算、已发到群、停止时还没结束、退出码、后台任务 id）除外：api-agent 约定 agent 把这份元数据原样落库。没有 `SpokenContent`、`Attachments` 的旧提问按存档正文原样显示。

## kind 常量

`WellKnownKinds` 是框架约定的 `Message.kind` 取值，完整列表与出口前缀见[消息到 LLM 的处理流水线](../concepts/message-llm-pipeline.md)。其中两个是指令类：

| 常量 | 字面量 | 含义 | 出口前缀 |
|---|---|---|---|
| `CrossSessionDelegation` | `'cross-session-delegation'` | 系统代发的任务指令（`triggerType: 'proactive'`，如 workflow 的 agent 节点） | `[跨会话委派]` |
| `HostNotice` | `'host-notice'` | 宿主撰写的事件通知（入站消息带 `hostNotice`） | `[宿主通知]` |

```ts
const DIRECTIVE_KINDS: ReadonlyArray<string>; // [CrossSessionDelegation, HostNotice]
```

`DIRECTIVE_KINDS` 是宿主或系统撰写、不是任何人发言的指令类 kind：

- 归档消息的 `kind` 属于它时，抽取（用户事实、指令、关系）与记忆扩窗一律跳过，跨会话读取（plugin-memory-history 的注入与 `recent_messages`、plugin-user-relation 的跨会话窗口）不带别的会话的这类消息；
- 请求期消息的 `metadata.injector` 属于它时，就是本轮的指令块：`turn-context`、`turn-hint` 两个锚位落在它之前，DeepSeek 提供者不把它改成 user。

自己拼历史交给模型抽取的插件，应按这个常量过滤，不要只写其中一个 kind。

## 实现者

- 本包**只定义类型与事件名**，由所有 `plugin-adapter-*` 直接 emit；没有专门的实现包。

## 相关

- 入站编排见 [api-gateway](./api-gateway.md)
- Agent 预处理见 [api-agent](./api-agent.md)
