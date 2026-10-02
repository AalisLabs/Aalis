# api-approval — 审批契约

**包名**: `@aalis/api-approval`  
**源码**: `packages/api-approval/src/index.ts`  
**实现**: `@aalis/plugin-session-server`

## 概述

模型发起、需要 owner 批准的操作以审批对象的形式出现：发起方发起并等结算，审批推给在场的审批面，owner 应答，结局回给发起方。本包定义服务描述符 `approvals`（服务名 `approvals`）、审批对象与请求的类型、审批面的登记接口，以及各审批面共用的卡片清洗函数 `sanitizeForCard`，不含实现。

三类使用方：

- **发起方**（执行守卫）：`request(req, signal)` 发起一个审批并等它结算。拒绝时结局里带着回给模型的话。
- **审批面**（WebUI、终端）：经绑定门面 `registerSurface(name)` 登记，随激活撤回。每个客户端（WebUI 的一条连接、终端）`attend` 一次，在场上报与应答都经它。审计里的审批面取登记身份（审批面名与登记它的插件实例），不取调用方自报。
- **展示方**：`list()` 列出推出、还没结的审批；`approval:created`、`approval:settled` 事件。

目前审批的目标只有工具调用。

## 谁能产生审批

请求带发起回合的类别（`origin.kind`），由发起方按回合的来源算出，不按授权身份算：owner 建的定时任务会把创建者回填成授权身份，按授权身份算它就成了 owner。第一方的发起方是 plugin-authority 的执行守卫，判据见 [plugin-authority](../plugins/plugin-authority.md) 的「发起回合的类别」。

| `kind` | 回合 | 处理 |
|---|---|---|
| `owner` | owner 自己的会话里 owner 亲手发来的消息 | 能产生审批 |
| `owner-chain` | 同一 owner 会话里后台任务完成后的续做 | 能产生审批 |
| `subtask` | 子任务回合 | 直接拒绝：子任务里需要确认的操作不会转给 owner，请在发起它的会话里执行 |
| `autonomous` | 定时任务、定时触发、空闲与主动发言、开话题，以及它们触发的编排 | 直接拒绝 |
| `room` | 群房间，以及对端不是 owner 的私聊；owner 在 WebUI 里驱动房间也算 | 直接拒绝 |
| `other` | 群成员或其他用户发起 | 直接拒绝 |

能产生审批的两类还要求发起回合的直接主体（`origin.platform`、`origin.userId`）是 owner。直接拒绝的请求不推给任何审批面，照样记审计。

## 流程

1. **发起**：`request(req, signal)`。`signal` 是发起回合的中止信号。
2. **在场**：审批面的客户端上报活动，最近一次活动在时限内的算在场；只算身份是 owner 的客户端，别人答不了，推给它只会让审批白等。发起时没人在场直接按拒绝结算，发起方立即拿到原因。
3. **排队**：同一会话的审批串行，一次只推出一张卡，不同会话之间并行；等待从卡推出那一刻算起。同一会话一段时间内推出的卡有上限，超出的直接拒绝并说明原因。
4. **推送**：推出时推给在场的客户端；不在场的客户端变为在场时补推还没结的。身份不是 owner 的客户端收不到推送。
5. **应答**：先答先得，核两项：应答人是 owner；`approvalId` 是本服务签发的、还没结算，并且 `contentHash` 一致。后到的应答回 `approval-settled`。
6. **结算**：owner 批准或拒绝；等满时限按拒绝结算；等待中在场的客户端都断开或变为不在场时先等一段重连宽限，宽限内有客户端恢复在场就照常等，没有就按拒绝结算（宽限不延长总的等待时限）；发起回合结束或中止、审批服务停止时按 cancelled 结算。结算推给拿到过这条请求的客户端，带上怎样结算的（`ApprovalSettlement`）。
7. **回给模型**：批准时工具照常执行。拒绝时结局里的 `message` 写明被什么拦下、能不能再申请；发起类别是 `room` 的（房间里的回合）只回一句通用的拒绝，不透露 owner 的文件布局与说明。owner 自己的 QQ 私聊不算房间，照样拿到写明原因的格式。
8. **审计**：请求与决定成对记下，不进模型上下文。

