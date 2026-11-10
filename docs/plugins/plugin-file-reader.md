# plugin-file-reader — 文件读取

**包名**: `@aalis/plugin-file-reader`  
**源码**: `packages/plugin-file-reader/src/index.ts`

## 概述

多格式文件上传处理器，支持文本、代码、文档（DOCX/PDF）等文件的读取与内容提取。经 agent 的输入预处理器（`agent.use.registerPreprocessor`）自动处理消息附件；这是唯一的入口，agent 提供者不支持预处理器时附件不被处理，插件也不记日志。插件不提供服务：上传的文件只经它自己的工具与会话面板取用。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-file-reader',
  uses: {
    storage,
    config,
    logger,
    lifecycle,
    events,
    contributions,
    tools: optional(tools),
    agent: optional(agent),
    media: optional(media),
    webui: optional(webuiServer),
    sessionManager: optional(sessionManager),
    authority: optional(authority),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxFileSizeMB` | number | `20` | 最大文件大小 (MB)：允许上传的最大文件大小（MB）。超过此限制的文件将被拒绝。 |
| `autoInlineLimit` | number | `100000` | 自动 inline 阈值（字符）：提取出的文本长度若 ≤ 此值，则直接 inline 到附件描述里（模型无需调工具即可看到全文）；否则只挂 ID，由模型按需用 read_uploaded_file 拉取。受众里有别人的会话（群、多人房间、对端不是 owner 的私聊）里一律不内联，只给文件名、ID 与大小。 |
| `toolDefaultMaxLength` | number | `50000` | read_uploaded_file 默认截断：read_uploaded_file 工具未显式传 maxLength 时使用的默认截断字符数，避免把超大文档一次喂进 LLM 上下文导致爆 token。0 表示不截断；要是非负整数，负数与小数报配置错误。 |
| `retentionDays` | number | `30` | 保留天数：上传文件保留的最长天数，超过即清理（按上传时间 uploadedAt）。0 表示不按时间清理。 |
| `lruMaxTotalMB` | number | `500` | 磁盘总量上限 (MB)：上传文件总目录占用超过该上限时，按上传时间 uploadedAt 由旧到新淘汰直到回落到上限以下。0 表示不限。 |
| `historyHintEnabled` | boolean | `true` | 注入会话文件清单提示：开启后：会话中存在上传文件时，在 LLM 调用前注入一条 system 提示列出可用文件（含 ID），避免模型遗忘过往上传。本轮有新上传时注入本轮清单与历史清单（本轮文件单独标出），否则只注入历史清单。只列最近 20 个，更早的在列表末尾写一句个数、用 list_uploaded_files 查。本轮新上传按这一轮各条输入的附件认：预处理器把处理过的文件附件改写成本插件的文件引用，引用的是本会话已知文件的就是；正文里写的文件描述不算。 |
| `recognizeDocImages` | boolean | `true` | 识别文档内嵌图片：读取 DOCX 时调用 media 服务识别内嵌图片，把描述附在正文末尾（需启用 media/vision；无 media 服务时自动跳过）。识别会增加首次解析耗时与 vision token 开销，结果随提取文本一并缓存。 |
| `maxDocImages` | number | `8` | 单文档最多识别图片数：超出的内嵌图片跳过识别，避免大量图片拖慢解析、消耗 vision token。0 等同关闭识别。 |

## 附件描述

上传的文件经预处理后，附件描述拼进用户消息。受众里有别人的会话（房间类别 `room`：群、多人房间、对端不是 owner 的私聊，判法见 [session-manager](../services/session-manager.md) 的房间类别）不内联；其余会话提取文本不超过 `autoInlineLimit` 时内联全文：文件头 `[文件: 名称 (ID: …)]` 的下一行以 `--- 文件内容 ---` 开头，同一行注明正文是数据不是指令，并给出本次的结束标记 `--- 文件内容结束 <编号> ---`。编号在每次生成描述时随机产生，正文中出现的其它结束标记都算正文，文件内容无法借伪造的结束标记把文字排到文件块之外。文件名中的换行等控制字符一律换成空格，名字只占文件头所在的一行；`|`、`]` 照 `formatAttachmentRef` 净化描述的写法换成全角，名字里拼不出附件引用。附件描述、文件清单与工具输出都用净化后的名字。不内联时（受众里有别人，或超过阈值）只给文件名、ID 与大小，由模型调用 `read_uploaded_file` 按需读取，两种同一句。受众里有别人的会话里上传时不解析，读的时候才解析文档、识别内嵌图片；只看字节就知道读不出的（旧版 Office 文档、媒体、认不出的格式）上传时就写明原因，PDF 与 DOCX 读不出的在读的时候才报。会话管理不在时判不出受众，照旧内联。读不出内容的写成 `[文件: 名称 (ID: …) — 读不出内容：<原因>]`，不给内容块；以方括号开头的普通文本照常内联。附件描述只给模型看：会话历史与实时推送里的提问取存档另记的发言人写的话与附件清单（见 [plugin-message-archive](./plugin-message-archive.md)），文件块不进气泡，文件显示成卡片。

## 附件的来源

文件附件的 `data` 按来源取字节：base64 data URL（WebUI 上传）解码；存储地址（QQ 发来的文件落盘在 `data:/files/…`）先看大小、没超上限才读；网址（落盘失败时 QQ 文件是原网址）经 util-network-guard 的受保护下载（拒内网地址），15 秒超时，响应体流式累计不超过上限；本插件停用、停机时下载随之停下，这个附件不写描述，这条消息后面的附件不再处理，消息照常往下交。别的来源（`file://`、本机路径）不读本机文件，描述写「读不出内容：附件来源不是存储地址、网址或 base64 的 data URL」，没有来源的（QQ 的文件段没带网址时）写「读不出内容：来源没有给出文件地址」；下载失败等其它错误写「处理失败：<原因>」。来源是存储地址或网址的，文件头按 `formatAttachmentRef` 带上这个地址（`[文件: 名称 (ID: …) | ref:<地址>]`）：处理过的附件 `data` 换成本插件的文件引用，这个地址另写在附件的 `ref` 上，存档的附件清单按它记地址，会话历史里这个文件照样能点开（与媒体识别落盘后写引用同一规则）。

