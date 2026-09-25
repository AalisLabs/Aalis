# authority 服务

## 1. 定位

访问控制服务：在任何敏感操作的边界回答「这个身份此刻能不能执行这个能力」。它把**数字等级单轴授权**（轴 A）与**人确认 / HITL**（轴 B）两套正交机制，统一收敛到一个 `authorize()` 闸 + 一套临时委托 / 确认回调里。

- 服务注册名：`'authority'`（`authority.current`）。
- 契约包：`@aalis/api-authority`（接口 + 类型 + `riskDefaults` / `resolveCapabilityPolicy` 纯函数 + 对 `@aalis/api-host-config` 的 `AalisConfig` 的 declaration merging）。
- 参考实现包：`@aalis/plugin-authority`（`provides: [authority]`，见 `packages/plugin-authority/src/index.ts`）。

## 2. 契约（@aalis/api-authority）

### 2.1 两轴模型的类型

```ts
// packages/api-authority/src/index.ts
export type CapabilityVisibility = 'public' | 'restricted';
// packages/api-authority/src/index.ts
export type CapabilityConfirm = 'session' | 'always';
// packages/api-authority/src/index.ts
export type CapabilityRisk = 'safe' | 'sensitive' | 'dangerous';
```

- 轴 A（授权 / 等级）：`visibility` + `risk` 决定操作的「最低等级」minLevel。
- 轴 B（确认 / HITL）：`confirm` 是否需要「人确认这一步」，与 visibility / 等级正交，**owner 也生效**（防会话内提示注入借权静默调用高危）。

风险声明糖 `risk` 展开为 `(visibility, confirm)` 默认，再被显式 `visibility`/`confirm` 覆盖：

```ts
// packages/api-authority/src/index.ts
const RISK_DEFAULTS = {
  safe:      { visibility: 'public' },
  sensitive: { visibility: 'restricted' },
  dangerous: { visibility: 'restricted', confirm: 'session' },
};
// packages/api-authority/src/index.ts  —— 仅取 risk 推导值，不带兜底（供「未声明=继承」语义的注册方用）
export function riskDefaults(risk?: CapabilityRisk): { visibility?; confirm? }
// packages/api-authority/src/index.ts  —— 展开为生效 (visibility, confirm)，含兜底默认
export function resolveCapabilityPolicy(decl: CapabilityPolicyDecl, defaultVisibility = 'public'): { visibility; confirm? }
```

`resolveCapabilityPolicy` 的优先级：**显式 visibility/confirm > risk 推导 > defaultVisibility**（缺省 `'public'`，即默认放行）。

### 2.2 服务接口 `AuthorityService`

`packages/api-authority/src/index.ts`：

```ts
export interface AuthorityService {
  // 是否 owner（owners 配置命中 → 拥有 `*`）
  isOwner(platform: string, userId?: string): boolean;

  // 统一权限闸（轴 A）。返回 null 放行；string 为拒绝原因（可直接展示）。
  // 裁决：deniedCapabilities(全局硬禁) > owner(∞) > level >= minLevel
  authorize(identity: UserIdentity | { platform: string; userId?: string },
            request: AuthorizeRequest): string | null;

  // 设 target 外部身份等级（覆盖式整数；level=0 且无备注则清记录）。调用方自保仅 owner 可达。
  setUserLevel(target: UserIdentity, level: number): void;
  removeUser(platform: string, userId: string): void;

  // ── 临时能力委托 + 确认（轴 B）──
  // 「未授权」分支专用闸：是否被 owner 预先放行（白名单/本会话已有授予），绝不询问发起者本人
  isPreApproved(request: AccessRequest): boolean;
  // 已授权但声明 confirm 时的意图确认（白名单 → 会话授予 → 确认回调；always 只走确认回调）
  requestAccess(request: AccessRequest): Promise<boolean>;
  listTemporaryGrants(): TemporaryGrant[];
  revokeGrantsOfCapability(capability: string): number;                                   // 撤销某能力上所有未过期的会话授予，返回撤销条数
  revokeTemporaryGrant(id: string): boolean;
  setConfirmHandler(platform: string, handler: AccessConfirmHandler): () => void;          // 返回注销函数
  // 注：plugin-authority 的 AuthorityManager 另有 hasConfirmHandler(platform)，供其自身守卫区分
  // 「被拒」与「没有确认通道」；它是实现内部方法，不在本契约面上，第三方实现无需提供。

  save(): void;
  listUsers(): AuthorityUserEntry[];
}
```

关键入参类型：

