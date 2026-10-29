# plugin-session-server — 会话服务：会话协议的服务端

**包名**: `@aalis/plugin-session-server`  
**源码**: `packages/plugin-session-server/src/index.ts`  
**契约**: [api-session-protocol](../api/api-session-protocol.md)（帧、方法与推送的 zod schema，服务描述符 `sessionProtocol`）、[api-approval](../api/api-approval.md)（审批，服务描述符 `approvals`）

## 概述

owner 的客户端经传输层（WebUI 的 WebSocket 端点 `/session`，见 [plugin-webui-server](./plugin-webui-server.md#session-会话协议)）接到 `sessionProtocol.connect`，本插件处理这条连接上的帧：握手、按方法表校验参数并分派、写错误帧、推送增量。会话本身都在 [session-manager](./plugin-session-manager.md) 里，本插件只做投影与转发，只认宿主契约、不认具体插件（守卫见 [plugin-webui-server](./plugin-webui-server.md#概述)）：

- **功能位**：握手回发送、回滚、压缩、设置四项，分别看对话（`agent`）、检查点（`checkpoint`）、压缩（`compression`）、会话设置（`session-settings`）服务在不在。这几个服务可能变了（核心的 `service:changed` 通知）、功能位变了时给每条连接推 `features/changed`；握手时现取，不用推过的那份。
- **应用名**：握手另回宿主配置文档里的 `name`（`host-config` 服务），每次握手现读，改名之后新的连接就拿到新名字；没有宿主配置时是 `Aalis`。
- **会话列表**：把会话表投影成摘要，按根会话的种类（`SessionInfo.kind`）分「我的」与房间两区，房间按接管它的适配器实例（`SessionInfo.originInstance`）分组，标出需要我处理（本会话或各级子会话有推出、还没结的审批）、出错、完成未读、运行中。缺省不列已归档的，`archived` 只列已归档的；`instance`、`platform` 只列一组房间。组名是实例的显示名：插件定义的 `displayName`（没有时用包名），非默认实例（`<包名>:<实例名>`）另带实例名，如「OneBot 适配器（work）」；插件已不在的用实例 id，没有实例的组用平台名。排序、搜索、分页与分组的规则见契约页。
- **增量**：`sessions/watch` 之后，`session:created`、`session:updated`、`session:completed`、`session:deleted`、回合进出、审批的推出与结算、后台任务的开始、结束与删除各推一条 `sessions/changed`，带变了的会话连同各级父会话的摘要与最新的分组。
- **按会话树算的字段**：摘要的 `background` 是本会话在跑的后台任务数，加各级子会话里有回合在跑或有后台任务在跑的会话数（运行中看下文的回合登记，后台任务看 `backgroundTasks`，一批摘要只遍历一次登记表）；`tokens` 把本会话与各级子会话的 `SessionInfo.tokens` 相加；`lastTurn` 取 `SessionInfo.lastTurn` 的结局与结束时间，状态为 error 时 `reason` 取它的原因；子会话另带 `ancestors`（各级父会话的 id 与标题，根在前）；`chat` 取根会话聊天窗口的类型名与多方标记，`place` 取 session-manager 的 `placeOf` 与场所记录的显示名（窗口还没有记录时是场所键），根会话是空记录（`isUnfiled`）时不给：这类会话没有场所层。子会话的回合进出、任务进出、token 记账（session-manager 据 `llm:usage` 累加、发 `session:updated`）都会改父会话的摘要，所以每次推送都连同各级父会话。`sessions/list` 带 `background` 时只列 `background` 大于 0 的，不看归档。
- **运行中**：在 `agent:turn:before` 中间件里登记回合，回合的 `next` 返回（含被下游拦下、出错）即撤销。有一轮在跑就算运行中。房间只在她真的开始一轮时显示运行中。
- **会话的增删改**：`session/create`、`rename`、`archive`、`unarchive`、`delete`、`batch` 转给 session-manager。
  - 新建根会话不复制各层，设置经各层实时生效；带 `parentId` 新建子会话时，建之前取会话设置管理面的 `childMetadata`（父会话此刻每一项适用于子会话的生效值）并进 metadata 一次写下，入口平台按根会话取；会话设置不在时回 `unsupported`、不建。
  - 归档连同子会话，单个与批量一致；恢复同样连同子会话，状态改回 `completed`（最后一轮收尾后的状态），没归档的不动。
  - 批量逐个执行：开始前就不存在的、执行出错的列进 `failed`，其余照常；删父会话时一并删掉的子会话不算失败。
- **会话设置**：转给会话设置的管理面（[plugin-session-settings](./plugin-session-settings.md)），本插件不认识具体的项。一行的身份是 `(plugin, key)`：实例 id 与字段名。`session/config/get` 给出适用于这个会话的各行（只能设到场所为止的项不列）：字段声明（去掉函数成员）、显眼程度（`composer` 同一组最多两项、多出的退到 `common`）、本会话的值、生效值与来源（层名），没设的另带 `actual`（声明字段的插件给出的此刻实际在用的值，如没设模型时此刻用的模型），另带 `platform`：平台档按哪个平台取（房间是根会话的出生平台；其余是入口平台，按根会话取：接管根会话 id 的平台适配器，没有时取这条连接的平台）。`session/config/update` 写本会话这一层的一项，`null` 恢复继承。`session/config/layers` 回可以设的各层与层表 `order`（取自 api-session-settings 的 `SESSION_LAYERS`，本插件不另写层表）；`layer/get`、`layer/update` 按层读写全局（插件配置）、平台档、平台类型档与场所，各行带解析到这一层为止的生效值与来源。`session/config/overrides` 回一个实例的各项在全局之外写过的各处，按项分组，子会话逐个列出、带父会话。写宿主配置文档的几层落盘失败时回包另带 `unsaved`（与插件详情保存的回执同一句）。写入被拒（没有这一项、不合字段的值、不适用的项、不合法的层、没有记录的场所键）回 `invalidParams`；会话设置不在时这些方法回 `unsupported`，握手的功能位 `settings` 为假。收到 `session-settings:changed` 或宿主的 `host-config:changed` 时，给每条连接推 `session/config/changed`。
- **已读**：`session/markSeen` 记下 owner 看过某个会话的时刻，落在 `pluginData:/session-server/seen.json`。「我的」区的会话在她最近一次开口（`SessionInfo.lastReplyAt`）晚于这个时刻时为完成未读；房间不记未读。会话删除后丢掉它的记录。
- **订阅与条目**：`session/subscribe` 回快照，之后把 agent、工具与存档的事件拼成条目推给订阅的连接，见下文「条目从哪里来」。
- **文件句柄**：条目里存储里的文件不给存储地址，给本插件签发的句柄（网址的文件直接给网址）；传输层下发文件之前经 `resolveFile` 核验，见下文「文件句柄」。
- **历史**：`session/history` 从存档归并条目、分页，见下文「历史归并」。
- **回合控制**：`turn/send`、`turn/continue` 以连接的身份发入站消息，`turn/send` 的附件按文件头定种类与 data URL 的类型头（见 [api-session-protocol](../api/api-session-protocol.md)）；`turn/abort` 转给 agent（`abort(sessionId, { turnId, reason: '停止键', by: 连接身份 })`，只停在跑的一轮，排着的随即开下一轮）；`session/compress` 调压缩服务（api-memory 的 `compression`），压完才回，没压成回错误；`turn/rewind` 转给检查点；`plan/clear` 转给待办服务。
- **后台任务**：可选使用后台任务登记（api-tools 的 `backgroundTasks`），投影成协议的形状（去掉模型给的参数与工具的结果，`display` 按工具声明从参数解析，同工具卡；退出码照登记的 `exitCode` 下发）。`background/list` 列全部会话的；`background/watch` 之后按 `background:changed` 推 `background/changed`：状态与上次推出的不同（开始、结束、停止）立即推，删掉的立即推 `removes`，只有最后一行与最后输出时间变了的攒起来每秒推一次（常量 1 秒），状态变了时攒着的那次并进去。`background/output`、`background/stop` 转给登记表。`background/stopAll` 先经 agent 的 `abort(id, { queued: true, by: 连接身份 })` 停各级子会话在跑的回合、放掉它们排着的输入（只有排着的追问、没有在跑一轮的子会话同样放掉），再经登记表的 `stop` 停本会话与各级子会话在跑的任务、等它们落定；本会话自己的回合不停。没有登记表时 list、output、stop 回 `unsupported`，watch 照常，stopAll 照样停子会话的回合。
- **工具卡的展示**：工具卡与审批卡上的事实按工具定义上声明的展示种类（api-tools 的 `display`，经 tools 服务的 `getAll()` 取）从参数里逐字取出，工具返回时按声明从结果里取命令的退出码（取在 agent 截断过长的结果之前），实时条目、历史与审批共用一份解析。
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
    plugins: pluginsService,
    platform: optional(platform),
    sessionSettings: optional(sessionSettings),
    agent: optional(agent),
    checkpoint: optional(checkpoint),
    compression: optional(compression),
    todoList: optional(todoList),
    authority: optional(authority),
    tools: optional(tools),
    backgroundTasks: optional(backgroundTasks),
    hostConfig: optional(hostConfig),
  },
  apply: run,
})
```

- `sessionManager`：会话表与增删改都经它；审批按会话的根会话的机器人账号认限定了账号的接入；输入里的插话按根会话记下的聊天窗口（`originChat.multiParty`）标出。
- `sessionSettings`：会话设置的管理面：设置的各行、各层、写入与写过的各处，建子会话时写下的那一层；缺席时这些方法与建子会话回 `unsupported`。
- `storage`：已读记录的落点；签发文件句柄时按存储根的种类挡掉插件状态。
- `paths`：审批的审计写在家目录的 `state/audit/approvals.jsonl`。
- `memory`：历史从存档归并。
- `hooks`：`agent:turn:before` 判运行中、拼出在途回合的条目；`agent:turn:after` 记下结局；`agent:reply:before` 切分重试的几版回复；`agent:tool:after` 把审批的结算、「已发出」、「回合停止时还没结束」、退出码与转到后台的任务 id 写进工具结果的元数据；`memory:clear` 清掉消息历史之后通知订阅的客户端重新取快照。
- `plugins`：房间分组的组名取适配器实例的显示名。
- `platform`：没有出生平台的会话按哪个入口平台取平台档。
- `agent`、`checkpoint`、`compression`、`todoList`：停止回合（含全部停止里子会话的回合）、回滚（与回滚之前查检查点）、压缩（用量条目的压缩线按会话取它的 `compressAt`）、计划的快照与清空；缺席时对应的方法回 `unsupported`，功能位对应的一项为 false，快照不带计划与压缩线。
- `authority`：判说话人与结算的应答人是不是 owner；缺席时都不是。审批谁能批由发起方给（第一方的执行守卫用权限服务判）。
- `tools`：工具定义上声明的展示种类；缺席时工具卡与后台任务都没有 `display`，审批卡逐字列出全部参数。
- `backgroundTasks`：后台任务的列表、增量、取输出与停止，摘要里在跑的后台任务数，工具卡的 `taskId`；缺席时摘要只按子会话的回合算 `background`，`background/list`、`output`、`stop` 回 `unsupported`。
- `hostConfig`：握手回应里的应用名；缺席时是 `Aalis`。

没有配置项。

## 条目从哪里来

| 条目 | 来源 |
|---|---|
| `turn` | `agent:turn:before` 开始一轮、推出回合条目，`source` 取开轮那条输入的来源（真人消息开的没有）；`agent:turn:after` 给出结局，`next` 返回时收尾；被下游拦下、没有结局的一轮按 silent 收尾。这一轮的输入随后在 agent 的默认动作里归档、并进这一轮（见 `user-message` 一行），排在回合条目之后。历史里由 agent 写的回合记录还原（见下文「历史归并」） |
| `reasoning`、`agent-message` | `outbound:stream` 的思考与正文增量，连续的同类增量接在同一条上；工具调用开始、定稿校验（`agent:reply:before`）与流结束时一条收尾。她这一轮的回复（`outbound:message`，`source` 为 agent）认作最后一版正文，带上模型与这一轮的 token（取消息的 `modelInfo`，与历史里取存档元数据的同一份写法）；回合外她发出的消息（`source` 为 agent）各成一条 |
| `tool-call` | `agent:tool:after` 时按回合与调用的 id 在后台任务登记里找这次调用：转到了后台的，卡上带 `taskId`、元数据记下 `backgroundTask`。模型生成参数时，`outbound:stream` 的工具调用进度带着这次调用的 callId，有了工具名就推一张 generating 的卡（只有工具名），之后的进度不再推；`tool:execute` 的开始与结束（`itemId` 是 callId）把同一张卡转为 running 再收尾，开始时按工具声明的展示种类解析出 `display`；`agent:tool:after` 时从截断之前的结果里取退出码、带进 `display`，结束时不为 0 的收成 failed；`agent:tool:after` 时回合的中止信号已触发的（停止时还没结束），卡落成 aborted，结束事件不再改它；生成了却没有执行的，回合结束时收尾（回合被停止的为 aborted，其余为 failed，结果都是「没有执行」）；`tool:output` 推成输出增量，工具结束之后才到的输出不再接上；审批推出与结算时再推一次（`approvalId`、`settlement`） |
| `notice` | `session:compressing`（`compress`）；流结束标记带 `toolLimitReached` 时给 `tool-limit`；落库的宿主通知按存档推；不是她发的 `outbound:message`（`source` 不是 agent，如 `[错误]`、指令的回复、插件发的图），文字一条、每个附件各一条，回合里与回合外都是，指令的回复（`source` 为 command）为 `command-reply`，其余为 `event-marker`；附件的那几条与存档的记法一样（api-message-archive 的 `outboundAddress`、`unaddressedText`）：有地址的带这个附件（文件带名字），文字为空；没有地址的是存档记的那一句（如「[图片] 名字」），不带附件。送达之后由 plugin-message-archive 记进存档，历史里还原成同样的几条通知 |
| `user-message`，她发出的附件 | `inbound:message:archived`、`assistant:message:archived` 带出的存档消息，与历史归并用同一套规则，`itemId` 相同。存档记着回合 id 的（进了一轮的提问与通知，回合里发出的附件）带上这一轮的 `turnId`，是这个会话的回合、这一轮还没收尾时并进这一轮的条目，快照的历史跳过它、由在途条目给出；别的会话的回合 id（如发到别的会话的附件）不并进来。进了一轮的提问与通知另带进入方式与是否被点名（见下文「历史归并」） |
| `queue` | `agent:queue`：按会话记下最近一份排着与待插入的输入，整份推出；各条的说话人同提问（是不是 owner 看权限服务），文字取给人看的那句（宿主通知的 `hostNotice.text`、平台事件合成的入站的 `text`，都没有时是 `content`，去掉随它转发来的聊天记录的占位），另写附件个数。快照带当前的列表（空的不带）；本插件重载之后，到下一次 `agent:queue` 之前没有 |
| `plan` | `todo:updated`；快照从待办服务读当前计划 |
| `usage` | `token:usage`，按会话记下最近一次，分项取事件的 `parts` 原样放进条目；快照带它，还没有时订阅之后发 `token:request`。房间的请求不填平台，agent 按出生平台算，与群里真实的回合一致；其余会话填连接的入口平台，与从这条连接发起的回合一致。压缩线 `compressAt` 在推送与取快照时现取压缩服务的 `compressAt(会话, 用量事件上的平台)`，与条目的 `tokenBudget / contextWindow` 取较小者（压缩线写得比裁剪预算还高时，到裁剪预算就压缩；不按用量压缩或没有服务时不给） |

回复与回合的对应靠异步上下文：`agent:turn:before` 的 `next` 在这一轮的上下文里跑，其中发出的回复与定稿校验归到这一轮，不同会话同时在跑的几轮互不串（同一会话一轮接一轮）。

**房间里没发出去的话**（`undelivered`）：

- agent 只把一轮最后的回复交给平台，工具调用之前说的话标「调用工具之前说的话不发到房间里」；
- 定稿校验之后又生成了一版（重试）时，前一版标「格式校验没通过，已重试」；
- 没回复就收尾的一轮（静默、中止、出错），最近一次工具调用之后说过的话按结局标出；
- 她的回复在回合结束时看平台的送达结果（`OutgoingMessage.delivery`），没有适配器接手、平台没收下或发送出错（送达结果以拒绝结算）时标出原因，逐条发出停在中途的（送达结果带 `sentPieces`）标「只发出了前 K 条」，其余结果未知的（送达结果带 `unconfirmed`，可能已经送达）标「可能已经发出，没等到平台确认」；停用前或等满时限还没结果的不下结论。

owner 自己的会话与房间的子会话不标：会话服务本身就是 owner 看她说话的地方，子会话没有窗口，她在里面说的话不交给平台。房间里经工具发出的消息（带 `callId`，如 `send_attachment`、`paper_send`）在平台收下后给那张工具卡标 `sentToRoom`。回合结束之后还在等送达结果的，这一轮算没收尾，见下文。

**刷新之后**，历史标出同样的结局，不给记忆服务加改消息元数据的方法：

- **工具结果的元数据**：工具结果落库之前（`agent:tool:after`），本插件把这次调用的审批结算（`approval: { id, state, source, at }`）、房间里经它发出、平台已收下的消息（`sentToRoom: true`）、回合停止时这次调用还没结束（`aborted: true`，工具上下文的中止信号此时已触发）、命令的退出码（`exitCode`）与转到后台的任务 id（`backgroundTask`）写进 `metadata`，agent 随结果落库。退出码在这里取：agent 跑完这个钩子才把过长的结果截断，截断后的结果不再是 JSON，从中取不到。发消息的工具都等过平台确认，这里只取已经到了的送达结果，不再等。
- **投递失败**：平台没收下她的回复时，适配器（onebot）在存档里记一条投递失败（`OutboundDeliveryFailed`，`metadata` 带这一轮的 `turnId` 与同一句原因）。这条记录在回复之后，可能落在更新的一页，归并时从这一页的开头往后全看。经工具发出的（带 `callId`）不算到回复上，那次调用的结果已写明。
- **推出来的**：工具调用之前说的话、重试丢掉的几版由存档的时间线推出。
- **不落库的**：没回复就收尾的一轮（静默）最后说的话不落库，只在实时推送里，历史里没有这几条。不是她发的外发消息（指令的回复、宿主提示、插件发的附件等）在发出时推出，送达之后才记进存档：送达之前订阅的快照里没有，送达之后的历史里才有；平台没收下时只在实时推送里。房间与终端会话里的这类消息由 message-archive 记，没装它时不落库，只在实时推送里。
- **回合的结局**：agent 每一轮写回合记录（结局与来源，记在最后落库的回复上，没有回复的一轮另落一条只带记录的事件标记），历史在它之后还原成回合条目，时间线末尾的「没有回复」「已停止」「这一轮出错了」刷新后照样在。被下游拦下的一轮 agent 不写记录，它的「没有回复」只在实时推送里；没写回合记录的旧存档与第三方 agent 历史里没有回合条目。

## 快照与推送

- 快照在同一拍取定 `seq`、抄下在途条目（拷贝，读历史期间的增量不会改动它）、登记订阅；登记之后的推送先攒着，快照回应发出之后按序补发。
- 回合结束之后还在等平台送达结果的（房间里的回复、经工具发进房间的消息），这一轮算没收尾：这段时间里订阅的快照照样给出它的实时条目，迟到的送达结果按同一个 `itemId` 推出，客户端合并得上。
- 读历史时，在途回合落了库的消息（agent 落库时在元数据的 `TurnId` 记下回合）按回合排除：取快照时还没收尾、或之后才结束或开始的回合，它们的存档不进这份历史，由在途条目与推送给出。在途条目按时间并进历史（两边各自的先后不变，同一时刻历史在前）：这一轮进行期间别人说的话排在它的条目中间，与实时看到的同序。收尾之后的历史按落库的时刻排，与快照不全同序：她某一步的输出（思考、正文、工具卡，最后的回复也算）出现之后、这一步落库之前别人说的话，快照里排在这一步之后，收尾之后的历史里排在它之前（工具调用组等工具跑完、回复等写完才落库）。收尾的回合留到没有在读历史的快照还要据它判断为止。
- `seq` 在一次启动内递增，所有会话共用一个计数；`epoch` 每次启动换一个。
- 会话的历史被改写时推 `session/resync`，订阅这个会话的客户端重新取快照：`history:changed`（如连对话一起回滚）；`memory:clear` 清掉了消息历史（`/clear`，`types` 缺省或含 `context`；`scope` 为 `all` 时推给全部被订阅的会话）。删除会话也经 `memory:clear`，那时会话已不在，不推，删除由会话列表的增量告知。

## 历史归并

存档里的消息先按 [schema-message](../api/schema-message.md) 的 `groupToolCalls` 归组（夹在工具调用与结果之间的别的消息挪到这组之后），之后按这个次序归并。元数据只按 schema-message 登记的键读（`WellKnownMetadataKeys`，各键谁写见 [schema-message 的「存档元数据的键」](../api/schema-message.md#存档元数据的键)），本插件自己写进工具结果元数据的几个（见下文）除外；按类型取，形状不对的项当没有：

- **提问**：正文取存档另记的发言人写的话（`SpokenContent`），没记时就是存档正文；附件取附件清单（`Attachments`）：图片、音频、视频的 `src` 是地址，文件有地址时给句柄（见下文「文件句柄」），没有地址的只给名字。存档正文里给模型看的发送者前缀、引用与附件描述不进提问。随消息转发来的聊天记录另成 `forwards`（存档的 `Forwards`，只有给界面的事实），文字去掉它们的占位。没记这两个键的旧提问按存档正文原样显示，不解析其中的文件块。说话人取自存档的元数据（`Platform`、`UserId`、`Nickname`、`Source`）。进了一轮的提问（与通知）带回合 id（`TurnId`）、进入方式（`TurnEntry`，开轮的 `opened`、插进来的 `joined`）与是否被点名：触发类型（`TriggerType`）为 `immediate` 或 `direct` 的被点名，`interval` 的在多方房间（根会话的 `originChat.multiParty`）里是插话，其余（没经触发判定的、一对一房间里过了频率闸的）不标。
- **通知**：`notice` 角色的消息与事件标记（压缩分隔线，送达之后记下的不是她回复的外发消息）各成一条通知；只带回合记录的事件标记不成条。宿主通知的种类取 `HostNoticeKind`，`noticeId` 与 `facts` 取 `HostNoticeId`、`HostNoticeFacts`（事实里只认字符串与有限数的项）；事件标记的种类是 `event-marker`，记着来源（`Source`）是 `command` 的是指令的回复，种类为 `command-reply`，与实时推送里按出站消息的 `source` 给的一致；记着回合 id（`TurnId`，回合里发出的 `[错误]` 等）的带上这一轮的 `turnId`，与实时推送一样并进回合；`notice` 角色的消息在实时推送里也由同一份存档消息算出，与历史一致。其余系统消息不显示。
- **发出的附件**：`outbound-image`、`outbound-video`、`outbound-audio`、`outbound-file` 的消息按附件引用占位符还原：她发的（`assistant` 角色）还原成只有附件的消息，插件发的（`notice` 角色）还原成带附件的通知，种类同事件标记按 `Source` 取（`command` 的为 `command-reply`，其余为 `event-marker`），文字为空；记着回合 id 的带上这一轮的 `turnId`。图片、音频、视频的 `src` 就是引用；文件的地址是网址时 `src` 就是网址，是存储地址时给句柄（见下文「文件句柄」）。文件的地址与名字先取存档时元数据里原样记下的 `SentRef`、`SentName`（占位符里的地址遇到 `]` 会截断，描述位的 `]`、`|` 换成了全角），没有时取占位符的引用与描述位，名字再没有就取地址的最后一段。
- **回复与工具调用**：同一轮里相邻的 assistant 与带 `toolCallId` 的 tool 消息成一组；回合 id（`TurnId`）不同的两条分属两组（旧存档没记回合的不分），前一轮按旧格式落库的工具调用组不会被后一轮的时间线盖掉。组里有带时间线（`segments`）的回复时，以最后这样一条为准，覆盖这一轮之前按旧格式落库的工具调用组；否则按旧格式拼：思考前置，正文与工具调用按序，工具结果按 `toolCallId` 对回它的调用。每段正文（一次模型调用说的话，重试的各版各是一段）各成一条，相邻的思考合成一条，空的不显示；组以回复收尾时，记下的模型与这一轮的 token（`ModelInfo`）挂在回复上，`TurnId` 给出条目的回合 id。
  - 工具卡的 `itemId` 是这次调用的 `callId`（时间线的 `tool_call` 段与工具结果元数据的 `CallId` 带它），与实时推送相同；旧存档没有 `callId`，回落到这一组第一条消息的 id 加序号。参数不是对象的（旧存档里模型给出的 `null`、数组等）按空参数显示。`display` 按工具现在的声明从参数与结果解析，退出码以元数据里记下的 `exitCode` 为准（没记下的，如结果落库时会话服务没在跑，从结果里取）；工具结果的元数据里记下的审批结算、`sentToRoom` 与 `backgroundTask`（还原成 `taskId`）还原到工具卡上。状态依次看：元数据记着停止时还没结束、或没有结果（重启或中断）的为 aborted，没批准的为 denied，结果带 `error` 或退出码不为 0 的为 failed，其余为 completed。
  - 房间里（房间的子会话不算）：最后一次工具调用之前的正文标「调用工具之前说的话不发到房间里」；以回复收尾的组，回复之前、最后一次工具调用之后的几版标「格式校验没通过，已重试」；回复有这一轮的投递失败记录（`TurnId` 对得上、不带 `CallId`）时标平台没收下，原因取 `DeliveryError`，记录带 `SentPieces` 的标「只发出了前 K 条」，其余 `Unconfirmed` 列着结果未知的项的标「可能已经发出，没等到平台确认」。依据是 api-agent 的约定：房间里一轮只把最后一条回复交给平台。与实时推送一致。

- **回合**：记着回合记录（`TurnRecord`）的那条之后给出这一轮的回合条目，`itemId` 是回合 id（与实时推送相同），带结局与来源；记录形状不对的不认。

分页从最新往前取 `limit` 条存档消息（按归组挪过的次序）；页的开头落在一组回复与工具调用中间，或落在组外的工具结果上（读的这一段把它的组切开了，调用在更早的存档里）时往前扩（同样按回合分组），一组不拆在两页。`before` 是上一页第一条存档消息的 id。

存档读回的消息先核字段：角色是字符串，正文、子分类、工具调用 id、思考是字符串，时间是有限数，元数据是对象，工具调用是 `{ id, function: { name, arguments } }` 都为字符串的数组，时间线的各段是认得的种类、字段类型对得上；没有的字段存成 `null`（MongoDB 就是这样）算没有。不对的消息（旧数据、手改或别的插件写坏的）整条不进历史、不占分页的位置，读到时记一条 warn 写明会话与条数，前后的照常归并，一条坏消息不会让整个快照或这一页取不出来；存档里的原样留着。重复的 `callId`、只有调用没有结果、断在半截的回合不算坏：它们按上面的规则照常归并，只影响自己那几条。

## 文件句柄

条目里存储里的文件（她发出的白纸成品、提问带的文件等）给句柄，不给存储地址：客户端拿不到也构造不出任意的存储地址，按句柄只能取到这个会话里的那个文件。网址的文件不经句柄，直接给网址。

- **形状**：`<载荷>.<签名>`，两段都是 base64url。载荷是存储地址与文件名，签名是密钥对会话 id 与载荷的 HMAC-SHA256。核验时先认形状，再比签名（定长比较），都过了才读载荷。
- **用签名，不用服务端的表**：同一会话同一文件每次算出同一个句柄，快照与历史翻多少遍都不必记下什么，内存不随之增长。
- **重启即失效**：密钥每次启动随机生成，只在内存里，不落盘。会话服务重启（停用后重新启用、重载）之后旧句柄一律核验不过；这时 `epoch` 也变了，客户端本来就要重新订阅，快照里是新句柄。
- **不签发的**（api-storage 的 `canIssueFileHandle`，页面单元格的文件句柄同用这一条）：不是存储地址的来源（网址、data URL）、存储服务里没有的根，以及种类为 `data`、`pluginData` 的根。`data` 根映射到家目录的 `state/`，里面有 WebUI 的访问 token 与审计；`pluginData` 在 `state/plugins` 下。这些附件只有名字。owner 自己在 storage-local 里加的直通根（如指向 `/` 的 `host`）不按路径区分，种类不是这两种的照常签发。
- **核验**：`resolveFile(sessionId, handle)` 回存储地址与文件名，传输层自己读出、当附件下发（WebUI 见 [plugin-webui-server](./plugin-webui-server.md#rest-api) 的 `/api/session-file`）。会话 id 不是签发时那个的、载荷或签名改动过的、重启之前签发的，都回 `undefined`。核验不看文件还在不在，删掉的文件由传输层读取时报出。

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
| 在场 | 审批面上能批这一张、接入覆盖它的客户端最近一次活动上报在 10 分钟内，或推给它的审批还没结 |
| 重连宽限 | 按会话算：等待中覆盖这个会话推出的审批的在场客户端全部离开之后 30 秒 |
| 频率上限 | 同一会话树（根会话连同各级子会话，按所在会话的根会话算；根会话不在会话表里时按会话自己）10 分钟内合计最多 10 张卡：排进队时就占额度，超出的发起时即拒；发起时就结算的（没人在场、发起者不能产生审批等）不算，排着没推出就结算的（回合中止、轮到它时没人在场）退还 |

四项都是代码里的具名常量，不做配置项。

- **发起时就结算的**，依次是：服务正在停止（`shutdown`）；发起回合已中止（`turn-ended`）；类别不是 `hand`（续做与子任务的类别沿起它的那一轮读），或参与者里没有人能批这一张（`ineligible`，要 owner 确认的就是这一轮里没有 owner 的话）；没人在场（`absent`）；超过频率上限（`rate-limit`）。这些请求不推给任何面，只记审计；带回合与调用的，工具卡照样带上结算（状态 denied），并写进工具结果的元数据。
- **排队**：同一会话一次只推出队首一张，它结算后推出下一张（子会话与父会话各排各的，几个子任务并行时各推一张）；推出那一刻起算 300 秒，到期时刻写进审批对象的 `expiresAt`。排队期间回合中止、或轮到它时这个会话已经没人在场的，不推出、直接结算。
- **一条规则**：推给谁、算谁在场、认谁的应答都看「客户端的身份能批这一张（发起方给的 `canAnswer`，现判），且它的接入覆盖这张审批」。不限定的接入（WebUI 的连接、终端）覆盖全部；限定了群窗口的（每个窗口与发言者一份）覆盖这个窗口发起的（所在会话的根会话就是这个窗口，连同它的子会话）、不是只有 owner 能批的审批；只限定了机器人账号的（IM 私聊每个身份与机器人账号一份）只覆盖只有 owner 能批的、这一轮的参与者里有它、且所在会话的根会话的机器人账号（经会话管理按 `rootSessionOf` 取 `originChat.selfId`）是这个账号的审批，补推也只补这些。参与者审批因此不推到 owner 的 IM 私聊，发在这一轮所在的聊天里（子会话的发在根会话所在的聊天里）；只有 owner 能批的从不进群窗口。下文的「在场客户端」都只数能批、覆盖这张审批的。
- **来源链**：所在会话在根会话以下时，推出的审批对象与审计的请求行带 `chain`：从根会话往下到它的各级子会话的 id 与标题（没有标题时是会话名，与会话摘要的 `ancestors` 同一写法），不含根会话。
- **在场**：最近一次活动上报在 10 分钟内，或推给它的审批还没结，就算在场：推出的卡让它一直在场，不因它不再上报活动（终端只在按键时报）到时失效，都结了回到它最近一次活动起的 10 分钟。推着的卡让它在场时，别的会话新发起的审批同样推给它、因它算在场，所以卡接连不断时，一个没人看的面会一直算在场，每张卡最多等满 300 秒。客户端上报离开时，推给它、还没结的对它算没收到，不再因它们算在场，按整份接入算、不分哪一张：IM 私聊里一张卡推不到时上报离开，同一份接入里已送达的别的卡也按没收到算（推不到说明这条通道断了）；之后变为在场时补推，同一张再推一次（WebUI 按 id 收，不重复）。结算照旧通知推给过它、还连着的客户端。接入句柄的 `present()` 按这一条回这份接入此刻还算不算在场（只看活动与推着的卡，不看哪一张），聊天审批据它撤掉不在场的接入。
- **结算**：不能批这一张的客户端不因它算在场，也收不到它。推出之后，在场客户端全部断开或上报离开时，起 30 秒的重连宽限：手机切到别的应用、锁屏，桌面上切一下标签页，都会让连接挂起或页面转为不可见。宽限内有客户端恢复在场（重连后重报在场），卡片照常等着并补推给它；满 30 秒没有恢复，按没人在场结算。宽限按会话算，从这个会话推出的审批没有在场客户端覆盖的那一刻起，别的会话在不在宽限里不影响它。宽限不延长 300 秒的总等待；这个会话的宽限期间轮到的下一张卡照常推出、一起等宽限，不在宽限里的直接按没人在场结算；宽限期间新发起的请求按发起时没人在场立即拒绝。审批面的登记撤回（登记它的插件停用）时它的客户端一并不算在场。发起回合结束（`agent:turn:before` 的 `next` 返回）或中止时，它没结的审批按 cancelled 结算。
- **应答**：先答先得。已结算的一律回 `approval-settled`，不论接入覆盖不覆盖它（最近结算的 1000 个 id 记得住，更早的按不认识处理）；还在等的，`approvalId` 不是本服务签发的、或不归这个接入覆盖的回 `not-found`，覆盖了而应答人不能批这一张的回 `forbidden`（「应答人不能批这一张」）；内容哈希是会话、回合、调用、工具与参数的 SHA-256，对不上回 `hash-mismatch`。结算与批准的结局记下应答人（`by`）。
- **工具卡**：推出时在这一轮的工具卡上挂 `approvalId` 并再推一次；结算时带上 `settlement`（结局、来源、时刻，有人应答的另带应答人，写成说话人：平台、账号与是不是 owner）再推一次，没批准的状态是 denied；结算随工具结果落库，见「刷新之后」。
- **回给模型的话**：不论在哪个会话发起，都是固定格式「需要批准的操作没有执行。原因：…。能否再申请：…。」，原因写明没人在场、等了 300 秒没有人应答、被拒绝（附说明）、这一轮里没有 owner 的话（不能产生审批）、这个会话树的频率上限、回合已结束或审批服务已停止。不指名应答人，点到 owner 的只有「这一轮里没有 owner 的话，要 owner 确认的操作不能执行」那句；owner 在群里发起的一轮被拦时，她拒绝时写的说明与「没人在场」「等满时限」也交给模型，群里那一轮可能转述出去。
- **推送出错**：审批面的推送回调或会话列表的推送抛错时只告警，不影响结算、排队与别的接收方。
- **事实**：按工具声明的展示种类取：命令类给命令与工作目录，改文件类按声明的删、加两侧生成 diff；没声明的工具全部参数逐字列出。各审批面与审计收到的是同一份。规则见契约页。

### 审计

请求与决定成对追加到家目录的 `state/audit/approvals.jsonl`（经 host-paths 取家目录），每行一个 JSON 对象，同一个 `id` 的请求总在它的决定之前。不进模型上下文。

```jsonc
{ "type": "request", "id": "…", "at": 1760000000000, "sessionId": "…", "turnId": "…", "callId": "…",
  "origin": { "kind": "hand", "participants": [{ "platform": "webui", "userId": "console" }] },
  "tool": "exec", "facts": { "command": "ls", "params": {} }, "contentHash": "…", "rule": "tool:exec 声明需确认" }
{ "type": "decision", "id": "…", "at": 1760000001234, "state": "approved", "source": "answer",
  "responder": { "platform": "webui", "userId": "console" },
  "surface": { "name": "webui", "plugin": "@aalis/plugin-webui-server" }, "waitedMs": 1234 }
