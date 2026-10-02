# plugin-session-server — 会话服务：会话协议的服务端

**包名**: `@aalis/plugin-session-server`  
**源码**: `packages/plugin-session-server/src/index.ts`  
**契约**: [api-session-protocol](../api/api-session-protocol.md)（帧、方法与推送的 zod schema，服务描述符 `sessionProtocol`）、[api-approval](../api/api-approval.md)（审批，服务描述符 `approvals`）

## 概述

owner 的客户端经传输层（WebUI 的 WebSocket 端点 `/session`，见 [plugin-webui-server](./plugin-webui-server.md#session-会话协议)）接到 `sessionProtocol.connect`，本插件处理这条连接上的帧：握手、按方法表校验参数并分派、写错误帧、推送增量。会话本身都在 [session-manager](./plugin-session-manager.md) 里，本插件只做投影与转发：

- **会话列表**：把会话表投影成摘要，分「我的」与房间两区，房间按接管它的适配器实例（`SessionInfo.originInstance`）分组，标出需要我处理（有推出、还没结的审批）、出错、完成未读、运行中。排序、搜索、分页与分组的规则见契约页。
- **增量**：`sessions/watch` 之后，`session:created`、`session:updated`、`session:completed`、`session:deleted` 与审批的推出、结算各推一条 `sessions/changed`，带变了的会话摘要与最新的分组。
- **运行中**：在 `agent:input:before` 中间件里登记回合，回合的 `next` 返回（含被下游拦下、出错）即撤销。同一会话按 lane 可以并行多轮，有一轮在跑就算运行中。房间只在她真的开始一轮时显示运行中。
- **会话的增删改**：`session/create`、`rename`、`archive`、`delete`、`batch` 转给 session-manager。
  - 新建根会话不复制平台档，配置经继承链实时生效；新建子会话复制父会话的生效配置（房间专属的键除外），因为继承链不经父会话自己的配置。
  - 归档连同子会话，单个与批量一致。
  - 批量逐个执行：开始前就不存在的、执行出错的列进 `failed`，其余照常；删父会话时一并删掉的子会话不算失败。
- **会话配置**：`session/config/get` 一次给出会话自己的覆盖、生效值、继承链（选档平台、受众、每一项的来源层）与可选项（人设、模型、工具分组）。owner 自己的会话按入口平台选档：会话记下的平台（子任务建档时写入）、接管会话 id 的平台适配器，都没有时取这条连接的平台。`session/config/update` 的 `null` 表示删掉这一项、恢复继承；有的存储后端会把它存成 `null`，读回的 `null` 与没写过同义，回给客户端前剥掉。
- **已读**：`session/markSeen` 记下 owner 看过某个会话的时刻，落在 `pluginData:/session-server/seen.json`。「我的」区的会话在她最近一次开口（`SessionInfo.lastReplyAt`）晚于这个时刻时为完成未读；房间不记未读。会话删除后丢掉它的记录。
- **订阅与条目**：`session/subscribe` 回快照，之后把 agent、工具与存档的事件拼成条目推给订阅的连接，见下文「条目从哪里来」。
- **历史**：`session/history` 从存档归并条目、分页，见下文「历史归并」。
- **回合控制**：`turn/send`、`turn/continue` 以连接的身份发入站消息；`turn/abort` 转给 agent；`session/compress` 发压缩请求；`turn/rewind` 转给检查点；`plan/clear` 转给待办服务。
- **审批**：提供 `approvals` 服务。审批推给在场的审批面，同一会话排队、限频，应答先答先得并核应答人与内容哈希，请求与决定成对记进审计，见下文「审批」。每条连接接入对端带来的审批面，`presence/update` 与 `approval/respond` 经它。

## 插件声明

```ts
definePlugin({
  name: '@aalis/plugin-session-server',
  displayName: '会话服务',
  subsystem: 'session',
  provides: [sessionProtocol, approvals],
  uses: {
    sessionManager,
    storage,
    paths: hostPaths,
    memory,
    hooks,
    events,
    lifecycle,
    logger,
    provide,
    platform: optional(platform),
    persona: optional(persona),
    llm: optional(llm),
    tools: optional(tools),
    agent: optional(agent),
    checkpoint: optional(checkpoint),
    todoList: optional(todoList),
    authority: optional(authority),
  },
  apply: run,
})
```

- `sessionManager`：会话表、配置继承与增删改都经它。
- `storage`：已读记录的落点。
- `paths`：审批的审计写在家目录的 `state/audit/approvals.jsonl`。
- `memory`：历史从存档归并。
- `hooks`：`agent:input:before` 判运行中、拼出在途回合的条目；`agent:turn:after` 记下结局；`agent:reply:before` 切分重试的几版回复；`memory:clear` 清掉消息历史之后通知订阅的客户端重新取快照。
- `platform`：owner 自己的会话按哪个入口平台选档。
- `persona`、`llm`、`tools`：只供会话配置列可选项，缺席即空列表。
- `agent`、`checkpoint`、`todoList`：停止回合、回滚、计划的快照与清空；缺席时对应的方法回 `unsupported`，快照不带计划。
- `authority`：判说话人、审批的发起主体与应答人是不是 owner；缺席时都不是，审批一律按发起者不能产生审批拒绝。

没有配置项。

## 条目从哪里来

| 条目 | 来源 |
|---|---|
| `turn` | `agent:input:before` 开始一轮，`agent:turn:after` 给出结局，`next` 返回时收尾；被下游拦下、没有结局的一轮按 silent 收尾。回合条目在这一轮第一次有动静时才推出，提问（在回合开头落库）总排在它前面 |
| `reasoning`、`agent-message` | `outbound:stream` 的思考与正文增量，连续的同类增量接在同一条上；工具调用开始、定稿校验（`agent:reply:before`）与流结束时一条收尾。她这一轮的回复（`outbound:message`，`source` 为 agent）认作最后一版正文，带上模型；回合里的其他出站消息（`[错误]` 等）各成一条，回合外的出站消息也各成一条 |
| `tool-call` | `tool:execute` 的开始与结束（`itemId` 是 callId），`tool:output` 推成输出增量；工具结束之后才到的输出不再接上 |
| `notice` | `session:compressing`（`compress`）；流结束标记带 `toolLimitReached` 时给 `tool-limit`；落库的宿主通知按存档推 |
| `user-message`，她发出的附件 | `inbound:message:archived`、`assistant:message:archived` 带出的存档消息，与历史归并用同一套规则，`itemId` 相同 |
| `plan` | `todo:updated`；快照从待办服务读当前计划 |
| `usage` | `token:usage`，按会话记下最近一次；快照带它，还没有时订阅之后发 `token:request`。房间的请求不填平台，agent 按出生平台算，与群里真实的回合一致；其余会话填连接的入口平台，与从这条连接发起的回合一致 |

回复与回合的对应靠异步上下文：`agent:input:before` 的 `next` 在这一轮的上下文里跑，其中发出的回复与定稿校验归到这一轮，同一会话并行的几轮互不串。

**房间里没发出去的话**（`undelivered`）：

- agent 只把一轮最后的回复交给平台，工具调用之前说的话标「调用工具之前说的话不发到群里」；
- 定稿校验之后又生成了一版（重试）时，前一版标「格式校验没通过，已重试」；
- 没回复就收尾的一轮（静默、中止、出错），最近一次工具调用之后说过的话按结局标出；
- 她的回复在回合结束时看平台的送达结果（`OutgoingMessage.delivery`），没有适配器接手、平台没收下或发送出错（送达结果以拒绝结算）时标出原因；停用前或等满时限还没结果的不下结论。

owner 自己的会话不标：会话服务本身就是 owner 看她说话的地方。房间里经工具发出的消息（带 `callId`，如 `send_attachment`、`paper_send`）在平台收下后给那张工具卡标 `sentToRoom`。

送达结果不落库：重新订阅之后，历史里只有工具调用之前那几句能从存档推出、照样标出；其余「未发出」与 `sentToRoom` 只在实时推送里。回合结束之后还在等送达结果的，这一轮算没收尾，见下文。

## 快照与推送

- 快照在同一拍取定 `seq`、抄下在途条目（拷贝，读历史期间的增量不会改动它）、登记订阅；登记之后的推送先攒着，快照回应发出之后按序补发。
- 回合结束之后还在等平台送达结果的（房间里的回复、经工具发进房间的消息），这一轮算没收尾：这段时间里订阅的快照照样给出它的实时条目，迟到的送达结果按同一个 `itemId` 推出，客户端合并得上。
- 读历史时，在途回合落了库的消息（plugin-agent 落库时在 `metadata.turnId` 记下回合）按回合排除：取快照时还没收尾、或之后才结束或开始的回合，它们的存档不进这份历史，由在途条目与推送给出。收尾的回合留到没有在读历史的快照还要据它判断为止。
- `seq` 在一次启动内递增，所有会话共用一个计数；`epoch` 每次启动换一个。
- 会话的历史被改写时推 `session/resync`，订阅这个会话的客户端重新取快照：`history:changed`（如连对话一起回滚）；`memory:clear` 清掉了消息历史（`/clear`，`types` 缺省或含 `context`；`scope` 为 `all` 时推给全部被订阅的会话）。删除会话也经 `memory:clear`，那时会话已不在，不推，删除由会话列表的增量告知。

## 历史归并

存档里的消息按顺序归并：

- **提问**：去掉文件读取插件追加的文件内容块（内联全文、大文件引用、超限、处理失败、降级等各代格式），`metadata.fileNames` 列成文件附件；说话人取自存档的元数据。
- **通知**：`notice` 角色的消息与压缩分隔线（`event-marker`）各成一条通知，宿主通知的种类取 `metadata.hostNoticeKind`。其余系统消息不显示。
- **她发出的附件**：`outbound-image`、`outbound-video`、`outbound-audio` 的消息按附件引用占位符还原成只有附件的消息。
- **回复与工具调用**：相邻的 assistant 与带 `toolCallId` 的 tool 消息成一组。组里有带时间线（`segments`）的回复时，以最后这样一条为准，覆盖之前按旧格式落库的工具调用组；否则按旧格式拼：思考前置，正文与工具调用按序，工具结果按 `toolCallId` 对回它的调用。相邻的同类正文或思考合成一条，空的不显示；组里记下的模型挂在最后一条正文上，`metadata.turnId` 给出条目的回合 id。
  - 工具卡的 `itemId` 是这次调用的 `callId`（时间线的 `tool_call` 段与工具结果的 `metadata.callId` 带它），与实时推送相同；旧存档没有 `callId`，回落到这一组第一条消息的 id 加序号。参数不是对象的（旧存档里模型给出的 `null`、数组等）按空参数显示。
  - 房间里最后一次工具调用之前的正文标「未发出」，与实时推送一致。

分页从最新往前取 `limit` 条存档消息；页的开头落在一组回复与工具调用中间时往前扩到这一组的开头。`before` 是上一页第一条存档消息的 id。

## 已读记录

文件格式是 `{ "seen": { "<会话 id>": <毫秒时间戳> } }`。

- 文件不存在时按没有记录起步。
- 内容读不懂时告警，按没有记录起步，下次记已读时覆盖。
- 读不出来（权限、存储不可用，不是文件不存在）时插件不启动：照空表落盘会覆盖原有记录。
- 落盘失败时 `session/markSeen` 回 `internalError`，不当成功。写入排队进行，文件里留下的总是最新的那份。

## 审批

契约与对象见 [api-approval](../api/api-approval.md)，协议上的样子见 [api-session-protocol](../api/api-session-protocol.md#在场与审批)。本插件的取值与做法：

| 项 | 取值 |
|---|---|
| 等待应答的时限 | 推出之后 300 秒 |
| 在场 | 审批面上身份是 owner 的客户端最近一次活动上报在 10 分钟内 |
| 频率上限 | 同一会话 10 分钟内最多 10 张卡：排进队时就占额度，超出的发起时即拒；发起时就结算的（没人在场、发起者不能产生审批等）不算，排着没推出就结算的（回合中止、轮到它时没人在场）退还 |

三项都是代码里的具名常量，不做配置项。

- **发起时就结算的**，依次是：服务正在停止（`shutdown`）；发起回合已中止（`turn-ended`）；子任务回合（`subtask`）；类别不是 `owner`、`owner-chain`，或发起主体不是 owner（`ineligible`）；没人在场（`absent`）；超过频率上限（`rate-limit`）。这些请求不推给任何面，只记审计。
- **排队**：同一会话一次只推出队首一张，它结算后推出下一张；推出那一刻起算 300 秒。排队期间回合中止、或轮到它时已经没人在场的，不推出、直接结算。
- **在场与结算**：身份不是 owner 的客户端（权限服务现判）不算在场，也收不到推送。推出之后，在场的客户端全部断开、上报离开、或它们最近一次活动都满 10 分钟时立即按没人在场结算，不等 300 秒；审批面的登记撤回（登记它的插件停用）时它的客户端一并不算在场。发起回合结束（`agent:input:before` 的 `next` 返回）或中止时，它没结的审批按 cancelled 结算。
- **应答**：先答先得。应答人不是 owner 回 `forbidden`；`approvalId` 不是本服务签发的回 `not-found`，已结算的回 `approval-settled`（最近结算的 1000 个 id 记得住，更早的按不认识处理）；内容哈希是会话、回合、调用、工具与参数的 SHA-256，对不上回 `hash-mismatch`。
- **工具卡**：推出时在这一轮的工具卡上挂 `approvalId` 并再推一次；没批准就结算的，工具卡收尾为 denied。
- **回给模型的话**：按请求的发起类别定。发起类别是 `room` 的（房间里的回合）不论什么原因都只回「需要批准的操作在这里不能执行。」，不透露 owner 的说明与文件布局；其余是固定格式「需要 owner 批准的操作没有执行。原因：…。能否再申请：…。」，原因写明没人在场、等了 300 秒没有人应答、owner 拒绝（附说明）、这一轮不是 owner 亲手发起的、子任务里的操作不转给 owner、频率上限、回合已结束或审批服务已停止。owner 自己的 QQ 私聊在会话列表里归房间区，但发起类别是 `owner`，拿到的是固定格式。
- **推送出错**：审批面的推送回调或会话列表的推送抛错时只告警，不影响结算、排队与别的接收方。
- **事实**：命令、工作目录与 file_edit、file_write、file_append 的 diff 按契约页的规则取自参数；疑似密钥的路径与内容只给路径。

### 审计

请求与决定成对追加到家目录的 `state/audit/approvals.jsonl`（经 host-paths 取家目录），每行一个 JSON 对象，同一个 `id` 的请求总在它的决定之前。不进模型上下文。

```jsonc
{ "type": "request", "id": "…", "at": 1760000000000, "sessionId": "…", "turnId": "…", "callId": "…",
  "origin": { "kind": "owner", "platform": "webui", "userId": "console" },
  "tool": "exec", "facts": { "command": "ls", "params": {} }, "contentHash": "…", "rule": "tool:exec 声明需确认" }
{ "type": "decision", "id": "…", "at": 1760000001234, "state": "approved", "source": "owner",
  "responder": { "platform": "webui", "userId": "console" },
  "surface": { "name": "webui", "plugin": "@aalis/plugin-webui-server" }, "waitedMs": 1234 }
```

- `rule` 是发起方给的命中的规则；`source` 是决定来源（见契约页的 `ApprovalSource`）。
- 只有 owner 应答的决定带 `responder`、`surface`（登记名与登记它的插件实例）与 `note`。
- `waitedMs` 从发起算起，含排队的时间。
- 追加失败只告警，审批照常进行。

### 已知的差距

页面开着、人刚离开时，最近一次活动之后最多 10 分钟才判不在场；系统空闲时间这一路信号随多源在场再加。

## 拆卸

撤回登记之前（`lifecycle.onDrain`）先把没结的审批按 cancelled 结算并告诉模型（审批服务已停止），审批面还接着，结算推得到；之后到来的请求直接按同样的原因拒绝。对外登记撤回之后（`lifecycle.onDispose`）断开全部连接，原因写「会话服务已停止」，并等排着的审计写完。传输层据此关闭底层连接，客户端重连时接到新的提供者。

## 相关

- 契约：[api-session-protocol](../api/api-session-protocol.md)、[api-approval](../api/api-approval.md)
- 会话本身：[plugin-session-manager](./plugin-session-manager.md)、[services/session-manager.md](../services/session-manager.md)
- 房间分组的数据来源：[plugin-adapter-onebot](./plugin-adapter-onebot.md)「多实例与路由」