```ts
// packages/api-authority/src/index.ts
interface AuthorizeRequest { capability: CapabilityId; visibility: CapabilityVisibility; risk?: CapabilityRisk; }
// requestAccess / isPreApproved 的入参；confirm 为操作的生效确认要求（'session' | 'always'）
interface AccessRequest { name; type: 'command'|'tool'; capability: CapabilityId; args?; sessionId; platform; userId?; confirm?: CapabilityConfirm; }
// 确认回调：boolean 最简允许/拒绝；对象可附临时委托范围
type AccessConfirmHandler = (request: AccessRequest) => Promise<boolean | AccessDecision>;
interface TemporaryGrantSpec { scope: 'once'|'session'; durationSeconds?: number; maxUses?: number; }
interface AccessDecision { allowed: boolean; grant?: TemporaryGrantSpec; }
interface UserIdentity { platform: string; userId: string; }
interface AuthorityUserEntry { platform; userId; isOwner: boolean; level: number; note?: string; }
```

`CapabilityId` 是 `string`，按惯例为 `<type>:<name>`，如 `tool:exec`、`command:shutdown`（守卫处由 `${g.type}:${g.name}` 拼装，见 `packages/plugin-authority/src/index.ts`）。

### 2.3 执行守卫契约（跨切面）

`commands` / `tools` 服务不直接依赖 authority；它们暴露 `setExecutionGuard()`，由 authority 注入一个守卫函数：

```ts
// packages/api-authority/src/index.ts   守卫上下文（执行前最小信息）
interface ExecutionGuardContext {
  name; type: 'command'|'tool';
  visibility: CapabilityVisibility;  // 注册时已由 resolveCapabilityPolicy 展开
  risk?: CapabilityRisk;             // 透传，供派生 minLevel；缺省回退 visibility
  confirm?: CapabilityConfirm;       // 轴 B，owner 也生效
  sessionId; platform; userId?; args?;
  skipConfirm?: boolean;             // 系统/受信源（scheduler）：仍走 authorize；被拒时不走救援闸；已授权时跳过非 always 的确认
}
// 返回 null 放行；返回 string 拦截（值即拒绝原因/提示）
type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<string | null>;
```

### 2.4 配置字段（declaration merging 注入 `AalisConfig`）

`packages/api-authority/src/index.ts` 把 authority 域业务字段注入 `@aalis/api-host-config` 的 `AalisConfig`（配置文档契约本身不知道任何权限语义）。这些字段位于配置文档顶层，参考实现经 `host-config` 服务读取，改动后以 `save()` 落盘：

| 字段 | 含义 |
|---|---|
| `owners?: UserIdentity[]` | owner 列表，owner = `*`，拥有一切 |
| `deniedCapabilities?: string[]` | 全局能力硬禁（glob），命中即拒，**连 owner 都压过** |
| `authorityOverrides?: Record<string, number>` | owner 逐条覆盖某操作最低等级（键 `type:name`），优先于 risk/visibility 派生 |
| `confirmOverrides?: Record<string, CapabilityConfirm \| 'off'>` | 逐条覆盖确认要求；`'off'` 强制关闭确认 |
| `restrictedPolicy?: { allow?: string[]; duration?: number }` | 受限能力临时白名单放行（自动化免确认）；`['*']` 全放 |
| `autoConfirmUntil?: number` | owner 临时免 session 确认的截止 epoch ms；`-1` 一直/缺省 关 |
| `network?: { blockPrivate?; denyCidrs?; allowedPorts? }` | SSRF 出口闸，注入进程级 `safeFetch` 策略（见第 6 节） |

## 3. 谁提供 / 谁消费

**提供方（参考实现）**：`@aalis/plugin-authority`
- 注册：`provide(authority, authority)`，`packages/plugin-authority/src/index.ts`（`new AuthorityManager(...)`）。
- 裁决纯函数：`packages/plugin-authority/src/authority-model.ts`（`resolveAccess` / `resolveMinLevel` / `matchAnyCap` / `shouldSkipConfirm` / `autoConfirmActive`）；risk→等级的映射本身在 `@aalis/api-authority` 的 `capabilityMinLevel`。
- 策略层 / 状态：`packages/plugin-authority/src/authority-manager.ts`（`AuthorityManager implements AuthorityService`）。
- 数据层：`packages/plugin-authority/src/user-store.ts`（`users.json` 等级存储，经 storage 网关）。

**消费方**：

