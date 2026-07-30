# 消息 → LLM 管线

本文面向两类作者：写 LLM provider 插件的人，以及写「会发消息 / 会读历史」插件的人。它讲清一条聊天消息如何从平台流到 LLM，包括四个必须掌握的概念：`role × kind` 正交模型、每个 provider 出口必须调用的 `prepareLLMMessages`、附件占位符 `[图片 | ref:…]` 格式，以及 `<at id="X">` @提及 token 文法。

所有消息类型契约由 `@aalis/schema-message` 持有，LLM 调用契约由 `@aalis/plugin-llm-api` 持有。

---

## 1. 为什么你需要读这篇

Aalis 的消息层分两层。

第一层是 **LLM 协议层**：`Message` / `ContentSegment` / `ToolCall`，直接对应 OpenAI/DeepSeek chat completions 协议。这是喂给模型、做历史压缩、做信息抽取时流转的载体。

第二层是 **平台适配层**：`IncomingMessage`（适配器流入）、`OutgoingMessage`（发往平台）、`StreamChunkMessage`（流式片段），是 Aalis 的边界形态。

如果你写 **LLM provider**（实现 `LLMModel`），你的工作是把上层给你的 `Message[]` 翻译成你的 API 的请求体。翻译之前必须先过 `prepareLLMMessages`（见 §3）。

如果你写**发消息 / 读历史**的插件，你需要理解 `role × kind` 正交语义（§2）、附件占位符（§4）、`<at>` token（§5），否则会写出污染上下文或解析断链的消息。

---

## 2. `role × kind` 正交模型

### 2.1 role：标准四种 + 任意扩展

```ts
export type WellKnownRole = 'system' | 'user' | 'assistant' | 'tool';
export type MessageRole = WellKnownRole | (string & {});
```

`WellKnownRole` 是 OpenAI/DeepSeek/Ollama 等 chat 协议直接接受的四种 role。`MessageRole` 采用 `WellKnownRole | (string & {})` 模式：既保留四种标准字面量的自动补全与类型收窄，又允许任意自定义 role（如 `'notice'`，以及未来可能的 `'event'` / `'observation'`）。

这里有一条硬约束：自定义 role 仅用于 Aalis 内部的存储、检索、渲染；调用 LLM 前必须由 provider 适配器转译为 `WellKnownRole` 之一。出口适配器只应看到这四种 role，这正是 `prepareLLMMessages` 的职责（§3）。

### 2.2 kind：与 role 正交的子分类维度

`Message.kind?: string` 是与 `role` 正交的语义子类。它的设计动机是让所有 role 共用同一个子类入口，避免出现 `system.name` / `notice.metadata.noticeType` / `assistant.metadata.kind` 这样三套互不相通的「伪子分类」。统一之后，`m.kind === 'event-marker'` 这类判断可以跨 role 通用。

框架约定的语义常量集中在 `WellKnownKinds`：

| 常量 | 字面量 | 含义 | 典型 role |
| --- | --- | --- | --- |
| `EventMarker` | `'event-marker'` | 纯 UI / 控制标记（如对话压缩分隔条），不应进入 LLM 上下文 | system |
| `CrossSessionDelegation` | `'cross-session-delegation'` | 另一会话的 agent 通过工具委派的任务 | notice |
| `OutboundImage` | `'outbound-image'` | assistant 已发出的图片占位 | assistant |
| `OutboundAudio` | `'outbound-audio'` | assistant 已发出的语音占位 | assistant |
| `OutboundVideo` | `'outbound-video'` | assistant 已发出的视频占位 | assistant |

第三方插件可以定义自己的 kind 字符串，但应避开上表已占用的语义。

### 2.3 `CONTROL_KINDS`：控制类 kind 在出口被过滤

```ts
export const CONTROL_KINDS: ReadonlyArray<string> = [WellKnownKinds.EventMarker];
```

`CONTROL_KINDS` 里的 kind 不携带可供模型理解或抽取的语义内容，仅用于 UI 与内部状态。因此 LLM 出口、信息抽取等流程默认应排除它们。

