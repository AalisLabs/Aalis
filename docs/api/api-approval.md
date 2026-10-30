# api-approval — 审批契约

**包名**: `@aalis/api-approval`  
**源码**: `packages/api-approval/src/index.ts`  
**实现**: `@aalis/plugin-session-server`

## 概述

模型发起、需要批准的操作以审批对象的形式出现：发起方发起并等结算，审批推给在场的审批面，能批的人应答，结局回给发起方。审批只有一种，发起方给出这一张谁能批（`canAnswer`），另标出只有 owner 能批的那种（`ownerOnly`，要 owner 确认的）。本包定义服务描述符 `approvals`（服务名 `approvals`）、审批对象与请求的类型、审批面的登记接口，以及各审批面共用的卡片清洗与截断函数 `sanitizeForCard`、`clipForCard`，不含实现。

三类使用方：

- **发起方**（执行守卫）：`request(req, signal)` 发起一个审批并等它结算。拒绝时结局里带着回给模型的话。
- **审批面**（WebUI、终端、owner 与她的 IM 私聊、群窗口）：经绑定门面 `registerSurface(name)` 登记，随激活撤回。每个客户端（WebUI 的一条连接、终端、owner 的一个 IM 身份经一个机器人账号、群窗口里的一个人）`attend` 一次，在场上报与应答都经它。审计里的审批面取登记身份（审批面名与登记它的插件实例），不取调用方自报。IM 私聊与群窗口这两种接入由 [plugin-chat-approval](../plugins/plugin-chat-approval.md) 登记（审批面 `chat`）。
- **展示方**：`list()` 列出推出、还没结的审批；`approval:created`、`approval:settled` 事件。

目前审批的目标只有工具调用。

## 谁能产生审批

请求带发起回合的类别（`origin.kind`）、这一轮的参与者（`origin.participants`，即授权身份）与这一张谁能批（`canAnswer`）。类别由发起方按这一轮从哪里来算出，不看会话类型与受众，也不按授权身份算：owner 建的定时任务会把创建者回填成授权身份，按授权身份算它就成了 owner 亲手。第一方的发起方是 plugin-authority 的执行守卫，判据见 [plugin-authority](../plugins/plugin-authority.md) 的「发起回合的类别」。

| `kind` | 回合 | 处理 |
|---|---|---|
| `hand` | 人亲手发来的消息（不带来源，含群里没点名、被频率触发挑中的插话），不论在哪个会话、是谁，以及它的续做与派出的子任务 | 参与者里有人能批时能产生审批，否则直接拒绝 |
| `autonomous` | 定时任务、编排、空闲与主动发言、开话题、平台请求事件等其余注入与它们的续做、派出的子任务，以及不在入站回合里的调用（含编排的工具节点、mcp-server 派出的子任务） | 直接拒绝 |

能不能产生审批由审批服务按类别与参与者判：`hand` 且参与者里有人能批（`canAnswer`），不论在哪个会话。只有 owner 能批的，这一条就是「人亲手且参与者里有 owner」；参与者审批只在有人自己就能做这个动作时发起，总能产生。直接拒绝的请求不推给任何审批面，照样记审计。

## 流程

