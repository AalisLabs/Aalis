# plugin-message-archive — 消息归档

**包名**: `@aalis/plugin-message-archive`  
**源码**: `packages/plugin-message-archive/src/index.ts`

## 概述

持久化会话消息（入站消息、助手回复、平台 notice 等）以供检索；入站消息落库前会把发送者前缀（webui、cli 平台除外）、引用回复内容和附件描述合进归档文本。注册 `message-archive` 服务（`MessageArchiveService`，契约见 `@aalis/api-message-archive`），提供 `saveMessage` / `archiveIncoming` / `archiveNotice` / `findByMessageId` 四个方法。本插件不自行存储，所有写入与读取均委派给 `memory` 服务（必需依赖），且每次调用时懒查服务引用。入站消息带附件且 `_attachmentDescriptions` 尚未预设时，调用可选的 `media` 服务的 `processMessage` 识别附件。识别对传入的消息对象做，结果写回入参：`processMessage` 按消息对象只处理一次，触发判定已启动的识别在这里命中（在途则等它），不再识别第二遍。

`archiveIncoming` 按消息种类定角色：代发任务（`triggerType: 'proactive'`）落成 `role: 'notice'`、`kind: 'cross-session-delegation'`；宿主通知（带 `hostNotice`）落成 `role: 'notice'`、`kind: 'host-notice'`，不带 `name`，`metadata.hostNoticeKind` 记通知子类，`metadata.source` 照常写。宿主通知只归档 `content`：注入方包好的不可信段 `hostNotice.untrusted` 不写进消息也不写进 metadata。归档的 notice 在出口转成 system，之后这个房间每一轮都看得到，不可信段只能在注入的那一轮出现。其余入站消息落成 `role: 'user'`。三种都照常发 `inbound:message:archived`，下游按 `kind` 或 `hostNotice` 自行跳过。

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
