# api-authority — 权限校验与执行守卫契约

**包名**: `@aalis/api-authority`  
**源码**: `packages/api-authority/src/index.ts`  
**实现**: `@aalis/plugin-authority`

描述符 `authority`（`name: 'authority'`），不给 bind，业务层就是 `AuthorityService` 形状的活句柄（`caps.authority.use`）。

## 概述

定义三件事：

1. **`AuthorityService.authorize`** —— capability 统一闸。tools / commands 的执行守卫在操作边界过这道裁决：
   裁决 `deniedCapabilities(全局硬禁) > owner(∞) > 封禁(level < 0) > 用户 level >= 操作 minLevel > 所属权限组覆盖`。
   模型详见 [docs/plugins/plugin-authority.md](../plugins/plugin-authority.md)。
2. **`ExecutionGuard`** —— tools/commands surface 的适配器。`plugin-commands` 与 `plugin-tools` 在执行前调用；裁决委托 authorize，已授权但声明了确认的操作在守卫里确认（见下文「守卫流程」）。
3. **身份** —— `UserIdentity`（全 surface 统一身份类型）。

## 两条正交轴

- **轴 A · 授权（谁能用）**：每个外部身份对应一个整数 **level**（缺省 0，封禁=负数）；owner = ∞（经 `owners` 列表命中，**不是**有限数字，无法被设成有限等级）。每个操作有一个 `minLevel`，调用者 `level >= minLevel` 才放行；等级不够时，所属权限组（`authorityGroups`）里有条目覆盖这个操作也放行。封禁（等级小于 0）一律拒。
- **轴 B · 确认（HITL 意图核验）**：与等级正交，**owner 也是被确认对象**（抵御会话内提示注入借权静默调高危）。工具由模型调用，确认是 owner 审批（[api-approval](./api-approval.md)）；指令由人亲手输入，确认是向发出者本人核对意图。

`risk` 声明同时设定两轴默认（`dangerous` = restricted + `confirm:'session'`）。

## 关键类型

```ts
type CapabilityId = string;                          // 例: "tool:file_write" / "command:shutdown"
type CapabilityVisibility = 'public' | 'restricted'; // 操作默认可见性（轴 A）
type CapabilityConfirm = 'session' | 'always';       // 确认要求（轴 B）
type CapabilityRisk = 'safe' | 'sensitive' | 'dangerous'; // 风险糖：展开为 (visibility, confirm) 默认

interface ExecutionGuardContext {
  name: string;
  type: 'command' | 'tool';
  visibility: CapabilityVisibility;  // 主能力生效可见性（注册时已由 resolveCapabilityPolicy 展开）
  risk?: CapabilityRisk;             // 原始风险声明（透传，供 authority 派生 minLevel；缺省回退 visibility）
  minLevel?: number;                 // 操作自己声明的最低等级（如会话设置项按字段声明的门槛），压过 risk 与 visibility 的派生、让位于 authorityOverrides；Infinity 即只有 owner
  confirm?: CapabilityConfirm;       // 生效确认要求（轴 B；缺省=不确认）
  sessionId: string;
  platform: string;
  userId?: string;                   // 物理发言者（会话语义），不参与裁决
  participants: readonly UserIdentity[]; // 这一轮的参与者（授权身份）：对每个参与者各裁决一次；指令一路是发出者
  toolGroups?: readonly string[];    // 工具所属的工具分组（工具一路由执行器填，指令没有）：原样转给 authorize
  args?: Record<string, unknown>;
  skipConfirm?: boolean;             // 受信系统源（scheduler、runtime 子命令）：仍走 authorize；已授权且参与者都是 owner 时跳过非 always 的确认
  turnId?: string;                   // 调用所在回合（工具调用由 agent 工具循环填写）；审批随回合结束撤销
  callId?: string;                   // 这次工具调用的 id；审批卡据它挂到工具卡上
  inbound?: InboundTurn;             // 调用所在的入站回合；缺省 = 不在由入站消息驱动的回合里（编排节点、mcp-server 等）
  confirmIntent?: () => Promise<boolean>; // 向发出者本人核对意图（指令用），resolve true 为确认
  signal?: AbortSignal;              // 调用方回合的中止信号：等审批期间中止，审批即撤销
  check?: (who: UserIdentity) => Verdict; // 取用判定（工具执行中经 approveFor 交来）：代替等级裁决，不再判确认
}

interface InboundTurn {
  source?: string;                   // 同 IncomingMessage.source：真人消息为 undefined
  fromTurn?: FromTurn;               // 同 IncomingMessage.fromTurn：续做与子任务都带着起它的那一轮，与它同一类别（类型见 schema-message）
  messageId?: string;                // 这一轮最近一条输入的平台消息 id，后台任务的结束通知据它引用这条消息
}

type Verdict = { ok: true; by?: UserIdentity } | { ok: false; reason: string | TextRef };
type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<Verdict>;
// 拦截的原因指令一路回复给发出者，工具一路交给模型；经审批放行时 by 是批的人，工具一路这次调用按他执行
```

