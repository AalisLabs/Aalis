# 消息 → LLM 管线

> 受众：写 LLM provider 插件、或写「会发消息 / 会读历史」插件的第三方作者。
> 本文讲清一条聊天消息如何从平台流到 LLM：`role × kind` 正交模型、每个 provider 出口**必须**调用的 `prepareLLMMessages`、附件占位符 `[图片 | ref:…]` 格式、以及 `<at id="X">` @提及 token 文法。
>
> 全部断言以代码为准并标注 `file:line`。所有消息类型契约由 `@aalis/plugin-message-api` 持有，LLM 调用契约由 `@aalis/plugin-llm-api` 持有。

---

## 1. 为什么你需要读这篇

Aalis 的消息层分两层（见 `packages/plugin-message-api/src/index.ts:1-23`）：

1. **LLM 协议层**：`Message` / `ContentSegment` / `ToolCall` —— 直接对应 OpenAI/DeepSeek chat completions 协议。这是喂给模型、做历史压缩、做信息抽取时流转的载体。
2. **平台适配层**：`IncomingMessage`（适配器流入）/ `OutgoingMessage`（发往平台）/ `StreamChunkMessage`（流式片段）—— Aalis 边界形态。

如果你写 **LLM provider**（实现 `LLMModel`），你的工作是把上层给你的 `Message[]` 翻译成你家 API 的请求体——而**翻译前必须先过 `prepareLLMMessages`**（见 §3）。
如果你写**发消息/读历史的插件**，你需要懂 `role × kind` 正交语义（§2）、附件占位符（§4）、`<at>` token（§5），否则会写出污染上下文或解析断链的消息。

---

## 2. `role × kind` 正交模型

### 2.1 role：标准四种 + 任意扩展

```ts
export type WellKnownRole = 'system' | 'user' | 'assistant' | 'tool';        // index.ts:69
export type MessageRole = WellKnownRole | (string & {});                      // index.ts:80
```

`WellKnownRole` 是 OpenAI/DeepSeek/Ollama 等 chat 协议**直接接受**的四种 role。`MessageRole` 用 `WellKnownRole | (string & {})` 模式：既保留四种标准字面量的自动补全/收窄，又允许任意自定义 role（如 `'notice'`，未来可能的 `'event'` / `'observation'`）。

**硬约束**（`index.ts:76-79`）：自定义 role 仅用于 Aalis 内部存储/检索/渲染；**调用 LLM 前必须由 provider 适配器转译为 `WellKnownRole` 之一**。出口适配器只应看到这四种 role——这正是 `prepareLLMMessages` 的职责（§3）。

### 2.2 kind：与 role 正交的子分类维度

`Message.kind?: string`（`index.ts:101`）是与 `role` **正交**的语义子类。设计动机（`index.ts:88-100`）：让所有 role 共用同一个子类入口，避免出现 `system.name` / `notice.metadata.noticeType` / `assistant.metadata.kind` 三套互不相通的「伪子分类」。统一后，`m.kind === 'event-marker'` 这种判断可以跨 role 通用。

框架约定的语义常量（`WellKnownKinds`，`index.ts:328-334`）：

| 常量 | 字面量 | 含义 | 典型 role |
| --- | --- | --- | --- |
| `EventMarker` | `'event-marker'` | 纯 UI/控制标记（如对话压缩分隔条），**不应进入 LLM 上下文** | system |
| `CrossSessionDelegation` | `'cross-session-delegation'` | 另一会话的 agent 通过工具委派的任务 | notice |
| `OutboundImage` | `'outbound-image'` | assistant 已发出的图片占位 | assistant |
| `OutboundAudio` | `'outbound-audio'` | assistant 已发出的语音占位 | assistant |
| `OutboundVideo` | `'outbound-video'` | assistant 已发出的视频占位 | assistant |

第三方插件**可以定义自己的 kind 字符串**，但请避开上表已占用的语义（`index.ts:99`、`index.ts:320` 注释明确允许新值）。