1. **发起**：`request(req, signal)`。`signal` 是发起回合的中止信号。
2. **在场**：推给谁、算谁在场、认谁的应答是一条规则：客户端的身份能批这一张（`canAnswer`；不能批的，推给它只会让审批白等），且它的接入覆盖这张审批（见「审批面」的限定）。客户端上报活动，最近一次活动在时限内的算在场，推给它、还没结的审批也让它一直算在场。发起时没有覆盖它的在场客户端，直接按拒绝结算，发起方立即拿到原因。
3. **排队**：同一会话的审批串行，一次只推出一张卡，不同会话之间并行（子会话与它的父会话各排各的）；等待从卡推出那一刻算起，到期时刻是这张审批自己的事实，记在审批对象的 `expiresAt` 上。同一根会话连同它的子会话一段时间内推出的卡有上限，超出的直接拒绝并说明原因。
4. **推送**：推出时推给覆盖它的在场客户端；不在场的客户端变为在场时补推它覆盖的、还没结的。客户端上报离开时，推给它、还没结的对它算没收到，之后变为在场时同一张再推一次（按 id 收即不重复）。不能批的客户端收不到推送，限定了的客户端收不到它不覆盖的审批。
5. **应答**：先答先得。已经结算的一律回 `approval-settled`，不论客户端覆盖不覆盖它；还在等的，`approvalId` 要是本服务签发的、归这个客户端覆盖（否则回 `not-found`），应答人要能批这一张（否则回 `forbidden`），`contentHash` 要一致。
6. **结算**：能批的人批准或拒绝，结算记下应答人（`by`）；等满时限按拒绝结算；等待中覆盖它的在场客户端都断开或上报离开时先等一段重连宽限，宽限内有客户端恢复在场就照常等，没有就按拒绝结算（宽限不延长总的等待时限）；发起回合结束或中止、审批服务停止时按 cancelled 结算。结算推给拿到过这条请求的客户端，带上怎样结算的（`ApprovalSettlement`）。
7. **回给模型**：批准时结局带批的人（`by`），发起方按他执行（第一方的执行守卫把这次调用的参与者换成他）。拒绝时结局里的 `message` 写明被什么拦下、能不能再申请，不论在哪个会话发起都是这个格式，不指名应答人。
8. **审计**：请求与决定成对记下，不进模型上下文。

