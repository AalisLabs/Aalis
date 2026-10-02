# api-session-protocol — 会话协议契约（实验性）

**包名**: `@aalis/api-session-protocol`  
**源码**: `packages/api-session-protocol/src/index.ts`  
**实现**: `@aalis/plugin-session-server`

## 概述

owner 的客户端（WebUI，以后还有终端）与守护进程之间的线上格式。本包定义 JSON-RPC 2.0 帧、握手与错误码，会话列表与增量、订阅与条目、回合控制、在场与审批的参数与结果，全部写成 zod schema，类型由 schema 推导；另有服务描述符 `sessionProtocol`（服务名 `session-protocol`）。不含实现。

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
}
```

主版本不同时回 `unsupported`，错误信息写明两边的版本，随即断开；只差次版本照常握手。握手之前的其它请求回 `invalidRequest`。

## 会话与列表

| 方法或通知 | 参数 | 结果 |
|---|---|---|
| `sessions/list` | `{ section?, parentId?, query?, cursor?, limit? }` | `{ sessions: SessionSummary[], nextCursor?, groups: RoomGroup[] }` |
| `sessions/watch` | `{}` | `{}`；之后推 `sessions/changed` |
| `sessions/changed`（通知） | `{ upserts: SessionSummary[], removes: string[], groups: RoomGroup[] }` | — |
| `session/create` | `{ name?, parentId? }` | `{ session: SessionSummary }` |
| `session/rename` | `{ sessionId, title }` | `{}` |
| `session/archive` | `{ sessionId }` | `{}`，连同子会话 |
| `session/delete` | `{ sessionId }` | `{}`，连同子会话，并清空它们的消息历史与长期记忆 |
| `session/batch` | `{ op: 'archive' \| 'delete', ids }` | `{ failed: Array<{ sessionId, message }> }` |
| `session/config/get` | `{ sessionId }` | 见下文「会话配置」 |
| `session/config/update` | `{ sessionId, patch }` | 同 `session/config/get` |
| `session/markSeen` | `{ sessionId }` | `{}` |

### 摘要

```ts
interface SessionSummary {
  id: string;
  title: string;              // 标题，没有时是会话名
  parentId?: string;
  childCount: number;
  kind: 'room' | 'task';      // task 为子任务
  section: 'owner' | 'rooms'; // 子会话归在根会话的区里
  platform?: string;          // 出生平台；owner 自己的会话没有
  instance?: string;          // 房间：接管它的适配器实例（插件实例 id）
  account?: string;           // 房间：会话 id 第二段，即机器人账号
  audience?: 'owner' | 'private' | 'group';
  createdAt: number;
  updatedAt: number;          // 最后活动：会话档案最近一次变化
  lastReplyAt?: number;       // 她最近一次开口（回合结局为 replied）
  running: boolean;           // 有回合在跑
  error: boolean;             // 最近一轮出错
  unread: boolean;            // 只用于「我的」区，房间恒为 false
  attention: boolean;         // 需要我处理：有推出、还没结的审批
  archived: boolean;
  paper?: boolean;            // 房间：生效配置是否开着白纸
}