### 2.3 `CONTROL_KINDS`：控制类 kind 在出口被过滤

```ts
export const CONTROL_KINDS: ReadonlyArray<string> = [WellKnownKinds.EventMarker];   // index.ts:342
```

`CONTROL_KINDS` 里的 kind 不携带可供模型理解或抽取的语义内容，仅用于 UI / 内部状态。**LLM 出口、信息抽取等流程默认应排除它们。**

注意：这个过滤**不是 `prepareLLMMessages` 做的**——而是**消费方（构造历史的一方）**做的。权威过滤点在 agent 构造消息列表时：

```ts
// packages/plugin-agent/src/index.ts:1843
messages.push(...history.filter(m => !CONTROL_KINDS.includes(m.kind ?? '')));
// 另一处构造路径同理：index.ts:1008
if (CONTROL_KINDS.includes(m.kind ?? '')) continue;
```

> 给插件作者的含义：如果你自己拼一份 `Message[]` 喂给 `resolveLLMModel(...).chat()`，**你有责任先过滤掉 `CONTROL_KINDS`**。`prepareLLMMessages` 只做 role 转译与前缀拼接，**不**剔除 event-marker。

`CrossSessionDelegation` 不在 `CONTROL_KINDS` 内——它**会**进入上下文（带 `[跨会话委派]` 前缀，见 §3），但许多抽取器会显式排除它（如 `plugin-user-relation/src/extractor.ts:398`、`plugin-user-profile/src/index.ts:1304`），因为它不是真实用户发言。

---

## 3. 强制出口：`prepareLLMMessages`

> **这是 LLM provider 作者必须记住的唯一一条铁律。**

```ts
// index.ts:380
export function prepareLLMMessages<T extends Pick<Message, 'role' | 'content' | 'kind'>>(messages: T[]): T[]
```

每个 provider 在序列化请求体**之前**必须调用它。它做两件事（`index.ts:380-390`）：

1. **role 归一**：所有自定义 role 经 `toLLMRole` 转译为 `WellKnownRole`。
2. **内容前缀**：按 kind 优先、role 次之，给 `content` 前面拼可读前缀。

`toLLMRole` 的回落规则（`index.ts:366-371`）：四种标准 role 原样返回；`'notice'` → `'system'`（`CUSTOM_ROLE_MAP`，`index.ts:345-347`）；**任何其它未知 role 一律回落 `'system'`**，确保没有漏网导致 provider 报错。

前缀映射：

- kind 级（优先）：`CrossSessionDelegation` → `'[跨会话委派]'`（`KIND_PREFIX`，`index.ts:358-360`）
- role 级（次之）：`'notice'` → `'[系统通知]'`（`CUSTOM_ROLE_PREFIX`，`index.ts:350-352`）

前缀只在 `content` 是非空字符串时拼接（`index.ts:385`）。函数**不修改原对象**，返回浅拷贝数组（必要时浅拷贝单条消息）（`index.ts:378`、`index.ts:388`）。

### 3.1 Provider 出口示例（OpenAI 风格）

三家官方 provider 都遵循同一模式（`plugin-openai/src/index.ts:198,266`、`plugin-deepseek/src/index.ts:239,360`、`plugin-ollama/src/index.ts:259,357`）：

```ts
import { prepareLLMMessages, toLLMRole } from '@aalis/plugin-message-api';

// chat() / chatStream() 入口第一步：
const messages = prepareLLMMessages(request.messages).map(m => this.toAPIMessage(m));
```

`toAPIMessage` 此时可以信任 role 已是 `WellKnownRole`、前缀已拼好，只需透传（`plugin-openai/src/index.ts:418-425`）：

