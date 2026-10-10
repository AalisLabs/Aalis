# api-authority — 权限校验与执行守卫契约

**包名**: `@aalis/api-authority`  
**源码**: `packages/api-authority/src/index.ts`  
**实现**: `@aalis/plugin-authority`

描述符 `authority`（`name: 'authority'`），不给 bind，业务层就是 `AuthorityService` 形状的活句柄（`caps.authority.use`）。

## 概述

定义三件事：

1. **`AuthorityService.authorize`** —— capability 统一闸。tools / commands 的执行守卫在操作边界过这道裁决：
   数字等级裁决 `deniedCapabilities(全局硬禁) > owner(∞) > 用户 level >= 操作 minLevel`。
   模型详见 [docs/plugins/plugin-authority.md](../plugins/plugin-authority.md)。
2. **`ExecutionGuard`** —— tools/commands surface 的适配器。`plugin-commands` 与 `plugin-tools` 在执行前调用；裁决委托 authorize，已授权但声明了确认的操作在守卫里确认（见下文「守卫流程」）。
3. **身份** —— `UserIdentity`（全 surface 统一身份类型）。

## 两条正交轴

- **轴 A · 授权（谁能用）**：每个外部身份对应一个整数 **level**（缺省 0，封禁=负数）；owner = ∞（经 `owners` 列表命中，**不是**有限数字，无法被设成有限等级）。每个操作有一个 `minLevel`，调用者 `level >= minLevel` 才放行。
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
  confirm?: CapabilityConfirm;       // 生效确认要求（轴 B；缺省=不确认）
  sessionId: string;
  platform: string;
  userId?: string;
  actor?: { platform: string; userId: string }; // 被裁决身份（缺省=会话身份 platform/userId）
  args?: Record<string, unknown>;
  skipConfirm?: boolean;             // 受信系统源（scheduler、runtime 子命令）：仍走 authorize；已授权时跳过非 always 的确认
  turnId?: string;                   // 调用所在回合（工具调用由 agent 工具循环填写）；审批随回合结束撤销
  callId?: string;                   // 这次工具调用的 id；审批卡据它挂到工具卡上
  inbound?: InboundTurn;             // 调用所在的入站回合；缺省 = 不在由入站消息驱动的回合里（编排节点、mcp-server 等）
  confirmIntent?: () => Promise<boolean>; // 向发出者本人核对意图（指令用），resolve true 为确认
  signal?: AbortSignal;              // 调用方回合的中止信号：等 owner 审批期间中止，审批即撤销
}

interface InboundTurn {
  source?: string;                   // 同 IncomingMessage.source：真人消息为 undefined
  callerUserId?: string;             // 宿主通知延续某次工具调用时，那次调用的发言者（hostNotice.callerUserId）
  messageId?: string;                // 同 IncomingMessage.messageId：入站消息的平台消息 id，后台任务的结束通知据它引用这条消息
}

