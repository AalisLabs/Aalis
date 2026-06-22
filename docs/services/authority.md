# authority 服务

## 1. 定位

访问控制服务：在任何敏感操作的边界回答「这个身份此刻能不能执行这个能力」。它把**数字等级单轴授权**（轴 A）与**人确认 / HITL**（轴 B）两套正交机制，统一收口到一个 `authorize()` 闸 + 一套临时委托 / 确认回调里。

- 服务注册名：`'authority'`（`getService<AuthorityService>('authority')`）。
- 契约包：`@aalis/plugin-authority-api`（接口 + 类型 + `riskDefaults` / `resolveCapabilityPolicy` 纯函数 + `AalisConfig` 的 declaration merging）。
- 参考实现包：`@aalis/plugin-authority`（`provides = ['authority']`，见 `packages/plugin-authority/src/index.ts:27`）。

> 注意：契约文件顶部的 `packages/plugin-authority-api/src/index.ts:1-9` 注释仍残留旧「纯能力委托模型」措辞，但**接口本体与参考实现已是数字等级单轴模型**（`level` / `setUserLevel` / `authorityOverrides` / `minLevel`）。以接口签名与 `authority-model.ts` 的裁决逻辑为准，详见第 7 节。

## 2. 契约（@aalis/plugin-authority-api）

### 2.1 两轴模型的类型

```ts
// packages/plugin-authority-api/src/index.ts:21
export type CapabilityVisibility = 'public' | 'restricted';
// packages/plugin-authority-api/src/index.ts:32
export type CapabilityConfirm = 'session' | 'always';
// packages/plugin-authority-api/src/index.ts:42
export type CapabilityRisk = 'safe' | 'sensitive' | 'dangerous';
```

- 轴 A（授权 / 等级）：`visibility` + `risk` 决定操作的「最低等级」minLevel。
- 轴 B（确认 / HITL）：`confirm` 是否需要「人确认这一步」，与 visibility / 等级正交，**owner 也生效**（防会话内提示注入借权静默调用高危）。

风险声明糖 `risk` 展开为 `(visibility, confirm)` 默认，再被显式 `visibility`/`confirm` 覆盖：

```ts
// packages/plugin-authority-api/src/index.ts:51
const RISK_DEFAULTS = {
  safe:      { visibility: 'public' },
  sensitive: { visibility: 'restricted' },
  dangerous: { visibility: 'restricted', confirm: 'session' },
};
// packages/plugin-authority-api/src/index.ts:61  —— 仅取 risk 推导值，不带兜底（供「未声明=继承」语义的注册方用）
export function riskDefaults(risk?: CapabilityRisk): { visibility?; confirm? }
// packages/plugin-authority-api/src/index.ts:74  —— 展开为生效 (visibility, confirm)，含兜底默认
export function resolveCapabilityPolicy(decl: CapabilityPolicyDecl, defaultVisibility = 'public'): { visibility; confirm? }
```

`resolveCapabilityPolicy` 的优先级：**显式 visibility/confirm > risk 推导 > defaultVisibility**。tools/commands 传 `'public'`（默认放行），WebUI actions 传 `'restricted'`（默认拒）。

### 2.2 服务接口 `AuthorityService`

`packages/plugin-authority-api/src/index.ts:227`：

