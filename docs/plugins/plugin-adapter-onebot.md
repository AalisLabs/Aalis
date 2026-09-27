# plugin-adapter-onebot — OneBot 协议适配器

**包名**: `@aalis/plugin-adapter-onebot`  
**源码**: `packages/plugin-adapter-onebot/src/`

## 概述

OneBot 协议适配器，通过 WebSocket 连接一个或多个 OneBot 实现端（如 go-cqhttp、Lagrange 等），支持 v11/v12 协议自动检测。

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
| `forward.summarize` | boolean | `true` | 生成摘要：展开后调用 LLM 生成一段摘要，作为消息正文进入对话/记忆/向量库；原文保留在缓存。 |
| `forward.summaryLLM` | llm-ref | — | 摘要模型：留空使用默认 LLM 服务；指定后按 (provider, model) 精确定位。建议挑便宜/快的模型。 |
| `forward.summaryMaxChars` | number | `600` | 摘要最大字数：提示给摘要模型的目标长度上限。模型被允许超出 10% 以保留多人互动结构。 |
| `forward.summaryInputLimit` | number | `8000` | 摘要原文输入上限（字符）：喂给摘要模型的原文输入上限；原文超过则前段截断。设为 0 表示不截断（注意超长文本会增加摘要成本）。 |
| `forward.summaryPrompt` | textarea | `''` | 摘要 system prompt（高级，留空使用内置）：留空使用内置默认 prompt（专为保留多人互动结构调优过）。填入非空内容则完全覆盖默认 prompt。 内置默认 prompt 如下，可作为撰写参考： 你是聊天记录摘要助手。给定一段合并转发的原始内容，用简体中文输出一段含多人互动细节的摘要： - 按时间顺序串联主线，使用“某人：……”或“某人对某人说……”这种紧凑句式保留发言人轮次与互动关系，但不要逐条复述每句寒暄； - 明确点出每位主要参与人的关键发言 / 立场 / 情绪变化，以及他们互相同意、反驳、调侃、追问的点； - 原文里出现的请求 / 指令 / 待执行事项 / 希望机器人代发或转告的内容，必须原文输出并保留具体目标对象 / 群聊 / 要表达的观点； - 图片识别结果、链接、文件名等视觉 / 附件信息也要写进来； - 不要寒暄、不要解释自己、不要使用 markdown 列表或标题；输出单段落纯文本； - 控制在目标字数以内，优先保留互动细节与可引用发言，寒暄/重复信息略去。 |
| `reply` | object | — | 引用消息处理：收到引用回复时如何展开被引用消息链 |
| `reply.maxDepth` | number | `5` | 引用链深度上限：递归获取被引用消息的最大层数。1 = 只读取直接引用；2 = 继续读取直接引用所引用的消息，依此类推。 |
| `attachmentCache` | object | — | 附件本地缓存：入站 / 出站的 image / audio / video / file 统一缓存到 data/{kind}s/{session}/，与图片目录布局一致，便于人工归档与多轮工具复用 |
| `attachmentCache.maxBytes` | number | `10485760` | 单文件大小上限 (Byte)：超过此尺寸的附件不落盘，保留原 URL（典型场景：长视频）。默认 10 MiB。 |

## 文件结构

| 文件 | 说明 |
|---|---|
| `index.ts` | 主入口，连接管理、事件分发、PlatformAdapter 实现 |
| `types.ts` | 类型定义、`segmentsToText()` 富文本渲染、CQ 字符串→消息段规范化、forward 段解析工具 |
| `v11.ts` | OneBot v11 协议处理器 |
| `v12.ts` | OneBot v12 协议处理器 |
| `attachment-cache.ts` | 入站/出站附件统一落盘缓存（`data/{kind}s/{session}/`，含单文件大小上限） |
| `attachments.ts` | 出站附件按文件头分流：能内联的媒体渲染为消息段标记，文件附件与不能内联的媒体物化为上传文件 |
| `forward.ts` | 合并转发展开与摘要信封构造 |
| `forward-expand.ts` | 合并转发自动展开器（缓存、媒体识别、LLM 摘要、默认摘要 prompt） |
| `sent-messages.ts` | 已发送消息记录（供撤回等工具查询） |

## 协议处理

- **v11**: `post_type`/`message_type`，ID 为 number 类型，`send_private_msg`/`send_group_msg`
- **v12**: `type`/`detail_type`，ID 为 string 类型，统一 `send_message`，支持 channel/guild
- **auto**: 连接建立后主动探测，先调用 v11 的 `get_version_info`，成功即采用 v11；失败再调用 v12 的 `get_version`，成功则采用 v12；两者都失败时回退为 v11。协议确定前收到的事件会被丢弃

## sessionId 格式

```
onebot:{selfId}:{detailType}:{targetId}
```

示例: `onebot:123456:group:789012`

`detailType` 取 `private`、`group` 或 `channel`；其中 `channel`（v12）的 `targetId` 为 `{guildId}:{channelId}`。

## 连接管理

- 支持多连接同时在线
- 自动重连：连接断开后固定 5 秒重试；握手超过 15 秒未完成视为超时并重连；断开时所有未完成的 action 以失败结束
- Action 请求-响应：每个请求带唯一 echo ID，30 秒超时；发送消息失败时间隔 1 秒最多重试 2 次（至少送达一次，偶有重复）
- 客户端心跳：每 30 秒发送一次 WebSocket ping，检查时若距上次收到 pong 或任何消息已超过 40 秒，则主动断开并重连（OneBot 的 heartbeat 元事件不单独处理，只作为普通流量计入）

## 消息入站

