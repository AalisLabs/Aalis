# schema-message — 平台消息数据契约

**包名**: `@aalis/schema-message`  
**源码**: `packages/schema-message/src/index.ts`  
**实现**: 由各 adapter 直接 emit；本包不提供 service

## 概述

定义 `IncomingMessage` / `OutgoingMessage` / `StreamChunkMessage` 以及 LLM 协议层 `Message` —— Aalis 平台 adapter 层（OneBot / WebUI / CLI）与编排层之间的消息边界。平台语义（Incoming/Outgoing）与 LLM 协议层 `Message` 同包、严格区分。

## IncomingMessage 关键字段

```ts
interface IncomingMessage {
  content: string;                     // 正文；随消息转发来的聊天记录在这里只留占位，展开在 forwards
  sessionId: string;
  platform: string;
  userId?: string;
  nickname?: string;
  messageId?: string;                  // 平台侧消息 id（如 OneBot 的 message_id），存档记成 MessageId，引用回复据此反查归档原文
  attachments?: MessageAttachment[];   // 多模态附件的唯一入口，各平台适配器都只填它
  _attachmentDescriptions?: Array<string | undefined>; // 预处理时各插件给自己负责的附件写的文本描述，按 attachments 下标对齐
  sessionType?: string;                // 平台类型名：适配器在 PlatformAdapter.sessionTypes 里声明的类型之一，会话管理建档时按它记下聊天窗口；不带时平台声明了多方类型的按其中第一个、多方，只声明了一对一类型的按第一个，没声明的按 private、一对一
  selfId?: string;                     // 收到这条消息的机器人账号（平台给出时由适配器填，如 OneBot 的 self_id）
  source?: string;                     // 系统侧注入者标识；真人消息不设。带 source 即内部注入（不经触发策略、不过冷却、不过指令解析，不进长期记忆），各自成一轮、不与别的输入叠加
  arrival?: number;                    // 到达序号：网关在入站相位之前打的，这次运行内递增，只用于日志关联，不落库、不进模型
  ownerApproved?: boolean;             // 注入方声明：文字建立时经 owner 过目过原文，带 source 的注入只有它过指令解析，见下文
  groupName?: string;
  groupId?: string;                    // 多方聊天窗口的 id（如 OneBot 的群号，频道为 `<guild>:<channel>`）
  senderRole?: 'owner' | 'admin' | 'member'; // 群聊中发送者在群内的角色
  senderTitle?: string;                // 群聊中发送者的专属头衔
  selfRole?: 'owner' | 'admin' | 'member';   // 群聊中机器人自己在群内的角色，适配器查询后填
  selfTitle?: string;                  // 群聊中机器人自己的专属头衔
  replyTo?: { messageId; content?; userId?; nickname? };
  forwards?: ForwardedChat[];          // 随这条消息转发来的聊天记录，按在正文里出现的先后，见下文
  noticeType?: string;                 // 非消息事件，如 poke / group_upload；存档记成消息的 kind
  noticeTargetIsSelf?: boolean;        // poke 是否指向机器人；false 按未点名互动判断，省略沿用戳机器人的语义
  text?: TextRef;                      // 平台事件合成或转成的入站给人看的那句（如好友申请、戳一戳），不进模型，存档记成 Text
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
  actor?: { platform: string; userId: string }; // 代理身份：系统侧触发器投递时记「AI 应代谁执行」，授权按它算
  fromTurn?: FromTurn;                 // 发起它的那一轮：续做与子任务带着，见下文
  hostNotice?: {                       // 宿主撰写的事件通知，见下文
    kind: string;
    id?: string;
    untrusted?: string;
    reportOnly?: boolean;
    replyTo?: string;
    facts?: Record<string, string | number>;
    text?: TextRef;
  };
}
```

### 随消息转发来的聊天记录（forwards）

```ts
interface ForwardedChat {
  id: string;            // 平台给的转发 id：正文里它的占位按它对位
  content: string;       // 给模型看的展开，归档文本把它换进占位的位置（OneBot 的信封；获取失败时写原因；适配器关掉展开时就是占位本身）
  facts?: ForwardFacts;  // 给界面的事实；获取内容失败、展开出错与关掉展开时没有
}

interface ForwardFacts {
  count: number;          // 顶层的条数
  participants: string[]; // 参与的人，最多前 8 个（写法由适配器定，如 OneBot 的「昵称(账号)」）
  unlisted?: number;      // 没列出的人数；都列出了时没有
  text: string;           // 转发的文字：有摘要时是摘要，没有时是原文（可能截断）
  cutOff?: true;          // 原文被截断时为 true
}

type ArchivedForward = Omit<ForwardedChat, 'content'>; // 存档记下的一段（元数据的 Forwards），展开已按原位置拼进归档正文
```