```ts
export interface AuthorityService {
  // 是否 owner（owners 配置命中 → 拥有 `*`）
  isOwner(platform: string, userId?: string): boolean;                                    // :229

  // 统一权限闸（轴 A）。返回 null 放行；string 为拒绝原因（可直接展示）。
  // 裁决：deniedCapabilities(全局硬禁) > owner(∞) > level >= minLevel
  authorize(identity: UserIdentity | { platform: string; userId?: string },
            request: AuthorizeRequest): string | null;                                    // :237

  // 设 target 外部身份等级（覆盖式整数；level=0 且无备注则清记录）。调用方自保仅 owner 可达。
  setUserLevel(target: UserIdentity, level: number): void;                                // :243
  removeUser(platform: string, userId: string): void;                                     // :246

  // ── 临时能力委托 + 确认（轴 B）──
  // 「未授权」分支专用闸：是否被 owner 预先放行（白名单/本会话已有授予），绝不询问发起者本人
  isPreApproved(request: AccessRequest): boolean;                                          // :253
  // 触达未授予 restricted 能力 / 命中 confirm 时走确认流程（白名单 → 会话授予 → 确认回调）
  requestAccess(request: AccessRequest): Promise<boolean>;                                 // :255
  listTemporaryGrants(): TemporaryGrant[];                                                 // :256
  revokeTemporaryGrant(id: string): boolean;                                               // :257
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): void;                // :258

  save(): void;                                                                            // :260
  listUsers(): AuthorityUserEntry[];                                                       // :261
}
```

关键入参类型：

```ts
// packages/plugin-authority-api/src/index.ts:135
interface AuthorizeRequest { capability: CapabilityId; visibility: CapabilityVisibility; risk?: CapabilityRisk; }
// :149  —— requestAccess / isPreApproved 的入参；confirm='confirm' 性质见 :160
interface AccessRequest { name; type: 'command'|'tool'; capability: CapabilityId; args?; sessionId; platform; userId?; confirm?: CapabilityConfirm; }
// :199  —— 确认回调：boolean 最简允许/拒绝；对象可附临时委托范围
type AccessConfirmHandler = (request: AccessRequest) => Promise<boolean | AccessDecision>;
// :170 / :178
interface TemporaryGrantSpec { scope: 'once'|'session'; durationSeconds?: number; maxUses?: number; }
interface AccessDecision { allowed: boolean; grant?: TemporaryGrantSpec; }
// :206 / :212
interface UserIdentity { platform: string; userId: string; }
interface AuthorityUserEntry { platform; userId; isOwner: boolean; level: number; note?: string; }
```

`CapabilityId` 是 `string`（:14），按惯例为 `<type>:<name>`，如 `tool:exec`、`command:shutdown`（守卫处由 `${g.type}:${g.name}` 拼装，见 `packages/plugin-authority/src/index.ts:55`）。

### 2.3 执行守卫契约（跨切面）

`commands` / `tools` 服务不直接依赖 authority；它们暴露 `setExecutionGuard()`，由 authority 注入一个守卫函数：

```ts
// packages/plugin-authority-api/src/index.ts:93   守卫上下文（执行前最小信息）
interface ExecutionGuardContext {
  name; type: 'command'|'tool';
  visibility: CapabilityVisibility;  // 注册时已由 resolveCapabilityPolicy 展开
  risk?: CapabilityRisk;             // 透传，供派生 minLevel；缺省回退 visibility
  confirm?: CapabilityConfirm;       // 轴 B，owner 也生效
  sessionId; platform; userId?; args?;
  skipConfirm?: boolean;             // 系统/受信源（scheduler）：跳交互确认弹窗，但不绕 authorize
}
// :123  返回 null 放行；返回 string 拦截（值即拒绝原因/提示）
type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;
```

### 2.4 配置字段（declaration merging 注入 `AalisConfig`）

`packages/plugin-authority-api/src/index.ts:270` 把 authority 域业务字段注入 core 的 `AalisConfig`（core 本身不知道任何权限语义）：

| 字段 | 含义 |
|---|---|
| `owners?: UserIdentity[]` | owner 列表，owner = `*`，拥有一切（:273） |
| `deniedCapabilities?: string[]` | 全局能力硬禁（glob），命中即拒，**连 owner 都压过**（:275） |
| `authorityOverrides?: Record<string, number>` | owner 逐条覆盖某操作最低等级（键 `type:name`），优先于 risk/visibility 派生（:278） |
| `confirmOverrides?: Record<string, CapabilityConfirm \| 'off'>` | 逐条覆盖确认要求；`'off'` 强制关闭确认（:285） |
| `restrictedPolicy?: { allow?: string[]; duration?: number }` | 受限能力临时白名单放行（自动化免确认）；`['*']` 全放（:291） |
| `autoConfirmUntil?: number` | owner 临时免 session 确认的截止 epoch ms；`-1` 一直、`0`/缺省 关（:299） |
| `network?: { blockPrivate?; denyCidrs?; allowedPorts? }` | SSRF 出口闸，注入进程级 `safeFetch` 策略（:304，见第 6 节） |