需要注意的是，这个过滤不是 `prepareLLMMessages` 做的，而是由消费方（构造历史的一方）做的。权威过滤点在 agent 构造消息列表时：

```ts
// agent 构造历史时过滤
messages.push(...history.filter(m => !CONTROL_KINDS.includes(m.kind ?? '')));
// 另一处构造路径同理
if (CONTROL_KINDS.includes(m.kind ?? '')) continue;
```

对插件作者而言，这意味着：如果你自己拼一份 `Message[]` 喂给 `resolveLLMModel(...).chat()`，你有责任先过滤掉 `CONTROL_KINDS`。`prepareLLMMessages` 只做 role 转译与前缀拼接，不剔除 event-marker。

`CrossSessionDelegation` 不在 `CONTROL_KINDS` 内，它会进入上下文（带 `[跨会话委派]` 前缀，见 §3）。不过许多抽取器（如用户关系、用户画像抽取器）会显式排除它，因为它不是真实用户发言。

---

## 3. 强制出口：`prepareLLMMessages`

这是 LLM provider 作者必须遵守的强制约定。

```ts
export function prepareLLMMessages<T extends Pick<Message, 'role' | 'content' | 'kind'>>(messages: T[]): T[]
```

每个 provider 在序列化请求体之前必须调用它。它做两件事：

1. **role 归一**：所有自定义 role 经 `toLLMRole` 转译为 `WellKnownRole`。
2. **内容前缀**：按 kind 优先、role 次之，给 `content` 前面拼一段可读前缀。

`toLLMRole` 的回落规则是：四种标准 role 原样返回；`'notice'` 经 `CUSTOM_ROLE_MAP` 映射为 `'system'`；任何其它未知 role 一律回落为 `'system'`，确保没有漏网 role 导致 provider 报错。

前缀映射分两级：

- kind 级（优先）：`CrossSessionDelegation` → `'[跨会话委派]'`（`KIND_PREFIX`）
- role 级（次之）：`'notice'` → `'[系统通知]'`（`CUSTOM_ROLE_PREFIX`）

前缀只在 `content` 是非空字符串时拼接。函数不修改原对象，返回浅拷贝数组，必要时浅拷贝单条消息。

### 3.1 Provider 出口示例（OpenAI 风格）

三家官方 provider（OpenAI、DeepSeek、Ollama）都遵循同一模式：

```ts
import { prepareLLMMessages, toLLMRole } from '@aalis/schema-message';

// chat() / chatStream() 入口第一步：
const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
```

到 `toAPIMessage` 这一步，可以信任 role 已是 `WellKnownRole`、前缀已拼好，只需透传：

```ts
private toAPIMessage(msg: Message): APIMessage {
  // 调用方已 prepareLLMMessages：role 已是 WellKnownRole，[系统通知]/[跨会话委派] 已进 content。
  const apiMsg: APIMessage = {
    role: toLLMRole(msg.role),   // 防御性幂等调用
    content: msg.content,
  };
  // 多模态：images[] 在 user 消息上展开为 content parts（OpenAI image_url 形态）
  if (msg.images?.length && msg.role === 'user') { /* ... */ }
  if (msg.toolCalls?.length) { apiMsg.tool_calls = /* 映射 ToolCall ... */ }
  if (msg.toolCallId) apiMsg.tool_call_id = msg.toolCallId;
  if (msg.name) apiMsg.name = msg.name;   // OpenAI name 字段，见 §6
  return apiMsg;
}
```

::: warning 即使不支持自定义 role 也要调用
`prepareLLMMessages` 是幂等的：纯标准 role 时原样返回同一引用，开销很小。但如果漏调，某天上游塞进 `notice` 或跨会话委派消息时，未归一的非标准 role 会让你的 provider 直接抛错。请在 `chat` / `chatStream` 第一步就调用它。
:::

---

## 4. 附件占位符：`[图片 | ref:…]` 文法

