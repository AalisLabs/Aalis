# api-session-protocol — 会话协议契约（实验性）

**包名**: `@aalis/api-session-protocol`  
**源码**: `packages/api-session-protocol/src/index.ts`  
**实现**: `@aalis/plugin-session-server`

## 概述

owner 的客户端（WebUI，以后还有终端）与守护进程之间的线上格式。本包定义 JSON-RPC 2.0 帧、握手与错误码，会话列表与增量、订阅与条目、回合控制、后台任务、在场与审批的参数与结果，全部写成 zod schema，类型由 schema 推导；另有服务描述符 `sessionProtocol`（服务名 `session-protocol`）。不含实现。

- **服务端**按 `sessionMethods` 校验收到的每一帧，自己发出的帧由推导出的类型约束。
- **客户端**（含第三方前端）照着这些 schema 实现，可以直接用它们解析服务端的帧。
- **传输层**（WebUI 的 WebSocket 等）负责认证，把连接接到 `sessionProtocol.connect`。WebUI 的端点是 `/session`，连接方式与关闭码见 [plugin-webui-server](../plugins/plugin-webui-server.md#session-会话协议)。

与 [api-platform](../services/platform.md) 的分工：平台契约管 Aalis 接入外部聊天平台（连接、账号、按会话发消息），每个 IM 适配器一个实例；会话协议管 owner 自己的客户端怎么看到和操作会话，IM 房间经平台契约产生会话，owner 经会话协议看到同一批会话。

**版本**：`SESSION_PROTOCOL_VERSION` 为 `<主>.<次>`。第一版标 experimental：终端客户端接入之前允许不兼容的修改，之后只做加法，加字段升次版本。对象 schema 不拒多余的键，旧客户端读到新加的字段照常解析。

## 帧

| 帧 | schema | 说明 |
|---|---|---|
| 请求 | `RequestFrameSchema` | `{ jsonrpc: '2.0', id, method, params? }`，`params` 是对象，没有参数的方法传 `{}` 或不传 |
| 结果 | `ResultFrameSchema` | `{ jsonrpc: '2.0', id, result }`，`result` 是对象 |
| 错误 | `ErrorFrameSchema` | `{ jsonrpc: '2.0', id, error: { code, message, data? } }`；认不出请求 id 时 `id` 为 `null` |
| 通知 | `NotificationFrameSchema` | 服务端推送，`{ jsonrpc: '2.0', method, params }`，不带 id，客户端不回 |

错误的数值码见 `RPC_ERROR_CODES`：

| 键 | 码 | 用在 |
|---|---|---|
| `parseError` | -32700 | 帧不是 JSON |
| `invalidRequest` | -32600 | 不是 JSON-RPC 2.0 请求（缺 id、jsonrpc 不对、params 不是对象）；握手之前调别的方法；重复握手 |
| `methodNotFound` | -32601 | 没有这个方法 |
| `invalidParams` | -32602 | 参数不合 schema |
| `internalError` | -32603 | 服务端处理出错（如落盘失败） |
| `applicationError` | -32000 | 业务错误，原因看 `error.data.code` |

业务错误码 `error.data.code`：`not-found`（会话、审批等对象不存在）、`forbidden`（这条连接的身份不能做这件事，如不是 owner 的应答）、`conflict`、`approval-settled`（审批已经结算）、`hash-mismatch`（应答带的内容哈希对不上）、`expected-turn-mismatch`（`turn/abort` 带的回合 id 不是正在跑的那一轮）、`unsupported`（协议版本不兼容，或所需的服务不在）。

## 握手

客户端连上后先发 `initialize { protocolVersion, client: { name, version } }`，服务端回：

```ts
{
  protocolVersion: string;            // 服务端的协议版本
  experimental: true;
  server: { name: string };
  identity: { platform: string; userId: string };  // 传输层认证出的身份
  surface: string;                    // 这条连接所在审批面的登记名（webui、cli）
  features: { send: boolean; rewind: boolean; compress: boolean };  // 功能位
  appName: string;                    // 应用名
}
```

**应用名**：宿主配置文档里的 `name`（[api-host-config](./api-host-config.md)），每次握手现读，改名之后新的连接就拿到新名字，不用重启；没有宿主配置时是 `Aalis`。WebUI 的标签页标题与房间里她的回复的说话人用它。

主版本不同时回 `unsupported`，错误信息写明两边的版本，随即断开；只差次版本照常握手。握手之前的其它请求回 `invalidRequest`。

**功能位**：发送、回滚、压缩三项，分别看对话服务（agent）、检查点服务、压缩服务（api-memory 的 `compression`）在不在，界面据此决定输入框能不能用、回滚与压缩的入口出不出现。这几个服务上线或下线、功能位变了时，服务端给每条连接推 `features/changed { features }`。计划、审批、用量不在功能位里，按数据出现：有计划条目才有计划，有用量条目才有用量。

## 会话与列表

| 方法或通知 | 参数 | 结果 |
|---|---|---|
| `sessions/list` | `{ section?, parentId?, instance?, platform?, archived?, background?, query?, cursor?, limit? }` | `{ sessions: SessionSummary[], nextCursor?, groups: RoomGroup[] }` |
| `sessions/watch` | `{}` | `{}`；之后推 `sessions/changed` |
| `sessions/changed`（通知） | `{ upserts: SessionSummary[], removes: string[], groups: RoomGroup[] }` | — |
| `session/create` | `{ name?, parentId? }` | `{ session: SessionSummary }` |
| `session/rename` | `{ sessionId, title }` | `{}` |
| `session/archive` | `{ sessionId }` | `{}`，连同子会话 |
| `session/unarchive` | `{ sessionId }` | `{}`，连同子会话，恢复成最后一轮收尾后的状态；没归档的不动 |
| `session/delete` | `{ sessionId }` | `{}`，连同子会话，并清空它们的消息历史与长期记忆 |
| `session/batch` | `{ op: 'archive' \| 'delete', ids }` | `{ failed: Array<{ sessionId, message }> }` |
| `session/config/get` | `{ sessionId }` | `{ items: SettingRow[] }`，见下文「会话设置」 |
| `session/config/update` | `{ sessionId, patch }` | 同 `session/config/get` |
| `session/config/layers` | `{}` | `{ layers: SettingLayer[] }` |
| `session/config/layer/get` | `{ layer }` | `{ items: SettingRow[] }` |
| `session/config/layer/update` | `{ layer, patch }` | 同 `session/config/layer/get` |
| `session/config/changed`（通知） | `{}` | — |
| `session/markSeen` | `{ sessionId }` | `{}` |
| `features/changed`（通知） | `{ features }` | —，见「握手」的功能位 |

### 摘要

```ts
interface SessionSummary {
  id: string;
  title: string;              // 标题，没有时是会话名
  parentId?: string;
  childCount: number;
  kind: 'owner' | 'room' | 'task';  // 会话种类（api-session-manager 的 sessionKind）：task 子任务，room IM 房间（含 owner 自己的私聊），owner 其余
  section: 'owner' | 'rooms'; // 子会话归在根会话的区里
  platform?: string;          // 出生平台；owner 自己的会话没有
  instance?: string;          // 房间：接管它的适配器实例（插件实例 id）
  account?: string;           // 房间：根会话聊天窗口记下的机器人账号（originChat.selfId）
  audience?: 'owner' | 'private' | 'group';
  createdAt: number;
  updatedAt: number;          // 最后活动：会话档案最近一次变化
  lastReplyAt?: number;       // 她最近一次开口（回合结局为 replied）
  running: boolean;           // 有回合在跑
  error: boolean;             // 最近一轮出错
  unread: boolean;            // 只用于「我的」区，房间恒为 false
  attention: boolean;         // 需要我处理：有推出、还没结的审批
  archived: boolean;
  background: number;         // 在跑的后台工作数，见下文
  tokens?: { input: number; output: number };  // 本会话与各级子会话的模型调用累计的 token
  lastTurn?: { outcome: 'replied' | 'silent' | 'aborted' | 'error'; endedAt: number };  // 最近结束的一轮
  reason?: string;            // 出错时最近一轮的一句原因
  ancestors?: Array<{ id: string; title: string }>;  // 子会话才有：各级父会话，根在前
}

interface RoomGroup {
  platform: string;
  instance?: string;          // 还没记下实例的房间按平台成一组，没有 instance
  label: string;              // 组名：实例的显示名（插件显示名，非默认实例另带实例名）；没有实例的组是平台名
  rooms: number;
  accounts: number;           // 组里房间涉及的机器人账号数，多于 1 时界面在行内标出账号
  attention: number;          // 组里需要我处理的房间数
}
```

### 列表的规则

- **分区**：「我的」（`owner`）是 owner 自己的会话，房间（`rooms`）是 IM 群与私聊（根会话的种类为 `room`）。不给 `section` 时两区都列，「我的」在前。
- **排序**：「我的」区按需要我处理、出错、完成未读、运行中依次靠前，其余按最后活动从新到旧；房间按最后活动从新到旧，靠分组里的状态露出，不显示未读。
- **子会话**：不给 `parentId` 时只列根会话；给了就列它的直接子会话，按最后活动从新到旧，`section` 不起作用。父会话不存在回 `not-found`。
- **归档**：缺省不含已归档的会话；`archived: true` 只列已归档的（界面的「已归档」区），归档的子会话同样按它取。她在已归档的会话里跑一轮不会让它回到列表，只有 `session/unarchive` 才回来。
- **一组房间**：`instance` 只列这个适配器实例接管的房间，`platform` 只列这个平台还没记下实例的房间（`groups` 里没有 `instance` 的那一组），两者不同时给（同时给回 `invalidParams`）。房间表据此翻页取全一组，筛选与排序在客户端做。
- **分组**：`groups` 是没归档的房间的分组，不受分区、搜索与分页影响。组按平台排，同平台里有实例的在前（按实例 id），没记下实例的那组在后。组名 `label` 由服务端给出，客户端不按平台名或实例 id 查表。
- **后台**：`background: true` 只列 `background` 大于 0 的会话，已归档的与没归档的都列，运行状况的「正在运行」据此取；不与 `archived` 同时给（同时给回 `invalidParams`），只取 `true`。
- **搜索**：`query` 按名称、标题、id 匹配，不分大小写；也认「平台:群号」，例如 `onebot:20001` 命中 `onebot:<账号>:group:20001`。
- **分页**：`limit` 缺省 50、最大 200；`cursor` 取上一页的 `nextCursor`，没有下一页时不给。坏的 `cursor` 回 `invalidParams`。

### 按会话树算的字段

- **`background`**：本会话在跑的后台任务数（见下文「后台任务」），加各级子会话里有回合在跑、或有后台任务在跑的会话数（一个子会话算一个）。本会话自己的回合不算，那是 `running`。界面的「后台 N」取它。
- **`tokens`**：本会话与各级子会话的模型调用累计的输入与输出 token（api-session-manager 的 `SessionInfo.tokens` 按子树相加），对话、摘要、识图、转写的调用都在里面；都还没有记账时没有。
- **`lastTurn`、`reason`**：最近结束的一轮的结局与结束时间（被拦下、没有结局的一轮记为 silent）；`error` 为真时 `reason` 是那一轮的一句原因（agent 给的），没给原因的没有。子会话与根会话一样收口：出错为 error，其余为 completed，被停止的从 `lastTurn.outcome` 为 aborted 看出。
- **`ancestors`**：子会话的各级父会话的 id 与标题，根会话在前；界面的路径「父会话 › 本会话」据此逐层退回。

### 增量

`sessions/watch` 之后，会话建档、改动、完成、删除，回合开始与结束，已读变化，审批推出与结算，后台任务的开始、结束与删除，以及 token 记账，都推一条 `sessions/changed`：变了的会话连同它的各级父会话给完整摘要（父会话的 `background`、`tokens` 按子树算），删掉的给 id，另附最新的分组。建、删子会话时父会话的子会话数变了，父会话也在 `upserts` 里。推送不去重，客户端按 id 用最新一条覆盖。连接关闭即停止推送。

### 完成未读

「我的」区的会话在她最近一次开口晚于 owner 上次 `session/markSeen` 的时刻时为完成未读。已读时刻由服务端记下并持久化，换连接、换设备都一致；客户端在 owner 看过会话（打开、看到新回复）时调 `markSeen`。

### 会话设置

设置项由拥有功能的插件登记（[api-session-manager](./api-session-manager.md)），协议与客户端都不认识具体的键：每一行带 schema-config 字段，客户端按字段渲染。

```ts
interface SettingRow {
  key: string;
  field: SchemaField;              // 类型、标签、说明、默认值、校验、可选项来源（dynamicOptions）
  plugin: string;                  // 登记它的插件实例 id，「高级」里按它分组
  prominence: 'composer' | 'common' | 'advanced';
  dependsOn?: string;              // 可选项依赖的另一行的键
  unset?: string;                  // 哪一层都没设、字段又没有默认值时这一项的含义（登记方给），界面写在生效值的位置
  value?: unknown;                 // 这一层自己的值：会话的读写里是本会话的覆盖，层的读写里是这一层写的值
  effective?: unknown;             // 生效值；哪一层都没设时没有，界面按字段的默认值显示
  source?: 'session' | 'parent' | 'audience' | 'platform' | 'defaults';  // 生效值出自哪一层
}

type SettingLayer =
  | { scope: 'defaults' }
  | { scope: 'platform'; platform: string }                               // 按平台名生效，不区分适配器实例
  | { scope: 'audience'; platform: string; audience: 'group' | 'private' };
```

- **哪些行：** 会话只列适用于它的种类（`SessionSummary.kind`）的项；全局默认与平台档列全部，受众条目只列适用于房间的项。登记它的插件没装或没启用时不列，值保留。
- **排序：** `composer`、`common` 在前，`advanced` 在后；同一显眼程度按登记时给的 `order`，没给的按登记的先后排在后面。`composer` 也放进输入框旁的快捷切换，同一组最多两项，多出的已退到 `common`。
- **可选项：** 字段的 `dynamicOptions` 指向提供它的服务，客户端经 webui-server 的 `/api/models/:service` 取（人设走 `listModels()`，工具分组走 `toolGroups`）；`llm-ref` 字段按模型列表渲染。带 `dependsOn` 的行取可选项时把那一行的生效值（没有时取字段默认值）写成 JSON 放在 `dependency` 查询参数里，那一行变了就重取；例如深度思考（`llm-thinking`）按「模型」这一行取档位，回应另带 `labels`（各模型声明过的档位的名字），存着的档位不在这个模型的可选项里时按它写出名字。
- **生效值：** 哪一层都没设时依次写字段的默认值、可选项接口标了默认的那一项、`unset`。
- **选档：** 房间按出生平台与受众选档；owner 自己的会话按入口平台选档，依次取会话记下的平台、接管会话 id 的平台适配器，都没有时取这条连接的平台。继承先后：本会话、父会话（旧数据）、受众条目、平台档、全局默认。
- **写：** `patch` 里给值即写入这一层（按登记的字段校验），`null` 删掉这一项、恢复继承，没给的键不动。没登记的键、不合字段的值，以及不适用于这个会话种类的项（受众条目按房间算）回 `invalidParams`，什么都不改；`null` 不看适用范围，已经写进去的照样清得掉。层写进宿主的配置文档，保存失败时撤回、回内部错误。
- **`session/config/layers`：** 可以设的各层：全局默认总在第一个，其后按平台名，每个平台先平台档、再群与私聊的受众条目。平台档是已装适配器的平台加上配置里写过的平台（卸了适配器后还能清掉）；受众条目按适配器声明的会话类型（`sessionTypes` 里的 `group`、`private`）出，加上配置里写过的。
- **`session/config/changed`：** 插件启停使设置项增减，或某一层、某个会话的覆盖被改写时推给每条连接，不带参数；客户端重取打开着的会话的设置与快捷切换。

## 订阅与条目

| 方法或通知 | 参数 | 结果 |
|---|---|---|
| `session/subscribe` | `{ sessionId }` | 快照 `{ epoch, seq, session, items, approvals, before? }` |
| `session/unsubscribe` | `{ sessionId }` | `{}` |
| `session/history` | `{ sessionId, before?, limit? }` | `{ items, before? }` |
| `item/started`、`item/completed`（通知） | `{ sessionId, epoch, seq, item }` | — |
| `item/delta`（通知） | `{ sessionId, epoch, seq, itemId, text }` | — |
| `session/resync`（通知） | `{ sessionId, epoch, seq }` | — |

- **快照**：订阅一律先回快照，内容是最近一页历史、在途回合已产出的条目、会话当前的计划（`plan`）与最近一次用量（`usage`），以及这个会话推出、还没结的审批（`approvals`，见下文「审批」）。还没有用量时，服务端在快照之后请 agent 算一次，结果按推送到达。一条连接可以订阅多个会话；重复订阅同一个会话等于重新取快照。
- **推送与去重**：之后的推送带 `epoch`（会话服务每次启动换一个）与 `seq`。`seq` 在一个 `epoch` 内递增，同一会话的推送 `seq` 递增但不一定连续。客户端丢掉 `seq` 不大于快照的推送；`epoch` 变了就重新订阅。快照回应发出之前，这条连接收不到这个会话的推送。不按 `seq` 补发，快照本身就能从断线中恢复。
- **条目的增量与正本**：`item/started` 放入一个条目；`item/delta` 的 `text` 接在条目的流式文字后面（消息与思考的正文，`tool-call` 的输出）；`item/completed` 里的全文是唯一正本，按 `itemId` 覆盖。一次成形的条目不经 `started` 直接 `completed`；同一个条目可以再次 `completed`，例如平台的送达结果晚到。
- **历史与在途回合**：快照里的历史是已收尾回合的存档归并；取快照时还没收尾、或之后才结束或开始的回合，它落了库的消息不进这份历史，由在途条目与之后的推送给出。回合结束之后还在等平台送达结果的（房间里的回复、经工具发进房间的消息）也算没收尾，迟到的送达结果按快照里同一个 `itemId` 推出。提问、通知与她发出的附件按存档推送，与历史里同一条消息的 `itemId` 相同，两边重叠时按 `itemId` 合并。
- **`session/resync`**：会话的历史被改写（如 `turn/rewind` 连对话一起回滚、`/clear` 清掉了消息历史），之前收到的条目作废，客户端重新订阅取快照。
- **`session/history`**：取更早的一页，`before` 取快照或上一页的 `before`，缺省是最新一页。`limit` 是这一页最多归并多少条存档消息（缺省 100、最大 200）；一轮的工具调用组不拆在两页，所以一页可能略多。`before` 指向的消息已不在存档里（被回滚删掉）时回 `not-found`。

条目（`SessionItemSchema`，按 `kind` 区分）统一带 `itemId`、`at`，多数带 `turnId`：

| kind | 内容 |
|---|---|
| `user-message` | 文字、附件、说话人（平台、用户 id、昵称、注入来源、是否 owner）。文字是发言人自己写的话，附件取存档记下的附件清单（见 [schema-message 的「存档元数据的键」](./schema-message.md#存档元数据的键)）；给模型看的发送者前缀、引用与附件描述不在文字里。存档没记这两样的旧提问，文字是存档正文原样 |
| `agent-message` | 文字与附件（可以只有附件）、`model`：生成这条回复的服务商与模型，以及这一轮的 token（`promptTokens` 是这一轮最后一次调用的上下文，`completionTokens` 是这一轮各次调用的输出合计；服务商没报时没有），实时与历史里还原的一致；房间里没发出去的带 `undelivered.reason`：工具调用之前说的话（她只把一轮最后的回复发进群）、重试丢掉的那版、没回复就收尾的一轮（静默、中止、出错）里最后一次工具调用之后说的话、平台没收下或发送出错的回复 |
| `reasoning` | 思考文字 |
| `tool-call` | `itemId` 就是工具调用的 callId；存档里没记 callId 的旧数据除外，它们在历史里的 `itemId` 是别的不透明 id。工具名、参数、状态（generating、running、completed、failed、denied、aborted）、流式输出（`exec` 等）、结果、耗时；结果是带 `error` 的 JSON 对象、或 `display` 里的退出码不为 0 时为 failed。模型还在生成参数时卡片已推出，状态是 generating，只有工具名、`args` 为空；开始执行时同一个 `itemId` 转为 running。回合被停止时还没结束的调用（工具返回时回合的中止信号已触发，包括生成了还没执行的）为 aborted，停止之后工具照样返回了结果也不改；历史里没有结果的调用（重启或中断）同样为 aborted。生成了却没有执行、回合不是被停止的（达到工具调用上限、回合出错）在回合结束时以 failed 收尾；生成了却没有执行的，收尾时结果都是「没有执行」。参数不合法、执行前出错这类没有执行就失败的调用，按回给模型的错误收成 failed，历史里同样以 callId 为 id。`display` 是按工具定义上声明的展示种类解析好的展示（见下文），没声明的没有，界面走通用卡。这次调用的审批推给了审批面时带 `approvalId`（挂上时再推一次 `item/started`），结算后带 `approvalId` 与 `settlement`（再推一次），发起时就结算、没推给审批面的同样带；没批准的（拒绝、没人应答、撤销）状态是 denied。房间里经工具发出、平台收下的消息，工具卡带 `sentToRoom`。转到后台的调用带 `taskId`（后台任务的 id，见下文「后台任务」）：卡片本身以转后台时回给模型的那段结果收尾（completed），任务的状态、耗时、最后一行与输出按 `taskId` 看后台任务；后台任务登记里已经找不到的（超出保留被清掉），只画这次调用本身 |
| `notice` | 宿主事件，`topic` 区分种类：宿主通知取通知的种类（如 `paper-task`），压缩为 `compress`，存档里的压缩分隔线为 `event-marker`，达到工具调用上限为 `tool-limit`（带 `canContinue`，可以 `turn/continue`）。宿主通知另带 `noticeId`（`hostNotice.id`）与 `facts`（`hostNotice.facts`，给界面的事实，键由定义这个种类的契约约定，见 [schema-message](./schema-message.md#宿主通知-hostnotice)）。界面认得的种类按事实画成状态、不显示 `text`（写给模型的那句话），如后台任务的结束通知（[api-tools](./api-tools.md#结束通知) 的 `BACKGROUND_TASK_NOTICE`，`noticeId` 是任务 id） |
| `plan` | 待办，整份替换；每个会话一条，`itemId` 固定为 `plan` |
| `usage` | 最近一次的 token 用量与分项；每个会话一条，`itemId` 固定为 `usage`，整份替换。它不是时间线上的一条，界面画在会话头部（用量百分比与拆分表）。`parts` 是产出方给的拆分表（显示名、token 数，按显示的次序，不含为回复预留的 `maxTokens`），界面照它画行、不认分项；某一项带 `injectors` 时是它按注入者的明细，键是注入者的全局键「插件实例 id/局部 id」，界面按实例前缀合并到插件；`compressAt` 是自动压缩的使用率（与 `usageRatio` 同一口径），取压缩服务的 `autoThreshold`，没有压缩服务或不自动压缩时没有 |
| `turn` | 回合开始（`by` 是发起方）与结束（`outcome` 取 replied、silent、aborted、error；被下游拦下、没有结局的一轮为 silent）。回合条目在她这一轮第一次有动静时推出，提问总排在它前面；历史里没有回合条目，其余条目带 `turnId` |

附件（`ItemAttachmentSchema`）有 `kind`、`src`、`name`。`src`：图片、音频、视频是媒体地址（存储地址或网址），其他文件是会话服务签发的不透明句柄。取不到可下载的来源时没有 `src`，只有名字，例如入站时只有内联数据、没有落盘的上传。

**文件句柄**：

- **形状**：只含字母、数字、`-`、`_` 与一个 `.` 的字符串。客户端不解析它，原样拿去下载。
- **取法**：经传输层给的下载入口取，WebUI 是 `GET /api/session-file?sessionId=<会话 id>&handle=<句柄>`（见 [plugin-webui-server](../plugins/plugin-webui-server.md#rest-api)），一律以附件、`application/octet-stream` 下发。
- **有效范围**：句柄绑定签发它的会话与文件，换个会话 id 用不了；只在签发它的那次启动（同一个 `epoch`）内有效，会话服务重启之后 `epoch` 变了，客户端重新订阅，快照里是新的句柄。
- **不签发的**：插件状态与插件私有数据的存储根（`data` 映射到家目录的 `state/`，里面有访问 token 与审计）里的文件、不是存储地址的来源。这些附件只有名字。

**工具卡的展示**（`display`，按 `kind` 区分）：种类是宿主维护的封闭集合，以后按加法加。各项从参数里逐字取出，命令的退出码从结果里取：

```ts
type ToolDisplay =
  | { kind: 'command'; command: string; cwd?: string; exitCode?: number }    // 命令、工作目录与结果里的退出码
  | { kind: 'file-change'; path: string; removed?: string; added?: string }; // 路径与删、加两侧的文本
```

工具没声明、种类不认识、声明的命令或路径不是字符串时没有 `display`。`exitCode` 只在工具声明了退出码取自结果的哪个键（api-tools 的 `ToolDisplay.result`）、调用已结束、结果是 JSON 对象且那一项是整数时才有。

**审批的结算**（`settlement`，与 `approval/settled` 同形）：

```ts
interface ApprovalSettlement {
  state: 'approved' | 'denied' | 'expired' | 'cancelled';
  source: 'owner' | 'absent' | 'timeout' | 'ineligible' | 'subtask' | 'rate-limit' | 'turn-ended' | 'shutdown';
  at: number;   // 结算的时刻
}
```

**刷新之后**：历史与实时推送标出同样的结局。

- **工具结果的元数据**：会话服务在工具结果落库之前（agent 的 `agent:tool:after` 钩子），把审批的结算、「平台已收下经它发出的消息」、「回合停止时这次调用还没结束」、命令的退出码与转到后台的任务 id 写进这次结果的元数据，历史里的工具卡据此带上 `approvalId`、`settlement`、`sentToRoom`、`taskId`，状态为 aborted，`display` 带上退出码（结果过长时 agent 落库的是截断后的结果，从中取不到）。
- **投递失败**：回复平台没收下时，适配器在存档里记一条投递失败（schema-message 的 `OutboundDeliveryFailed`，带这一轮的 `turnId`），历史据此给那一轮的回复标 `undelivered`。
- **重试与工具调用之前**：重试丢掉的几版与工具调用之前说的话由存档的时间线推出，历史里同样标 `undelivered`。
- **不落库的**：没回复就收尾的一轮（静默、重复跳过）最后说的话不落库，只在实时推送里，历史里没有这几条。
- **发起时就被拒的审批**：发起时没人在场、发起者不能产生审批、子任务、超过频率上限，审批没推给审批面，工具卡照样带 `approvalId` 与 `settlement`、状态是 denied，结算同样写进工具结果的元数据；不推 `approval/requested`，不算「需要我处理」。

## 回合控制

| 方法 | 参数 | 结果 |
|---|---|---|
| `turn/send` | `{ sessionId, content, attachments? }` | `{}`；以连接的身份发一条入站消息，网关收下就回，回合的进展经条目推送。文字去掉首尾空白；只有附件、没写文字的照常发出，两者都空（含只有空白）的不合参数 |
| `turn/continue` | `{ sessionId }` | `{}`；工具调用达到上限后请她接着做 |
| `turn/abort` | `{ sessionId, turnId? }` | `{}`；不带 `turnId` 停这个会话所有在跑的回合，带 `turnId` 时只停那一轮，对不上回 `expected-turn-mismatch` |
| `session/compress` | `{ sessionId }` | `{}`；调压缩服务，压完才回，进度以 `compress` 通知推送，之后推最新用量。没压成（摘要模型不在或失败、期间会话被清空）回 `internalError`，错误信息写明原因，压缩通知同样写明失败；这个会话正在压缩或生成摘要时直接拒绝，同样回 `internalError`，时间线上没有新的通知 |
| `turn/checkpoint` | `{ sessionId, turnId }` | `{ execUsed: boolean }`；回滚之前查这一轮的检查点：为真表示这一轮执行过命令（`exec` 等直接起子进程的工具），命令的效果不经存储，回滚撤不回，界面在回滚确认里写明。没有这一轮的检查点时为 false |
| `turn/rewind` | `{ sessionId, turnId, scope: 'code' \| 'code-and-chat' }` | 回滚结果，字段同 [api-checkpoint](./api-checkpoint.md) 的 `RollbackResult`，连对话一起回滚时另有 `deletedMessages`、`chatDeleted`；回合 id 就是 agent 的 `turnId`。检查点只按已提交（收尾）的回合回滚，在跑的回合没有可回滚的清单；界面只在这个会话没有回合在跑时，给已收尾的回合出回滚入口 |
| `plan/clear` | `{ sessionId }` | `{}` |

发给 agent 的附件（`OutgoingAttachmentSchema`）的 `data` 是 data URL。所需的服务（agent、检查点、压缩、待办）不在时，`turn/abort`、`turn/checkpoint`、`turn/rewind`、`session/compress`、`plan/clear` 回 `unsupported`。

## 后台任务

在后台替 owner 跑着的东西：现在是转到后台的工具调用（声明了可转后台的工具在前台等满让出时限还没结束，或模型要求立即转后台，见 [api-tools](./api-tools.md#后台任务登记)）。各级子会话的回合不在这里，它们来自会话树（`sessions/list` 带 `parentId` 按层取，摘要的 `background` 已算进去）。

| 方法或通知 | 参数 | 结果 |
|---|---|---|
| `background/list` | `{}` | `{ tasks: BackgroundTask[] }`：全部会话在跑的与保留的结束的任务（每个会话留最近 20 条结束的），已归档的会话的也在 |
| `background/watch` | `{}` | `{}`；之后推 `background/changed` |
| `background/changed`（通知） | `{ upserts: BackgroundTask[], removes: string[] }` | — |
| `background/output` | `{ taskId, after? }` | `{ text, end, truncated }`：`text` 是 `after` 之后的输出，`end` 是至今的输出总字数，下次带作 `after` 只取新增的；缓冲只留末尾，`after` 早于缓冲的开头时 `truncated` 为真。Aalis 重启之前的任务没有留下输出 |
| `background/stop` | `{ taskId }` | `{}`；中止它并等它落定（最多几秒）才回，状态经 `background/changed` 推出（`stopped`）。被停止的不给她发结束通知 |
| `background/stopAll` | `{ sessionId }` | `{}`；停掉这个会话下面的全部后台工作：各级子会话在跑的回合，本会话与各级子会话在跑的后台任务，等任务落定才回。本会话自己的回合不停（那是 `turn/abort`） |

```ts
interface BackgroundTask {
  id: string;
  sessionId: string;
  kind: 'tool-call';          // 宿主维护的封闭集合，以后按加法加
  label: string;              // 显示名：工具调用是工具名
  call?: { tool: string; turnId: string; callId: string };  // tool-call 才有；callId 就是工具卡的 itemId
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'aborted';
  startedAt: number;
  endedAt?: number;
  lastLine?: string;          // 输出的最后一行
  lastOutputAt?: number;      // 最后一次有输出的时刻
  reason?: string;            // 失败或中断的一句原因
  exitCode?: number;          // 命令的退出码（取自登记，工具撤回登记、Aalis 重启之后照样在）
  display?: ToolDisplay;      // 同工具卡：按工具声明的展示种类从参数解析，不带退出码
}
```

- **状态**：失败是结果带 `error` 或退出码不为 0；被停止是经 `background/stop`、`background/stopAll` 或模型自己停的；被中断是工具撤回登记、工具注册表停用或 Aalis 重启时还在跑的。界面只画推送来的状态：按了停止之后等推送，不先自行标成已停止。
- **不下发的**：模型给的参数与工具的结果都不下发。`display` 按工具现在的声明从参数解析，工具已撤回登记时没有；退出码在 `exitCode`，取自后台任务登记（随登记落盘），不随工具在不在。
- **推送的节拍**：开始、结束、停止与删除立即推；只有最后一行与最后输出时间变了的攒起来，每秒至多推一次；状态变了时，攒着的那次并进这一次。删掉的（会话删除、超出保留）在 `removes` 里。`background/watch` 不依赖后台任务登记在不在，登记晚些上线时照样推。
- **服务不在**：没有后台任务登记时，`background/list`、`background/output`、`background/stop` 回 `unsupported`；`background/stopAll` 照样停子会话的回合。子会话有回合在跑、对话服务却停不了回合时，`background/stopAll` 回 `unsupported`，什么都不停。任务不认识回 `not-found`，会话不存在回 `not-found`。

## 在场与审批

需要 owner 批准的工具调用以审批对象的形式出现，对象与规则见 [api-approval](./api-approval.md)。每条连接都在它所在的审批面上（传输层登记的那一个，握手回它的登记名）；在场上报与应答都记在这个审批面的登记身份名下，连接自己报不了别的面。

| 方法或通知 | 参数 | 结果 |
|---|---|---|
| `presence/update` | `{ active }` | `{}` |
| `approval/requested`（通知） | `{ approval: Approval }` | — |
| `approval/settled`（通知） | `{ approvalId, state, source, at }`：结局（`approved`、`denied`、`expired`、`cancelled`）、从哪里来与结算的时刻，同工具卡上的 `settlement` | — |
| `approval/respond` | `{ approvalId, decision: 'approve' \| 'deny', contentHash, note? }` | `{}` |

- **在场**：`active` 为真表示页面可见且刚有键盘或指针活动，为假表示页面转到后台，即刻不在场。最近一次为真的上报在 10 分钟内即算在场，所以客户端在有活动时按需重报（例如节流到每分钟一次），页面转到后台时报一次假。从没上报过的连接不算在场。
- **推送**：审批推出时，`approval/requested` 推给在场、身份是 owner 的连接，不要求这条连接订阅了那个会话；不在场的连接变为在场时补推还没结的。结算时 `approval/settled` 推给拿到过这条请求的连接。订阅了会话的连接另从快照的 `approvals` 与工具卡的 `approvalId`、`settlement` 看到它。
- **重连宽限**：等待中在场的连接全部断开或转为不在场时，审批不立即结算：30 秒内有连接恢复在场（重连后重报在场），卡片照常等着并推给它；满 30 秒没有恢复，按没人在场（`absent`）结算。宽限不延长 300 秒的总等待。发起时就没人在场的仍立即拒绝。
- **应答**：先答先得。服务端核两项：应答人（这条连接的身份）是 owner，否则 `forbidden`；`approvalId` 是本服务签发的、还没结算（不认识回 `not-found`，已结算回 `approval-settled`），并且 `contentHash` 与审批对象的一致（否则 `hash-mismatch`）。审批服务不在时回 `unsupported`。`note` 是说明，拒绝时回给模型。
- **显示**：`facts` 是逐字的参数，可能带控制符、双向控制符与零宽字符。卡片显示之前一律经 api-approval 的 `sanitizeForCard` 清洗。

```ts
interface Approval {
  id: string;
  sessionId: string;
  turnId?: string;
  callId?: string;            // 工具卡的 itemId
  origin: { kind: 'owner' | 'owner-chain' | 'subtask' | 'autonomous' | 'room' | 'other'; platform: string; userId?: string };
  target: 'tool';
  tool: string;
  facts: { command?: string; cwd?: string; diff?: { path: string; patch?: string }; params: Record<string, unknown> };
  options: Array<'approve' | 'deny'>;
  contentHash: string;        // 应答时原样带回
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
}
```

## 服务接口

```ts
interface SessionPeer {
  identity: { platform: string; userId: string };
  surface: ApprovalSurface;            // 传输层经 approvals.registerSurface 登记得到的审批面句柄
  disconnect(reason: string): void;    // 服务端要断开这条连接时调用
}

interface SessionConnection {
  receive(frame: string): Promise<void>;  // 这一帧处理完、回应已发出时落定，不会被拒
  close(): void;                          // 底层连接已关闭
}

interface SessionProtocolService {
  connect(peer: SessionPeer, send: (frame: string) => void): SessionConnection;
  /** 核验文件句柄：这次启动内为这个会话签发的，回存储地址与文件名，否则 undefined */
  resolveFile(sessionId: string, handle: string): { uri: string; name: string } | undefined;
}
```

传输层下发文件之前调 `resolveFile`：伪造的、改动过的、别的会话的、会话服务重启之前签发的句柄回 `undefined`。核验出的存储地址由传输层自己读出，当附件下发，不按存储地址提供任意读取。

服务端在两种情况下调 `disconnect`：握手时主版本不合（回完错误帧之后）；会话服务停止或重载（客户端重连时接到新的提供者）。原因的长度不设上限（主版本不合时原样带着客户端报的版本号），传输层的关闭原因有长度限制的（WebSocket 的关闭帧最多 123 字节）自己截短。

## 使用

传输层登记自己的审批面，把一条已认证的 WebSocket 接到会话协议：

```ts
import { approvals } from '@aalis/api-approval';
import { sessionProtocol } from '@aalis/api-session-protocol';
import { definePlugin, optional } from '@aalis/core';

export default definePlugin({
  name: '@acme/plugin-example-transport',
  uses: { sessionProtocol: optional(sessionProtocol), approvals: optional(approvals) },
  apply({ sessionProtocol, approvals }) {
    const surface = approvals.registerSurface('webui');
    function accept(socket: WebSocketLike, identity: { platform: string; userId: string }) {
      const service = sessionProtocol.current;
      if (!service) return socket.close(1013, '会话服务不在');
      const conn = service.connect(
        { identity, surface, disconnect: reason => socket.close(1000, reason) },
        frame => socket.send(frame),
      );
      socket.on('message', data => void conn.receive(String(data)));
      socket.on('close', () => conn.close());
    }
  },
});
```

客户端用 schema 解析服务端的帧：

```ts
import { sessionMethods, sessionNotifications } from '@aalis/api-session-protocol';

const page = sessionMethods['sessions/list'].result.parse(reply.result);
const change = sessionNotifications['sessions/changed'].parse(frame.params);
```

## 实现者列表

- [@aalis/plugin-session-server](../plugins/plugin-session-server.md)
