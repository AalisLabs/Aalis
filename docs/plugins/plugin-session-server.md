# plugin-session-server — 会话服务：会话协议的服务端

**包名**: `@aalis/plugin-session-server`  
**源码**: `packages/plugin-session-server/src/index.ts`  
**契约**: [api-session-protocol](../api/api-session-protocol.md)（帧、方法与推送的 zod schema，服务描述符 `sessionProtocol`）、[api-approval](../api/api-approval.md)（审批，服务描述符 `approvals`）

## 概述

owner 的客户端经传输层（WebUI 的 WebSocket 端点 `/session`，见 [plugin-webui-server](./plugin-webui-server.md#session-会话协议)）接到 `sessionProtocol.connect`，本插件处理这条连接上的帧：握手、按方法表校验参数并分派、写错误帧、推送增量。会话本身都在 [session-manager](./plugin-session-manager.md) 里，本插件只做投影与转发，只认宿主契约、不认具体插件（守卫见 [plugin-webui-server](./plugin-webui-server.md#概述)）：

- **功能位**：握手回发送、回滚、压缩三项，分别看对话（`agent`）、检查点（`checkpoint`）、压缩（`compression`）服务在不在。这三个服务可能变了（核心的 `service:changed` 通知）、功能位变了时给每条连接推 `features/changed`；握手时现取，不用推过的那份。
- **应用名**：握手另回宿主配置文档里的 `name`（`host-config` 服务），每次握手现读，改名之后新的连接就拿到新名字；没有宿主配置时是 `Aalis`。
- **会话列表**：把会话表投影成摘要，按根会话的种类（`SessionInfo.kind`）分「我的」与房间两区，房间按接管它的适配器实例（`SessionInfo.originInstance`）分组，标出需要我处理（有推出、还没结的审批）、出错、完成未读、运行中。缺省不列已归档的，`archived` 只列已归档的；`instance`、`platform` 只列一组房间。组名是实例的显示名：插件定义的 `displayName`（没有时用包名），非默认实例（`<包名>:<实例名>`）另带实例名，如「OneBot 适配器（work）」；插件已不在的用实例 id，没有实例的组用平台名。排序、搜索、分页与分组的规则见契约页。
- **增量**：`sessions/watch` 之后，`session:created`、`session:updated`、`session:completed`、`session:deleted`、回合进出、审批的推出与结算、后台任务的开始、结束与删除各推一条 `sessions/changed`，带变了的会话连同各级父会话的摘要与最新的分组。
- **按会话树算的字段**：摘要的 `background` 是本会话在跑的后台任务数，加各级子会话里有回合在跑或有后台任务在跑的会话数（运行中看下文的回合登记，后台任务看 `backgroundTasks`，一批摘要只遍历一次登记表）；`tokens` 把本会话与各级子会话的 `SessionInfo.tokens` 相加；`lastTurn` 取 `SessionInfo.lastTurn` 的结局与结束时间，状态为 error 时 `reason` 取它的原因；子会话另带 `ancestors`（各级父会话的 id 与标题，根在前）；`chat` 取根会话聊天窗口的类型名与多方标记，`place` 取 session-manager 的 `placeOf` 与场所记录的显示名（窗口还没有记录时是场所键）。子会话的回合进出、任务进出、token 记账（session-manager 据 `llm:usage` 累加、发 `session:updated`）都会改父会话的摘要，所以每次推送都连同各级父会话。`sessions/list` 带 `background` 时只列 `background` 大于 0 的，不看归档。
- **运行中**：在 `agent:input:before` 中间件里登记回合，回合的 `next` 返回（含被下游拦下、出错）即撤销。同一会话按 lane 可以并行多轮，有一轮在跑就算运行中。房间只在她真的开始一轮时显示运行中。
- **会话的增删改**：`session/create`、`rename`、`archive`、`unarchive`、`delete`、`batch` 转给 session-manager。
  - 新建根会话不复制各层，配置经继承链实时生效；新建子会话复制父会话的生效配置（session-manager 的 `childConfig`，不带登记为 liveOnly 的项），因为继承链不经父会话自己的配置。
  - 归档连同子会话，单个与批量一致；恢复同样连同子会话，状态改回 `completed`（最后一轮收尾后的状态），没归档的不动。
  - 批量逐个执行：开始前就不存在的、执行出错的列进 `failed`，其余照常；删父会话时一并删掉的子会话不算失败。
- **会话设置**：设置项由各插件登记在 session-manager 上，本插件不认识具体的键。`session/config/get` 给出适用于这个会话种类的各行（只能设到场所为止的项不列）：字段、所属插件、显眼程度、可选项依赖的另一项（登记了 `dependsOn` 的）、没设时的含义（登记了 `unset` 的）、本会话的值、生效值与来源（层名），排好显眼程度与先后，`composer` 同一组最多两项、多出的退到 `common`。owner 自己的会话按入口平台选平台档：会话记下的平台（子任务建档时写入）、接管会话 id 的平台适配器，都没有时取这条连接的平台。`session/config/update` 按键写本会话的覆盖，`null` 恢复继承。`session/config/layers` 回可以设的各层与层表（取自 api-session-manager 的 `SESSION_LAYERS`，本插件不另写层表）；`layer/get`、`layer/update` 按层读写全局默认、平台档、平台类型档与场所：前三种列全部，场所按它的类别列（窗口列适用于房间的项，工作区列适用于 owner 的会话的项），各行带解析到这一层为止的生效值与来源。生效值出自全局默认或哪一层都没设的行另带 `resolved`：全局默认层由服务偏好承担的项（「模型」）此刻实际用的那一个，取自 session-manager 的 `resolvedDefaults`。给值的键不适用于这个会话种类（场所按它的类别算）时回 `invalidParams`，`null` 不受限；读写被 session-manager 拒绝（没登记的键、不合字段的值、写进本会话的只能设到场所为止的项、不合法的层、没有记录的场所键）同样回 `invalidParams`。session-manager 发 `session:config:changed`（设置项登记或撤回、某一层或某个会话的覆盖被改写、llm 服务的偏好变了或提供者上下线）时，给每条连接推 `session/config/changed`。
- **已读**：`session/markSeen` 记下 owner 看过某个会话的时刻，落在 `pluginData:/session-server/seen.json`。「我的」区的会话在她最近一次开口（`SessionInfo.lastReplyAt`）晚于这个时刻时为完成未读；房间不记未读。会话删除后丢掉它的记录。
- **订阅与条目**：`session/subscribe` 回快照，之后把 agent、工具与存档的事件拼成条目推给订阅的连接，见下文「条目从哪里来」。
- **文件句柄**：条目里她发出的文件不给存储地址，给本插件签发的句柄；传输层下发文件之前经 `resolveFile` 核验，见下文「文件句柄」。
- **历史**：`session/history` 从存档归并条目、分页，见下文「历史归并」。
- **回合控制**：`turn/send`、`turn/continue` 以连接的身份发入站消息；`turn/abort` 转给 agent；`session/compress` 调压缩服务（api-memory 的 `compression`），压完才回，没压成回错误；`turn/checkpoint`（回滚之前查这一轮执行过命令没有）与 `turn/rewind` 转给检查点；`plan/clear` 转给待办服务。
- **后台任务**：可选使用后台任务登记（api-tools 的 `backgroundTasks`），投影成协议的形状（去掉模型给的参数与工具的结果，`display` 按工具声明从参数解析，同工具卡；退出码照登记的 `exitCode` 下发）。`background/list` 列全部会话的；`background/watch` 之后按 `background:changed` 推 `background/changed`：状态与上次推出的不同（开始、结束、停止）立即推，删掉的立即推 `removes`，只有最后一行与最后输出时间变了的攒起来每秒推一次（常量 1 秒），状态变了时攒着的那次并进去。`background/output`、`background/stop` 转给登记表。`background/stopAll` 先经 agent 的 `abort` 停各级子会话在跑的回合，再经登记表的 `stop` 停本会话与各级子会话在跑的任务、等它们落定；本会话自己的回合不停。没有登记表时 list、output、stop 回 `unsupported`，watch 照常，stopAll 照样停子会话的回合。
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

- `sessionManager`：会话表、会话设置（登记的设置项、继承与各层）与增删改都经它。
- `storage`：已读记录的落点；签发文件句柄时按存储根的种类挡掉插件状态。
- `paths`：审批的审计写在家目录的 `state/audit/approvals.jsonl`。
- `memory`：历史从存档归并。
- `hooks`：`agent:input:before` 判运行中、拼出在途回合的条目；`agent:turn:after` 记下结局；`agent:reply:before` 切分重试的几版回复；`agent:tool:after` 把审批的结算、「已发到群」、「回合停止时还没结束」、退出码与转到后台的任务 id 写进工具结果的元数据；`memory:clear` 清掉消息历史之后通知订阅的客户端重新取快照。
- `plugins`：房间分组的组名取适配器实例的显示名。
- `platform`：owner 自己的会话按哪个入口平台选档。
- `agent`、`checkpoint`、`compression`、`todoList`：停止回合（含全部停止里子会话的回合）、回滚（与回滚之前查检查点）、压缩（用量条目的压缩线按会话取它的 `compressAt`）、计划的快照与清空；缺席时对应的方法回 `unsupported`，功能位对应的一项为 false，快照不带计划与压缩线。
- `authority`：判说话人、审批的发起主体与应答人是不是 owner；缺席时都不是，审批一律按发起者不能产生审批拒绝。
- `tools`：工具定义上声明的展示种类；缺席时工具卡与后台任务都没有 `display`，审批卡逐字列出全部参数。
- `backgroundTasks`：后台任务的列表、增量、取输出与停止，摘要里在跑的后台任务数，工具卡的 `taskId`；缺席时摘要只按子会话的回合算 `background`，`background/list`、`output`、`stop` 回 `unsupported`。
- `hostConfig`：握手回应里的应用名；缺席时是 `Aalis`。

没有配置项。

## 条目从哪里来

| 条目 | 来源 |
|---|---|
| `turn` | `agent:input:before` 开始一轮，`agent:turn:after` 给出结局，`next` 返回时收尾；被下游拦下、没有结局的一轮按 silent 收尾。回合条目在这一轮第一次有动静时才推出，提问（在回合开头落库）总排在它前面 |
| `reasoning`、`agent-message` | `outbound:stream` 的思考与正文增量，连续的同类增量接在同一条上；工具调用开始、定稿校验（`agent:reply:before`）与流结束时一条收尾。她这一轮的回复（`outbound:message`，`source` 为 agent）认作最后一版正文，带上模型与这一轮的 token（取消息的 `modelInfo`，与历史里取存档元数据的同一份写法）；回合里的其他出站消息（`[错误]` 等）各成一条，回合外的出站消息也各成一条 |
| `tool-call` | `agent:tool:after` 时按回合与调用的 id 在后台任务登记里找这次调用：转到了后台的，卡上带 `taskId`、元数据记下 `backgroundTask`。模型生成参数时，`outbound:stream` 的工具调用进度带着这次调用的 callId，有了工具名就推一张 generating 的卡（只有工具名），之后的进度不再推；`tool:execute` 的开始与结束（`itemId` 是 callId）把同一张卡转为 running 再收尾，开始时按工具声明的展示种类解析出 `display`；`agent:tool:after` 时从截断之前的结果里取退出码、带进 `display`，结束时不为 0 的收成 failed；`agent:tool:after` 时回合的中止信号已触发的（停止时还没结束），卡落成 aborted，结束事件不再改它；生成了却没有执行的，回合结束时收尾（回合被停止的为 aborted，其余为 failed，结果都是「没有执行」）；`tool:output` 推成输出增量，工具结束之后才到的输出不再接上；审批推出与结算时再推一次（`approvalId`、`settlement`） |
| `notice` | `session:compressing`（`compress`）；流结束标记带 `toolLimitReached` 时给 `tool-limit`；落库的宿主通知按存档推 |
| `user-message`，她发出的附件 | `inbound:message:archived`、`assistant:message:archived` 带出的存档消息，与历史归并用同一套规则，`itemId` 相同 |
| `plan` | `todo:updated`；快照从待办服务读当前计划 |
| `usage` | `token:usage`，按会话记下最近一次，分项取事件的 `parts` 原样放进条目；快照带它，还没有时订阅之后发 `token:request`。房间的请求不填平台，agent 按出生平台算，与群里真实的回合一致；其余会话填连接的入口平台，与从这条连接发起的回合一致。压缩线 `compressAt` 在推送与取快照时现取压缩服务的 `compressAt(会话, 用量事件上的平台)`，与条目的 `tokenBudget / contextWindow` 取较小者（压缩线写得比裁剪预算还高时，到裁剪预算就压缩；不按用量压缩或没有服务时不给） |

回复与回合的对应靠异步上下文：`agent:input:before` 的 `next` 在这一轮的上下文里跑，其中发出的回复与定稿校验归到这一轮，同一会话并行的几轮互不串。

**房间里没发出去的话**（`undelivered`）：

- agent 只把一轮最后的回复交给平台，工具调用之前说的话标「调用工具之前说的话不发到群里」；
- 定稿校验之后又生成了一版（重试）时，前一版标「格式校验没通过，已重试」；
- 没回复就收尾的一轮（静默、中止、出错），最近一次工具调用之后说过的话按结局标出；
- 她的回复在回合结束时看平台的送达结果（`OutgoingMessage.delivery`），没有适配器接手、平台没收下或发送出错（送达结果以拒绝结算）时标出原因；停用前或等满时限还没结果的不下结论。

owner 自己的会话不标：会话服务本身就是 owner 看她说话的地方。房间里经工具发出的消息（带 `callId`，如 `send_attachment`、`paper_send`）在平台收下后给那张工具卡标 `sentToRoom`。回合结束之后还在等送达结果的，这一轮算没收尾，见下文。

**刷新之后**，历史标出同样的结局，不给记忆服务加改消息元数据的方法：

- **工具结果的元数据**：工具结果落库之前（`agent:tool:after`），本插件把这次调用的审批结算（`approval: { id, state, source, at }`）、房间里经它发出、平台已收下的消息（`sentToRoom: true`）、回合停止时这次调用还没结束（`aborted: true`，工具上下文的中止信号此时已触发）、命令的退出码（`exitCode`）与转到后台的任务 id（`backgroundTask`）写进 `metadata`，agent 随结果落库。退出码在这里取：agent 跑完这个钩子才把过长的结果截断，截断后的结果不再是 JSON，从中取不到。发消息的工具都等过平台确认，这里只取已经到了的送达结果，不再等。
- **投递失败**：平台没收下她的回复时，适配器（onebot）在存档里记一条投递失败（`OutboundDeliveryFailed`，`metadata` 带这一轮的 `turnId` 与同一句原因）。这条记录在回复之后，可能落在更新的一页，归并时从这一页的开头往后全看。经工具发出的（带 `callId`）不算到回复上，那次调用的结果已写明。
- **推出来的**：工具调用之前说的话、重试丢掉的几版由存档的时间线推出。
- **不落库的**：没回复就收尾的一轮（静默、重复跳过）最后说的话不落库，历史里没有这几条。
- **刷新后不还原的**：时间线末尾「没有回复」「已停止」「这一轮出错了」这几行来自实时的回合条目，历史里没有回合条目，刷新后不再出现。要还原就得另开存放处与上限，且不能写进记忆存档（读存档的地方都会读到）；这几行只是提示，会话列表与摘要的 `lastTurn` 仍给出最近一轮的结局与原因。已知局限，不改。

## 快照与推送

- 快照在同一拍取定 `seq`、抄下在途条目（拷贝，读历史期间的增量不会改动它）、登记订阅；登记之后的推送先攒着，快照回应发出之后按序补发。
- 回合结束之后还在等平台送达结果的（房间里的回复、经工具发进房间的消息），这一轮算没收尾：这段时间里订阅的快照照样给出它的实时条目，迟到的送达结果按同一个 `itemId` 推出，客户端合并得上。
- 读历史时，在途回合落了库的消息（agent 落库时在元数据的 `TurnId` 记下回合）按回合排除：取快照时还没收尾、或之后才结束或开始的回合，它们的存档不进这份历史，由在途条目与推送给出。收尾的回合留到没有在读历史的快照还要据它判断为止。
- `seq` 在一次启动内递增，所有会话共用一个计数；`epoch` 每次启动换一个。
- 会话的历史被改写时推 `session/resync`，订阅这个会话的客户端重新取快照：`history:changed`（如连对话一起回滚）；`memory:clear` 清掉了消息历史（`/clear`，`types` 缺省或含 `context`；`scope` 为 `all` 时推给全部被订阅的会话）。删除会话也经 `memory:clear`，那时会话已不在，不推，删除由会话列表的增量告知。

## 历史归并

存档里的消息按顺序归并。元数据只按 schema-message 登记的键读（`WellKnownMetadataKeys`，各键谁写见 [schema-message 的「存档元数据的键」](../api/schema-message.md#存档元数据的键)），本插件自己写进工具结果元数据的几个（见下文）除外；按类型取，形状不对的项当没有：

- **提问**：正文取存档另记的发言人写的话（`SpokenContent`），没记时就是存档正文；附件取附件清单（`Attachments`）：图片、音频、视频的 `src` 是地址，文件有地址时给句柄（见下文「文件句柄」），没有地址的只给名字。存档正文里给模型看的发送者前缀、引用与附件描述不进提问。没记这两个键的旧提问按存档正文原样显示，不解析其中的文件块。说话人取自存档的元数据（`Platform`、`UserId`、`Nickname`、`Source`）。
- **通知**：`notice` 角色的消息与压缩分隔线（`event-marker`）各成一条通知，宿主通知的种类取 `HostNoticeKind`，`noticeId` 与 `facts` 取 `HostNoticeId`、`HostNoticeFacts`（事实里只认字符串与有限数的项）。实时推送的通知由同一份存档消息算出，与历史一致。其余系统消息不显示。
- **她发出的附件**：`outbound-image`、`outbound-video`、`outbound-audio`、`outbound-file` 的消息按附件引用占位符还原成只有附件的消息。图片、音频、视频的 `src` 就是引用；文件的 `src` 是句柄（见下文「文件句柄」）。文件的地址与名字先取存档时元数据里原样记下的 `SentRef`、`SentName`（占位符里的地址遇到 `]` 会截断，描述位的 `]`、`|` 换成了全角），没有时取占位符的引用与描述位，名字再没有就取地址的最后一段。
- **回复与工具调用**：同一轮里相邻的 assistant 与带 `toolCallId` 的 tool 消息成一组；回合 id（`TurnId`）不同的两条分属两组（旧存档没记回合的不分），前一轮按旧格式落库的工具调用组不会被后一轮的时间线盖掉。组里有带时间线（`segments`）的回复时，以最后这样一条为准，覆盖这一轮之前按旧格式落库的工具调用组；否则按旧格式拼：思考前置，正文与工具调用按序，工具结果按 `toolCallId` 对回它的调用。每段正文（一次模型调用说的话，重试的各版各是一段）各成一条，相邻的思考合成一条，空的不显示；组以回复收尾时，记下的模型与这一轮的 token（`ModelInfo`）挂在回复上，`TurnId` 给出条目的回合 id。
  - 工具卡的 `itemId` 是这次调用的 `callId`（时间线的 `tool_call` 段与工具结果元数据的 `CallId` 带它），与实时推送相同；旧存档没有 `callId`，回落到这一组第一条消息的 id 加序号。参数不是对象的（旧存档里模型给出的 `null`、数组等）按空参数显示。`display` 按工具现在的声明从参数与结果解析，退出码以元数据里记下的 `exitCode` 为准（没记下的，如结果落库时会话服务没在跑，从结果里取）；工具结果的元数据里记下的审批结算、`sentToRoom` 与 `backgroundTask`（还原成 `taskId`）还原到工具卡上。状态依次看：元数据记着停止时还没结束、或没有结果（重启或中断）的为 aborted，没批准的为 denied，结果带 `error` 或退出码不为 0 的为 failed，其余为 completed。
  - 房间里：最后一次工具调用之前的正文标「调用工具之前说的话不发到群里」；以回复收尾的组，回复之前、最后一次工具调用之后的几版标「格式校验没通过，已重试」；回复有这一轮的投递失败记录（`TurnId` 对得上、不带 `CallId`）时标平台没收下，原因取 `DeliveryError`。依据是 api-agent 的约定：房间里一轮只把最后一条回复交给平台。与实时推送一致。

分页从最新往前取 `limit` 条存档消息；页的开头落在一组回复与工具调用中间时往前扩到这一组的开头（同样按回合分组）。`before` 是上一页第一条存档消息的 id。

存档读回的消息先核字段：角色是字符串，正文、子分类、工具调用 id、思考是字符串，时间是有限数，元数据是对象，工具调用是 `{ id, function: { name, arguments } }` 都为字符串的数组，时间线的各段是认得的种类、字段类型对得上；没有的字段存成 `null`（MongoDB 就是这样）算没有。不对的消息（旧数据、手改或别的插件写坏的）整条不进历史、不占分页的位置，读到时记一条 warn 写明会话与条数，前后的照常归并，一条坏消息不会让整个快照或这一页取不出来；存档里的原样留着。重复的 `callId`、只有调用没有结果、断在半截的回合不算坏：它们按上面的规则照常归并，只影响自己那几条。

## 文件句柄

条目里她发出的文件（白纸成品等）给句柄，不给存储地址：客户端拿不到也构造不出任意的存储地址，按句柄只能取到这个会话里她发出的那个文件。

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
| 在场 | 审批面上身份是 owner 的客户端最近一次活动上报在 10 分钟内 |
| 重连宽限 | 等待中在场的客户端全部离开之后 30 秒 |
| 频率上限 | 同一会话 10 分钟内最多 10 张卡：排进队时就占额度，超出的发起时即拒；发起时就结算的（没人在场、发起者不能产生审批等）不算，排着没推出就结算的（回合中止、轮到它时没人在场）退还 |

四项都是代码里的具名常量，不做配置项。

- **发起时就结算的**，依次是：服务正在停止（`shutdown`）；发起回合已中止（`turn-ended`）；子任务回合（`subtask`）；类别不是 `owner`、`owner-chain`，或发起主体不是 owner（`ineligible`）；没人在场（`absent`）；超过频率上限（`rate-limit`）。这些请求不推给任何面，只记审计；带回合与调用的，工具卡照样带上结算（状态 denied），并写进工具结果的元数据。
- **排队**：同一会话一次只推出队首一张，它结算后推出下一张；推出那一刻起算 300 秒。排队期间回合中止、或轮到它时已经没人在场的，不推出、直接结算。
- **在场与结算**：身份不是 owner 的客户端（权限服务现判）不算在场，也收不到推送。推出之后，在场的客户端全部断开、上报离开、或它们最近一次活动都满 10 分钟时，起 30 秒的重连宽限：手机切到别的应用、锁屏，桌面上切一下标签页，都会让连接挂起或页面转为不可见。宽限内有客户端恢复在场（重连后重报在场），卡片照常等着并补推给它，宽限作废；满 30 秒没有恢复，推出的审批都按没人在场结算。宽限不延长 300 秒的总等待；宽限期间轮到的下一张卡照常推出、一起等宽限；宽限期间新发起的请求按发起时没人在场立即拒绝。审批面的登记撤回（登记它的插件停用）时它的客户端一并不算在场。发起回合结束（`agent:input:before` 的 `next` 返回）或中止时，它没结的审批按 cancelled 结算。
- **应答**：先答先得。应答人不是 owner 回 `forbidden`；`approvalId` 不是本服务签发的回 `not-found`，已结算的回 `approval-settled`（最近结算的 1000 个 id 记得住，更早的按不认识处理）；内容哈希是会话、回合、调用、工具与参数的 SHA-256，对不上回 `hash-mismatch`。
- **工具卡**：推出时在这一轮的工具卡上挂 `approvalId` 并再推一次；结算时带上 `settlement`（结局、来源、时刻）再推一次，没批准的状态是 denied；结算随工具结果落库，见「刷新之后」。
- **回给模型的话**：按请求的发起类别定。发起类别是 `room` 的（房间里的回合）不论什么原因都只回「需要批准的操作在这里不能执行。」，不透露 owner 的说明与文件布局；其余是固定格式「需要 owner 批准的操作没有执行。原因：…。能否再申请：…。」，原因写明没人在场、等了 300 秒没有人应答、owner 拒绝（附说明）、这一轮不是 owner 亲手发起的、子任务里的操作不转给 owner、频率上限、回合已结束或审批服务已停止。owner 自己的 QQ 私聊在会话列表里归房间区，但发起类别是 `owner`，拿到的是固定格式。
- **推送出错**：审批面的推送回调或会话列表的推送抛错时只告警，不影响结算、排队与别的接收方。
- **事实**：按工具声明的展示种类取：命令类给命令与工作目录，改文件类按声明的删、加两侧生成 diff；疑似密钥的路径与内容只给路径；没声明的工具全部参数逐字列出。规则见契约页。

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

每个结算另记一行 info 日志：「审批结算：会话 \<id>，工具 <名>，<结局>（<原因>）」，结局写批准、拒绝、过期或撤销，原因是 owner 应答或回给模型的那句原因（不带 owner 的说明）。发起时就结算的（自主回合、频率上限等）也在里面；WebUI 运行状况的日志用「审批」预设（提供审批服务的实例）看它们。

### 已知的差距

页面开着、人刚离开时，最近一次活动之后最多 10 分钟才判不在场；系统空闲时间这一路信号随多源在场再加。

## 拆卸

撤回登记之前（`lifecycle.use.onDrain`）先把没结的审批按 cancelled 结算并告诉模型（审批服务已停止），审批面还接着，结算推得到；之后到来的请求直接按同样的原因拒绝。对外登记撤回之后（`lifecycle.use.onDispose`）丢掉攒着的后台任务推送，断开全部连接，原因写「会话服务已停止」，并等排着的审计写完。传输层据此关闭底层连接，客户端重连时接到新的提供者。

## 相关

- 契约：[api-session-protocol](../api/api-session-protocol.md)、[api-approval](../api/api-approval.md)
- 会话本身：[plugin-session-manager](./plugin-session-manager.md)、[services/session-manager.md](../services/session-manager.md)
- 房间分组的数据来源：[plugin-adapter-onebot](./plugin-adapter-onebot.md)「多实例与路由」
