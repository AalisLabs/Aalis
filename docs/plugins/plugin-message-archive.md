# plugin-message-archive — 消息归档

**包名**: `@aalis/plugin-message-archive`  
**源码**: `packages/plugin-message-archive/src/index.ts`

## 概述

持久化会话消息（入站消息、助手回复、平台 notice 等）以供检索；入站消息落库前会把发送者前缀、引用回复内容和附件描述合进归档文本，说话人按 api-message-archive 的 `speakerOf` 给，规则见 [services/message-archive.md](../services/message-archive.md) 的「发送者前缀」。注册 `message-archive` 服务（`MessageArchiveService`，契约见 `@aalis/api-message-archive`），提供 `saveMessage` / `archiveIncoming` / `recordOutbound` / `archiveNotice` / `findByMessageId` 五个方法。本插件不自行存储，所有写入与读取均委派给 `memory` 服务（必需依赖），且每次调用时懒查服务引用。入站消息带附件且 `_attachmentDescriptions` 尚未预设时，调用可选的 `media` 服务的 `processMessage` 识别附件。识别对传入的消息对象做，结果写回入参：`processMessage` 按消息对象只处理一次，触发判定已启动的识别在这里命中（在途则等它），不再识别第二遍。

`archiveIncoming` 按消息种类定角色：代发任务（`triggerType: 'proactive'`）落成 `role: 'notice'`、`kind: 'cross-session-delegation'`；宿主通知（带 `hostNotice`）落成 `role: 'notice'`、`kind: 'host-notice'`，不带 `name`，元数据记通知的子类、id 与给界面的事实（见下段），`metadata.source` 照常写。宿主通知只归档 `content`：注入方包好的不可信段 `hostNotice.untrusted` 不写进消息也不写进 metadata。归档的 notice 在出口转成 system，之后这个房间每一轮都看得到，不可信段只能在注入的那一轮出现。其余入站消息落成 `role: 'user'`，入站带 `noticeType`（平台事件转成的入站，如戳一戳）时存档的 `kind` 记成它。三种都照常发 `inbound:message:archived`，下游按 `kind` 或 `hostNotice` 自行跳过。空闲开话题的提示（`triggerType: 'idle'`）不落档：它是写给模型的话，不是谁的发言，也不是要留档的事件；回 `undefined`，不发 `inbound:message:archived`，不论来源叫什么。agent 开轮或插入时交来这条进的那一轮，元数据另记回合 id 与进入方式（`TurnId`、`TurnEntry`）；没进一轮的（被触发判定或流控吞掉的）不记。