随消息转发来的聊天记录（如 OneBot 的合并转发）不是发言人自己写的话。适配器在 `content` 里它所在的位置写 `forwardPlaceholder(id)`（`<forward id="…">[合并转发消息]</forward>`，转发 id 不含双引号；用户手打的同样写法先转义，同 `AT_SELF_PATTERN`），给模型的展开写在 `forwards` 一项的 `content`、给界面的事实写在 `facts`；适配器必须写占位，漏写的展开不进归档文本。归档文本（`buildIncomingContent`）把占位换回展开，模型看到的与展开写在正文里一样；发言人的话（`content`、存档的 `SpokenContent`）、点名、禁言关键词与 @ 的账号只看 `content`；存档另记成 `Forwards`。别的平台有转发照这条接：渲染成占位、展开放 `forwards`、转义手打的写法；存档、会话服务、WebUI、点名与画像都不认平台。

### triggerType 语义

| 值 | 含义 |
|---|---|
| `direct` | 私聊或单一用户直连，userId 是主发言者 |
| `immediate` | 群聊被 @/名字主动触发 |
| `interval` | 群聊没点名、因频率/活跃度被挑中；提示词按无明确主发言者写，授权身份照旧是这条消息的发言者 |
| `idle` | 空闲自动触发，无 userId；存档不落档，agent 以 system 指令块交给模型 |
| `proactive` | 系统代发给 agent 的任务指令，如 workflow 的 agent 节点；content 是任务描述而非用户消息 |

真人消息的 `triggerType` 由 `inbound:trigger` 相位生效的触发插件写入（`immediate` / `interval`），平台适配器不设置；`idle`、`proactive` 由注入方自带。flow 相位对 `immediate` 不查回复后冷却与限速，入站消息上预设的 `immediate` 在触发插件的生效范围外（或没装触发插件时）会原样生效。点名只决定她回不回与触发类型，不动授权身份：送进这一轮的话都按说它的人算，只有没有人的话引起的一轮（空闲开话题、没有创建者的定时任务等）才是她自己开口。

### 发起它的那一轮（fromTurn）

续做（如后台任务的结束通知开的一轮）与子任务（子任务插件在入站回合里派出的任务消息与追问）带着发起它的那次调用所在那一轮的事实：

```ts
interface FromTurn {
  platform: string;
  userId?: string;                                         // 那一轮的物理发言者
  participants: readonly { platform: string; userId: string }[]; // 那次调用的参与者（授权身份，originTurnOf 算；批过的是批的人）
  source?: string;                                         // 那一轮的来源，人亲手发来的没有
  fromTurn?: FromTurn;                                     // 那一轮自己的发起它的那一轮
}
```

权限服务按那一轮判这一轮的类别与主体（续做与子任务都与发起它的那一轮同一类别）；带它的消息不设 `actor`，这一轮的授权身份取它的参与者，agent 经 api-authority 的 `originTurnOf` 把发言者与参与者填进工具调用上下文。只由登记的注入方填（`test/architecture/host-notice-identity.test.ts`，现在是后台任务结束通知与子任务的任务消息），只在那次调用在入站回合里时填，不由模型给；不是发言者，归档、用户档案、关系与提示词钩子都不看它。

### 经 owner 过目的注入（ownerApproved）

