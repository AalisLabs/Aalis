# plugin-adapter-onebot — OneBot 协议适配器

**包名**: `@aalis/plugin-adapter-onebot`  
**源码**: `packages/plugin-adapter-onebot/src/`

## 概述

OneBot 协议适配器，通过 WebSocket 连接一个或多个 OneBot 实现端（如 go-cqhttp、Lagrange 等），支持 v11/v12 协议自动检测。

## 插件声明

```typescript
meta.name = '@aalis/plugin-adapter-onebot'
meta.provides = ['platform']
meta.inject = {
  required: ['storage', 'process'],
  optional: ['llm', 'commands', 'message-archive', 'persona', 'flow-control'],
}
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
| `types.ts` | 类型定义、`segmentsToText()` 富文本渲染、forward 段解析工具 |
| `v11.ts` | OneBot v11 协议处理器 |
| `v12.ts` | OneBot v12 协议处理器 |
| `attachment-cache.ts` | 入站/出站附件统一落盘缓存（`data/{kind}s/{session}/`，含单文件大小上限） |
| `attachments.ts` | 出站附件标记渲染 |
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

适配器不做流控或触发判定：消息事件解析后直接以 `inbound:message` 发出，由 `@aalis/plugin-flow-control` 与 `@aalis/plugin-trigger-policy` 在 `inbound:flow` / `inbound:trigger` 相位决定是否响应。机器人自身的群禁言与解禁事件，以及启动或重连后按 `shut_up_timestamp` 恢复的禁言状态，通过 `flow-control` 服务的 `setMuted` 同步。

## 附件与图片

入站和出站的图片、语音、视频、文件统一缓存到 `data/{kind}s/{session}/`，单文件超过 `attachmentCache.maxBytes` 时不落盘、保留原 URL。入站文本中的 `[图片]`、`[语音]` 等占位符会改写为带本地引用的形式。

适配器不对普通入站图片调用视觉模型。合并转发内的图片在 `forward.imageRecognition` 开启时送 media 服务识别，语音与视频在 media 服务具备相应能力时一并识别。引用消息中的图片只复用 media 服务已有的描述缓存，写成 `[图片: 描述]`，查不到时保留 `[图片]`。