Aalis 在多处需要把附件（图 / 音 / 视 / 文件）以可读、可解析的形式塞回 LLM 文本上下文。历史上有四个调用点各自硬编码这套格式：onebot 入站占位、image-sender 出站归档、media 重写历史描述、image-recognition 解析历史引用。任何一处格式漂移都会让其它三处解析悄悄断链。因此这套格式由单一模块统一提供，是唯一的格式来源。

### 4.1 格式

```ts
formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: '一只猫', ref: 'data/x.png' })
//  → '[图片: 一只猫 | ref:data/x.png]'
formatAttachmentRef({ kind: AttachmentRefKind.Image, ref: 'data/x.png' })
//  → '[图片 | ref:data/x.png]'    // desc 为空/空串则省略冒号段
```

kind 显示名是中文，取自 `AttachmentRefKind`：`图片` / `音频` / `视频` / `文件`。新增 kind 时在该常量表加一项即可。

`ref` 是引用标识，可以是本地路径、`file://` 或 `http(s)` URL，由调用方决定如何解析。

### 4.2 解析与匹配

```ts
parseAttachmentRefs(text): AttachmentRef[]
```

`parseAttachmentRefs` 扫描文本里所有形如 `[<kind>(: <desc>)? | ref:<ref>]` 的占位符。

`buildAttachmentRefMatcher(kind, ref)` 构造一个匹配「指定 kind + 指定 ref」全部占位符的正则，供 media 的 `update_image_description` 工具重写描述使用。

### 4.3 契约约束

这套格式有三条必须遵守的约束：

- 输出必须 byte-for-byte 兼容历史格式，数据库里已有的字符串不会被重写。
- parser 不消耗 `desc` 中的转义，因此写入方必须保证 `desc` 不含 `]` 或 `|`，否则解析会错位。
- `ref` 内不允许出现 `]`。

::: warning 不要手写这套字符串
不要用 `String.replace` 硬编码 `[图片: … | ref:…]`。请一律使用 `formatAttachmentRef` / `parseAttachmentRefs`，否则就会重新引入本节开头描述的「四处格式漂移」问题。
:::

### 4.4 与结构化附件的关系

`MessageAttachment` 是 v2 的结构化主字段，所有适配器优先填 `IncomingMessage.attachments` / `OutgoingMessage.attachments`。出站附件的 `description` 与 `ref` 字段，正是全局出站归档写 `[类型: desc | ref:xxx]` 标记的数据来源，让 `memory_recall` 能命中。`skipArchive` 用于 history_ref 重发场景，避免向量库膨胀。

---

## 5. `<at id="X">` @提及 token 文法

`<at>` token 不是 `schema-message` 导出的 API，而是一套由适配器产出、跨插件复用的纯文本约定。`schema-message` 的源码里没有任何 `<at>` 代码。它由各 adapter 产出，由下游插件以正则解析。

### 5.1 产出方（adapter，以 OneBot 为例）

OneBot 适配器把平台消息段渲染为含 XML 标记的富文本喂给 LLM：

```ts
// at 段 → <at id="QQ">昵称</at>；自身被 @ 加 self 属性；@全体 → <at>all</at>
case 'at': {
  const qq = String(seg.data.qq ?? '');
  if (qq === 'all') return '<at>all</at>';
  const nick = nicknameMap?.get(qq) ?? qq;
  const selfAttr = selfId && qq === selfId ? ' self' : '';
  return `<at${selfAttr} id="${qq}">${nick}</at>`;
}
```

CQ 码也归一到同一文法：

```ts
.replace(/\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]/g, '<at id="$1">$1</at>')
```

完整的文法家族：

| 形态 | 含义 |
| --- | --- |
| `<at id="QQ">昵称</at>` | @提及（新格式，带昵称） |
| `<at self id="QQ">昵称</at>` | @机器人自己（带 `self` 属性） |
| `<at>all</at>` | @全体成员 |
| `<at id="QQ">QQ</at>` / `<at>QQ</at>` | 旧格式 / 无昵称兼容 |

