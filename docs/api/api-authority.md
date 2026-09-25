# api-authority — 权限校验与执行守卫契约

**包名**: `@aalis/api-authority`  
**源码**: `packages/api-authority/src/index.ts`  
**实现**: `@aalis/plugin-authority`

描述符 `authority`（`name: 'authority'`），绑定接口是普通 `ServiceRef<AuthorityService>`。

## 概述

定义三件事：

1. **`AuthorityService.authorize`** —— capability 统一闸。tools / commands 的执行守卫在操作边界过这道裁决：
   数字等级裁决 `deniedCapabilities(全局硬禁) > owner(∞) > 用户 level >= 操作 minLevel`。
   模型详见 [docs/plugins/plugin-authority.md](../plugins/plugin-authority.md)。
2. **`ExecutionGuard`** —— tools/commands surface 的适配器。`plugin-commands` 与 `plugin-tools` 在执行前调用；裁决委托 authorize；被拒后的救援闸（`isPreApproved`）与已授权后的意图确认（`requestAccess`）留在适配层。
3. **身份与确认** —— `UserIdentity`（全 surface 统一身份类型）、意图确认与会话临时授予、平台 confirm 回调注册。

## 两条正交轴

- **轴 A · 授权（谁能用）**：每个外部身份对应一个整数 **level**（缺省 0，封禁=负数）；owner = ∞（经 `owners` 列表命中，**不是**有限数字，无法被设成有限等级）。每个操作有一个 `minLevel`，调用者 `level >= minLevel` 才放行。
- **轴 B · 确认（HITL 意图核验）**：与等级正交，**owner 也是被确认对象**（抵御会话内提示注入借权静默调高危）。由独立的 `plugin-session-confirm` 协调器经 `setConfirmHandler` 注入执行。

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
  skipConfirm?: boolean;             // 受信系统源（scheduler）：仍走 authorize；被拒时不走救援闸；已授权时跳过非 always 的确认
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

  // ── 意图确认与临时能力委托 ──
  // 「未授权」分支专用闸：是否被 owner 预先放行（restrictedPolicy 白名单 / 本会话已有授予）
  // 且不触犯硬禁。绝不询问发起者本人（杜绝自我确认提权）。
  isPreApproved(request: AccessRequest): boolean;
  requestAccess(request: AccessRequest): Promise<boolean>;
  listTemporaryGrants(): TemporaryGrant[];
  revokeGrantsOfCapability(capability: string): number; // 撤销某能力上所有未过期的会话授予，返回撤销条数
  revokeTemporaryGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): () => void; // 返回注销函数，注册方 dispose 时调用

  save(): void;
  listUsers(): AuthorityUserEntry[]; // { platform, userId, isOwner, level, note? }
}
```

## 守卫流程：救援闸与意图确认

执行前 `ExecutionGuard` 委托 `authorize` 裁决（轴 A），被裁决身份取 `actor`，缺省即会话身份（`platform` / `userId`）。之后按裁决结果分两条路径。

**被拒（等级不够 / 硬禁）：救援闸**

- 守卫只查 `isPreApproved`，不询问任何人，发起者无法靠自我确认提权；查不中就拒。
- `isPreApproved` 先过硬禁：命中 `deniedCapabilities` 的能力不可救。再看是否被预先放行：`restrictedPolicy` 白名单（这条路径上只认 owner 本人），或该用户在本会话已有的临时授予。命中即放行，不再走意图确认。
- 救援闸只在被裁决身份就是会话身份时适用。`actor` 覆盖了会话身份（委派、定时、自发回合）时直接拒，发言者的白名单与授予不能替另一个身份放行。
- `skipConfirm` 的受信系统源被拒即拒，不走救援闸。

**已授权且声明了 `confirm`（轴 B）：意图确认**

- 先按 `shouldSkipConfirm` 判断能否跳过：`always` 永不跳过；非 `always` 在 `skipConfirm`、或 auto 模式开启且被裁决身份是 owner 时跳过。
- 否则调 `requestAccess`：`restrictedPolicy` 白名单免确认 → 会话临时授予复用（按 platform + userId + sessionId + capability 匹配）→ 平台 `AccessConfirmHandler`（由 `plugin-session-confirm` 等提供）询问。`confirm:'always'` 只走确认回调。没有确认通道时返回 false，操作被拒。
- 确认应答可返回 `{ allowed: true, grant: { scope: 'session', durationSeconds, maxUses } }`，在该会话窗口内对同一用户的同一能力免确认；`always` 不建立会话授予。
- 确认回复约定：`Y`=本次允许；`YS`=本会话允许（限时）；其它=取消。

## 关键类型（请求 / 决策）

```ts
interface AuthorizeRequest {
  capability: CapabilityId;        // 操作主能力（tool:<name> / command:<name>）
  visibility: CapabilityVisibility; // 主能力默认可见性（无 risk 时作 minLevel 兜底）
  risk?: CapabilityRisk;            // 原始风险（透传，供 minLevel 派生；缺省回退 visibility）
}

interface AccessRequest {
  name: string;
  type: 'command' | 'tool';
  capability: CapabilityId;        // 触达的（受限）能力
  args?: Record<string, unknown>;
  sessionId: string;
  platform: string;
  userId?: string;
  confirm?: CapabilityConfirm;      // 'session' 可按会话记住；'always' 每次都问，不接受白名单与会话记忆
}

interface TemporaryGrantSpec {
  scope: 'once' | 'session';
  durationSeconds?: number;          // 仅 scope=session 有效
  maxUses?: number;                  // 仅 scope=session 有效
}

interface AccessDecision {
  allowed: boolean;
  grant?: TemporaryGrantSpec;
}

// 确认回调：boolean 为最简允许/拒绝；对象可附带临时委托范围
type AccessConfirmHandler = (request: AccessRequest) => Promise<boolean | AccessDecision>;
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
- `restrictedPolicy?: { allow?: string[]; duration?: number }` —— 受限能力临时放行策略（`allow` glob，`['*']` 全放；`duration` 放行时长秒，0=永久）
- `autoConfirmUntil?: number` —— auto 确认模式（owner 临时免 dangerous 二次确认，便于批处理）：epoch ms 截止；-1=一直；0/缺省=关。仅跳过 owner 自己的 session 确认，不动等级/deny，`always` 不跳
- `network?: { blockPrivate?: boolean; denyCidrs?: string[]; allowedPorts?: number[] }` —— 网络出口闸（SSRF 防护）：限制由 LLM/用户 URL 触发的 `safeFetch` 能连到哪

## 管理入口

owner 仅管理权限（无自授）：

- **WebUI authority 页**（owner-only）—— 设等级、管覆盖
- **`/level`** 指令 —— 设某用户的等级
- **`/auto`** 指令 —— 切 auto 确认模式（`autoConfirmUntil`）

## 实现者

- [@aalis/plugin-authority](../plugins/plugin-authority.md)

## 相关

- 权限数据（level / note）存于 `data/users.json`
- 确认轴（HITL）由独立的 `plugin-session-confirm` 协调器经 `setConfirmHandler` 接入
- 用户身份模型 `UserIdentity` 在本 api 包中定义，是全 surface 统一的调用者身份类型
  （WebUI action 的 caller 第三参、scheduler actor 快照等均为该类型）