## 3. 谁提供 / 谁消费

**提供方（参考实现）**：`@aalis/plugin-authority`
- 注册：`ctx.provide('authority', authority)`，`packages/plugin-authority/src/index.ts:47`（`new AuthorityManager(...)`）。
- 裁决纯函数：`packages/plugin-authority/src/authority-model.ts`（`resolveAccess` :76、`resolveMinLevel` :48、`riskToLevel` :23、`matchAnyCap` :39、`shouldSkipConfirm` :95、`autoConfirmActive` :86）。
- 策略层 / 状态：`packages/plugin-authority/src/authority-manager.ts`（`AuthorityManager implements AuthorityService`，:25）。
- 数据层：`packages/plugin-authority/src/user-store.ts`（`users.json` 等级存储，经 storage 网关）。

**消费方**：

| 消费点 | 文件:行 | 用法 |
|---|---|---|
| commands / tools 服务 | `packages/plugin-authority/src/index.ts:107` / `:113` | authority 用 `ctx.whenService` 调它们的 `setExecutionGuard(guard)` 注入闸（**反向注入**，非它们 getService authority） |
| plugin-tools 执行点 | `packages/plugin-tools/src/tools.ts:171` | 执行前 `resolveCapabilityPolicy(tool)` → 调 `this._guard({...})`，非 null 即拦截 |
| plugin-session-confirm | `packages/plugin-session-confirm/src/index.ts:151` | `whenService('authority')` → `setConfirmHandler('*', busChannel.handler)` 注册兜底确认通道 |
| plugin-webui-server | `packages/plugin-webui-server/src/index.ts:963` | `setConfirmHandler('webui', ...)` 注册 WS 确认通道 |
| plugin-cli | `packages/plugin-cli/src/index.ts:249` | `setConfirmHandler('cli', ...)` 注册终端确认 |
| WebUI actions | `packages/plugin-authority/src/index.ts:205` | `getOverview` / `setUserLevel` / `setOwners` 等管理面，均 `getService<AuthorityService>('authority')` |

## 4. 写一个 provider（替换默认 authority 实现）

绝大多数作者**不需要**重写 authority——参考实现已覆盖单 owner 个人 bot 的全部场景。只有当你要换一套裁决模型（如接你自己的 RBAC / 外部 IAM）时才重写；那时务必把两套机制都实现完整，否则会破坏全框架的安全边界。

### 4.1 必须实现 vs 可选

`AuthorityService` 全部方法都被消费方调用，没有「可选」方法，但行为侧最小可用集是：

- **必须**：`isOwner`、`authorize`（轴 A）、`requestAccess` + `setConfirmHandler`（轴 B，否则 confirm 能力永远拒）、`isPreApproved`（守卫拒绝后唯一救回路径）、`save`、`listUsers`。
- **管理面用**：`setUserLevel`、`removeUser`、`listTemporaryGrants`、`revokeTemporaryGrant`（被 WebUI/CLI actions 调）。
- **裁决不变量（必须保留）**：`deniedCapabilities` 硬禁 **压过 owner**；`isPreApproved` / `requestAccess` 的「未授权」分支**绝不询问发起者本人**（杜绝自我提权）；`confirm:'always'` 永不被任何 skip 跳过。

### 4.2 注册（ctx.provide）

DI 按名解析：同名 `'authority'` 的胜者 = `preference > priority > 注册顺序`（见 docs/concepts/service-model.md）。要让你的实现盖过参考实现，注册时给更高优先级：

```ts
import { ServicePriority } from '@aalis/core'; // Backend=0 / Override=50 / System=200
ctx.provide('authority', new MyAuthority(...), { priority: ServicePriority.Override }); // 50 > 默认 Backend(0)
```

