# plugin-message-archive — 消息归档

**包名**: `@aalis/plugin-message-archive`  
**源码**: `packages/plugin-message-archive/src/index.ts`

## 概述

持久化会话消息（入站消息、助手回复、平台 notice 等）以供检索；入站消息落库前会把发送者前缀（webui、cli 平台除外）、引用回复内容和附件描述合进归档文本。注册 `message-archive` 服务（`MessageArchiveService`，契约见 `@aalis/api-message-archive`），提供 `saveMessage` / `archiveIncoming` / `archiveNotice` / `findByMessageId` 四个方法。本插件不自行存储，所有写入与读取均委派给 `memory` 服务（必需依赖），且每次调用时懒查服务引用。入站消息带附件且 `_attachmentDescriptions` 尚未预设时，调用可选的 `media` 服务的 `processMessage` 识别附件。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-message-archive',
  displayName: '消息归档',
  subsystem: 'message',
  provides: [messageArchive],
  uses: {
    memory,
    media: optional(media),
    events,
    logger,
    config,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

配置项由 `packages/plugin-message-archive/src/index.ts` 的 `configSchema` 声明。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `debugLogs` | boolean | `true` | 归档调试日志：记录图片解释完成和消息写入记忆等调试日志。 |

## 相关

- 服务契约 `@aalis/api-message-archive`：[services/message-archive.md](../services/message-archive.md)
- 底层存储 `memory` 服务：[api/api-memory.md](../api/api-memory.md)
- 附件识别 `media` 服务：[plugins/plugin-media.md](./plugin-media.md)
- 消息到 LLM 的处理流水线：[concepts/message-llm-pipeline.md](../concepts/message-llm-pipeline.md)
