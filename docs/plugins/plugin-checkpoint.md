# plugin-checkpoint — 会话检查点：保存与回滚对话状态

**包名**: `@aalis/plugin-checkpoint`  
**源码**: `packages/plugin-checkpoint/src/index.ts`  
**契约**: [api-checkpoint](../api/api-checkpoint.md)（服务描述符 `checkpoint` 与对外类型）

## 概述

在 LLM 一次回合期间记录受控存储中的写入、删除与重命名操作，在改动发生前备份原始文件内容，用户可经会话协议的 `turn/rewind` 回滚整轮操作（见 `packages/plugin-checkpoint/src/service.ts` 头部注释）。`plugin-storage-local` 在执行 `writeFile` / `delete` / `rename` / `move` 之前，若这次改动处在一个进行中的回合里，经 `checkpoint` 服务的 `beforeMutate` 对待修改的 URI 做一次性快照（同一回合内同一 URI 只保留最早的原始内容；落在 `rootDir` 之下的 URI 是 checkpoint 自身的备份与清单，不参与快照，也不计入 manifest；`kind` 为 `data` / `pluginData` / `logs` 的根不参与快照：它们是多会话、多平台共享的写入区，有别处落盘的附件与插件状态，storage 写入没有会话归属、无法分辨，记进回合会让回滚误删别人刚落盘的文件、把插件状态写回旧版，因此这些根下的改动不可回滚；`tmp` 根是回合结束前就清理的临时目录，`cache` 根是缓存，同样不记账；kind 为 `self` 的 `personas` / `skills` / `workflows` 三个内部根也不记账：现在任何会话都能经工具写技能与人设，写入同样没有会话归属，等访问层限定只有 owner 的干净线程能写它们之后再记账；其余根照常记账，包括 `workspace`、用户在 storage 配置里自建的 `custom` 等）；回合由 `agent:turn:before` 维护：这个钩子的 `next` 就是一轮的全部（后续中间件、输入的归档、模型调用、工具、回合结束钩子），插件用 agent 给的 `turnId` 把它包成一轮，回合 id 与 agent 的回合 id 相同，`next` 返回（含被下游拦下、出错）即提交；只包「记检查点的会话」`coverage` 覆盖的会话（见「配置」）。活跃回合按 `turnId` 记：几轮可以同时在跑（不同会话的回合并发；同一会话一轮接一轮），一次改动只记进它所在的那一轮，按写入发生在哪一轮的异步上下文里认；回合里起的异步任务在回合提交之后才写入的不记（转到后台的工具调用也在此列，如转后台之后才写进 `workspace` 的 `http_download`：回合不等它就提交，之后经存储写的文件不进这一轮，回滚撤不回，清单里也没有标记），回合之外的改动（回滚本身、别的插件在后台的写入）也不记进任何一轮。命令（`exec`、`run_*` 起的子进程）与外部工具（如 MCP 工具）的副作用不经 storage，不在保护范围内；不逐轮判这一轮调没调用它们，回滚确认里固定写明命令与外部工具的效果撤不回。插件登记清理类型 `checkpoint`、参与 `memory:clear` 钩子，`/clear` 与会话删除时同步清理对应 checkpoint；插件上下文销毁时（停机、重载、卸载与配置变更均会触发）提交所有未结束的活跃回合。目录级改动没有内容可备份：递归删除记为 `skipped`，回滚时如实计入 `errors` 而非报成功；改名与移动在 manifest 里带目标 URI，回滚优先把文件/目录原路移回（移不动才回落到「写回源端 + 删目标」），不会在目标端留一份重复；回落时只要源端写回成功就算这条已复原，删目标只是善后——目标已不在（ENOENT：重复回滚、别处已清）才忽略，因此改名/移动条目在重复回滚时不会二次报错（本回合只含改名/移动条目时，连点两次第二次仍 `ok: true`；含新建文件的回合第二次回滚会因文件已删而 `ok: false`）；删目标因其它原因失败（如权限被拒）则如实计入 `errors`，本次回滚返回 `ok: false`。回滚按 manifest 逆序撤销（LIFO，后发生的改动先回退），「移走后又改写目标」这类同回合叠加改动才能一并回到回合开始的样子。回滚结果的 `alsoChangedBy` 如实列出这一轮改过、同一会话里另有回合也改过的文件（含移动的目标端）及那些回合的 id：回滚把文件恢复成这一轮第一次改动前的内容，那些回合在这之后的改动会一并被撤掉；在这一轮开始前就已结束的回合不算，已提交的与还在跑的回合都算，结束与开始落在同一毫秒、分不出先后的按算处理。回滚照常执行，这只是提示。内容去重按 URI，但改名与移动不受它吞噬：同一回合里「先写入或改写某文件、再把它移走」时，移动仍会补记一条不带备份的条目（内容已由更早的条目备份，不重复存一份），逆序回滚先由它把文件从目标端移回源端，再由更早的写入条目恢复原文或删除新建文件，两端都不留残留。两种回滚经 `checkpoint` 服务的 `rollback` / `rollbackWithChat` 提供，会话服务的 `turn/rewind` 调它们；`rollbackWithChat` 在回滚文件后按 manifest 记录的消息时间戳删除本轮对话消息，并发出 `memory:messages-deleted` 事件，由 `plugin-memory-vector` 清理对应向量条目。提交时只记时间窗里属于这一轮的消息：元数据的回合 id（`TurnId`）是这一轮的（这一轮的输入、工具调用组、回复，子任务自动完成时合成的回报，带回合 id 的出站记录与投递失败记录，经工具发出的附件与它的投递失败记录也带它）。这一轮进行期间同一会话里别人的消息（被触发判定或流控吞掉、影子归档的）与之前之后别的回合的产出不记，回滚时不连带删掉；同一毫秒落库的别的消息仍会被一起删（记忆只能按时间戳删）。列出回合或读取 manifest 失败时，除目标不存在外都记一条 warn（带 URI 与原因），如 storage 暂不可用、权限被拒或 manifest 损坏；每次回滚都要读这个会话的全部清单，因此同一 URI 同一原因的失败只记第一次，读取恢复（或确认不存在）之后再失败才再记；读不出的回合不算在内，对它回滚仍报「checkpoint 不存在」。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-checkpoint',
  provides: [checkpoint],
  subsystem: 'scheduler',
  uses: {
    storage,
    memory: optional(memory),
    contributions: optional(contributions),
    sessionManager: optional(sessionManager),
    authority: optional(authority),
    sessionFields: optional(sessionFields),
    document: optional(ownHostConfig),
    events,
    hooks,
    lifecycle,
    logger,
    config,
    provide,
  },
  apply: run,
})
```

## 配置

配置项由 `configSchema` 声明，不传时取表中默认值。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `rootDir` | string | `'data:/checkpoints'` | 存储目录：存储 URI（默认 data:/checkpoints）。所有 checkpoint blob 和 manifest 写入此位置。 |
| `maxFileSize` | number | `10485760` | 单文件大小上限（字节）：超过此大小的文件不做内容快照，只在 manifest 里记录为 skipped。 |
| `keepSessions` | number | `20` | 保留的会话数：GC 阈值。每次提交回合后，若 session 目录数超过此值，删除最早的几个。设为 0 关闭 GC。 |
| `keepTurns` | number | `200` | 每个会话保留的回合数：每次提交回合后，这个会话的回合数超过此值就删除最早的几轮（连同备份），只能回滚最近这么多轮；没改文件、只有对话的回合也算一轮。设为 0 不限。 |
| `coverage` | select | `'ownerOnly'` | 记检查点的会话：`off` 不记，`ownerOnly` 按受众（只有你时记），`all` 记；可按会话设，见下文 |

`rootDir` 的显式错误类型或非 storage URI 会在插件注册服务前拒绝；留空仍取默认目录。

`coverage` 是可按会话覆盖的字段（[api-session-settings](../api/api-session-settings.md)，只有 owner 能改），各种会话都适用：全局层是这里的插件配置，另可按平台档、平台类型档、场所与单个会话设，每一轮按会话现读，改了不重载插件。选项在哪一层读都是字面意思：在某个群的场所层选「记」，就是这个群记。会话设置不在场时只取插件配置里的值。

按受众（默认）看会话的房间类别（[api-session-manager](../api/api-session-manager.md) 的 `roomClass`，子会话取根会话的），为 `owner-only` 才记：WebUI 与终端的会话、owner 自己的 IM 私聊记，群与别人的私聊不记。按会话判，不看这一轮从哪个入口进来：owner 从 WebUI 发进群的那一轮也不记。owner 判定取权限服务的 `isOwner`，权限服务不在时没有人是 owner（owner 的 IM 私聊不记，WebUI 与终端的会话照记）；会话管理不在时判不出房间类别，一律不记。

## 相关

- 存储服务与 URI 语法：[services/storage.md](../services/storage.md)、[concepts/storage-uri-grammar.md](../concepts/storage-uri-grammar.md)
- 记忆服务（对话回滚依赖）：[services/memory.md](../services/memory.md)
- 会话服务（回滚的入口 `turn/rewind`）：[plugin-session-server.md](./plugin-session-server.md)

## 拆卸顺序

`storage` 声明为 required，不只是因为快照要经它落盘，更是为了关停次序。关停以激活为单位分 drain / close：checkpoint 对 storage 是普通依赖，消费者整个 close 完提供者才 drain，因此 `lifecycle.use.onDispose` 里的 `flushAll()` 仍能调 `storage.use.writeFile`。单独禁用或热重载 storage 时本插件作为正在用它的 required 下游并入同一批先关，`flushAll` 同样能落盘。依赖交接放 `onDrain`；本插件冲刷用的是自己的依赖，放在 `onDispose` 与「消费者 close 期间依赖仍可用」一致。