`provide` 第三参支持 `priority` / `label` 等元数据；按整体框架惯例 per-entry 注册用 `entryId: '${ctx.id}/<sub>'`（authority 是单实例服务，无需子条目）。**不要**仅靠移除参考实现来「让位」——显式优先级更稳。

### 4.3 双源元数据必须同步

`provides` / `inject` 有两套独立元数据源（见 docs/concepts/manifest-metadata.md），代码导出与 package.json 必须一致：

```ts
// src/index.ts
export const provides = ['authority'];
export const inject = { optional: ['commands', 'tools'] }; // 反向注入守卫，故 optional
```
```jsonc
// package.json
{ "aalis": { "service": { "provides": ["authority"], "optional": ["commands", "tools"] } } }
```

### 4.4 可编译最小骨架

```ts
import type { Context, PluginModule } from '@aalis/core';
import type {
  AuthorityService, AuthorizeRequest, AccessRequest, AccessConfirmHandler,
  TemporaryGrant, AuthorityUserEntry, UserIdentity,
} from '@aalis/plugin-authority-api';

export const name = '@aalis/plugin-my-authority';
export const provides = ['authority'];
export const inject = { optional: ['commands', 'tools'] };

class MyAuthority implements AuthorityService {
  private handlers = new Map<string, AccessConfirmHandler>();
  isOwner(platform: string, userId?: string) { /* owners 命中判定 */ return false; }
  authorize(id: { platform: string; userId?: string }, req: AuthorizeRequest): string | null {
    // 1) deniedCapabilities 硬禁（压过 owner） 2) owner 放行 3) level >= minLevel
    return null; // null 放行 / string 拒绝原因
  }
  isPreApproved(_req: AccessRequest): boolean { return false; } // 绝不问发起者本人
  async requestAccess(req: AccessRequest): Promise<boolean> {
    const h = this.handlers.get(req.platform) ?? this.handlers.get('*');
    if (!h) return false;                              // 无确认通道 → 拒
    const d = await h(req);
    return typeof d === 'boolean' ? d : d.allowed;
  }
  setConfirmHandler(platform: string, h: AccessConfirmHandler) { this.handlers.set(platform, h); }
  setUserLevel(_t: UserIdentity, _l: number) {}
  removeUser(_p: string, _u: string) {}
  listTemporaryGrants(): TemporaryGrant[] { return []; }
  revokeTemporaryGrant(_id: string) { return false; }
  listUsers(): AuthorityUserEntry[] { return []; }
  save() {}
}

export async function apply(ctx: Context) {
  const authority = new MyAuthority();
  ctx.provide('authority', authority);
  // 反向注入守卫到 commands / tools（whenService 在其上线/重启各调一次）
  const guard = async (g): Promise<string | null> => {
    const capability = `${g.type}:${g.name}`;
    const denied = authority.authorize({ platform: g.platform, userId: g.userId },
      { capability, visibility: g.visibility, risk: g.risk });
    if (denied) return g.skipConfirm ? denied
      : (authority.isPreApproved({ ...g, capability }) ? null : denied);
    if (g.confirm) { /* 轴 B：requestAccess（参考实现见 src/index.ts:90-102）*/ }
    return null;
  };
  ctx.whenService('commands', (svc: any) => svc.setExecutionGuard?.(guard));
  ctx.whenService('tools', (svc: any) => svc.setExecutionGuard?.(guard));
}
```

## 5. 标准消费姿势

### 5.1 绝大多数插件作者：不直接调 authority

工具/指令的权限**只靠声明**——在注册时标 `risk` / `visibility` / `confirm`，守卫自动生效，**无需手写 `getService('authority')`**：