type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;
// 返回 null 放行；返回字符串表示拦截原因（会回复给用户）
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

  // 这一轮是谁发起的（api-approval 的 OriginKind）：按回合的来源判，不按授权身份判，会话的受众按会话管理里记下的字段判。
  // 只有 owner 与 owner-chain 能产生审批；本地效果由触及服务按这一类别定主体：owner 与 owner-chain 为 owner，
  // subtask 随派出它的那一轮父会话，其余没有本地效果
  originOf(turn: OriginTurn): OriginKind;

  // capability 统一闸：null 放行 | string 拒绝原因
  // 数字等级裁决：deniedCapabilities(全局硬禁) > owner(∞) > 用户 level >= 操作 minLevel；
  // minLevel 由 request.risk/visibility/config.authorityOverrides 派生。
  authorize(
    identity: UserIdentity | { platform: string; userId?: string },
    request: AuthorizeRequest, // { capability, visibility, risk? }
  ): string | null;

  // 设置 target 外部身份的等级（覆盖式整数；level=0 默认值且无备注则清记录）。
  // 单 owner 终态：权限只由 owner 管理。调用方自行确保仅 owner 可达（防自授）。
  setUserLevel(target: UserIdentity, level: number): void;

  // 删除用户记录（等级一并清除，回退默认 0）
  removeUser(platform: string, userId: string): void;

  save(): void;
  listUsers(): AuthorityUserEntry[]; // { platform, userId, isOwner, level, note? }
}
```

`OriginTurn` 是判发起类别要的回合信息，取执行守卫上下文的五项：

```ts
type OriginTurn = Pick<ExecutionGuardContext, 'sessionId' | 'platform' | 'userId' | 'actor' | 'inbound'>;
```

判据见 [plugin-authority](../plugins/plugin-authority.md#发起回合的类别)。

## 守卫流程：授权与确认

执行前 `ExecutionGuard` 先委托 `authorize` 裁决（轴 A），被裁决身份取 `actor`，缺省即会话身份（`platform` / `userId`）。等级不够或命中硬禁即拒，没有别的放行口：发起者本人不能靠确认给自己提权，`restrictedPolicy` 白名单也不放宽授权。

已授权且声明了 `confirm`（经 `confirmOverrides` 覆盖后）的操作再走轴 B：

- **可免的确认**：`confirm` 为 `session` 时，`skipConfirm` 的受信来源（scheduler 触发的指令、runtime 一次性子命令）与 `restrictedPolicy` 白名单命中的能力免确认。`always` 什么都免不掉。
- **指令**：确认的是发出者本人的意图。调用方给了 `confirmIntent` 就调它，发出者确认才执行；没给（带 `source` 的注入，例如编排投递的指令）就无从确认，直接拒。
- **工具**：确认是 owner 审批。守卫按发起回合的类别（`inbound`、`actor`、续做的调用者与会话受众，不按授权身份）调 `approvals.request`，只有 owner 本人与 owner 链的延续能产生审批，其余由审批服务立即拒绝、不推给任何面。拒绝时把审批服务给的话回给模型；审批服务不在时立即拒并说明。

## 关键类型（请求）

```ts
interface AuthorizeRequest {
  capability: CapabilityId;        // 操作主能力（tool:<name> / command:<name>）
  visibility: CapabilityVisibility; // 主能力默认可见性（无 risk 时作 minLevel 兜底）
  risk?: CapabilityRisk;            // 原始风险（透传，供 minLevel 派生；缺省回退 visibility）
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
- `confirmOverrides?: Record<string, CapabilityConfirm | 'off'>` —— 单条操作的确认要求覆盖；`'off'` 强制关闭确认（便于自动化），与等级正交，owner 也吃
- `restrictedPolicy?: { allow?: string[]; duration?: number }` —— 免确认白名单（`allow` glob，`['*']` 全放；`duration` 生效时长秒，0=永久）。只免 `session` 档的确认，`always` 照常确认；不放宽授权
- `network?: { blockPrivate?: boolean; denyCidrs?: string[]; allowedPorts?: number[] }` —— 网络出口闸（SSRF 防护）：限制由 LLM/用户 URL 触发的出口能连到哪，即 `safeFetch`，以及 tool-browser 开启 `blockPrivate` 时的浏览器网络闸（三项都遵循）

## 管理入口

owner 仅管理权限（无自授）：

- **WebUI authority 页**（owner-only）—— 设等级、管覆盖
- **`/level`** 指令 —— 设某用户的等级

## 实现者

- [@aalis/plugin-authority](../plugins/plugin-authority.md)

## 相关

- 权限数据（level / note）存于 `data:/users.json`（家目录的 `state/users.json`）
- 工具的确认经 [api-approval](./api-approval.md) 的 `approvals` 服务（由 `plugin-session-server` 提供）；指令的意图确认由 `plugin-commands` 在同一会话里问发出者
- 用户身份模型 `UserIdentity` 在本 api 包中定义，是全 surface 统一的调用者身份类型
  （WebUI action 的 caller 第三参、scheduler actor 快照等均为该类型）