```ts
private toAPIMessage(msg: Message): APIMessage {
  // 调用方已 prepareLLMMessages：role 已是 WellKnownRole，[系统通知]/[跨会话委派] 已进 content。
  const apiMsg: APIMessage = {
    role: toLLMRole(msg.role),   // 防御性幂等调用
    content: msg.content,
  };
  // 多模态：images[] 在 user 消息上展开为 content parts（OpenAI image_url 形态）
  if (msg.images?.length && msg.role === 'user') { /* ... index.ts:428-437 */ }
  if (msg.toolCalls?.length) { apiMsg.tool_calls = /* 映射 ToolCall ... */ }
  if (msg.toolCallId) apiMsg.tool_call_id = msg.toolCallId;
  if (msg.name) apiMsg.name = msg.name;   // OpenAI name 字段，见 §6
  return apiMsg;
}
```

> 即使你不打算支持自定义 role，也要调 `prepareLLMMessages`：它是幂等的（纯标准 role 时原样返回同一引用，`index.ts:386`），漏调的代价是某天上游塞进 `notice`/委派消息时你的 provider 直接抛错。

---

## 4. 附件占位符：`[图片 | ref:…]` 文法

模块：`packages/plugin-message-api/src/attachment-ref.ts`。

Aalis 在多处需要把附件（图/音/视/文件）以**可读、可解析**的形式塞回 LLM 文本上下文。历史上有四个调用点各自硬编码这套格式（`attachment-ref.ts:5-11`：onebot 入站占位、image-sender 出站归档、media 重写历史描述、image-recognition 解析历史引用），任何一处格式漂移都会让其它三处解析悄悄断链。本模块是**单一格式来源**。

### 4.1 格式

```ts
formatAttachmentRef({ kind: AttachmentRefKind.Image, desc: '一只猫', ref: 'data/x.png' })
//  → '[图片: 一只猫 | ref:data/x.png]'
formatAttachmentRef({ kind: AttachmentRefKind.Image, ref: 'data/x.png' })
//  → '[图片 | ref:data/x.png]'    // desc 为空/空串则省略冒号段（attachment-ref.ts:55-59）
```

kind 显示名是中文（`AttachmentRefKind`，`attachment-ref.ts:27-32`）：`图片` / `音频` / `视频` / `文件`。新增 kind 在该常量表加一项即可。

`ref` 是引用标识——本地路径 / `file://` / `http(s)` URL，由调用方决定如何解析（`attachment-ref.ts:43`）。

### 4.2 解析与匹配

```ts
parseAttachmentRefs(text): AttachmentRef[]    // attachment-ref.ts:70
```

扫描所有形如 `[<kind>(: <desc>)? | ref:<ref>]` 的占位符（正则 `attachment-ref.ts:71`）。
`buildAttachmentRefMatcher(kind, ref)`（`attachment-ref.ts:86`）构造匹配「指定 kind + 指定 ref」全部占位符的正则，供 media 的 `update_image_description` 工具重写描述用。

### 4.3 契约约束（务必遵守）

- 输出必须 **byte-for-byte 兼容历史格式**——数据库里已有的字符串不会被重写（`attachment-ref.ts:22`）。
- parser **不消耗 desc 中的转义**；写入方必须保证 `desc` 不含 `]` 或 `|`（`attachment-ref.ts:23`、`attachment-ref.ts:67-68`），否则解析会错位。
- `ref` 内不允许出现 `]`（同上契约保证）。

> 别自己 `String.replace` 硬编码 `[图片: … | ref:…]`——一定用 `formatAttachmentRef` / `parseAttachmentRefs`，否则就是 `attachment-ref.ts:5-11` 描述的那种「四处漂移」技术债。

### 4.4 与结构化附件的关系

`MessageAttachment`（`index.ts:129-159`）是 v2 的结构化主字段，所有适配器优先填 `IncomingMessage.attachments` / `OutgoingMessage.attachments`。出站附件的 `description` + `ref` 字段（`index.ts:144-153`）正是全局出站归档写 `[类型: desc | ref:xxx]` 标记的数据来源，让 `memory_recall` 能命中。`skipArchive`（`index.ts:154-158`）用于 history_ref 重发场景避免向量库膨胀。

---

## 5. `<at id="X">` @提及 token 文法