```ts
// 工具：ToolDefinition 字段 packages/plugin-tools-api/src/index.ts:77-81
tools.register({
  name: 'exec', /* ... */,
  visibility: 'restricted',   // 默认拒，须 owner 或被授等级
  confirm: 'session',         // 执行前需人确认，可本会话记住
  // 或直接用糖：risk: 'dangerous'（= restricted + confirm:'session'）
});
// 真实例：packages/plugin-tool-system/src/tools/shell.ts:139-141（exec 工具）
// 指令：CommandDefinition 同名字段 packages/plugin-commands-api/src/index.ts:83-87
cmds.command('level <target> <n:number>', '设等级', { visibility: 'restricted' }); // src/index.ts:146
```

声明展开与守卫调用：执行点 `resolveCapabilityPolicy(tool)` → `guard({ name, type, visibility, confirm, risk, ... })`，返回 string 即拦截（`packages/plugin-tools/src/tools.ts:171-188`）。

### 5.2 直接消费 authority 服务（管理面 / 自定义 surface）

按框架惯例**每次现取，别缓存**（provider 反弹会失效，见 docs/concepts/lazy-service-access.md）：

```ts
const auth = ctx.getService<AuthorityService>('authority');
if (!auth) throw new Error('Authority 服务不可用'); // 可选依赖：缺失要兜底
if (caller && !auth.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
auth.setUserLevel({ platform, userId }, level);
auth.save();
```

参考真实兜底写法：`packages/plugin-authority/src/index.ts:265-269`（`setUserLevel` action）。新建确认通道的 surface 应 `whenService('authority', a => a.setConfirmHandler('<platform>', handler))`（参考 `packages/plugin-cli/src/index.ts:249`）。

### 5.3 错误边界

- `authorize` 同步返回，`null` = 放行、`string` = 直接可展示的拒绝原因；不要把 string 当成功值。
- `requestAccess` 是 `Promise<boolean>`；无注册的确认通道 → 返回 `false`（拒），别把它当默认放行。
- 守卫返回 string 时，调用方（tools）会以 `{ error }` JSON 返回给 LLM（`tools.ts:184-187`），不抛异常。

## 6. 能力 / 风险 → 影响

### 6.1 裁决优先级（轴 A，`authority-model.ts:76` 的 `resolveAccess`）

首个命中即决：

1. `deniedCapabilities` glob 命中 → **拒**（压过 owner，保 `deny > owner` 不变量；这是配置总闸，非 per-user）。
2. `isOwner` → **放行**（owner = ∞）。
3. `level >= minLevel` → 放行；否则拒（封禁 = 负数，自然连 `minLevel=0` 都不过）。

`minLevel` 解析（`authority-model.ts:48` `resolveMinLevel`）：`authorityOverrides[cap] > risk 派生 > visibility 兜底`。`riskToLevel`（:23）：`dangerous→2 / sensitive→1 / safe|未声明→0`（`DEFAULT_AUTHORITY=0`）；`visibility` 兜底仅在无 risk 时用：`restricted→RESTRICTED_LEVEL(2) / public→0`。owner 等级 `OWNER_RANK = +Infinity`（:16）。

### 6.2 确认轴（轴 B，owner 也吃）

confirm 与等级**正交**，**只对已授权操作做意图确认**（不是提权入口）。守卫顺序：先 `authorize`（轴 A），过了再看 `confirm`（轴 B），见 `packages/plugin-authority/src/index.ts:71-102`。

跳过规则 `shouldSkipConfirm`（`authority-model.ts:95`）：
- `confirm:'always'` → **永不跳过**（cron 等无人确认即拒）。
- `skipConfirm`（系统/受信源如 scheduler）→ 跳交互确认，但**不绕 `authorize`**（仍评估等级，防提权）。
- `auto` 模式且**触发者是 owner 本人** → 跳过（`autoConfirmUntil`，`autoConfirmActive` :86）。

### 6.3 临时委托的隔离不变量

会话临时授予按 **userId + sessionId + capability** 三元匹配（`authority-manager.ts:123-129`、`:182-191`），**群内 sessionId 全群共享时不会跨用户泄漏**——provider 重写时必须保留这个 userId 匹配，否则群里低权用户会白嫖他人的授予。`restrictedPolicy` 白名单的 `duration` 用运行时态 `policyEnabledAt`（不持久化，重启失效，`authority-manager.ts:30`/`:174`）。

