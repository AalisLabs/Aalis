# plugin-file-reader — 文件读取

**包名**: `@aalis/plugin-file-reader`  
**源码**: `packages/plugin-file-reader/src/index.ts`

## 概述

多格式文件上传处理器，支持文本、代码、文档（DOCX/PDF）等文件的读取与内容提取。通过 `agent:input:before` 钩子自动处理消息附件。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-file-reader',
  provides: [fileReader],
  uses: {
    storage,
    config,
    logger,
    lifecycle,
    events,
    hooks,
    contributions,
    provide,
    tools: optional(tools),
    agent: optional(agent),
    memory: optional(memory),
    media: optional(media),
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxFileSizeMB` | number | `20` | 最大文件大小 (MB)：允许上传的最大文件大小(MB)。超过此限制的文件将被拒绝。 |
| `autoInlineLimit` | number | `100000` | 自动 inline 阈值（字符）：提取出的文本长度若 ≤ 此值，则直接 inline 到附件描述里（模型无需调工具即可看到全文）；否则只挂 ID，由模型按需用 read_uploaded_file 拉取。 |
| `toolDefaultMaxLength` | number | `50000` | read_uploaded_file 默认截断：read_uploaded_file 工具未显式传 maxLength 时使用的默认截断字符数，避免把超大文档一次喂进 LLM 上下文导致爆 token。 |
| `retentionDays` | number | `30` | 保留天数：上传文件保留的最长天数，超过即清理（按文件 mtime）。0 表示不按时间清理。 |
| `lruMaxTotalMB` | number | `500` | 磁盘总量上限 (MB)：上传文件总目录占用超过该上限时，按 mtime 由旧到新淘汰直到回落到上限以下。0 表示不限。 |
| `historyHintEnabled` | boolean | `true` | 在本轮无新上传时注入历史文件清单提示：开启后：仅当会话中存在历史上传文件且本轮没有新上传时，在 LLM 调用前注入一条 system 提示列出可用文件（含 ID），避免模型遗忘过往上传。本轮有新上传时跳过注入（user message 里已有 【文件: ...】 描述）以节省 token。 |
| `recognizeDocImages` | boolean | `true` | 识别文档内嵌图片：读取 DOCX 时调用 media 服务识别内嵌图片，把描述附在正文末尾（需启用 media/vision；无 media 服务时自动跳过）。识别会增加首次解析耗时与 vision token 开销，结果随提取文本一并缓存。 |
| `maxDocImages` | number | `8` | 单文档最多识别图片数：超出的内嵌图片跳过识别，避免大量图片拖慢解析、消耗 vision token。0 等同关闭识别。 |

## 支持格式

- 文本/代码文件（按 UTF-8 解码；MIME 缺失或为 `application/octet-stream` 时按扩展名推断）
- Microsoft Word (.docx) — 使用 mammoth（内嵌图片可经 media 服务识别，见下）
- PDF (.pdf) — 使用 unpdf（仅文本；内嵌图片识别尚未实现）
- 旧版 Word (.doc) 及其它格式不提取内容：.doc 返回「请转换为 .docx」提示，其余返回 `[不支持的文件格式: <mime>]` 占位

## 文档内嵌图片识别

读取 DOCX 时，若启用 `recognizeDocImages`（默认开）且 `media` 服务可用，会提取内嵌图片、调用 `media.describeImage` 识别，并把描述以「`--- 文档内图片 (N) ---`」小节附在正文末尾。

- `maxDocImages`（默认 8）限制单文档识别张数，避免大量图片拖慢解析、消耗 vision token；超出跳过。
- 单张识别失败不影响其余；无 `media` 服务时整体静默跳过。
- 提取文本（含图片描述）长度不超过 `autoInlineLimit` 时，结果写入文件元信息缓存，之后读取不再重复解析与识别；超过阈值的文档每次读取都会重新解析。
- PDF 暂不识别内嵌图片，仅提取文本。

## 限制

| 限制 | 值 |
|---|---|
| 最大文件大小 | 默认 20 MB（`maxFileSizeMB`；超限文件不入库，附件描述标注「超过大小限制」） |
| 文件保留时间 | 默认 30 天（`retentionDays`，按上传时间 `uploadedAt` 计算，同会话重传同一文件会刷新；启动时及每小时清理一次） |