### 风险糖展开

`risk` 是可选声明糖，框架按下表展开为 `(visibility, confirm)` 默认；显式 `visibility` / `confirm` 覆盖 risk 推导值：

| risk | visibility | confirm | 例 |
| --- | --- | --- | --- |
| `safe` | public | （无） | 查天气 / 算术 |
| `sensitive` | restricted | （无） | owner 顺手的中危 |
| `dangerous` | restricted | `session` | shell / 写删 / 改系统 |

三者皆不声明 → 兜底 `public`。纯函数 `resolveCapabilityPolicy(decl, defaultVisibility)` / `riskDefaults(risk)` 导出供注册方使用。

## 服务接口

```ts
interface AuthorityService {
  // 是否 owner（owners 配置命中 → 拥有一切，level = ∞）
  isOwner(platform: string, userId?: string): boolean;

  // owner 在这个平台登记的账号：配置 owners 里这个平台的第一个，没有时为 undefined。本机控制台（webui、cli 的 console）
  // 恒为 owner，但不是登记的账号，不算。入站正文的发送者前缀据它写 owner 从别的平台往房间里插话的那条（api-message-archive 的 speakerOf）
  ownerOn(platform: string): UserIdentity | undefined;

  // 这一轮从哪里来（api-approval 的 OriginKind）：只看消息事实（来源、起它的那一轮、授权身份有没有账号），
  // 不看会话类型与受众，不判是不是 owner，不按授权身份判。能不能产生审批由审批服务按类别与参与者判
  originOf(turn: OriginTurn): OriginKind;

  // 这一轮的主体，定本地效果：类别为 hand 且参与者（授权身份）都是 owner 的为 owner；续做与子任务的类别沿 fromTurn 随起它的
  // 那一轮，参与者是那一轮交来的（批过的调用是批的人）；其余为 other（owner 与别人同在的一轮也是）
  principalOf(turn: OriginTurn): 'owner' | 'other';

  // capability 统一闸：null 放行；否则是拒绝原因（字符串或文字对象，读法同 ExecutionGuard 的拒绝原因）
  // 裁决：deniedCapabilities(全局硬禁) > owner(∞) > 封禁(level < 0) > 用户 level >= 操作 minLevel > 所属权限组覆盖；
  // minLevel 取 config.authorityOverrides，没有时取 request.minLevel，再没有时由 request.risk/visibility 派生；组的放行条目取自 config.authorityGroups。
  authorize(
    identity: UserIdentity | { platform: string; userId?: string },
    request: AuthorizeRequest, // { capability, visibility, risk?, minLevel?, toolGroups? }
  ): string | TextRef | null;

  // 这个身份的等级够不够 minLevel：owner 恒过，封禁（等级为负数）恒不过，其余登记等级不低于 minLevel 才过；
  // minLevel 为 Infinity 即只有 owner。不看能力、权限组与硬禁（那些归 authorize），给会话设置按层固定的门槛用。提供者要实现它
  meetsLevel(identity: UserIdentity | { platform: string; userId?: string }, minLevel: number): boolean;

  // 设置 target 外部身份的等级（覆盖式整数；level=0 默认值且记录里没有备注等别的内容则清记录）。
  // 单 owner 终态：权限只由 owner 管理。调用方自行确保仅 owner 可达（防自授）。
  setUserLevel(target: UserIdentity, level: number): void;

  // 删除用户记录（等级一并清除，回退默认 0）
  removeUser(platform: string, userId: string): void;

  save(): void;
  listUsers(): AuthorityUserEntry[]; // { platform, userId, isOwner, level, note? }
}
```