### 6.4 网络出口（SSRF）

authority 在 `apply` 时把 `config.network` 注入进程级 `safeFetch` 策略：`setNetworkPolicy(ctx.config.get('network') ?? {})`（`packages/plugin-authority/src/index.ts:51`）。SSRF 防护归属在权限域，但实际守卫在 `@aalis/util-network-guard` 的 `safeFetch`——**由 LLM/用户 URL 触发的出口必须走 `safeFetch`**，本地固定服务（ollama/onebot daemon）走裸 fetch 不受影响。详见 docs/concepts/security-model.md。

## 7. 边界与坑

- **契约注释与实现脱节（文档级，非运行时 bug）**：`packages/plugin-authority-api/src/index.ts:1-9`、`:13-66` 的注释仍以「纯能力委托 / public∪restricted / 委托加减」措辞描述模型，但接口（`authorize` 用 `level/minLevel`、`setUserLevel`、`authorityOverrides`）与参考实现已是**数字等级单轴**。写 provider/consumer 一律以 `AuthorityService` 签名 + `authority-model.ts` 裁决为准。
- **`risk` 在两轴里走不同路径**：守卫把 `risk` 既透传给 `authorize`（派生 minLevel）又用 `resolveCapabilityPolicy` 展开出 `confirm`（`tools.ts:171`）。即 `risk:'dangerous'` 同时抬高最低等级到 2 **且**要求 session 确认；只想要其一时显式写 `visibility`/`confirm` 覆盖。
- **守卫是反向注入，时序敏感**：authority 经 `whenService('commands'|'tools')` 注入守卫（`src/index.ts:107`/`:113`），confirm 通道经 `whenService('authority')` 反注（`session-confirm/src/index.ts:151`）。任何一方未上线时另一方退化：没 authority → tools/commands 无守卫（全放行）；没 confirm 通道 → `requestAccess` 返回 false（confirm 能力全拒）。重写时保持 `whenService`（provider 重启会重新触发），不要用一次性 getService。
- **`autoConfirmUntil` / `restrictedPolicy.enabledAt` 是双状态**：`autoConfirmUntil` 持久化到 config；`policyEnabledAt` 是运行时态不持久化。重启后 `restrictedPolicy` 的 duration 计时归零（需再次触发 `markPolicyEnabled`，见 action `setRestrictedPolicy`，`src/index.ts:304-308`）。
- **owner 判定有内置后门身份**：`platform ∈ {webui, cli}` 且 `userId === 'console'` 恒为 owner（`authority-manager.ts:48`）——本地控制台天然是机主。暴露新的本地 surface 时注意别误用 `console` 这个 userId。
- **`isPreApproved` ≠ `requestAccess`**：守卫「未授权」分支只能调 `isPreApproved`（不问人），**绝不能**调 `requestAccess`（那会向发起者弹确认 = 自我提权）。这是参考实现修过的 bug，重写时务必区分（`src/index.ts:78-83` 注释）。

## 8. 交叉链接

- docs/core/authority.md — 权限系统总览（数字等级单轴的设计与配置面）。
- docs/concepts/security-model.md — 威胁模型、SSRF / `safeFetch`、插件作者责任边界。
- docs/services/session-confirm.md — confirm 通道（`AccessConfirmHandler` 的实际实现：bus / WS / 终端）。
- docs/concepts/service-model.md — DI 按名解析、`ServicePriority`、覆盖同名服务。
- docs/concepts/lazy-service-access.md — 为什么消费 authority 要每次现取、不缓存。
- docs/concepts/manifest-metadata.md — `provides`/`inject` 双源元数据同步。
- docs/concepts/storage-uri-grammar.md — `users.json` 等级存储经 storage 网关；storage 不是沙盒。
- docs/core/tools.md / docs/core/commands.md — 工具/指令如何声明 `risk`/`visibility`/`confirm`。
