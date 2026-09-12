# plugin-checkpoint — 会话检查点：保存与回滚对话状态

**包名**: `@aalis/plugin-checkpoint`  
**源码**: `packages/plugin-checkpoint/src/index.ts`

## 概述

在 LLM 一次回合期间记录受控存储中的写入、删除与重命名操作，在改动发生前备份原始文件内容，用户可从 WebUI 回滚整轮操作（见 `packages/plugin-checkpoint/src/service.ts` 头部注释）。`plugin-storage-local` 在执行 `writeFile` / `delete` / `rename` / `move` 之前，若存在活跃回合，经 `checkpoint` 服务的 `beforeMutate` 对待修改的 URI 做一次性快照（同一回合内同一 URI 只保留最早的原始内容；落在 `rootDir` 之下的 URI 是 checkpoint 自身的备份与清单，不参与快照，也不计入 manifest 与 `listTurns` 的文件数与预览）；回合边界由 `agent:input:before` 与 `agent:turn:after` 两个钩子维护，仅对 `scopes` 匹配的会话建 checkpoint。`exec` / `shell` 工具直接调用系统命令，不在保护范围内；若该会话有活跃回合，调用时该回合被标记为 `execUsed`。插件参与 `memory:clear` 钩子，`/clear` 与会话删除时同步清理对应 checkpoint；插件上下文销毁时（停机、重载、卸载与配置变更均会触发）提交所有未结束的活跃回合。向 WebUI 暴露 `listTurns` / `getManifest` / `rollback` / `rollbackWithChat` 四个 action，其中 `rollbackWithChat` 在回滚文件后按 manifest 记录的消息时间戳删除本轮对话消息，并发出 `memory:messages-deleted` 事件，由 `plugin-memory-vector` 清理对应向量条目。

## 插件声明

```typescript
meta.name = '@aalis/plugin-checkpoint'
meta.provides = ['checkpoint']
meta.subsystem = 'scheduler'
```

## 配置

配置项由 `configSchema` 声明，不传时取表中默认值。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `rootDir` | string | `'data:/checkpoints'` | 存储目录：存储 URI（默认 data:/checkpoints），也兼容裸名/相对路径。所有 checkpoint blob 和 manifest 写入此位置。 |
| `maxFileSize` | number | `10485760` | 单文件大小上限（字节）：超过此大小的文件不做内容快照，只在 manifest 里记录为 skipped。 |
| `keepSessions` | number | `20` | 保留的会话数：GC 阈值。每次提交回合后，若 session 目录数超过此值，删除最早的几个。设为 0 关闭 GC。 |
| `scopes` | multiselect | `["webui:*"]` | 启用作用域：仅在匹配下列 platform:sessionType 的会话中参与 turn 生命周期（建 checkpoint）。格式举例：`webui:*` / `onebot:group` / `*` 表示全部。默认仅 `webui:*`：onebot 等聊天平台不会为每条消息创建 checkpoint。留空数组 = 禁用 checkpoint（仅允许手动 rollback）。 |

## 相关

- 存储服务与 URI 语法：[services/storage.md](../services/storage.md)、[concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)
- 记忆服务（对话回滚依赖）：[services/memory.md](../services/memory.md)
- WebUI 服务端：[plugin-webui-server.md](./plugin-webui-server.md)