interface RoomGroup {
  platform: string;
  instance?: string;          // 还没记下实例的房间按平台成一组，没有 instance
  rooms: number;
  accounts: number;           // 组里房间涉及的机器人账号数，多于 1 时界面在行内标出账号
  attention: number;          // 组里需要我处理的房间数
}
```

### 列表的规则

- **分区**：「我的」（`owner`）是 owner 自己的会话，房间（`rooms`）是 IM 群与私聊。不给 `section` 时两区都列，「我的」在前。
- **排序**：「我的」区按需要我处理、出错、完成未读、运行中依次靠前，其余按最后活动从新到旧；房间按最后活动从新到旧，靠分组里的状态露出，不显示未读。
- **子会话**：不给 `parentId` 时只列根会话；给了就列它的直接子会话，按最后活动从新到旧，`section` 不起作用。父会话不存在回 `not-found`。
- **分组**：`groups` 是全部房间的分组，不受分区、搜索与分页影响。组按平台排，同平台里有实例的在前（按实例 id），没记下实例的那组在后。
- **搜索**：`query` 按名称、标题、id 匹配，不分大小写；也认「平台:群号」，例如 `onebot:20001` 命中 `onebot:<账号>:group:20001`。
- **分页**：`limit` 缺省 50、最大 200；`cursor` 取上一页的 `nextCursor`，没有下一页时不给。坏的 `cursor` 回 `invalidParams`。

### 增量

`sessions/watch` 之后，会话建档、改动、完成、删除，回合开始与结束，已读变化，以及审批推出与结算，都推一条 `sessions/changed`：变了的会话给完整摘要，删掉的给 id，另附最新的分组。建、删子会话时父会话的子会话数变了，父会话也在 `upserts` 里。推送不去重，客户端按 id 用最新一条覆盖。连接关闭即停止推送。

### 完成未读

「我的」区的会话在她最近一次开口晚于 owner 上次 `session/markSeen` 的时刻时为完成未读。已读时刻由服务端记下并持久化，换连接、换设备都一致；客户端在 owner 看过会话（打开、看到新回复）时调 `markSeen`。

### 会话配置

```ts
{
  config: SessionConfig;           // 会话自己的覆盖，另含 sessionDefaults
  effective: SessionConfigValues;  // 生效值：继承值叠上会话自己的覆盖
  inheritance: {
    platform?: string;             // 选档用的平台
    audience?: 'private' | 'group';
    values: SessionConfigValues;   // 继承值
    sources: Partial<Record<键, 'defaults' | 'platform' | 'audience' | 'parent'>>;
  };
  options: {
    personas: string[];
    models: Array<{ provider: string; model: string; capabilities: string[] }>;
    toolGroups: Array<{ name: string; label: string }>;
  };
}
```

配置的各项与 [api-session-manager](./api-session-manager.md) 的 `SessionConfig` 同义。房间按出生平台与受众选档；owner 自己的会话按入口平台选档，依次取会话记下的平台、接管会话 id 的平台适配器，都没有时取这条连接的平台。

`session/config/update` 的 `patch` 里给值即写成会话自己的覆盖，`null` 删掉这一项、恢复继承，没给的键不动。

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
| `user-message` | 文字、附件、说话人（平台、用户 id、昵称、注入来源、是否 owner）。文字是存档里的原文，多人平台带说话人前缀，附带的文件内容块已剥掉、文件名列成附件 |
| `agent-message` | 文字与附件（可以只有附件）、模型；房间里没发出去的带 `undelivered.reason`：工具调用之前说的话（她只把一轮最后的回复发进群）、重试丢掉的那版、没回复就收尾的一轮（静默、中止、出错）里最后一次工具调用之后说的话、平台没收下或发送出错的回复 |
| `reasoning` | 思考文字 |
| `tool-call` | `itemId` 就是工具调用的 callId；存档里没记 callId 的旧数据与参数没解析成、没有执行的调用除外，它们在历史里的 `itemId` 是别的不透明 id。工具名、参数、状态（running、completed、failed、denied）、流式输出（`exec` 等）、结果、耗时；结果是带 `error` 的 JSON 对象时为 failed。这次调用要 owner 批准时带 `approvalId`（挂上时再推一次 `item/started`），没批准就结算的（拒绝、没人应答、撤销）收尾为 denied。房间里经工具发出、平台收下的消息，工具卡带 `sentToRoom` |
| `notice` | 宿主事件，`topic` 区分种类：宿主通知取通知的种类（如 `paper-task`），压缩为 `compress`，存档里的压缩分隔线为 `event-marker`，达到工具调用上限为 `tool-limit`（带 `canContinue`，可以 `turn/continue`） |
| `plan` | 待办，整份替换；每个会话一条，`itemId` 固定为 `plan` |
| `usage` | 最近一次的 token 用量与分项；每个会话一条，`itemId` 固定为 `usage` |
| `turn` | 回合开始（`by` 是发起方）与结束（`outcome` 取 replied、silent、aborted、error；被下游拦下、没有结局的一轮为 silent）。回合条目在她这一轮第一次有动静时推出，提问总排在它前面；历史里没有回合条目，其余条目带 `turnId` |

附件（`ItemAttachmentSchema`）有 `kind`、`src`、`name`。`src`：图片、音频、视频是媒体地址（存储地址或网址），其他文件是会话服务签发的不透明句柄。取不到可下载的来源时没有 `src`，只有名字，例如存档只记了文件名的用户上传。

**文件句柄**：

- **形状**：只含字母、数字、`-`、`_` 与一个 `.` 的字符串。客户端不解析它，原样拿去下载。
- **取法**：经传输层给的下载入口取，WebUI 是 `GET /api/session-file?sessionId=<会话 id>&handle=<句柄>`（见 [plugin-webui-server](../plugins/plugin-webui-server.md#rest-api)），一律以附件、`application/octet-stream` 下发。
- **有效范围**：句柄绑定签发它的会话与文件，换个会话 id 用不了；只在签发它的那次启动（同一个 `epoch`）内有效，会话服务重启之后 `epoch` 变了，客户端重新订阅，快照里是新的句柄。
- **不签发的**：插件状态与插件私有数据的存储根（`data` 映射到家目录的 `state/`，里面有访问 token 与审计）里的文件、不是存储地址的来源。这些附件只有名字。

送达结果（`undelivered`、`sentToRoom`）与审批（`approvalId`、denied）不落库。重新订阅之后，历史里只标得出工具调用之前说的话，其余标记只在实时推送里；历史里被审批拦下的工具调用显示为 failed，结果是回给模型的拒绝。

## 回合控制

| 方法 | 参数 | 结果 |
|---|---|---|
| `turn/send` | `{ sessionId, content, attachments? }` | `{}`；以连接的身份发一条入站消息，网关收下就回，回合的进展经条目推送。文字去掉首尾空白；只有附件、没写文字的照常发出，两者都空（含只有空白）的不合参数 |
| `turn/continue` | `{ sessionId }` | `{}`；工具调用达到上限后请她接着做 |
| `turn/abort` | `{ sessionId, turnId? }` | `{}`；不带 `turnId` 停这个会话所有在跑的回合，带 `turnId` 时只停那一轮，对不上回 `expected-turn-mismatch` |
| `session/compress` | `{ sessionId }` | `{}`；压缩结束才回，进度以 `compress` 通知推送，之后推最新用量 |
| `turn/rewind` | `{ sessionId, turnId, scope: 'code' \| 'code-and-chat' }` | 回滚结果，字段同 [api-checkpoint](./api-checkpoint.md) 的 `RollbackResult`，连对话一起回滚时另有 `deletedMessages`、`chatDeleted`；回合 id 就是 agent 的 `turnId` |
| `plan/clear` | `{ sessionId }` | `{}` |

发给 agent 的附件（`OutgoingAttachmentSchema`）的 `data` 是 data URL。所需的服务（agent、检查点、待办）不在时，`turn/abort`、`turn/rewind`、`plan/clear` 回 `unsupported`。

## 在场与审批

需要 owner 批准的工具调用以审批对象的形式出现，对象与规则见 [api-approval](./api-approval.md)。每条连接都在它所在的审批面上（传输层登记的那一个，握手回它的登记名）；在场上报与应答都记在这个审批面的登记身份名下，连接自己报不了别的面。

| 方法或通知 | 参数 | 结果 |
|---|---|---|
| `presence/update` | `{ active }` | `{}` |
| `approval/requested`（通知） | `{ approval: Approval }` | — |
| `approval/settled`（通知） | `{ approvalId, state }`，`state` 是结局：`approved`、`denied`、`expired`、`cancelled` | — |
| `approval/respond` | `{ approvalId, decision: 'approve' \| 'deny', contentHash, note? }` | `{}` |

- **在场**：`active` 为真表示页面可见且刚有键盘或指针活动，为假表示页面转到后台，即刻不在场。最近一次为真的上报在 10 分钟内即算在场，所以客户端在有活动时按需重报（例如节流到每分钟一次），页面转到后台时报一次假。从没上报过的连接不算在场。
- **推送**：审批推出时，`approval/requested` 推给在场、身份是 owner 的连接，不要求这条连接订阅了那个会话；不在场的连接变为在场时补推还没结的。结算时 `approval/settled` 推给拿到过这条请求的连接。订阅了会话的连接另从快照的 `approvals` 与工具卡的 `approvalId` 看到它。
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