| 消费点 | 文件 | 用法 |
|---|---|---|
| commands / tools 服务 | `packages/plugin-authority/src/index.ts` | `commands.follow` / `tools.follow` 调 `setExecutionGuard(guard)` 注入闸（反向注入，不返回 cleanup） |
| plugin-tools 执行点 | `packages/plugin-tools/src/tools.ts` | 执行前 `resolveCapabilityPolicy(tool)` → 调 `this._guard({...})`，非 null 即拦截 |
| plugin-session-confirm | `packages/plugin-session-confirm/src/index.ts` | `authority.follow(provider => provider.setConfirmHandler('*', busChannel.handler))` 注册兜底确认通道 |
| plugin-webui-server | `packages/plugin-webui-server/src/index.ts` | `setConfirmHandler('webui', ...)` 注册 WS 确认通道 |
| plugin-cli | — | 无自有通道，落 session-confirm 的 `'*'` 兜底 |
| WebUI actions | `packages/plugin-authority/src/index.ts` | `getOverview` / `setUserLevel` / `setOwners` 等管理面，经闭包里本次激活的 manager 调用 |

## 4. 写一个 provider（替换默认 authority 实现）

绝大多数作者**不需要**重写 authority——参考实现已覆盖单 owner 个人 bot 的全部场景。只有当你要换一套裁决模型（如接你自己的 RBAC / 外部 IAM）时才重写；那时务必把两套机制都实现完整，否则会破坏全框架的安全边界。

### 4.1 必须实现 vs 可选

`AuthorityService` 没有「可选」方法。第一方插件跨包只调用 `isOwner`、`listUsers`、`setConfirmHandler`，其余方法由参考实现自己的守卫与管理面使用，是替换实现时需要提供的完整面。行为侧最小可用集是：

- **必须**：`isOwner`、`authorize`（轴 A）、`requestAccess` + `setConfirmHandler`（轴 B，否则 confirm 能力永远拒）、`isPreApproved`（守卫拒绝后唯一补救路径）、`save`、`listUsers`。
- **管理面用**：`setUserLevel`、`removeUser`、`listTemporaryGrants`、`revokeTemporaryGrant`（被 WebUI/CLI actions 调）。
- **裁决不变量（必须保留）**：`deniedCapabilities` 硬禁 **压过 owner**；守卫的「未授权」分支只调 `isPreApproved`，**绝不询问发起者本人**（杜绝自我提权）；`confirm:'always'` 永不被任何 skip 跳过。

### 4.2 注册（provide）

DI 按名解析：同名 `'authority'` 的胜者 = `preference > priority > 注册顺序`（见 docs/concepts/service-model.md）。要让你的实现覆盖参考实现，注册时给更高优先级：

```ts
provide(authority, new MyAuthority(...), { priority: 50 }); // 高于默认 0 即覆盖
```

`provide` 第三参支持 `priority` / `label` 等元数据；按整体框架惯例 per-entry 注册用 `entryId: '${lifecycle.id}/<sub>'`（authority 是单实例服务，无需子条目）。**不要**仅靠移除参考实现来「让位」——显式优先级更明确可靠。

### 4.3 双源元数据必须同步

`provides` / `uses` 有两套独立元数据源（见 docs/concepts/manifest-metadata.md），代码导出与 package.json 必须一致：

```ts
// src/index.ts
provides: [authority];
uses: { commands: optional(commands), tools: optional(tools) }; // 反向注入守卫，故 optional
```
```jsonc
// package.json
{ "aalis": { "service": { "provides": ["authority"], "optional": ["commands", "tools"] } } }
```

### 4.4 可编译最小骨架

```ts
import { authority } from '@aalis/api-authority';
import type {
  AccessConfirmHandler,
  AccessRequest,
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  ExecutionGuardContext,
  TemporaryGrant,
  UserIdentity,
} from '@aalis/api-authority';
import { commands } from '@aalis/api-commands';
import { tools } from '@aalis/api-tools';
import { definePlugin, optional, provide } from '@aalis/core';

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
  setConfirmHandler(platform: string, h: AccessConfirmHandler) {
    this.handlers.set(platform, h);
    return () => { if (this.handlers.get(platform) === h) this.handlers.delete(platform); }; // 只摘自己
  }
  setUserLevel(_t: UserIdentity, _l: number) {}
  removeUser(_p: string, _u: string) {}
  listTemporaryGrants(): TemporaryGrant[] { return []; }
  revokeGrantsOfCapability(_capability: string) { return 0; }
  revokeTemporaryGrant(_id: string) { return false; }
  listUsers(): AuthorityUserEntry[] { return []; }
  save() {}
}

export default definePlugin({
  name: '@aalis/plugin-my-authority',
  provides: [authority],
  uses: { provide, commands: optional(commands), tools: optional(tools) },
  apply({ provide, commands, tools }) {
    const impl = new MyAuthority();
    provide(authority, impl);
    const guard = async (g: ExecutionGuardContext): Promise<string | null> => {
      const capability = `${g.type}:${g.name}`;
      return impl.authorize({ platform: g.platform, userId: g.userId }, {
        capability, visibility: g.visibility, risk: g.risk,
      });
    };
    // 不返回 cleanup：契约没有「摘掉守卫」的口，守卫随旧实例一起消失
    commands.follow(svc => { svc.setExecutionGuard(guard); });
    tools.follow(svc => { svc.setExecutionGuard(guard); });
  },
});
```

