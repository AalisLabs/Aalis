# plugin-file-reader — 文件上传读取

**包名**: `@aalis/plugin-file-reader`  
**源码**: `packages/plugin-file-reader/src/index.ts`

## 概述

多格式文件上传处理器，支持文本、代码、文档（Word/PDF）等文件的读取与内容提取。通过 `agent:input:before` 钩子自动处理消息附件。

## 插件声明

```typescript
meta.name = '@aalis/plugin-file-reader'
meta.inject = {}
```

## 支持格式

- 文本/代码文件（自动编码检测）
- Microsoft Word (.docx) — 使用 mammoth（**内嵌图片可经 media 服务识别**，见下）
- PDF (.pdf) — 使用 unpdf（仅文本；内嵌图片识别为待办，见 docs/issues.md）
- 其他文件类型的 MIME 检测

## 文档内嵌图片识别

读取 DOCX 时，若启用 `recognizeDocImages`（默认开）且 `media` 服务可用，会提取内嵌图片、
调用 `media.describeImage` 识别，并把描述以「`--- 文档内图片 (N) ---`」小节附在正文末尾，
让 LLM「看见」文档里的图。

- `maxDocImages`（默认 8）限制单文档识别张数，避免大量图片拖慢解析、消耗 vision token；超出跳过。
- 单张识别失败不影响其余；无 `media` 服务时整体静默跳过。
- 识别结果随提取文本一并缓存（小文件），重复读取不会反复识别。
- PDF 内嵌图片识别尚未实现（PDF 抽图较复杂），仅提取文本。

## 限制

| 限制 | 值 |
|---|---|
| 最大文件大小 | 20 MB |
| 文件保留时间 | 60 分钟 |