同族的其它内联 XML 标记还有 `<image url>` / `<reply id>` / `<face id>` / `<video url>` / `<record url>` / `<forward id>`。在把长文本分条切割时，这些标记需要作为整体处理，不能被切碎。

### 5.2 消费方（平台无关，依赖统一文法）

下游插件按「各 adapter 输出统一 `<at id="X">` 标签」这一约定解析。message-archive 与 memory-vector 用完全一致的正则抽取被 @ 的用户 ID：

```ts
// 抽取被 @ 的用户 ID（含 self 变体）
const re = /<at(?:\s+self)?\s+id="([^"]+)">/g;
```

trigger-policy 用 `self` 属性判定「机器人是否被 @」，据此决定是否立即触发：

```ts
export function checkImmediateMention(content: string): boolean {
  if (/<at self[\s>][\s\S]*?<\/at>/.test(content)) return true;
  if (/\[CQ:at,qq=\d+\]/.test(content)) return true;              // 兼容裸 CQ 码
  return false;
}
```

::: warning 写新平台适配器时必须遵循这套文法
要让 @提及在归档、向量记忆、触发判定里都生效，你产出的入站文本必须遵循：@提及用 `<at id="X">显示名</at>`、机器人自身用 `<at self id="X">`、@全体用 `<at>all</at>`。这是事实标准而非编译期契约，没有类型会替你兜底，写错只会静默断链。
:::

---

## 6. 身份标识工具

message-api 提供三个跨插件统一的发送者标识函数：

- `getSenderLabel(nickname?, userId?)`：两者都有时返回 `昵称(ID)`；只有一个时取其一；都没有时返回 `undefined`。
- `prefixSender(content, nickname?, userId?)`：有标签时返回 `[label]: content`，否则原样返回。
- `getMessageName(userId?)`：返回适合 `Message.name` / OpenAI `name` 字段的安全标识符，用稳定的 userId 而非可变的 nickname。

`Message.name` 最终透传给 OpenAI 协议的 `name` 字段。群聊里多个用户混在同一个 `user` role 时，靠 `prefixSender` 在 content 内标注发言者，靠 `name` 给协议层身份。

---

## 7. LLM 调用契约：`ChatModelRequest` / `LLMModel`

契约在 `@aalis/plugin-llm-api`，完整说明见 `docs/services/llm.md`。

`ChatModelRequest` 不含 model / provider 字段。原因是每个 model 都是 `ServiceContainer` `'llm'` 服务名下的独立 entry，entry 已经绑定了具体的 `(provider, model)`：

```ts
export interface ChatModelRequest {
  messages: Message[];        // 你在这里收到待发消息——记得 prepareLLMMessages（§3）
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  think?: boolean;
}
```

`LLMModel` 提供 `chat(request): Promise<ChatResponse>`，以及可选的 `chatStream(request): AsyncIterable<ChatStreamChunk>`。

服务粒度是 per-model 的：provider 插件在 `apply()` 期间，对 `listModels()` 的每个 model 单独调一次 `ctx.provide('llm', modelHandle, {...})`，entryId 约定为 `${provider}/${model}`，由 `resolveLLMModel` 负责解析。

`capabilities` 是领域元数据，不是 DI 选择维度。`vision` / `audio` / `tool_calling` 等只供 media 发现可处理某模态的模型，以及供前端下拉过滤。0.5.0 已移除内核的「服务能力选择层」：服务选择一律走配置加按名解析，`getService('llm')` 只接受名字，不接受能力维度。`resolveLLMModel(ctx, ref, requiredCaps)` 里的 cap 过滤是在 `instance.capabilities` 元数据上做的，不是内核 DI。

消费方的典型用法：

```ts
const handle = resolveLLMModel(ctx, ref, ['vision'])?.instance;
await handle?.chat({ messages });   // entry 已知道是哪个 model
```

default model 通过 `ServiceContainer.setPreference('llm', preferredContextId)`，或 persona.yaml 的 `defaultServices` 选定。详见 `docs/services/llm.md`、`docs/services/service-container.md`。

