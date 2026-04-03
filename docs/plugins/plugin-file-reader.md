# plugin-file-reader — 文件上传读取

**包名**: `@aalis/plugin-file-reader`  
**源码**: `packages/plugin-file-reader/src/index.ts`

## 概述

多格式文件上传处理器，支持文本、代码、文档（Word/PDF）等文件的读取与内容提取。通过 `message:before` 钩子自动处理消息附件。

## 插件声明

```typescript
meta.name = '@aalis/plugin-file-reader'
meta.inject = {}
```

## 支持格式

- 文本/代码文件（自动编码检测）
- Microsoft Word (.docx) — 使用 mammoth
- PDF (.pdf) — 使用 pdf-parse
- 其他文件类型的 MIME 检测

## 限制

| 限制 | 值 |
|---|---|
| 最大文件大小 | 20 MB |
| 文件保留时间 | 60 分钟 |
