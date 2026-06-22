# message 服务（契约包速查）

> **这不是一个 DI 服务。** `@aalis/plugin-message-api` 是**纯契约包**——只导出消息载体类型、`WellKnownRole`/`WellKnownKinds`、`prepareLLMMessages`/`toLLMRole`、附件占位符文法、发送者标识工具，外加经 declaration merging 注入的几个事件。**没有任何插件用 `ctx.provide('message', …)` 注册运行时服务，也没有 `getService('message')` 这回事**（已 grep 全仓确认：`provides/provide/getService` 均无 `'message'` 命中）。
>
> 包元数据也证明这一点：`packages/plugin-message-api/package.json` 只有 `"aalis": { "types": true }`（**没有** `aalis.service` 字段），keyword 是 `aalis-api`。第三方作者**不是去"实现/消费 message 服务"**，而是 **import 这些类型/函数**来写自己的 LLM provider / 适配器 / 读历史的插件。

## 这篇怎么用

完整语义（`role × kind` 正交模型、强制出口 `prepareLLMMessages`、附件 `[图片 | ref:…]` 文法、`<at id="X">` @提及约定、流式分段、`actor` 授权身份、边界与坑）**全部在概念文档里讲透了**：

> **→ [`docs/concepts/message-llm-pipeline.md`](../concepts/message-llm-pipeline.md)**（写 LLM provider 或写"会发消息/会读历史"插件前必读）

本页只做**导出符号速查表**，按文件归档。每一项都标了真实 `file:line`，要看语义直接跳概念文档对应小节。

---

## 导出速查（`@aalis/plugin-message-api`）

### LLM 协议层类型 — `src/index.ts`

| 符号 | 类别 | file:line | 一句话 |
| --- | --- | --- | --- |
| `Message` | interface | `index.ts:82-120` | LLM 对话上下文消息主体：`role`/`content`/`toolCalls`/`name`/`kind`/`segments`/`images`/`audios`/`metadata` 等 |
| `ToolCall` | interface | `index.ts:35-42` | assistant 消息的 `tool_calls` 载荷（OpenAI 协议字段：`id`/`type:'function'`/`function{name,arguments}`） |
| `ContentSegment` | type（三联合） | `index.ts:53-63` | assistant 输出的有序时间线：`text` / `reasoning_text` / `tool_call`（后者带 `startTime`/`endTime`） |
| `WellKnownRole` | type | `index.ts:69` | `'system' \| 'user' \| 'assistant' \| 'tool'`——chat 协议直接接受的四种 |
| `MessageRole` | type | `index.ts:80` | `WellKnownRole \| (string & {})`——四种标准 + 任意扩展 role（如 `'notice'`） |

### 平台适配层类型 — `src/index.ts`

| 符号 | 类别 | file:line | 一句话 |
| --- | --- | --- | --- |
| `IncomingMessage` | interface | `index.ts:161-241` | 从适配器流入的原始消息：会话上下文 + `attachments` + `triggerType` + `actor`（授权身份）等 |
| `OutgoingMessage` | interface | `index.ts:245-269` | 发往平台的回复：`content`/`segments`/`attachments`/`source`/`modelInfo` |
| `StreamChunkMessage` | interface | `index.ts:274-292` | 流式片段（经 `'outbound:stream'` 事件发往前端）：`contentDelta`/`reasoningDelta`/`toolCallProgress`/`done`/`toolLimitReached` |
| `MessageAttachment` | interface | `index.ts:129-159` | v2 多模态附件统一载体：`kind`/`data`/`mimeType`/`description`/`ref`/`skipArchive` 等 |

### LLM 出口工具（值导出）— `src/index.ts`

| 符号 | 类别 | file:line | 一句话 |
| --- | --- | --- | --- |
| `WellKnownKinds` | const 对象 | `index.ts:328-334` | 约定 kind 常量：`EventMarker`/`CrossSessionDelegation`/`OutboundImage`/`OutboundAudio`/`OutboundVideo` |
| `WellKnownKind` | type | `index.ts:336` | `WellKnownKinds` 值的联合 |
| `CONTROL_KINDS` | const 数组 | `index.ts:342` | 控制类 kind（当前仅 `EventMarker`）——**消费方拼历史时须自行过滤**（不是 `prepareLLMMessages` 干的） |
| `toLLMRole(role)` | function | `index.ts:366-371` | 自定义 role → `WellKnownRole`；未知一律回落 `'system'`；`notice → system` |
| `prepareLLMMessages(messages)` | function | `index.ts:380-390` | **LLM provider 出口铁律**：归一 role + 拼前缀；不改原对象返回浅拷贝；幂等 |

> `prepareLLMMessages` 签名：`<T extends Pick<Message, 'role' \| 'content' \| 'kind'>>(messages: T[]): T[]`（`index.ts:380`）。语义、为何必调、为何不剔 event-marker——见概念文档 §3 + §9。

### 附件占位符文法 — `src/attachment-ref.ts`（经 `index.ts:392-398` 转出）