> **重要更正（以代码为准）**：`<at>` token **不是** `plugin-message-api` 导出的 API，而是一套**适配器产出、跨插件复用的纯文本约定**。`packages/plugin-message-api/src/` 里没有任何 `<at>` 代码（已 grep 确认）。它由各 adapter 产出、由下游插件以正则解析。

### 5.1 产出方（adapter，以 OneBot 为例）

OneBot 适配器把平台消息段渲染为含 XML 标记的富文本喂给 LLM（`plugin-adapter-onebot/src/types.ts:180-204`）：

```ts
// at 段 → <at id="QQ">昵称</at>；自身被 @ 加 self 属性；@全体 → <at>all</at>
case 'at': {
  const qq = String(seg.data.qq ?? '');
  if (qq === 'all') return '<at>all</at>';
  const nick = nicknameMap?.get(qq) ?? qq;
  const selfAttr = selfId && qq === selfId ? ' self' : '';
  return `<at${selfAttr} id="${qq}">${nick}</at>`;     // types.ts:195
}
```

CQ 码也归一到同一文法（`forward.ts:166`；`types.ts:279` 同义，捕获组写法略异用 `\d+`）：

```ts
.replace(/\[CQ:at,[^\]]*qq=([^,\]]+)[^\]]*\]/g, '<at id="$1">$1</at>')
```

文法家族（`types.ts:373-374`）：

| 形态 | 含义 |
| --- | --- |
| `<at id="QQ">昵称</at>` | @提及（新格式，带昵称） |
| `<at self id="QQ">昵称</at>` | @机器人自己（带 `self` 属性） |
| `<at>all</at>` | @全体成员 |
| `<at id="QQ">QQ</at>` / `<at>QQ</at>` | 旧格式/无昵称兼容 |

同族的其它内联 XML 标记（`<image url>` / `<reply id>` / `<face id>` / `<video url>` / `<record url>` / `<forward id>`，见 `types.ts:385`、`types.ts:213`），在分条切割时需作为整体不被切碎（`plugin-adapter-onebot/src/index.ts:458-466`）。

### 5.2 消费方（平台无关，依赖统一文法）

下游插件按「各 adapter 输出统一 `<at id="X">` 标签」这一约定解析（注释原文：`plugin-message-archive/src/index.ts:41`、`plugin-memory-vector/src/index.ts:174`）：

```ts
// 抽取被 @ 的用户 ID（含 self 变体）
const re = /<at(?:\s+self)?\s+id="([^"]+)">/g;   // message-archive/index.ts:45 与 memory-vector/index.ts:178 完全一致
```

trigger-policy 用 `self` 属性判定「机器人是否被 @」来决定是否立即触发（`plugin-trigger-policy/src/detector.ts:8-13`）：

```ts
export function checkImmediateMention(content: string): boolean {
  if (/<at self[\s>][\s\S]*?<\/at>/.test(content)) return true;   // detector.ts:10
  if (/\[CQ:at,qq=\d+\]/.test(content)) return true;              // 兼容裸 CQ 码
  return false;
}
```

> 给写**新平台适配器**的作者：要让 @提及在归档/向量记忆/触发判定里都生效，你产出的入站文本**必须**遵循 `<at id="X">显示名</at>`、机器人自身用 `<at self id="X">`、@全体用 `<at>all</at>`。这是事实标准而非编译期契约——没有类型会替你兜底，写错只会静默断链。

---

## 6. 身份标识工具（`identity.ts`）

`packages/plugin-message-api/src/identity.ts` 提供三个跨插件统一的发送者标识函数（cleanup-9 从 core 迁出）：

- `getSenderLabel(nickname?, userId?)`：两者都有 → `昵称(ID)`；否则取其一；都无 → `undefined`（`identity.ts:18-22`）。
- `prefixSender(content, nickname?, userId?)`：有标签时返回 `[label]: content`，否则原样（`identity.ts:28-31`）。
- `getMessageName(userId?)`：返回适合 `Message.name` / OpenAI `name` 字段的安全标识符——用**稳定的 userId** 而非可变 nickname（`identity.ts:38-40`）。