归档文本是给模型看的。元数据按 schema-message 登记的键（`WellKnownMetadataKeys`，见 [schema-message 的「存档元数据的键」](../api/schema-message.md#存档元数据的键)）另记说话人（`Platform`、`UserId`、`Nickname`）、加了发送者前缀时用的标签（`SenderLabel`）、发言人自己写的话里 @ 的账号（`Mentions`，引用与附件描述里的不算）、来源（`Source`）、宿主通知的子类、id 与给界面的事实（`HostNoticeKind`、`HostNoticeId`、`HostNoticeFacts`），以及给人看的两样：发言人写的话（`SpokenContent`，入站消息的 `content`，只在与归档文本不同时记）与附件清单（`Attachments`，每项是种类、名字与地址）。附件的地址先取它的 `data`：网址原样记，存储地址只在根是存储服务登记过的根时记（各提供者的根合起来，存储按根逐条提供；存储服务不在时一个也不记）。`data` 不是地址时（内联数据、本机路径、预处理器换上的私有引用，如文件读取插件的 `aalis-file://<id>`），按同样的规则取预处理器给它写的描述里同种附件的引用（`formatAttachmentRef` 的写法，如媒体识别落盘后写的）；都没有时只记种类与名字。会话服务回看历史与实时推送的提问取这两样。

出站消息记进会话历史只由本插件做（`recordOutbound`），所有平台一条规则：

- 不是她回复的文字（指令的回复、宿主提示等，`OutgoingMessage.source` 不是 `agent`）按 schema-message 的 `outboundMarkerMessage` 记一条事件标记，不进模型的上下文，会话服务据此在历史里还原成通知（指令的回复是 `command-reply`）。她的回复由 agent 存档，这里不记。
- 附件逐个记，不分来源、种类，也不分是否随她的回复发出（重发的、回复里转出的都记）。地址按 api-message-archive 的 `outboundAddress` 取：附件的 `ref`，没有时 `data` 是存储地址或网址的取 `data`。有地址的按 `outboundMediaMessage` 记：她发的（`source` 为 `agent`）是 `role: 'assistant'`，照常发 `assistant:message:archived`，向量记忆据此收作她的发言；插件发的是 `role: 'notice'`，进模型时是一条系统通知，不发这个事件。元数据带原样的地址（`SentRef`），文件的描述位写文件名、另带 `SentName`。没有地址的（data URL、`file://` 与本机路径）记成事件标记「[图片] 名字」一类（api-message-archive 的 `unaddressedText`，没有名字时只写种类），元数据带同一句的文字对象，按读者语言显示，内容本身不进历史。
- 每条记录（文字的事件标记、附件与没有地址的标记）的元数据带出站的 `Source`、`TurnId` 与 `CallId`，都是有才记；出站记录的时间戳各不相同（同一毫秒里的几条往后错开），按会话与时间戳认消息的下游（回滚、向量记忆）分得开。要记的内容在调用时取走，调用之后对消息的改写不算。
- 图、音、视频的描述取附件带的，发出即记、不等识图。她发的网址图片与视频没带描述时，记完、这一条的 `assistant:message:archived` 派发完（向量记忆据此收录原来那条，改写通知赶在它前面就删不到旧条目）之后在后台调 `media` 的 `describeImage` / `describeVideo`（图片等 25 秒，视频等 30 秒），补到后经记忆的 `updateMessageContent` 把这一条正文里的附件引用换成带描述的（只改这个会话里最近一条含它的消息），改到了就发 `memory:messages-rewritten`，向量记忆据此按带描述的正文重收录。记忆后端没有 `updateMessageContent` 或 `media` 不在时不补，也不报错；识图超时或失败记一条 warn，这一条保持不带描述。插件发的只记不识别。

谁来调：送达之后发 `outbound:delivered` 的适配器（onebot、终端）由本插件监听它调，记录写失败时记一条 warn，不拖住同一事件的其它监听；送达本身就是写进会话历史的适配器（WebUI）直接调、等它兑现，写失败时回执没发出。子会话没有窗口，任何适配器都不认领它的出站：本插件监听 `outbound:message`，还没人认领、会话记录有 `parentId` 的同步认领，记进子会话自己的历史即算送达（写失败时回执带原因）。有窗口的会话没人认领时（适配器不在）照旧算没发出；会话管理不在时判不出是不是子会话，不认领。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-message-archive',
  displayName: '消息归档',
  subsystem: 'message',
  provides: [messageArchive],
  uses: {
    memory,
    media: optional(media),
    storage: optional(storage),
    sessionManager: optional(sessionManager),
    authority: optional(authority),
    events,
    logger,
    config,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

配置项由 `packages/plugin-message-archive/src/index.ts` 的 `configSchema` 声明。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `debugLogs` | boolean | `true` | 归档调试日志：记录图片解释完成和消息写入记忆等调试日志。 |

## 相关

- 服务契约 `@aalis/api-message-archive`：[services/message-archive.md](../services/message-archive.md)
- 底层存储 `memory` 服务：[api/api-memory.md](../api/api-memory.md)
- 附件识别 `media` 服务：[plugins/plugin-media.md](./plugin-media.md)
- 存储地址的根表 `storage` 服务：[concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)
- 消息到 LLM 的处理流水线：[concepts/message-llm-pipeline.md](../concepts/message-llm-pipeline.md)