| 符号 | 类别 | file:line | 一句话 |
| --- | --- | --- | --- |
| `AttachmentRefKind` | const 对象 + type | `attachment-ref.ts:27-34` | 中文显示名：`图片`/`音频`/`视频`/`文件` |
| `AttachmentRef` | interface | `attachment-ref.ts:39-45` | `{ kind, desc?, ref }` |
| `formatAttachmentRef(r)` | function | `attachment-ref.ts:55-59` | `→ '[图片: desc \| ref:xxx]'`（desc 空则省冒号段） |
| `parseAttachmentRefs(text)` | function | `attachment-ref.ts:70-80` | 扫描全部 `[<kind>(: <desc>)? \| ref:<ref>]` 占位符 |
| `buildAttachmentRefMatcher(kind, ref)` | function | `attachment-ref.ts:86-90` | 构造匹配「指定 kind + 指定 ref」全部占位符的正则 |

> 契约约束：byte-for-byte 兼容历史；写入方须保证 `desc`/`ref` 不含 `]`/`|`。别手搓字符串——见概念文档 §4。

### 发送者标识工具 — `src/identity.ts`（经 `index.ts:400` 转出）

| 符号 | file:line | 一句话 |
| --- | --- | --- |
| `getSenderLabel(nickname?, userId?)` | `identity.ts:18-22` | 两者都有 → `昵称(ID)`；否则取其一；都无 → `undefined` |
| `prefixSender(content, nickname?, userId?)` | `identity.ts:28-31` | 有标签 → `[label]: content`，否则原样 |
| `getMessageName(userId?)` | `identity.ts:38-40` | 给 `Message.name` / OpenAI `name` 字段用的稳定标识符（用 userId 不用 nickname） |

### 事件（declaration merging 注入 `@aalis/core` 的 `AalisEvents`）— `src/index.ts:296-310`

| 事件名 | payload | 说明 |
| --- | --- | --- |
| `'inbound:message'` | `[IncomingMessage]` | 适配器流入的入站消息 |
| `'inbound:message:archived'` | `[{ sessionId, incoming: IncomingMessage, archivedMessage: Message }]` | 入站已落库（无论是否触发回复都发） |
| `'outbound:message'` | `[OutgoingMessage]` | 发往平台的回复 |
| `'outbound:stream'` | `[StreamChunkMessage]` | 流式片段（发往 WebUI 等前端） |

> 该包仅以 `import type {} from '@aalis/core'` 锚定模块身份做增强（`index.ts:27`），运行时无副作用。listen/emit 这些事件的姿势见 `docs/core/context.md` / `docs/concepts/service-model.md`。

---

## 谁 import 它（典型消费点，全部 file:line 实测）

不是"消费 message 服务"，而是 import 上面这些符号。代表性站点：

- **LLM provider 出口必调 `prepareLLMMessages`**：`plugin-deepseek/src/index.ts:239,360`、`plugin-ollama/src/index.ts:259,357,707`、`plugin-openai`（同模式，概念文档 §3.1）。
- **`CONTROL_KINDS` 过滤**（消费方职责）：`plugin-agent/src/index.ts:1008,1843`。
- **附件占位符**：产出于 `plugin-adapter-onebot/src/index.ts:408,413`、`plugin-image-sender/src/index.ts:337`；重写/解析于 `plugin-media/src/tools.ts:59,186,191`。
- **发送者标识**：`plugin-agent/src/index.ts:1028,1082`、`plugin-message-archive/src/index.ts:60`、`plugin-memory-vector/src/index.ts:354`、`plugin-adapter-onebot/src/index.ts:937`。
- 全仓有 ~40 个包 import `@aalis/plugin-message-api`（消息是跨层公共载体）。

---

## 相关文档

- **[`docs/concepts/message-llm-pipeline.md`](../concepts/message-llm-pipeline.md)** — 本契约的**权威语义文档**（role×kind、`prepareLLMMessages`、附件、`<at>`、流式、`actor`、坑）。本页是它的导出速查附录。
- [`docs/services/llm.md`](./llm.md) — `LLMModel` / `ChatModelRequest` / `resolveLLMModel`：`Message[]` 真正被发出去的地方（forward-ref，可能尚未落地）。
- [`docs/concepts/service-model.md`](../concepts/service-model.md) — `ServiceContainer` 按名注册与事件机制（本包只用事件增强，不注册服务）。
- [`docs/concepts/manifest-metadata.md`](../concepts/manifest-metadata.md) — `aalis.types` vs `aalis.service` 双源约定（本包是 `types: true` 的纯契约包范例）。
- [`docs/concepts/storage-uri-grammar.md`](../concepts/storage-uri-grammar.md) — `MessageAttachment.ref` / `AttachmentRef.ref` 可承载 `<root>:/path` storage URI。
- [`docs/concepts/security-model.md`](../concepts/security-model.md) — `IncomingMessage.actor` 授权身份、防 LLM 提权（概念文档 §9.7）。

**权威源码**：`packages/plugin-message-api/src/index.ts`、`packages/plugin-message-api/src/attachment-ref.ts`、`packages/plugin-message-api/src/identity.ts`。