## 5. 标准消费方式

### 5.1 绝大多数插件作者：不直接调 authority

工具/指令的权限**只靠声明**——在注册时标 `risk` / `visibility` / `confirm`，守卫自动生效，**无需手写 `authority.current`**：

```ts
// 工具：ToolDefinition 字段 packages/api-tools/src/index.ts
tools.register({
  name: 'exec', /* ... */,
  visibility: 'restricted',   // 默认拒，须 owner 或被授等级
  confirm: 'session',         // 执行前需人确认，可本会话记住
  // 或直接用糖：risk: 'dangerous'（= restricted + confirm:'session'）
});
// 真实例：packages/plugin-tool-system/src/tools/shell.ts（exec 工具）
// 指令：CommandDefinition 同名字段 packages/api-commands/src/index.ts
cmds.command('level <target> <n:number>', '设等级', { visibility: 'restricted' }); // packages/plugin-authority/src/index.ts
```

声明展开与守卫调用：执行点 `resolveCapabilityPolicy(tool)` → `guard({ name, type, visibility, confirm, risk, ... })`，返回 string 即拦截（`packages/plugin-tools/src/tools.ts`）。

### 5.2 直接消费 authority 服务（管理面 / 自定义 surface）

按框架惯例**每次现取、不缓存**（provider 反弹会失效，见 docs/concepts/lazy-service-access.md）：

```ts
const auth = authority.current;
if (!auth) throw new Error('Authority 服务不可用'); // 可选依赖：缺失要兜底
if (caller && !auth.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
auth.setUserLevel({ platform, userId }, level);
auth.save();
```

消费方判空的真实写法见 `packages/plugin-commands/src/index.ts`、`packages/plugin-user-profile/src/index.ts`（`authority.current` 缺席时，前者按非 owner、等级 0 处理，后者直接跳过指令提取）。新建确认通道的 surface 应 `authority.follow(provider => provider.setConfirmHandler('<platform>', handler))`——回调直接返回注销函数，作为 follow 的 cleanup，authority 换胜者或本插件 dispose 时自动注销（参考 `packages/plugin-session-confirm/src/index.ts`）。

### 5.3 错误边界

- `authorize` 同步返回，`null` = 放行、`string` = 直接可展示的拒绝原因；不要把 string 当成功值。
- `requestAccess` 是 `Promise<boolean>`；无注册的确认通道 → 返回 `false`（拒），别把它当默认放行。
- 守卫返回 string 时，调用方（tools）会以 `{ error }` JSON 返回给 LLM（`tools.ts`），不抛异常。

## 6. 能力 / 风险 → 影响

### 6.1 裁决优先级（轴 A，`authority-model.ts` 的 `resolveAccess`）

首个命中即决：

1. `deniedCapabilities` glob 命中 → **拒**（压过 owner，保 `deny > owner` 不变量；这是配置总闸，非 per-user）。
2. `isOwner` → **放行**（owner = ∞）。
3. `level >= minLevel` → 放行；否则拒（封禁 = 负数，自然连 `minLevel=0` 都不过）。

`minLevel` 解析（`authority-model.ts` `resolveMinLevel`）：`authorityOverrides[cap] > risk 派生 > visibility 兜底`。`capabilityMinLevel`（在 `@aalis/api-authority`）：`dangerous→2 / sensitive→1 / safe|未声明→0`（`DEFAULT_AUTHORITY=0`）；`visibility` 兜底仅在无 risk 时用：`restricted→RESTRICTED_LEVEL(2) / public→0`。owner 等级 `OWNER_RANK = +Infinity`。

### 6.2 确认轴（轴 B，对 owner 同样生效）

confirm 与等级**正交**，**只对已授权操作做意图确认**（不是提权入口）。守卫顺序：先 `authorize`（轴 A），过了再看 `confirm`（轴 B），见 `packages/plugin-authority/src/index.ts`。

