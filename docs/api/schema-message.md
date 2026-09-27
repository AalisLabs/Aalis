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
  triggerType?: 'direct' | 'immediate' | 'interval' | 'idle' | 'proactive';
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

## OutgoingMessage

```ts
interface OutgoingMessage {
  content: string;
  sessionId: string;
  platform?: string;
  reasoningContent?: string;
  segments?: ContentSegment[];        // 与协议层 Message.segments 一致
  source?: 'agent' | 'system' | 'command';
}
```

`source='agent'` 表示由 AI 生成，可被分条延迟发送以模拟自然节奏；其它来源默认整条立即发送。

## 事件（AalisEvents）

```ts
'inbound:message':           [message: IncomingMessage]
'inbound:message:archived':  [message: IncomingMessage]   // 已写入 memory
'outbound:message':          [message: OutgoingMessage]
'outbound:stream':           [chunk: StreamChunkMessage]
```

## 工具函数（runtime exports）

```ts
getSenderLabel(nickname?: string, userId?: string): string | undefined;
prefixSender(content: string, nickname?: string, userId?: string): string;
getMessageName(userId?: string): string | undefined;
buildIncomingContent(incoming: IncomingMessage): string;
```

前三个用于在 LLM messages 里把发言者前缀化（群聊场景必要）。`buildIncomingContent` 把入站消息拼成归档文本（发送者前缀、引用回复、附件描述），归档与触发判定共用同一份拼法。

## 实现者

- 本包**只定义类型与事件名**，由所有 `plugin-adapter-*` 直接 emit；没有专门的实现包。

## 相关

- 入站编排见 [api-gateway](./api-gateway.md)
- Agent 预处理见 [api-agent](./api-agent.md)