时限、在场的判据、重连宽限、频率上限与审计的落点由实现定，默认实现的取值见 [plugin-session-server](../plugins/plugin-session-server.md#审批)。

## 类型

```ts
type OriginKind = 'owner' | 'owner-chain' | 'subtask' | 'autonomous' | 'room' | 'other';

interface ApprovalOrigin {
  kind: OriginKind;
  platform: string;           // 发起回合的直接主体
  userId?: string;
}

interface ApprovalRequest {
  sessionId: string;
  turnId?: string;            // 回合结束或中止时，没结的审批按 cancelled 结算
  callId?: string;            // 客户端据它把审批卡挂到工具卡上
  origin: ApprovalOrigin;
  tool: string;
  args: Record<string, unknown>;
  rule: string;               // 命中的规则，记进审计
}

interface Approval {
  id: string;                 // 由审批服务签发
  sessionId: string;
  turnId?: string;
  callId?: string;
  origin: ApprovalOrigin;
  target: 'tool';
  tool: string;
  facts: ApprovalFacts;
  options: Array<'approve' | 'deny'>;
  contentHash: string;        // 会话、回合、调用、工具与参数的哈希，应答时原样带回
  state: ApprovalState;
}

type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
type SettledState = Exclude<ApprovalState, 'pending'>;   // 结算之后的四种结局

interface ApprovalSettlement {
  state: SettledState;
  source: ApprovalSource;
  at: number;                 // 结算的时刻
}

type ApprovalOutcome =
  | { approvalId: string; approved: true }
  | { approvalId: string; approved: false; source: ApprovalSource; message: string };
```

`state` 的结局：owner 批准为 `approved`；owner 拒绝，或发起不被允许（类别、频率上限）为 `denied`；没人应答（不在场、等满时限）为 `expired`；回合结束或中止、服务停止为 `cancelled`。

`ApprovalSource` 是结算从哪里来：`owner`（owner 应答）、`absent`（发起时没人在场，或等待中在场的都离开、宽限内没有回来）、`timeout`、`ineligible`、`subtask`、`rate-limit`、`turn-ended`、`shutdown`。

### 事实

卡片上的事实按工具定义上声明的展示种类（[api-tools](./api-tools.md) 的 `display`）从参数里取，各项逐字、与执行的参数一致：

```ts
interface ApprovalFacts {
  command?: string;                         // 命令类工具声明的命令
  cwd?: string;                             // 命令类工具声明的工作目录
  diff?: { path: string; patch?: string };  // 改文件类工具声明的路径与删、加两侧
  params: Record<string, unknown>;          // 其余参数，逐字
}
```

`diff.patch` 里删的行以 `-` 开头、加的行以 `+` 开头，例如 `file_edit` 声明 `oldText` 为删的一侧、`newText` 为加的一侧，`file_write` 与 `file_append` 只有加的一侧 `content`（不读原文件）。路径像密钥文件（`.env*`、`.npmrc`、私钥与证书、`.ssh` 等目录下）或内容像密钥（私钥块、常见的令牌前缀、「密钥名 = 值」）时没有 `patch`，只给路径。用掉的参数不在 `params` 里重复。没声明展示种类的工具（参数名叫 `command`、`path` 也一样）全部参数都在 `params` 里。

## 审批面

```ts
interface ApprovalSurface {
  readonly name: string;      // 登记名（webui、cli）
  attend(who: { platform: string; userId: string }, sink: ApprovalSink): ApprovalAttendance;
}

interface ApprovalSink {
  requested(approval: Approval): void;
  settled(approvalId: string, settlement: ApprovalSettlement): void;
}

interface ApprovalAttendance {
  presence(active: boolean): void;
  respond(answer: ApprovalAnswer): ApprovalResponse;
  leave(): void;
}
```

- `registerSurface(name)` 经绑定门面登记：同一激活同名再登记替换旧的，提供者换人自动重挂，随激活撤回。审计记的审批面是登记名加登记它的插件实例。
- `attend(who, sink)`：接入一个客户端，`who` 是它经认证得出的身份，应答人就是它。审批推送与结算推送经 `sink` 到达。`who` 不是 owner 的客户端不算在场、收不到推送，应答回 `forbidden`。
- `presence(true)` 表示刚有键盘或指针活动（WebUI 另要页面可见），`presence(false)` 表示离开、即刻不在场。从没上报过的客户端不算在场。
- `respond(answer)` 回 `{ ok: true }` 或 `{ ok: false, refusal, message }`，`refusal` 取 `forbidden`（应答人不是 owner）、`not-found`、`approval-settled`、`hash-mismatch`、`unavailable`（审批服务不在）。
- 审批服务不在场时，接入的客户端照样拿到句柄：在场上报不生效，应答回 `unavailable`。服务上线或换了提供者之后，下一次上报或应答时在新的登记上重新接入。
- 登记撤回（登记它的插件停用）时，它的客户端都不再算在场。

### 卡片清洗

```ts
function sanitizeForCard(text: string, limit?: number): string;
```

事实是逐字的参数，可能带控制符、双向控制符与零宽字符，显示之前一律经它清洗，各审批面共用：

- C0 与 C1 控制符、DEL 转义成 `\x1B` 的样子显示，ANSI 转义序列因此整段看得见；换行与制表符保留。
- 双向控制符、零宽字符等看不见的字符（Unicode 格式符、行与段分隔符、落单的代理项）换成 `⟨U+202E⟩` 的样子。
- 给了 `limit` 且原文超过 `limit` 个字符时，保留开头与结尾共 `limit` 个字符，中间写明省略了多少。截断按码点算，不切开代理对、转义或占位符；由多个码点组成的表情（国旗、键帽、肤色修饰等）可能被切开。

原文的每个字符都显示出来，不隐藏、不改变顺序。

## 服务接口

```ts
interface ApprovalService {
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>;
  list(filter?: { sessionId?: string }): Approval[];
  attachSurface(name: string, registrant: string): SurfaceBinding;   // 经绑定门面调用
}

interface BoundApprovals extends ServiceRef<ApprovalService> {
  registerSurface(name: string): ApprovalSurface;
}
```

事件：

| 事件 | 参数 | 时机 |
|---|---|---|
| `approval:created` | `Approval` | 一个审批推给了审批面 |
| `approval:settled` | `Approval`（`state` 是结局） | 一个推出过的审批结算了 |

发起时就被拒绝、或排队期间就结算的请求没有推出过，不发这两个事件，只记审计。

## 使用

发起方：

```ts
import { approvals } from '@aalis/api-approval';

// uses: { approvals: optional(approvals) }
const service = caps.approvals.current;
if (!service) return '需要 owner 批准，但审批服务不在，操作没有执行';
const outcome = await service.request(
  {
    sessionId,
    turnId,
    callId,
    origin: { kind: 'owner', platform, userId },
    tool: name,
    args,
    rule: `${capability} 声明需确认`,
  },
  signal,
);
if (!outcome.approved) return outcome.message;
```

进程内的审批面：

```ts
import { approvals, sanitizeForCard } from '@aalis/api-approval';

// uses: { approvals: optional(approvals) }
const surface = caps.approvals.registerSurface('cli');
const attendance = surface.attend({ platform: 'cli', userId: 'console' }, {
  requested: approval => showCard(sanitizeForCard(approval.facts.command ?? approval.tool, 400)),
  settled: (approvalId, { state }) => closeCard(approvalId, state),
});
attendance.presence(true);   // 有输入时
const reply = attendance.respond({ approvalId, decision: 'approve', contentHash });
```

经会话协议接入的客户端由传输层把登记得到的审批面交给 `sessionProtocol.connect`，见 [api-session-protocol](./api-session-protocol.md#在场与审批)。

## 实现者列表

- [@aalis/plugin-session-server](../plugins/plugin-session-server.md#审批)