`ownerApproved` 是注入方的声明：这段文字在建立时经 owner 过目过原文（owner 自己写下，或每次由 owner 审批）。注入方必须同时设 `source`，只给经 owner 过目原文的文字设。带 `source` 的注入里只有带这个声明的才当指令解析，判据与插件作者的写法见 [security-model](../concepts/security-model.md#注入的文字不执行指令)。

### 宿主通知（hostNotice）

`hostNotice` 标记一条由宿主撰写的事件通知，它不是任何人的发言（如执行器的后台任务结束通知）。注入方的约定：

- 必须同时设 `source`；不设 `userId`、`nickname`、`sessionType`、`triggerType`。
- 身份：不延续某次调用的通知（如插件自己发起的通知），`actor` 用 `selfInitiatedActor(platform)`。延续某次工具调用的通知（如 plugin-tools 执行器的后台任务结束通知）不设 `actor`，改带 `fromTurn`（那次调用所在那一轮，见上文），`platform` 同那一轮。
- `replyTo` 是回复这条通知时要引用的平台消息 id，取自发起那次调用的入站消息（`ToolCallContext.inbound.messageId`）；入站消息没有平台消息 id 的不设。plugin-agent 回复时把它带进出站消息的 `replyTo`。
- `kind` 是通知的子类（如后台任务的结束通知 `'background-task'`，即 api-tools 的 `BACKGROUND_TASK_NOTICE`），`id` 是注入方生成的通知标识，供日志与注入方自己的记录对位；`id` 的含义随 `kind`，如后台任务结束通知的是任务 id。
- `facts` 是给界面的事实：扁平的键值，键由定义这个 `kind` 的契约约定（如 [api-tools 的结束通知](./api-tools.md#结束通知)）。界面认得的 `kind` 据此画成状态，写给模型的 `content` 不给人看；`facts` 不进模型的上下文。
- 宿主撰写的行一律放在 `content` 里。`untrusted` 放注入方已用 `wrapUntrustedContent`（`@aalis/api-tools`）包好的不可信段，如外部服务回来的文字，放在最后。

第一方各插件对它的处理：

- plugin-agent 以一条 system 消息呈现，内容为 `[宿主通知]`、`content`，再接 `untrusted`；不推当前 user 消息。工具调用上下文的 `userId` 与授权身份取 `fromTurn`（见上文）。
- plugin-message-archive 归档为 `role: 'notice'`、`kind: 'host-notice'`，元数据按登记的键记子类、`id` 与 `facts`（`HostNoticeKind`、`HostNoticeId`、`HostNoticeFacts`）；只归档 `content`，`untrusted`、`fromTurn` 与 `replyTo` 不写进消息也不写进 metadata。之后的回合从历史里只看得到宿主正文。
- 不进向量记忆，不计入关系图与用户档案的抽取计数，也不出现在它们的抽取窗口与记忆扩窗里；plugin-memory-history 的跨会话注入与 `recent_messages` 不带别的会话的宿主通知（见下文 `DIRECTIVE_KINDS`）。

带 `source` 的消息不经触发判定、不查回复后冷却，禁言与限速照常：禁言期被吞掉的通知经影子归档落成 notice，同样不含 `untrusted`。

## OutgoingMessage

```ts
interface OutgoingMessage {
  content: string;
  text?: TextRef;                     // 正文是要翻译的文字时，它的文字对象
  sessionId: string;
  platform?: string;
  hostNotice?: { kind: string; id?: string }; // 最终通知关联，工具中途发消息不带
  replyTo?: string;                   // 引用回复：被引用消息的平台消息 id
  markup?: boolean;                   // 正文含平台标记、要解析；不设的按纯文字发
  source?: 'agent' | 'system' | 'command';
  callId?: string;                    // 由工具调用发出时，那次调用的 id
  turnId?: string;                    // agent 这一轮发出的消息：这一轮的 id
  modelInfo?: { provider?: string; model?: string; promptTokens?: number; completionTokens?: number };
  delivery?: Promise<
    | { ok: true; messageIds?: string[] }
    | { ok: false; error: string | TextRef; unconfirmed?: true; sentPieces?: number }
  >;
}
```

出站消息只带要发出去的正文与附件，不带思考与工具时间线：平台适配器只发正文；要展示思考与工具调用的客户端经会话协议拿（流式片段与 `reasoning` 条目），存档的 `Message` 照旧带 `reasoningContent` 与 `segments`。

`source='agent'` 表示由 AI 发出（她的回复与她经工具发的附件），`system` 是宿主提示，`command` 是指令回复。

`text` 是正文要翻译时它的文字对象：发起方同时写 `content`（`toSource(text)`，按原文渲染的整句）。经网关派发时，网关按这条消息所在会话（`{ sessionId, platform }`）的语言把它渲染进 `content`，i18n 缺席或渲染抛错时按原文；按连接显示的出口（会话协议的时间线、WebUI 会话的历史）另按各自的读者渲染它，其余照旧读 `content`。

`markup` 表示正文含平台标记、要解析：有标记语法的适配器（OneBot 的 `<at>`、`<image|record|video url>`、`<reply>`）把它们解析成 @、媒体与引用，并可分条延迟发送以模拟自然节奏。不设的正文一律按纯文字原样整条发出，不解析、不分条，其中回显的参数与错误信息不会变成 @、图片或引用。要发平台标记的出站自己设它，第一方只有 agent 的回复设。`attachments` 不受它影响，照常发出。媒体标记的地址不是网址的（`file://`、本机路径、存储地址、data URI、正文里写的 `base64://`），适配器不得自己读取，也不交给实现端，一律去掉并报投递失败：存储里的媒体由 plugin-image-sender 在派发前过媒体判据转成附件，留在正文里的存储地址是没转成的（过不了判据、读不出、不是对应媒体，或没装它）。正文里的媒体标记怎么发，见 [media 服务的「出站转换」](../services/media.md#媒体判据)。

`modelInfo` 是 agent 一轮的回复由哪个模型生成与这一轮的 token（`promptTokens` 取回复定稿时的上下文，`completionTokens` 是这一轮各次调用的输出之和），agent 存档时把同一份写进这条 assistant 消息的元数据（登记的键 `ModelInfo`，见下文「存档元数据的键」），会话服务据此在实时推送与回看历史里标出回复的模型与 token。需要总数时取两项之和；用时由会话协议时间线条目各自的时刻（`at`）算出。

`replyTo` 是被引用消息的平台消息 id。支持引用的适配器把引用加在这条消息的第一条分条前（OneBot v11、v12 各按自己的消息段写法，正文里模型已写了引用标记的不再加第二个），其余适配器忽略。现在只有 plugin-agent 回复带 `replyTo` 的宿主通知时带上它。

`callId` 是发出这条消息的那次工具调用的 id（`ToolCallContext.callId`），如 `send_attachment` 发的附件。会话的客户端据此把消息挂到对应的工具卡上；平台收下后，房间里的工具卡标「已发出」。

`turnId` 是 agent 这一轮发出的消息（回复与 `[错误]` 等提示）所在回合的 id。平台适配器记回复的投递失败（`WellKnownKinds.OutboundDeliveryFailed`）时把 `turnId` 或 `callId` 连同原因写进记录的元数据（登记的键 `TurnId`、`CallId`、`DeliveryError`，停在中途的另记 `SentPieces`），会话服务回看历史时据此标出哪条没发出；出站记进会话历史的各条（不是回复的文字记成的事件标记、发出的附件）由存档同样记下 `TurnId`（api-message-archive 的 `recordOutbound`），会话服务据此认出在途回合里的那一条，取快照时不与实时条目重复。

`delivery` 是进程内的投递回执，不序列化、不持久化。目标适配器在出站监听器中同步填写；发起方等 `outbound:message` 广播结束后再等它。没有回执表示未确认，不能声称发送成功。Promise 始终 resolve；OneBot 成功表示平台接口确认接受；WebUI 自己的会话以会话历史为收件箱，成功表示已经由存档写进会话历史（打开着的页面经会话服务推送，没打开的打开时从历史看到），存档服务不在场或写入失败都算失败；没有窗口的子会话由存档认领，成功同样表示已经写进它自己的历史；CLI 成功表示已在终端写出（附件写一行说明）。均不表示人已阅读。WebUI 镜像查看其他平台会话时不得认领或覆盖目标平台的回执。

成功回执的 `messageIds` 是正文送达时平台给出的消息 id：分条发出的各一个，按发送顺序，与入站 `replyTo.messageId` 同一写法，引用回复据它认出被引用的是哪一条（如 [plugin-chat-approval](../plugins/plugin-chat-approval.md) 认审批消息）。平台不给 id、或只发出了附件时没有。

失败回执的 `error` 是给人看的原因，可以是文字对象（`TextRef`，按读者语言显示）；交给模型、写日志的一方取 `toSource`。失败回执带 `unconfirmed: true` 时表示有请求已经发出、只是没等到平台确认，那部分可能已经送达（如 OneBot 发消息或上传文件超时、等回执时断线）；发起方不得自动重发，也不得劝模型重发。只要有一部分属于这种情况适配器就带它。没有这个标记的失败才是确定没送达。失败回执带 `sentPieces` 时表示逐条发出（分条的正文与各自成一条的附件）停在了中途：前 `sentPieces` 条平台已经收下，之后的没收下或结果未知，补发只补后面的；一条都没发出时不带。

发起方用 `awaitDelivery(delivery, signal)` 等回执：回合中止或等满 `DELIVERY_WAIT_MS`（90 秒）时返回 `undefined`，只表示未确认，不表示没发出（适配器的发送不随之取消），应告诉模型「结果未确认，请勿重发」。

`outbound:delivered` 在送达之后发出，是送达部分的快照，给存档与旁观者用：文字送达时才带 `content`，部分失败不包含失败附件。认领回执的适配器在送达后对每条消息都发，只有文字的也发，存档据此调 api-message-archive 的 `recordOutbound` 记进会话历史（记法见 [plugin-message-archive](../plugins/plugin-message-archive.md)）；送达本身就是写进会话历史的适配器（WebUI）不发，改为直接调 `recordOutbound` 并等它兑现。`outbound:message` 是发送请求，不能用它判断送达。

宿主通知可在入站的 `hostNotice` 中设 `reportOnly: true`：Agent 保留人设与对话，移除本轮请求中的历史工具协议，明确要求直接转述宿主结果，不暴露或执行工具。误调用工具、空回复或遗漏正文链接先纠正，与人设格式纠正共用重试预算（至少一次），用尽才由注入方兜底。客户端只收到校验后的正文，不流出生成中或失败轮的原文。模型失败通过 `agent:turn:after` 的 `error` 结果报告，不向会话发通用错误提示。需要工具后续行动的通知不设置此项。最终转述与宿主兜底的出站 `hostNotice` 只携带 `kind`、`id`，不携带入站的不可信说明或调用者身份；它用于关联派发，不代表平台送达。

## 事件（AalisEvents）

```ts
'inbound:message':           [message: IncomingMessage]
'inbound:message:archived':  [message: IncomingMessage]   // 已写入 memory
'outbound:message':          [message: OutgoingMessage]
'outbound:delivered':        [message: OutgoingMessage]
'outbound:stream':           [chunk: StreamChunkMessage]
```

`StreamChunkMessage` 带 `turnId`：所在回合的 id，由 agent 在回合开始时生成，同一轮的工具调用、用量与回合结束带同一个（见 [api-agent](./api-agent.md#回合-id)）。一轮的最后一个片段是 `done: true`，这一轮在 `agent:turn:before` 被拦下时也会发这一片。

模型生成工具调用的参数时，片段带 `toolCallProgress { index, name, charsAccumulated, callId }`：`index` 是这次模型回复里的第几个调用，`charsAccumulated` 是已生成的参数字数，`callId` 是 agent 给这次调用配的 id，与之后执行它的 `tool:execute` 的 `callId` 相同，同一个调用的几次进度 `callId` 不变。会话服务据此在参数生成期间就给出工具卡。

## 工具函数（runtime exports）

```ts
getSenderLabel(nickname?: string, userId?: string): string | undefined;
prefixSender(content: string, nickname?: string, userId?: string): string;
stripSenderPrefix(content: string, label: string | undefined): string;
getMessageName(userId?: string): string | undefined;
buildIncomingContent(incoming: IncomingMessage, speaker?: Pick<IncomingMessage, 'nickname' | 'userId'>): string;
forwardPlaceholder(id: string): string;
withForwards(content: string, forwards: readonly ForwardedChat[] | undefined): string;
outboundMediaMessage(
  kind: 'image' | 'audio' | 'video' | 'file',
  ref: string,
  opts?: { desc?: string; source?: OutgoingMessage['source'] },
): Message & { content: string };
outboundMarkerMessage(msg: OutgoingMessage): Message | undefined;
oneSpeaker(inputs: readonly Pick<IncomingMessage, 'platform' | 'userId'>[]): boolean;
wasAddressed(message: Pick<IncomingMessage, 'source' | 'triggerType'>): boolean;
AT_SELF_PATTERN: RegExp;
extractMentions(text: string): string[];
arrivalTag(message: Pick<IncomingMessage, 'arrival'>): string;
groupToolCalls(messages: readonly Pick<Message, 'role' | 'toolCalls' | 'toolCallId'>[]): MessageUnit[];

interface MessageUnit {
  at: readonly number[];                      // 各条在原列表里的下标：工具组是调用在前、各条结果按找到的先后
  shape: 'complete' | 'partial' | 'loose' | 'single';   // 结果找齐了的工具组、没找齐的、组外的工具结果、别的单独一条
}
```

`getSenderLabel`、`prefixSender`、`getMessageName` 用于在 LLM messages 里把发言者前缀化（群聊场景必要）。`stripSenderPrefix` 去掉归档文本里烘进的发送者前缀：只在 `content` 以 `[label]: ` 开头时去掉这一段，`label` 取存档记下的 `SenderLabel`，没有时原样返回，正文自己以 `[..]: ` 开头的不动；把归档文本重排给模型或界面看、身份另有标注的一方（向量记忆的召回片段、OneBot 的撤回摘录与引用反查）用它。`buildIncomingContent` 把入站消息拼成归档文本（转发的展开换回正文里占位的位置，再加发送者前缀、引用回复、附件描述），归档与触发判定共用同一份拼法；给了说话人（`speaker`）才加发送者前缀，不看平台，谁算说话人由调用方定（参考规则是 api-message-archive 的 `speakerOf`）；归档文本是给模型看的，发言人自己写的话、附件清单与转发另记在元数据里（见下文）。`forwardPlaceholder` 是正文里一段转发所在位置的占位，适配器写进 `content`；`withForwards` 把正文里的转发占位换成对应的展开，没有对应展开的占位原样留着。`outboundMediaMessage` 是发出的图片、音频、视频与文件归档进会话历史的写法：`kind` 为 `outbound-image` / `outbound-audio` / `outbound-video` / `outbound-file`，正文是附件引用占位符（如 `[音频: 描述 | ref:data:/audio/a.mp3]`；文件的描述位记文件名，如 `[文件: 主页.html | ref:workspace:/…]`）。出站的 `source` 是 `agent` 的是她发的，`role: 'assistant'`；其余是插件发的，`role: 'notice'`，进模型时是一条系统通知，不算她的发言。时间戳与 `metadata` 由调用方补上。`outboundMarkerMessage` 是不是她回复的出站文字（`source` 不是 `agent`，如指令的回复、宿主提示）归档进会话历史的写法：一条事件标记（`role: 'system'`、`kind: 'event-marker'`，不进模型的上下文），正文是 `content`，元数据记文字对象（登记的键 `Text`，有才记）；她的回复与空文字回 `undefined`，时间戳与出站的 `Source`、`TurnId`、`CallId` 由调用方补上（与 `outboundMediaMessage` 记的附件同一条规则，见 api-message-archive 的 `recordOutbound`）。不是她回复的出站文字的归档一律用它，会话服务回看历史才能还原成同样的通知。`oneSpeaker` 判一轮的各条输入是不是同一位物理发言者（平台与账号都相同）说的：会话语义的发言者（工具调用上下文的 `userId`、人设的说话人事实）只在这时有，api-authority 的 `originTurnOf` 与人设插件都用它。`wasAddressed` 判一条输入点没点名她：真人输入（不带 `source`）的触发类型为 `direct` 或 `immediate`，没有触发类型的（没经触发判定）按 `direct` 算，带来源的注入（定时任务、编排、各种通知）不算；agent 的焦点指引与排着开的一轮的说明、档案与关系子图的主发言者都按它判。`AT_SELF_PATTERN` 是适配器按机器人账号写下的对她的 @（`<at self …>…</at>`），读的一方只认这个结构化标记、不按文字猜；文法与读它的几处见[消息到 LLM 的处理流水线](../concepts/message-llm-pipeline.md)。`extractMentions` 按同一套文法取一段文字 @ 了哪些账号（`<at id="…">` 与 `<at self id="…">` 里的账号，按出现先后去重；@全体不是账号、不算，入站写作 `<at>all</at>`，她的回复里写作 `<at id="all">`）；存档从发言人自己写的话里抽，记成 `Mentions`。`arrivalTag` 是日志行里一条输入的到达序号（` #<序号>`，带前导空格，接在动作之后；没经网关进来的为空串），网关、触发、流控与 agent 的日志据此串起同一条输入，不记正文与昵称。`groupToolCalls` 是读历史的各方共用的工具调用组归组：从带工具调用的 assistant 往后找 `toolCallId` 对得上的结果，结果找齐、遇到下一次工具调用或对不上、重复的结果就停，其间别的消息挪到这组之后、保持各自先后，回挪过之后的次序；各方只比单位的形状，组外的工具结果是 `loose`。组的结果按调用之后逐毫秒记时间戳，按时间戳读历史的存储（MongoDB、SQLite）会把组写入期间归档的别的消息（插进来的输入、被触发判定或流控吞掉的影子归档、随后的回复）排进调用与结果之间，按相邻认组会把组拆开。agent 装载历史（`partial` 与 `loose` 不发给模型）、会话服务归并时间线、记忆摘要切单位与定切分点都用它。

## 存档元数据的键

`Message.metadata` 是开放字典。`WellKnownMetadataKeys` 登记由一方写入、另一方读取的键：第一方插件写与读都引用常量（查询条件与索引里按路径写的拼成 `` `metadata.${WellKnownMetadataKeys.Platform}` ``），架构守卫钉住；第三方的 agent、存档与平台适配器照着写，读历史与记忆的一方（会话服务回看历史、向量记忆、用户档案与关系等）才还原得出说话人、群、文件、回复的模型与 token、工具卡的归组。

| 常量 | 键 | 谁写、写在哪 | 形状 | 谁读 |
|---|---|---|---|---|
| `VisibleContent` | `visibleContent` | agent：落库的回复是结构化输出的信封时，写解码后的可见正文 | 字符串，只在与 `content` 不同时写 | agent 交给模型的历史取它；检索、摘要等按语义读历史的一方，读不到退回 `content` |
| `SpokenContent` | `spokenContent` | 存档：提问里发言人自己写的话（入站消息的 `content`；合并转发的展开不在里面，只有它的占位） | 字符串，可以是空串；只在与归档文本不同时写 | 会话服务给出提问条目的正文；用户档案核对原话 |
| `Attachments` | `attachments` | 存档：提问带的附件 | `ArchivedAttachment[]`，按入站顺序；没有附件时不写 | 会话服务把文件还原成卡片、图片等按地址显示 |
| `Forwards` | `forwards` | 存档：提问随附的转发（入站消息 `forwards` 的 id 与事实，不存展开），有才写 | `ArchivedForward[]` | 会话服务把转发画成单独的块，提问的文字里去掉它们的占位 |
| `SenderLabel` | `senderLabel` | 存档：归档文本发送者前缀里的标签（`getSenderLabel` 的写法），只在加了前缀时写 | 字符串 | 把归档文本重排给模型或界面看的一方按它用 `stripSenderPrefix` 去掉这一层：向量记忆的召回片段、OneBot 的撤回摘录与引用反查；没有这个键的不去 |
| `Mentions` | `mentions` | 存档：发言人自己写的话 @ 了哪些账号（`extractMentions` 从入站消息的 `content` 抽，引用、附件描述与转发里的不算），有才写 | 字符串数组 | 向量记忆给被 @ 的人加权；关系图的提取据此认被 @ 的人（没发过言、图里也没有的人，被 @ 了也能记进关系） |
| `Platform`、`UserId`、`Nickname` | `platform`、`userId`、`nickname` | 存档写入站消息的说话人；agent 给她自己的回复写这一轮的平台与她在那里的账号、昵称 | 字符串 | 会话服务标说话人与是不是 owner；记忆后端按平台筛最近消息；向量记忆、用户档案与关系等 |
| `GroupId`、`GroupName`、`SessionType` | `groupId`、`groupName`、`sessionType` | 存档写入站消息的群号、群名与会话类型；agent 给她自己的回复写这一轮的 | 字符串，即入站消息的同名字段 | 向量记忆与最近消息写出说话的位置，只用于显示；判是不是多方读会话记录的 `originChat.multiParty`（子会话取根会话的） |
| `MessageId` | `messageId` | 存档：平台侧的消息 id（入站消息的 `messageId`） | 字符串 | 存档按它反查被引用的原文（`findByMessageId`）；关系插件把引用与回复对回消息 |
| `Source` | `source` | 存档写入站消息的 `source`（内部注入的来源，真人发言没有）；出站消息记进历史的各条（文字的事件标记与发出的附件）写出站的 `source`（如指令回复的 `command`）；插件自己写的其余记录（投递失败）写插件的名字 | 字符串 | 会话服务标出提问是不是内部注入的、认出指令的回复，插件发的附件按它定通知的种类 |
| `HostNoticeKind` | `hostNoticeKind` | 存档：宿主通知的子类（`hostNotice.kind`） | 字符串 | 会话服务给出通知条目的种类 |
| `HostNoticeId`、`HostNoticeFacts` | `hostNoticeId`、`hostNoticeFacts` | 存档：宿主通知的 `id` 与给界面的事实（`hostNotice.id`、`hostNotice.facts`），有才写 | 字符串；扁平的键值（值是字符串或数） | 会话服务给出通知条目的 `noticeId` 与 `facts` |
| `TurnId` | `turnId` | 存档按 agent 归档时交来的回合写在进了一轮的输入上；agent 写在这一轮落库的回复、工具结果与停下标记（`TurnStopped`）上；平台适配器写在一轮回复的投递失败记录上；出站记进历史的各条由存档按出站消息的 `turnId` 记下（有才记） | 字符串 | 会话服务把存档归回回合、标出哪一轮的回复没发出；连对话回滚据此只删这一轮的消息 |
| `TurnEntry` | `turnEntry` | 存档与 `TurnId` 一起写在进了一轮的输入上 | `'opened'`（开轮的）或 `'joined'`（插进在跑的一轮的） | 会话服务给出输入怎么进的这一轮 |
| `TriggerType` | `triggerType` | 存档：入站消息的触发类型（`IncomingMessage.triggerType`），有才写 | 字符串 | 会话服务标出被点名与插话 |
| `TurnRecord` | `turnRecord` | agent 写在这一轮最后落库的那条回复上；没有落库回复的一轮（静默、中止、出错）另落一条只带 `TurnId` 与它的事件标记（`role: 'system'`、`kind: 'event-marker'`、正文为空，不进模型、不进摘要） | `TurnRecord`：`{ outcome: 'replied' \| 'silent' \| 'aborted' \| 'error'; source?: string }`，`source` 是这一轮的来源（输入的 `source`，真人消息开的没有） | 会话服务在历史里还原这一轮的结局与来源；连对话回滚随这一轮删 |
| `CallId` | `callId` | agent 写在工具结果上；平台适配器写在经工具发出的消息的投递失败记录上；出站记进历史的各条由存档按出站消息的 `callId` 记下（有才记） | 字符串，即 `ToolCallContext.callId` | 会话服务把历史里的工具卡对回实时推送 |
| `ModelInfo` | `modelInfo` | agent 写在这一轮最后的回复上 | 同 `OutgoingMessage.modelInfo` | 会话服务标在回复条目上 |
| `SentRef`、`SentName` | `ref`、`name` | 存档记发出的附件时（`outboundMediaMessage` 记的那条，见 api-message-archive 的 `recordOutbound`）：原样的地址与文件名 | 字符串 | 会话服务还原发出的附件：占位符里的地址遇到「]」会截断、描述位的「]」「\|」换成了全角，优先取这两个键 |
| `DeliveryError` | `error` | 平台适配器写在投递失败记录（`OutboundDeliveryFailed`）上：与投递结果同一句的原因 | 字符串或文字对象 | 会话服务按读者语言写出回复为什么没发出 |
| `SentPieces` | `sentPieces` | 平台适配器写在投递失败记录上：逐条发出停在中途时与投递结果同一个已发出条数，一条都没发出时不写 | 数字 | 会话服务写出回复只发出了前几条 |
| `Unconfirmed` | `unconfirmed` | 平台适配器写在投递失败记录上：已经发出、没等到平台确认的各项（如「消息（第 2 条）」「文件 a.html」） | 字符串数组 | 会话服务写出回复可能已经发出 |
| `Text` | `text` | 写通知与事件标记的一方：宿主通知的 `hostNotice.text`、平台通知的文字、平台事件合成的入站的 `IncomingMessage.text`、不是她回复的出站按 `outboundMarkerMessage` 记成事件标记时的 `OutgoingMessage.text`，没有地址的出站附件记成的事件标记、压缩分隔线同样 | 文字对象（@aalis/schema-i18n），`content` 是写给模型的话或它按原文渲染的整句 | 会话服务按读者语言显示（合成的入站画成通知），没有时显示 `content` |

```ts
interface ArchivedAttachment {
  kind: 'image' | 'audio' | 'video' | 'file';
  name?: string;   // 入站附件带的文件名
  ref?: string;    // 地址：存储地址（<根>:/路径）或网址
}
```

附件种类（`MessageAttachment['kind']`）到引用种类（`AttachmentRefKind`）的对应只有一份，`ATTACHMENT_REF_KINDS`：写引用与按种类认引用的各方（媒体、OneBot 适配器，以及 `outboundMediaMessage` 自己）都查它，`AttachmentRefKind` 加种类时只改这一处。附件的 `data` 不是地址时（内联数据、本机路径、预处理换上的私有引用），存档取预处理时写在这个附件 `ref` 上的落盘地址：预处理把附件落盘或换掉 `data` 时把地址写在那里，读历史的一方就能显示它。附件描述只给模型看，存档不从里面取地址：描述里有群友起的文件名，附件清单是媒体判据认的系统记下的引用。存档怎么取地址见 [plugin-message-archive](../plugins/plugin-message-archive.md)。

会话服务读历史只认登记的键，会话服务自己经 `agent:tool:after` 写进工具结果元数据的几个（审批结算、已发出、停止时还没结束、退出码、后台任务 id）除外：api-agent 约定 agent 把这份元数据原样落库。没有 `SpokenContent`、`Attachments` 的旧提问按存档正文原样显示。

**局限：**

- 适配器把附件的占位写进入站消息的 `content` 时（OneBot 把图片写成 `[图片 | ref:…]`），`SpokenContent` 照样带着它：契约里发言人写的话与附件的占位分不开，界面上提问正文里多一段占位文字，下面再出这张图。要分开得由适配器另给不含占位的发言文字，契约现在没有这一项。

## kind 常量

`WellKnownKinds` 是框架约定的 `Message.kind` 取值，完整列表与出口前缀见[消息到 LLM 的处理流水线](../concepts/message-llm-pipeline.md)。其中三个是指令类：

| 常量 | 字面量 | 含义 | 出口前缀 |
|---|---|---|---|
| `CrossSessionDelegation` | `'cross-session-delegation'` | 系统代发的任务指令（`triggerType: 'proactive'`，如 workflow 的 agent 节点） | `[跨会话委派]` |
| `HostNotice` | `'host-notice'` | 宿主撰写的事件通知（入站消息带 `hostNotice`） | `[宿主通知]` |
| `IdlePrompt` | `'idle-prompt'` | 空闲开话题的提示（`triggerType: 'idle'`）交给模型时那条指令块的 `metadata.injector`；它不落档，没有这个 kind 的归档消息 | 无 |

```ts
const DIRECTIVE_KINDS: ReadonlyArray<string>; // [CrossSessionDelegation, HostNotice, IdlePrompt]
```

`DIRECTIVE_KINDS` 是宿主或系统撰写、不是任何人发言的指令类 kind：

- 归档消息的 `kind` 属于它时，抽取（用户事实、指令、关系）与记忆扩窗一律跳过，跨会话读取（plugin-memory-history 的注入与 `recent_messages`、plugin-user-relation 的跨会话窗口）不带别的会话的这类消息；
- 请求期消息的 `metadata.injector` 属于它时，就是本轮的指令块：`turn-context`、`turn-hint` 两个锚位落在它之前，agent 裁剪时不缩不删，DeepSeek 提供者不把它改成 user。

自己拼历史交给模型抽取的插件，应按这个常量过滤，不要只写其中一个 kind。

## 实现者

- 本包**只定义类型与事件名**，由所有 `plugin-adapter-*` 直接 emit；没有专门的实现包。

## 相关

- 入站编排见 [api-gateway](./api-gateway.md)
- 输入阶段的钩子 `agent:input:before` 见 [api-agent](./api-agent.md)