时限、在场的判据、重连宽限、频率上限与审计的落点由实现定，默认实现的取值见 [plugin-session-server](../plugins/plugin-session-server.md#审批)。

## 类型

```ts
type OriginKind = 'hand' | 'autonomous';

interface ApprovalOrigin {
  kind: OriginKind;
  participants: { platform: string; userId: string }[]; // 这一轮的参与者（授权身份）
}

interface ApprovalRequest {
  sessionId: string;
  turnId?: string;            // 回合结束或中止时，没结的审批按 cancelled 结算
  callId?: string;            // 客户端据它把审批卡挂到工具卡上
  origin: ApprovalOrigin;
  tool: string;
  args: Record<string, unknown>;
  rule: string;               // 命中的规则，记进审计
  canAnswer: (who: ApprovalIdentity) => boolean; // 这个人能不能批：参与者审批是他自己就能做，要 owner 确认的是 owner
  ownerOnly: boolean;         // 只有 owner 能批的那种：只给接入的覆盖用
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
  expiresAt: number;          // 到期的时刻（毫秒时间戳），审批服务推出时按它的等待时限填
  state: ApprovalState;
  chain?: { id: string; title: string | TextRef }[]; // 来源链：所在会话在根会话以下时才有
}

type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
type SettledState = Exclude<ApprovalState, 'pending'>;   // 结算之后的四种结局

interface ApprovalSettlement {
  state: SettledState;
  source: ApprovalSource;
  at: number;                 // 结算的时刻
  by?: ApprovalIdentity;      // 应答人，有人应答时才有
}

type ApprovalOutcome =
  | { approvalId: string; approved: true; by: ApprovalIdentity }
  | { approvalId: string; approved: false; source: ApprovalSource; message: string };
```

`canAnswer` 与 `ownerOnly` 只在进程内交给提供者，不进推给审批面的审批对象：审批面不判谁能批，也不判能不能发在有别人的窗口里。

`chain` 是来源链：审批所在会话不是根会话时（子任务的子会话、WebUI 里建的子会话），从根会话往下到它的各级子会话，按层级先后，不含根会话，每级是会话 id 与标题（没有标题时是会话名，子任务没取名的是默认名「子任务 <建档时间>」，是文字对象）。所在会话就是根会话时没有。审批服务推出时按会话树填，审批面据它写是哪个子任务；根会话不在里面，各面另有写它的地方（私聊卡的来源一行、WebUI 的页头、终端卡头的会话 id）。

`state` 的结局：批准为 `approved`；拒绝，或发起不被允许（类别、参与者里没人能批、频率上限）为 `denied`；没人应答（不在场、等满时限）为 `expired`；回合结束或中止、服务停止为 `cancelled`。

`ApprovalSource` 是结算从哪里来：`answer`（有人应答）、`absent`（发起时没人在场，或等待中在场的都离开、宽限内没有回来）、`timeout`、`ineligible`、`rate-limit`、`turn-ended`、`shutdown`。

### 事实

卡片上的事实按工具定义上声明的展示种类（[api-tools](./api-tools.md) 的 `display`）从参数里取，各项逐字、与执行的参数一致：

```ts
interface ApprovalFacts {
  command?: string;                         // 命令类工具声明的命令
  cwd?: string;                             // 命令类工具声明的工作目录
  diff?: { path: string; patch: string };   // 改文件类工具声明的路径与删、加两侧
  params: Record<string, unknown>;          // 其余参数，逐字
}
```

`diff.patch` 里删的行以 `-` 开头、加的行以 `+` 开头，例如 `file_edit` 声明 `oldText` 为删的一侧、`newText` 为加的一侧，`file_write` 与 `file_append` 只有加的一侧 `content`（不读原文件）。用掉的参数不在 `params` 里重复。没声明展示种类的工具（参数名叫 `command`、`path` 也一样）全部参数都在 `params` 里。

## 审批面

```ts
interface ApprovalSurface {
  readonly name: string;      // 登记名（webui、cli、chat）
  attend(who: { platform: string; userId: string }, sink: ApprovalSink, scope?: AttendScope): ApprovalAttendance;
}

interface AttendScope {
  selfId?: string;            // IM 私聊：机器人账号
  window?: string;            // 群窗口：根会话 id（连同它下面的子会话；根会话已经定了机器人账号，不再给 selfId）
}

interface ApprovalSink {
  requested(approval: Approval): void;
  settled(approvalId: string, settlement: ApprovalSettlement): void;
}

interface ApprovalAttendance {
  presence(active: boolean): void;
  present(): boolean;
  respond(answer: ApprovalAnswer): ApprovalResponse;
  leave(): void;
}
```

- `registerSurface(name)` 经绑定门面登记：同一激活同名再登记替换旧的，提供者换人自动重挂，随激活撤回。审计记的审批面是登记名加登记它的插件实例。
- `attend(who, sink, scope?)`：接入一个客户端，`who` 是它经认证得出的身份，应答人就是它。审批推送与结算推送经 `sink` 到达。一张审批只推给能批它、且接入覆盖它的客户端，只因这样的审批算在场；覆盖了却不能批的应答回 `forbidden`。
- 接入的覆盖按限定：不给 `scope` 的覆盖全部，只给 owner 的面（WebUI 的连接、终端）：别的身份不限定地接入，会收到各会话里它能批的审批、看到别的会话的工具与参数，所以别人的接入一律给 `window`。给了 `window` 的（群窗口每个窗口与发言者接入一份）覆盖这个窗口发起的（所在会话的根会话就是这个窗口，连同它下面的子会话）、不是只有 owner 能批的审批：群窗口是公开的面，不发只有 owner 能批的，owner 自己在这个窗口的接入也一样。只给 `selfId` 的（IM 私聊每个身份与机器人账号接入一份）只覆盖只有 owner 能批的、这一轮的参与者里有 `who`、且所在会话的根会话的机器人账号（`originChat.selfId`）等于 `selfId` 的审批，两边都没有账号算相同：参与者审批不推到私聊，发在这一轮所在的聊天里。限定了的接入只因它覆盖的审批算在场、只收和只能应答它们。
- `presence(true)` 表示刚有活动（WebUI 另要页面可见），`presence(false)` 表示离开、即刻不在场，推给它、还没结的审批对它算没收到，变为在场时补推。推给它、还没结的审批让它一直算在场，不随最近一次活动满时限失效。从没上报过的客户端不算在场。
- `present()` 回它此刻还算不算在场（同上一条规则，由审批服务判，审批服务不在时为假）：审批面据它撤掉不在场的接入，不自己另记时限（聊天审批就是这样）。撤掉（`leave()`）的接入收不到推给过它、还没结的审批的结算，还要等结算的先别撤。
- `respond(answer)` 回 `{ ok: true }` 或 `{ ok: false, refusal, message }`，`refusal` 取 `forbidden`（应答人不能批这一张）、`not-found`（不是本服务签发的 id，或还在等的审批不归这个接入覆盖）、`approval-settled`（已经结算，不论接入覆盖不覆盖它）、`hash-mismatch`、`unavailable`（审批服务不在）。被拒时的 `message` 是给应答人看的原因，可以是文字对象（`string | TextRef`）。
- 审批服务不在场时，接入的客户端照样拿到句柄：在场上报不生效，`present()` 为假，应答回 `unavailable`。服务上线或换了提供者之后，下一次上报或应答时在新的登记上重新接入。
- 登记撤回（登记它的插件停用）时，它的客户端都不再算在场。

### 卡片清洗

```ts
function sanitizeForCard(text: string): string;
function clipForCard(text: string, limit: number): { head: string; omitted: number; tail: string };
```

事实是逐字的参数，可能带控制符、双向控制符与零宽字符，显示之前一律经 `sanitizeForCard` 清洗，各审批面共用：

- C0 与 C1 控制符、DEL 转义成 `\x1B` 的样子显示，ANSI 转义序列因此整段看得见；换行与制表符保留。
- 双向控制符、零宽字符等看不见的字符（Unicode 格式符、行与段分隔符、落单的代理项）换成 `⟨U+202E⟩` 的样子。

原文的每个字符都显示出来，不隐藏、不改变顺序。

`clipForCard` 同样清洗，原文超过 `limit` 个字符时只保留开头与结尾共 `limit` 个字符：交出清洗过的两段与中间省略的字数（没有截断时 `omitted` 为 0、整段在 `head`），由显示方在两段之间按读者语言写明省略了多少。截断按原文的码点算，不切开代理对、转义或占位符；由多个码点组成的表情（国旗、键帽、肤色修饰等）可能被切开。

## 服务接口

```ts
interface ApprovalService {
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome>;
  list(filter?: { sessionId?: string }): Approval[];
  attachSurface(name: string, registrant: string): SurfaceBinding;   // 经绑定门面调用
}

interface BoundApprovals extends ApprovalService {
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
if (!caps.approvals.present) return '需要批准，但审批服务不在，操作没有执行';
const service = caps.approvals.use;
const outcome = await service.request(
  {
    sessionId,
    turnId,
    callId,
    origin: { kind: 'hand', participants }, // participants：这一轮的参与者（授权身份）
    tool: name,
    args,
    rule: `${capability} 声明需确认`,
    canAnswer: who => authority.isOwner(who.platform, who.userId), // 要 owner 确认的：只有 owner 能批
    ownerOnly: true,
  },
  signal,
);
if (!outcome.approved) return outcome.message;
// outcome.by 是批的人
```

进程内的审批面：

```ts
import { approvals, clipForCard } from '@aalis/api-approval';

// uses: { approvals: optional(approvals) }
const surface = caps.approvals.use.registerSurface('cli');
const attendance = surface.attend({ platform: 'cli', userId: 'console' }, {
  requested: approval => {
    const { head, omitted, tail } = clipForCard(approval.facts.command ?? approval.tool, 400);
    showCard(omitted === 0 ? head : `${head}…（省略 ${omitted} 字）…${tail}`);
  },
  settled: (approvalId, { state }) => closeCard(approvalId, state),
});
attendance.presence(true);   // 有输入时
const reply = attendance.respond({ approvalId, decision: 'approve', contentHash });
```

经会话协议接入的客户端由传输层把登记得到的审批面交给 `sessionProtocol.connect`，见 [api-session-protocol](./api-session-protocol.md#在场与审批)。

## 实现者列表

- [@aalis/plugin-session-server](../plugins/plugin-session-server.md#审批)