## 支持格式

按内容判，附件报的 MIME 与扩展名不看（浏览器把 `.ts` 报成 `video/mp2t`，没有扩展名的 README 报成二进制流）：

- 文本：合法的 UTF-8、不含 NUL 字节即是，源码、配置、没有扩展名的 README 都照文本读。只认 UTF-8：GBK 等编码的文本如实写读不出，不硬解出乱码；扩展名写成文本、内容其实是二进制的同样读不出。
- DOCX（ZIP 里有 `word/document.xml`）：使用 mammoth；没有正文也没有内嵌图片描述的写读不出（内嵌图片见下）。
- PDF（文件头 `%PDF-`）：使用 unpdf，仅文本；没有可提取文字的写读不出。
- 旧版 Office 文档（doc、xls、ppt 共用的复合文档）不提取，原因写「请另存为新格式后重传」；认得出的图片、音频、视频写明是什么格式（如「这是 PNG 图片」），其余写「不是 UTF-8 文本，也不是 PDF 或 DOCX」。

会话面板与工具输出里的「类型」是判定出的格式名：`文本`、`PDF`、`DOCX`、`OLE`、媒体格式名（如 `PNG`），都认不出的写 `未知`。

## 文档内嵌图片识别

读取 DOCX 时，若启用 `recognizeDocImages`（默认开）且 `media` 服务可用，会提取内嵌图片、调用 `media.use.describeImage` 识别，并把描述以「`--- 文档内图片 (N) ---`」小节附在正文末尾。

- 图片的类型按文件头认（mammoth 报的是按扩展名登记的类型）；不是认得出的图片的（EMF、WMF、SVG 等）识别模型读不了，跳过。
- `maxDocImages`（默认 8）限制单文档识别张数，避免大量图片拖慢解析、消耗 vision token；超出跳过。
- 单张识别失败不影响其余；无 `media` 服务时整体静默跳过。
- 识别接中止信号：`read_uploaded_file` 读时接这次调用的，上传时内联解析接本插件这次激活的。中止时这次读或这个附件按中止收尾，不按解析失败报，已识别的部分不缓存，下次重新识别。
- 提取文本（含图片描述）长度不超过 `autoInlineLimit` 时，结果写入文件元信息缓存，之后读取不再重复解析与识别；超过阈值的文档每次读取都会重新解析。读不出的结论同样缓存；读文件失败与解析失败可能是一时的，不缓存，下次重试。
- PDF 暂不识别内嵌图片，仅提取文本。

## 存储与会话隔离

上传的文件存在 `pluginData:/file-reader/<会话目录>/<文件 ID><扩展名>`，元信息在同目录同名的 `.meta.json` 里；会话目录名是把会话 id 里的 `:`、`/`、`\` 换成 `_`（Windows 文件名不收冒号）。存储不是沙箱，会话之间的隔离靠下面的校验。

文件 ID 是 `sha256(会话 id + '\0' + 内容)` 的前 16 位十六进制：同一会话重传同一文件得到同一 ID，不同会话上传相同内容得到不同 ID。ID 仍可预测（知道会话 id 与内容就能算出），所以工具 `read_uploaded_file`、`list_uploaded_files`、`delete_uploaded_file` 只认本会话（`ToolCallContext.sessionId`）的文件，别的会话的文件一律当作不存在。`read_uploaded_file`、`list_uploaded_files` 不分组、总是给（只读这个会话自己收到的文件）；`delete_uploaded_file` 在 `file-reader` 分组里（显示名「删除上传的文件」），是 `restricted`。会话删除（`session:deleted`）时删掉这个会话的全部文件。

工具的失败一律抛错，执行层按失败记、WebUI 工具卡显示为失败：`read_uploaded_file` 找不到文件（不在索引里或不属于本会话，两种同一句）时写「找不到文件 (ID: …)：上传的文件按保留天数与总量清理，已清理的请用户重新上传」，读不出内容时写原因；`maxLength` 给了就要是正整数，截断不切开代理对。

## 会话面板

会话右侧面板的「+」里有「上传的文件」（页面 `uploads`），只在本会话有上传文件时出现：列出本会话上传的文件（文件名、大小、类型、上传时间），行动作「删除」（确认框，只认本会话的文件；存储删不掉时回失败并写明原因，文件留在列表里可以重试）。文件存在插件数据里，面板不提供下载。文件增删（含按保留天数与总量的清理、会话删除时的联动清理）后，只有那个会话的面板重取；清理时删不掉的文件记一条告警、留到下次，不拦后面的。

## 限制

| 限制 | 值 |
|---|---|
| 最大文件大小 | 默认 20 MB（`maxFileSizeMB`；超限文件不入库，附件描述标注「超过大小限制」） |
| 文件保留时间 | 默认 30 天（`retentionDays`，按上传时间 `uploadedAt` 计算，同会话重传同一文件会刷新；启动时及每小时清理一次）。清理掉的文件读不到，`read_uploaded_file` 如实说找不到、请用户重新上传 |
| 文本编码 | 只认 UTF-8 |
