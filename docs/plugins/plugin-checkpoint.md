# plugin-checkpoint — 会话检查点：保存与回滚对话状态

**包名**: `@aalis/plugin-checkpoint`  
**源码**: `packages/plugin-checkpoint/src/index.ts`

## 概述

在 LLM 一次回合期间记录受控存储中的写入、删除与重命名操作，在改动发生前备份原始文件内容，用户可从 WebUI 回滚整轮操作（见 `packages/plugin-checkpoint/src/service.ts` 头部注释）。`plugin-storage-local` 在执行 `writeFile` / `delete` / `rename` / `move` 之前，若存在活跃回合，经 `checkpoint` 服务的 `beforeMutate` 对待修改的 URI 做一次性快照（同一回合内同一 URI 只保留最早的原始内容；落在 `rootDir` 之下的 URI 是 checkpoint 自身的备份与清单，不参与快照，也不计入 manifest 与 `listTurns` 的文件数与预览；`kind` 为 `data` / `pluginData` / `logs` 的根不参与快照：它们是多会话、多平台共享的写入区，既有别处落盘的附件与插件状态，也有本回合经工具产生的内容（如 `skill_create` / `skill_update` 写入的 `data:/skills`），storage 写入没有会话归属、无法分辨，记进回合会让回滚误删别人刚落盘的文件、把插件状态写回旧版，因此这些根下的改动不可回滚；`tmp` 根是回合结束前就清理的临时目录，同样不记账；其余根——`workspace` 与用户在 storage 配置里自建的 `custom` 等——照常记账。升级前写下的 manifest 里若含这些根的条目，读取时一并忽略，`listTurns` 的计数与回滚保持一致）；回合边界由 `agent:input:before` 与 `agent:turn:after` 两个钩子维护，仅对 `scopes` 匹配的会话建 checkpoint。`exec` / `exec_background` / `run_*` 工具直接调用系统命令或子进程，其副作用不经 storage、不在保护范围内；若该会话有活跃回合，调用时该回合被标记为 `execUsed`，WebUI 据此提示「部分未保护」。插件参与 `memory:clear` 钩子，`/clear` 与会话删除时同步清理对应 checkpoint；插件上下文销毁时（停机、重载、卸载与配置变更均会触发）提交所有未结束的活跃回合。目录级改动没有内容可备份：递归删除记为 `skipped`，回滚时如实计入 `errors` 而非报成功；改名与移动在 manifest 里带目标 URI，回滚优先把文件/目录原路移回（移不动才回落到「写回源端 + 删目标」），不会在目标端留一份重复；回落时只要源端写回成功就算这条已复原，删目标只是善后——目标已不在（ENOENT：重复回滚、别处已清）才忽略，因此改名/移动条目在重复回滚时不会二次报错（本回合只含改名/移动条目时，连点两次第二次仍 `ok: true`；含新建文件的回合第二次回滚会因文件已删而 `ok: false`）；删目标因其它原因失败（如权限被拒）则如实计入 `errors`，本次回滚返回 `ok: false`。回滚按 manifest 逆序撤销（LIFO，后发生的改动先回退），「移走后又改写目标」这类同回合叠加改动才能一并回到回合开始的样子。内容去重按 URI，但改名与移动不受它吞噬：同一回合里「先写入或改写某文件、再把它移走」时，移动仍会补记一条不带备份的条目（内容已由更早的条目备份，不重复存一份），逆序回滚先由它把文件从目标端移回源端，再由更早的写入条目恢复原文或删除新建文件，两端都不留残留。向 WebUI 暴露 `listTurns` / `getManifest` / `rollback` / `rollbackWithChat` 四个 action，其中 `rollbackWithChat` 在回滚文件后按 manifest 记录的消息时间戳删除本轮对话消息，并发出 `memory:messages-deleted` 事件，由 `plugin-memory-vector` 清理对应向量条目。

## 插件声明

```typescript
meta.name = '@aalis/plugin-checkpoint'
meta.provides = ['checkpoint']
meta.subsystem = 'scheduler'
meta.inject = { required: ['storage'] }
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

## 拆卸顺序

`storage` 声明为硬依赖，不只是因为快照要经它落盘，更是为了拆卸顺序：`topoSortByDeps` 只按
`required` 建边，不声明的话 checkpoint 与 storage 的 inDegree 都是 0，拆卸序退化成注册序的
逆序——storage 可能先被 retire，随后 `onDispose` 里的 `flushAll()` 调 `storage.writeFile` 时
entry 已被摘除，在飞回合的 manifest 落不了盘。声明之后消费者必然先于提供者关闭。