`Message.name`（`index.ts:87`）最终透传给 OpenAI 协议的 `name` 字段（`plugin-openai/src/index.ts:454-456`）。群聊里多用户混在 `user` role 时，靠 `prefixSender` 在 content 内标注发言者、靠 `name` 给协议层身份。

---

## 7. LLM 调用契约：`ChatModelRequest` / `LLMModel`

契约在 `@aalis/plugin-llm-api`。要点（详见 forward-ref → `docs/services/llm.md`）：

`ChatModelRequest`（`plugin-llm-api/src/index.ts:69-76`）**不含 model/provider 字段**——因为每个 model 是 `ServiceContainer` `'llm'` 服务名下的**独立 entry**，entry 已绑定具体 `(provider, model)`（`plugin-llm-api/src/index.ts:61-67`）：

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

`LLMModel.chat(request): Promise<ChatResponse>`、可选 `chatStream(request): AsyncIterable<ChatStreamChunk>`（`plugin-llm-api/src/index.ts:113-114`）。

**per-model service 粒度**：provider 插件在 `apply()` 期间，对 `listModels()` 的**每个 model 单独**调一次 `ctx.provide('llm', modelHandle, {...})`，entryId 约定 `${provider}/${model}`（`plugin-llm-api/src/index.ts:78-90`、解析见 `resolveLLMModel`，`index.ts:219-229`）。

**capabilities 是领域元数据，不是 DI 选择维度**（`plugin-llm-api/src/index.ts:106-111`、`190-198`）：`vision`/`audio`/`tool_calling` 等只供 media 发现可处理某模态的模型、供前端下拉过滤。0.5.0 已**移除**内核的「服务能力选择层」——服务选择一律走配置 + 按名解析（`getService('llm')` 只接受名字，不接受能力维度）。`resolveLLMModel(ctx, ref, requiredCaps)` 里的 cap 过滤是在 `instance.capabilities` 元数据上做的，非内核 DI（`index.ts:194-198`）。

消费方典型用法（`plugin-llm-api/src/index.ts:86-88`）：

```ts
const handle = resolveLLMModel(ctx, ref, ['vision'])?.instance;
await handle?.chat({ messages });   // entry 已知道是哪个 model
```

> default model 通过 `ServiceContainer.setPreference('llm', preferredContextId)` 或 persona.yaml 的 `defaultServices` 选定（`plugin-llm-api/src/index.ts:89-90`）。详见 forward-ref → `docs/services/llm.md`、`docs/services/service-container.md`。

---

## 8. 流式与时间线分段

- **`ContentSegment`**（`index.ts:53-63`）：assistant 输出的**有序时间线**，三种 —— `text` / `reasoning_text`（DeepSeek-R1、Ollama thinking 等产出的思考文本）/ `tool_call`（带 `startTime`/`endTime` 供时长展示）。存在时它是**渲染顺序的真相**；`content` 与 `reasoningContent` 是供 LLM API/历史压缩等纯文本消费者用的派生镜像，生产方累积时需同步写（`index.ts:104-109`）。
- **`ChatStreamChunk`**（`plugin-llm-api/src/index.ts:35-47`）：流式增量。`contentDelta` / `reasoningDelta` / `toolCalls`（最终结果）/ `toolCallProgress`（增量进度提示，与 `toolCalls` 互斥，`plugin-llm-api/src/index.ts:39`）/ `done` / `usage`。
- **`StreamChunkMessage`**（`index.ts:274-292`）：平台层流式片段，经 `'outbound:stream'` 事件发往 WebUI 等前端。`toolCallProgress` 仅用于 UI「正在生成工具调用」提示，不影响最终 tool_call segment 下发（`index.ts:279-288`）。

---

## 9. 边界与坑（审计标记）