跳过规则 `shouldSkipConfirm`（`authority-model.ts`）：
- `confirm:'always'` → **永不跳过**（cron 等无人确认即拒）。
- `skipConfirm`（系统/受信源如 scheduler）→ 跳交互确认，但**不绕 `authorize`**（仍评估等级，防提权）。
- `auto` 模式且**触发者是 owner 本人** → 跳过（`autoConfirmUntil`，`autoConfirmActive`）。

### 6.3 临时委托的隔离不变量

会话临时授予按 **platform + userId + sessionId + capability** 四元匹配（`authority-manager.ts` `isTemporarilyAllowed`），**群内 sessionId 全群共享时不会跨用户泄漏，跨平台同名 id 也不会互相命中**——provider 重写时必须保留 userId 与 platform 匹配，否则群里低权用户会盗用他人的授予。`restrictedPolicy` 白名单的 `duration` 用运行时态 `policyEnabledAt`（不持久化，重启失效，`authority-manager.ts`）。

### 6.4 网络出口（SSRF）

authority 在 `apply` 时把 `config.network` 注入进程级 `safeFetch` 策略：`setNetworkPolicy(config.get('network') ?? {})`（`packages/plugin-authority/src/index.ts`）。SSRF 防护归属在权限域，但实际守卫在 `@aalis/util-network-guard` 的 `safeFetch`——**由 LLM/用户 URL 触发的出口必须走 `safeFetch`**，本地固定服务（ollama/onebot daemon）走裸 fetch 不受影响。详见 docs/concepts/security-model.md。

## 7. 边界与注意事项

- **`risk` 在两轴里走不同路径**：守卫把 `risk` 既透传给 `authorize`（派生 minLevel）又用 `resolveCapabilityPolicy` 展开出 `confirm`（`tools.ts`）。即 `risk:'dangerous'` 同时抬高最低等级到 2 **且**要求 session 确认；只想要其一时显式写 `visibility`/`confirm` 覆盖。
- **守卫是反向注入，时序敏感**：authority 经 `commands.follow` / `tools.follow` 注入守卫（`packages/plugin-authority/src/index.ts`），confirm 通道经 `authority.follow` 反注（`packages/plugin-session-confirm/src/index.ts`）。任何一方未上线时另一方退化：没 authority → tools/commands 无守卫（全放行）；没 confirm 通道 → `requestAccess` 返回 false（confirm 能力全拒）。重写时保持 `follow`（provider 重启会重新触发），不要用一次性 `services.get`（无依赖边）。
- **`autoConfirmUntil` / `restrictedPolicy.enabledAt` 是双状态**：`autoConfirmUntil` 持久化到 config；`policyEnabledAt` 是运行时态不持久化。重启后 `restrictedPolicy` 的 duration 计时归零（需再次触发 `markPolicyEnabled`，见 action `setRestrictedPolicy`，`src/index.ts`）。
- **owner 判定含内置本地控制台身份**：`platform ∈ {webui, cli}` 且 `userId === 'console'` 恒为 owner（`authority-manager.ts`）。这是设计而非后门——`platform` 由适配器填写，远端用户无法伪造成 `cli`/`webui`，能填这两个平台名的只有本进程内代码（已具完全能力）。因此新增平台适配器**不得**把自身 platform 命名为 `cli` 或 `webui`；暴露新的本地 surface 时也注意别误用 `console` 这个 userId。
- **`isPreApproved` ≠ `requestAccess`**：守卫「未授权」分支只能调 `isPreApproved`（不询问发起者），**绝不能**调 `requestAccess`（那会向发起者弹确认 = 自我提权）。这是参考实现修过的 bug，重写时务必区分（`src/index.ts` 注释）。

## 8. 交叉链接

- docs/plugins/plugin-authority.md — 权限系统总览（数字等级单轴的设计与配置面）。
- docs/concepts/security-model.md — 威胁模型、SSRF / `safeFetch`、插件作者责任边界。
- docs/services/session-confirm.md — confirm 通道（`AccessConfirmHandler` 的实际实现：bus / WS / 终端）。
- docs/concepts/service-model.md — DI 按名解析、priority、覆盖同名服务。
- docs/concepts/lazy-service-access.md — 为什么消费 authority 要每次现取、不缓存。
- docs/concepts/manifest-metadata.md — `provides`/`uses` 双源元数据同步。
- docs/concepts/storage-uri-grammar.md — `users.json` 等级存储经 storage 网关；storage 不是沙盒。
- docs/plugins/plugin-tools.md / docs/plugins/plugin-commands.md — 工具/指令如何声明 `risk`/`visibility`/`confirm`。