---

## 8. 流式与时间线分段

- **`ContentSegment`** 是 assistant 输出的有序时间线，有三种：`text`、`reasoning_text`（DeepSeek-R1、Ollama thinking 等产出的思考文本）、`tool_call`（带 `startTime` / `endTime` 供时长展示）。当它存在时，它是渲染顺序的真相；`content` 与 `reasoningContent` 是供 LLM API、历史压缩等纯文本消费者使用的派生镜像，生产方累积时需要同步写。
- **`ChatStreamChunk`** 是流式增量，包含 `contentDelta` / `reasoningDelta` / `toolCalls`（最终结果）/ `toolCallProgress`（增量进度提示，与 `toolCalls` 互斥）/ `done` / `usage`。
- **`StreamChunkMessage`** 是平台层的流式片段，经 `'outbound:stream'` 事件发往 WebUI 等前端。其中 `toolCallProgress` 仅用于 UI「正在生成工具调用」提示，不影响最终 tool_call segment 的下发。

---

## 9. 边界与注意事项

1. **漏调 `prepareLLMMessages` 会导致 provider 崩溃。** 某天上游塞进 `notice` 或跨会话委派消息，未归一的非标准 role 会让你的 API 直接返回 400。务必在 `chat` / `chatStream` 第一步调用（§3.1）。
2. **`prepareLLMMessages` 不剔除 event-marker。** 它只做 role 转译加前缀。`CONTROL_KINDS` 过滤是消费方的职责。你自己拼历史喂模型时要先 `filter(m => !CONTROL_KINDS.includes(m.kind ?? ''))`。
3. **自定义 kind 不要撞已占用语义。** 可以定义新 kind，但要避开 `WellKnownKinds`。前端有一份字面量副本，改动 `event-marker` 等值时要同步前后端。
4. **附件占位符必须走 `formatAttachmentRef` / `parseAttachmentRefs`**，且写入方保证 `desc` 不含 `]` 或 `|`（§4.3）。手写字符串会让四处解析悄悄断链。
5. **`<at>` 是约定不是 API**，没有编译期兜底。新平台适配器产出的入站文本必须严格遵循 `<at id="X">名</at>` / `<at self …>` / `<at>all</at>`，否则归档、向量、触发判定会全部静默失效（§5.2）。`<at self>` 是 trigger-policy 判定「机器人被 @」的唯一信号。
6. **`Message.metadata` 不发给 LLM。** 要让模型看到的信息必须进 `content` / `segments` / `images` / `audios`，不要塞进 metadata。
7. **`actor` 是授权身份，不可被 LLM 自由指定。** 系统侧触发器（scheduler / idle / proactive）创建任务时会 snapshot 调用者身份并回填，agent 构造 `ToolCallContext` 时优先用 `actor` 查权限，以防提权。详见 `docs/concepts/authority.md`。
8. **`images` / `audios` 的解析格式由 provider 负责。** 可能是 base64 data URL、`file://`、本地路径或 `http(s)`。OpenAI 把 `images[]` 仅在 `user` role 上展开为 `image_url` content parts；其它 role 携带图片不会被它消费。

---

## 相关文档

兄弟概念（forward-ref，可能尚未落地）：

- `docs/concepts/service-model.md` — `ServiceContainer` 按名注册、同名多 provider 胜出规则（preference > priority > 注册序）、per-entry 粒度。
- `docs/concepts/authority.md` — 数字等级鉴权、`actor` 授权身份、HITL 确认。
- `docs/concepts/storage-uri-grammar.md` — `<root>:/path` 文法（`ref` 字段可承载 storage URI）。

服务文档（forward-ref）：

- `docs/services/llm.md` — `LLMModel` / `ChatModelRequest` / `resolveLLMModel` / per-model entry 注册全貌。
- `docs/services/service-container.md` — `provide` / `getService` / `getAllServices` / `setPreference` / `whenService`。