两种上报消息格式都支持：实现端的 `message` 既可以是消息段数组，也可以是含 `[CQ:…]` 码的字符串（`message_format=string`）。字符串格式在 v11 入站时先被规范化成消息段数组，之后附件提取、引用回复提取与 `segmentsToText()` 富文本渲染与数组格式共用同一条路径——`<at self>` 标记与 selfId 判定只有一处，CQ 码不会流进下游文本（触发插件的 @ 判定因此只认 `<at self>`）。段类型名与 data 键沿用 v11 段语义（`at.qq`、`image.url`/`file`、`reply.id` 等），参数原样透传。

适配器不做流控或触发判定：消息事件解析后直接以 `inbound:message` 发出，由生效的触发插件（如 `@aalis/plugin-trigger-policy`）与 `@aalis/plugin-flow-control` 在 `inbound:trigger` / `inbound:flow` 相位决定是否响应。机器人自身的群禁言与解禁事件，以及启动或重连后按 `shut_up_timestamp` 恢复的禁言状态，通过 `flow-control` 服务的 `setMuted` 同步。

好友申请、入群邀请与加群申请（request 事件）合成为 `[系统通知] …` 消息发出，提示 agent 调用对应的 onebot 工具处理：好友申请与入群邀请发往申请人的私聊会话，加群申请发往该群的会话。这些消息带 `source: 'onebot-request'`，属于系统侧注入：不经触发判定，不受回复后冷却约束，禁言与限速照常；agent 按「会话 + 来源」分道，它们与同一会话的真人消息互不打断。

## 附件与图片

入站和出站的图片、语音、视频、文件统一缓存到 `data/{kind}s/{session}/`，单文件超过 `attachmentCache.maxBytes` 时不落盘、保留原 URL。入站文本中的 `[图片]`、`[语音]` 等占位符会改写为带本地引用的形式。

适配器不对普通入站图片调用视觉模型。合并转发内的图片在 `forward.imageRecognition` 开启时送 media 服务识别，语音与视频在 media 服务具备相应能力时一并识别。引用消息中的图片只复用 media 服务已有的描述缓存，写成 `[图片: 描述]`，查不到时保留 `[图片]`。

## 出站附件

出站附件的内容读出后以 `base64://` 交给实现端，走 WebSocket 隧道：实现端在容器里（如 Docker 里的 NapCat）时读不到宿主路径，这是最稳的形态。storage URI 先量大小再读，超过 10 MiB 的不整份读进内存。

- **图片、语音、视频**：先按文件头认格式（格式签名在 [`@aalis/util-media-signature`](../utils/README.md)，与 `send_attachment` 的白名单是同一份），再分三路。实现端能内联的格式（图片 PNG、JPEG、GIF、WebP；语音 WAV、MP3、OGG、FLAC、AMR、SILK、M4A；视频 MP4、MOV、WebM）内联为消息段；认得出、但不能内联的媒体（BMP、AVIF、HEIC 图片，MKV、AVI 视频，以及与附件 `kind` 不符的媒体）改经文件上传，规则同下面的文件附件，没有名字时群文件名为类型加格式（如 `image.bmp`）；都认不出的拒发并记 warn。发送工具接受任意 storage URI，不核对的话任意可读文件（如含密钥的配置）能冒充媒体发出。能内联、但超过 10 MiB 的退回宿主的 `file://` 路径或原 http 链接，实现端读不到时发不出，日志里会说明：实现端在容器里（如 Docker 里的 NapCat）读不到宿主路径，超过 10 MiB 的本机文件因此发不出去，这是送达方式的限制，要发更大的文件得让实现端与 Aalis 共享文件系统。storage 文件退回宿主路径之前同样按文件头核对（按字节区间读出开头 4 KiB，不整份读进内存），超过 10 MiB 又不能内联的不发。`send_attachment` 交来的是 storage URI，大文件照样经这道核对；附件本来就是 `file://` 或本机绝对路径（只有插件代码直接发出的附件是这种形态）、又没能落盘的，原样交给实现端，不经核对。
- **文件**（`kind: 'file'`）与改走上传的媒体：不走消息段。在文字与消息段发出之后逐个上传：群会话调 `upload_group_file`，私聊调 `upload_private_file`。`file` 只用 `base64://`；超过 10 MiB 的 storage 文件、超限的 http 链接、原样透传的 `file://` 这类物化结果不是 `base64://` 的，一律拒发并记 warn。群文件里显示的文件名去掉 `/` 与 `\`，文件附件没有名字时用 `file`。上传不重试：上传超时多半是文件还在传，重试会在群文件里留两份。v12 连接不支持文件上传，按失败处理。
- **投递失败回报**：由 agent 发出（`source: 'agent'`）的消息，文字发送、附件物化（含文件头不符的拒发）或文件上传任何一处失败，都往会话记忆写一条 `outbound-delivery-failed` 系统记录，每条出站消息至多一条，agent 下一轮能看到并重发。

文件上传经适配器的非标准扩展方法 `uploadFile(sessionId, file, name)` 完成，它不在 `@aalis/api-platform` 契约里。

## 合并转发原文

合并转发展开后，完整原文在内存里缓存 1 小时，有 memory 服务时同时写入记忆元数据（namespace `onebot:forward`，key 为转发 id），`get_forward_msg` 先查内存、再查持久化层。持久化条目保留 7 天，由后续写入惰性回收，每小时至多扫描一次。

原文是聊天内容，以 `context` 类型参与 `memory:clear`：全局清理（`/clear all` 不带类型或含 `context`）时清空持久化条目与内存缓存。条目没有会话归属，会话级 `/clear` 不动它，靠 7 天回收。多个适配器实例共用同一 namespace、各有一份内存缓存，清理时每个实例都清自己的缓存，回显合并为一条。