`OriginTurn` 是判发起类别与主体要的回合信息，取执行守卫上下文的五项。由入站消息拼一轮用 `originTurnOf`，调用方不各自拼：

```ts
type OriginTurn = Pick<ExecutionGuardContext, 'sessionId' | 'platform' | 'userId' | 'participants' | 'inbound'>;

// 由一轮的输入拼这一轮。参与者：各条输入的授权身份（actor，没有时是发言者，没有发言者的是无主体；插话不带 actor，
// 就是发言者），带起它的那一轮的取那一轮的参与者，按进入先后排、按身份去重，owner 的各个身份算一个（isOwner 不给时
// 按字面身份）；发言者：各条输入的发言者相同时是他，缺省时取起它的那一轮的；inbound 取 { source, fromTurn }
// 与最近一条输入的 messageId
function originTurnOf(
  inputs: readonly [IncomingMessage, ...IncomingMessage[]],
  isOwner?: (platform: string, userId: string) => boolean,
): OriginTurn;

// 是不是同一个参与者：身份相同，或两边都是 owner（isOwner 不给时只按字面身份）
function sameParticipant(a: UserIdentity, b: UserIdentity, isOwner?: (platform: string, userId: string) => boolean): boolean;
```

agent 用 `originTurnOf(这一轮的输入, 权限服务的 isOwner)` 填工具调用上下文；不另导出取参与者的函数。历史里别人的话、工具读进来的内容都不算参与者，引用与转发进某条输入的内容算发这条输入的人的。判据见 [plugin-authority](../plugins/plugin-authority.md#发起回合的类别)与[这一轮的主体](../plugins/plugin-authority.md#这一轮的主体)。

## 守卫流程：授权与确认

执行前 `ExecutionGuard` 对每个参与者各委托 `authorize` 裁决一次（轴 A），不看物理发言者。命中硬禁、封禁，或等级不够、所属组也不覆盖的参与者做不了：发起者本人不能靠确认给自己提权，`restrictedPolicy` 白名单也不放宽授权。按这个动作三分：

- **都能做**：往下判确认。
- **有人能做、有人做不了**：这一个调用要一道参与者审批，凡自己就能做这个动作的人都能批（`canAnswer` 是「他自己 authorize 过」），这一轮里别的动作照常各自判。一轮里能做的因此不超过参与者里最高的那位，低的人借不到高的人不经审批的权限；权限组让两个人各能做对方做不了的事时照样判得出。
- **都做不了**：照旧拒，不产生审批。只有一位参与者时用 `authorize` 的拒绝语，几位时写「这一轮的参与者里没有人能做这件事」。

已授权且声明了 `confirm`（经 `confirmOverrides` 覆盖后）的操作再走轴 B：

- **可免的确认**：只对参与者都是 owner 的回合。`confirm` 为 `session` 时，`skipConfirm` 的受信来源（带 `ownerApproved` 的注入即定时任务触发的指令、runtime 一次性子命令）与 `restrictedPolicy` 白名单命中的能力免确认；`always` 只有 `confirmOverrides` 设为 `'off'` 能免。有别人的回合照旧确认，`'off'` 回落到插件的声明。
- **指令**：确认的是发出者本人的意图。调用方给了 `confirmIntent` 就调它，发出者确认才执行；没给（例如适配器没给发出者的消息）就无从确认，直接拒。指令一路的参与者只有发出者，放行不带 `by`。
- **工具**：要一道只有 owner 能批的审批（`canAnswer` 是 isOwner，`ownerOnly` 为真），与参与者审批合成一次。守卫带上发起回合的类别（`originOf`）与这一轮的参与者调 `approvals.request`；人亲手发起的一轮（含它的续做与子任务，不论在哪个会话）、参与者里有人能批才能产生审批，其余由审批服务立即拒绝、不推给任何面：要 owner 确认的，参与者里没有 owner 时直接拒。批了回 `{ ok: true, by }`，`by` 是批的人，他就是参与者之一时取那个参与者的身份（owner 的各个身份算一个）；拒绝、过期与产生不了时把审批服务给的话回给模型，只拒这一个调用；审批服务不在时立即拒并说明。

工具执行中的取用判定（工具调用上下文的 `approveFor`，见 [api-tools](./api-tools.md#toolcallcontext)）同样经守卫：上下文带 `check` 时按它对每个参与者判、代替等级裁决，三分同上，有人过不了时发一道参与者审批（`canAnswer` 是 `check(who).ok`，不是只有 owner 能批的那种），都过不了回第一位的原因；确认在这次调用开始时已经判过，不再判。

## 关键类型（请求）

```ts
interface AuthorizeRequest {
  capability: CapabilityId;        // 操作主能力（tool:<name> / command:<name>）
  visibility: CapabilityVisibility; // 主能力默认可见性（无 risk 时作 minLevel 兜底）
  risk?: CapabilityRisk;            // 原始风险（透传，供 minLevel 派生；缺省回退 visibility）
  toolGroups?: readonly string[];   // 被裁决的工具所属的工具分组（工具一路由执行器填）：权限组的 tool-group: 条目按它覆盖，权限服务不反查工具表
}
```

## CapabilityId 命名约定

守卫按 `${type}:${name}` 拼装能力串：

- 工具：`tool:<工具名>`，例 `tool:file_write`
- 指令：`command:<path>`，例 `command:shutdown`

## 配置字段（declaration merging 注入 `@aalis/api-host-config` 的 `AalisConfig`）

以下字段位于配置文档顶层，由宿主经 `host-config` 服务提供读写。

- `owners?: UserIdentity[]` —— owner 列表（owner = ∞，拥有一切）
- `deniedCapabilities?: string[]` —— 全局硬禁用（glob；命中即拒，连 owner 都压过）
- `authorityOverrides?: Record<string, number>` —— 单条操作的最低等级覆盖（能力键 `type:name` → 任意整数），优先于 risk/visibility 派生
- `confirmOverrides?: Record<string, CapabilityConfirm | 'off'>` —— 单条操作的确认要求覆盖；`'off'` 关闭确认（便于自动化），只对参与者都是 owner 的回合生效，有别人的回落到插件的声明；与等级正交
- `authorityGroups?: Record<string, string[]>` —— 权限组：组名 → 放行条目。条目写成 `tool:<名或通配>`、`command:<名或通配>`（通配同 `deniedCapabilities`）或 `tool-group:<工具分组名>`；裸 `*` 与别的前缀不命中任何操作。只加放行，硬禁与封禁照旧先拒，确认照旧。成员关系不在契约里，参考实现记在 users.json
- `restrictedPolicy?: { allow?: string[]; duration?: number }` —— 免确认白名单（`allow` glob，`['*']` 全放；`duration` 生效时长秒，0=永久）。只免 `session` 档的确认，`always` 照常确认；只对参与者都是 owner 的回合生效；不放宽授权
- `network?: { blockPrivate?: boolean; denyCidrs?: string[]; allowedPorts?: number[] }` —— 网络出口闸（SSRF 防护）：限制由 LLM/用户 URL 触发的出口能连到哪，即 `safeFetch`，以及 tool-browser 开启 `blockPrivate` 时的浏览器网络闸（三项都遵循）

## 管理入口

owner 仅管理权限（无自授）：

- **WebUI authority 页**（owner-only）—— 设等级、管权限组与成员、管覆盖
- **`/level`** 指令 —— 设某用户的等级
- **`/perm`** 指令 —— 设某用户所属的权限组

## 实现者

- [@aalis/plugin-authority](../plugins/plugin-authority.md)

## 相关

- 权限数据（level / note / groups）存于 `data:/users.json`（家目录的 `state/users.json`）
- 工具的确认经 [api-approval](./api-approval.md) 的 `approvals` 服务（由 `plugin-session-server` 提供）；指令的意图确认由 `plugin-commands` 在同一会话里问发出者
- 用户身份模型 `UserIdentity` 在本 api 包中定义，是全 surface 统一的调用者身份类型
  （WebUI action 的 caller 第三参、scheduler actor 快照等均为该类型）