```

- `rule` 是发起方给的命中的规则；`source` 是决定来源（见契约页的 `ApprovalSource`）。
- 只有有人应答的决定带 `responder`、`surface`（登记名与登记它的插件实例）与 `note`。
- `waitedMs` 从发起算起，含排队的时间。
- 追加失败只告警，审批照常进行。

每个结算另记一行 info 日志：「审批结算：会话 \<id>，工具 <名>，<结局>（<原因>）」，结局写批准、拒绝、过期或撤销，原因是「有人应答」或回给模型的那句原因（不带应答人的说明）。发起时就结算的（自主回合、频率上限等）也在里面；WebUI 运行状况的日志用「审批」预设（提供审批服务的实例）看它们。

### 已知的差距

页面开着、人刚离开时，最近一次活动之后最多 10 分钟才判不在场；系统空闲时间这一路信号随多源在场再加。

## 拆卸

撤回登记之前（`lifecycle.use.onDrain`）先把没结的审批按 cancelled 结算并告诉模型（审批服务已停止），审批面还接着，结算推得到；之后到来的请求直接按同样的原因拒绝。对外登记撤回之后（`lifecycle.use.onDispose`）丢掉攒着的后台任务推送，断开全部连接，原因写「会话服务已停止」，并等排着的审计写完。传输层据此关闭底层连接，客户端重连时接到新的提供者。

## 相关

- 契约：[api-session-protocol](../api/api-session-protocol.md)、[api-approval](../api/api-approval.md)
- 会话本身：[plugin-session-manager](./plugin-session-manager.md)、[services/session-manager.md](../services/session-manager.md)
- 房间分组的数据来源：[plugin-adapter-onebot](./plugin-adapter-onebot.md)「多实例与路由」