1. **漏调 `prepareLLMMessages` = provider 崩**。某天上游塞 `notice` 或跨会话委派消息进来，未归一的非标准 role 会让你的 API 直接 400。务必在 `chat`/`chatStream` 第一步调用（§3.1）。
2. **`prepareLLMMessages` 不剔 event-marker**。它只做 role 转译 + 前缀。`CONTROL_KINDS` 过滤是**消费方**的职责（`plugin-agent/src/index.ts:1843`）。你自己拼历史喂模型时要先 `filter(m => !CONTROL_KINDS.includes(m.kind ?? ''))`。
3. **自定义 kind 别撞已占用语义**。可以定义新 kind，但避开 `WellKnownKinds`（`index.ts:99`）。前端有字面量副本（`plugin-webui-client/src/useSessionManager.ts:105` 注释提醒），改动 `event-marker` 等值要同步前后端。
4. **附件占位符必须走 `formatAttachmentRef`/`parseAttachmentRefs`**，且写入方保证 `desc` 不含 `]`/`|`（§4.3）。手搓字符串 = 四处解析悄悄断链。
5. **`<at>` 是约定不是 API**，没有编译期兜底。新平台适配器产出的入站文本必须严格遵循 `<at id="X">名</at>` / `<at self …>` / `<at>all</at>`，否则归档/向量/触发判定全部静默失效（§5.2）。`<at self>` 是 trigger-policy 判定「机器人被 @」的唯一信号（`detector.ts:10`）。
6. **`Message.metadata` 不发给 LLM**（`index.ts:118-119`）。要让模型看到的信息必须进 `content`/`segments`/`images`/`audios`，别塞 metadata。
7. **`actor` 是授权身份，不可被 LLM 自由指定**（`index.ts:225-240`）：系统侧触发器（scheduler/idle/proactive）创建任务时 snapshot 调用者身份并回填，agent 构造 `ToolCallContext` 时优先用 `actor` 查权限，防提权。详见 forward-ref → `docs/concepts/authority.md`。
8. **`images`/`audios` 的解析格式由 provider 负责**（`index.ts:110-117`）：可能是 base64 data URL / `file://` / 本地路径 / http(s)。OpenAI 把 `images[]` 仅在 `user` role 上展开为 `image_url` content parts（`plugin-openai/src/index.ts:428`）；其它 role 携带图片不会被它消费。

---

## 相关文档

兄弟概念（forward-ref，可能尚未落地）：

- `docs/concepts/service-model.md` — `ServiceContainer` 按名注册、同名多 provider 胜出规则（preference > priority > 注册序）、per-entry 粒度。
- `docs/concepts/authority.md` — 数字等级鉴权、`actor` 授权身份、HITL 确认。
- `docs/concepts/storage-uri-grammar.md` — `<root>:/path` 文法（`ref` 字段可承载 storage URI）。

服务文档（forward-ref）：

- `docs/services/llm.md` — `LLMModel` / `ChatModelRequest` / `resolveLLMModel` / per-model entry 注册全貌。
- `docs/services/service-container.md` — `provide` / `getService` / `getAllServices` / `setPreference` / `whenService`。

权威源码：

- `packages/plugin-message-api/src/index.ts`（消息类型、`WellKnownRole`/`WellKnownKinds`/`CONTROL_KINDS`、`prepareLLMMessages`、`toLLMRole`）
- `packages/plugin-message-api/src/attachment-ref.ts`（附件占位符文法）
- `packages/plugin-message-api/src/identity.ts`（发送者标识）
- `packages/plugin-llm-api/src/index.ts`（`ChatModelRequest`/`LLMModel`/`resolveLLMModel`）
- `packages/plugin-adapter-onebot/src/types.ts`、`forward.ts`、`index.ts`（`<at>` 等内联 XML 文法产出）
- `packages/plugin-trigger-policy/src/detector.ts`、`packages/plugin-message-archive/src/index.ts`、`packages/plugin-memory-vector/src/index.ts`（`<at>` 消费方）
