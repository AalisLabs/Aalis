# authority 服务

## 1. 定位

访问控制服务：在任何敏感操作的边界回答「这个身份此刻能不能执行这个能力」。它把**等级与权限组授权**（轴 A）与**人确认 / HITL**（轴 B）两套正交机制收敛到一个 `authorize()` 闸与执行守卫里：工具的确认交给 owner 审批（`approvals`），指令的确认向发出者本人核对意图。

- 服务注册名：`'authority'`（消费方经 `authority.use` 调用）。
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

  // owner 在这个平台登记的账号：配置 owners 里这个平台的第一个，没有时为 undefined；本机控制台身份不算
  ownerOn(platform: string): UserIdentity | undefined;

  // 这一轮从哪里来（api-approval 的 OriginKind）：只看消息事实，不看会话类型与受众，不判是不是 owner，不按授权身份判
  originOf(turn: OriginTurn): OriginKind;

  // 这一轮的主体，定本地效果：hand（含随起它的那一轮的续做与子任务）且参与者都是 owner 的为 owner；其余 other
  principalOf(turn: OriginTurn): 'owner' | 'other';

  // 统一权限闸（轴 A）。返回 null 放行；string 为拒绝原因（可直接展示）。
  // 裁决：deniedCapabilities(全局硬禁) > owner(∞) > 封禁(level < 0) > level >= minLevel > 所属权限组覆盖
  authorize(identity: UserIdentity | { platform: string; userId?: string },
            request: AuthorizeRequest): string | null;

  // 设 target 外部身份等级（覆盖式整数；level=0 且记录里没有备注等别的内容则清记录）。调用方自保仅 owner 可达。
  setUserLevel(target: UserIdentity, level: number): void;
  removeUser(platform: string, userId: string): void;

  save(): void;
  listUsers(): AuthorityUserEntry[];
}
```

关键入参类型：

```ts
// packages/api-authority/src/index.ts
interface AuthorizeRequest { capability: CapabilityId; visibility: CapabilityVisibility; risk?: CapabilityRisk; toolGroups?: readonly string[]; }
interface UserIdentity { platform: string; userId: string; }
interface AuthorityUserEntry { platform; userId; isOwner: boolean; level: number; note?: string; }
type OriginTurn = Pick<ExecutionGuardContext, 'sessionId' | 'platform' | 'userId' | 'participants' | 'inbound'>;
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
  participants: readonly UserIdentity[]; // 这一轮的参与者（授权身份）：对每个参与者各裁决一次；指令一路是发出者
  toolGroups?: readonly string[];    // 工具所属的工具分组（工具一路由执行器填）：原样转给 authorize，权限组的 tool-group: 条目按它覆盖
  skipConfirm?: boolean;             // 受信来源（scheduler 触发的指令、runtime 子命令）：仍走 authorize；已授权且参与者都是 owner 时跳过非 always 的确认
  turnId?; callId?;                  // 工具调用所在回合与这次调用的 id（agent 工具循环填写）
  inbound?: InboundTurn;             // { source?, fromTurn?, messageId? }：调用所在的入站回合，判发起类别用
  confirmIntent?: () => Promise<boolean>; // 指令用：向发出者本人核对意图
  signal?: AbortSignal;              // 回合中止信号：等审批期间中止即撤销
  check?: (who: UserIdentity) => Verdict; // 取用判定（工具调用上下文的 approveFor 交来）：代替等级裁决，不再判确认
}
// 放行 { ok: true, by? }（by 是批的人，经审批放行才有）；拦截 { ok: false, reason }
type ExecutionGuard = (ctx: ExecutionGuardContext) => Promise<Verdict>;
```

没有注入守卫时，参考实现 plugin-tools / plugin-commands 按 fail-closed 处理：等同所有人都是默认等级（`DEFAULT_AUTHORITY`）、没人能确认。`capabilityMinLevel` 高于默认等级或声明了 `confirm` 的操作一律拒绝，其余照常执行。

### 2.4 配置字段（declaration merging 注入 `AalisConfig`）

`packages/api-authority/src/index.ts` 把 authority 域业务字段注入 `@aalis/api-host-config` 的 `AalisConfig`（配置文档契约本身不知道任何权限语义）。这些字段位于配置文档顶层，参考实现经 `host-config` 服务读取，改动后以 `save()` 落盘：

| 字段 | 含义 |
|---|---|
| `owners?: UserIdentity[]` | owner 列表，owner = `*`，拥有一切 |
| `deniedCapabilities?: string[]` | 全局能力硬禁（glob），命中即拒，**连 owner 都压过** |
| `authorityOverrides?: Record<string, number>` | owner 逐条覆盖某操作最低等级（键 `type:name`），优先于 risk/visibility 派生 |
| `confirmOverrides?: Record<string, CapabilityConfirm \| 'off'>` | 逐条覆盖确认要求；`'off'` 关闭确认，只对参与者都是 owner 的回合生效，有别人的回落到插件的声明 |
| `restrictedPolicy?: { allow?: string[]; duration?: number }` | 免确认白名单（给自动化）；`['*']` 全放。只免 `session` 档，只对参与者都是 owner 的回合生效，不放宽授权 |
| `authorityGroups?: Record<string, string[]>` | 权限组：组名 → 放行条目（`tool:…`、`command:…` 可带通配，`tool-group:<分组名>`）；只加放行，硬禁与封禁照旧先拒。成员记在参考实现的 users.json 里 |
| `network?: { blockPrivate?; denyCidrs?; allowedPorts? }` | SSRF 出口闸，注入进程级网络策略，`safeFetch` 与 tool-browser 的浏览器网络闸都按它判定（见第 6 节） |

## 3. 谁提供 / 谁消费

**提供方（参考实现）**：`@aalis/plugin-authority`。工具的确认与参与者审批经 `approvals`（`@aalis/api-approval`，由 plugin-session-server 提供）请能批的人审批（要确认的只有 owner 能批），它缺席时要审批的工具调用一律拒绝。
- 注册：`caps.provide.use(authority, manager)`，`packages/plugin-authority/src/index.ts`（`new AuthorityManager(...)`）。
- 裁决纯函数：`packages/plugin-authority/src/authority-model.ts`（`resolveAccess` / `resolveMinLevel` / `matchAnyCap` / 发起回合类别 `originKind`）；risk→等级的映射本身在 `@aalis/api-authority` 的 `capabilityMinLevel`。
- 策略层 / 状态：`packages/plugin-authority/src/authority-manager.ts`（`AuthorityManager implements AuthorityService`）。
- 数据层：`packages/plugin-authority/src/user-store.ts`（`users.json` 等级存储，经 storage 服务）。

**消费方**：

| 消费点 | 文件 | 用法 |
|---|---|---|
| commands / tools 服务 | `packages/plugin-authority/src/index.ts` | `commands.follow` / `tools.follow` 调 `setExecutionGuard(guard)` 注入闸（反向注入），返回的清理调 `setExecutionGuard(undefined)` 摘掉 |
| plugin-tools 执行点 | `packages/plugin-tools/src/tools.ts` | 执行前 `resolveCapabilityPolicy(tool)` → 调 `this._guard({...})`（带上工具的分组 `toolGroups`），非 null 即拦截 |
| plugin-commands 执行点 | `packages/plugin-commands/src/index.ts` | 人亲手输入的指令带 `confirmIntent`，守卫需要确认时经它问发出者本人 |
| plugin-gateway 入站 | `packages/plugin-gateway/src/index.ts` | 以 `isOwner` 作 `roomClass` 的 owner 谓词判会话的房间类别，`owner-only` 的跳过触发与流控（结构性放行）；缺席时没有人是 owner |
| plugin-file-reader 附件描述 | `packages/plugin-file-reader/src/index.ts` | 以 `isOwner` 作 `roomClass` 的 owner 谓词判会话的房间类别，`room` 的不内联上传的文件；缺席时没有人是 owner |
| 入站正文的发送者前缀 | `packages/api-message-archive/src/index.ts`（`speakerOf`，plugin-message-archive、plugin-trigger-laya、plugin-agent 调） | 以 `isOwner` 判房间类别与授权身份是不是 owner，owner 从别的平台往房间里插话时以 `ownerOn` 取 owner 在房间所在平台登记的账号写进前缀；缺席时没有人是 owner |
| 权限页 | `packages/plugin-authority/src/index.ts` | 设置里的声明式页面（用户等级、权限组、owner、操作门槛、禁用与免确认），处理函数经闭包里本次激活的 manager 调用；组成员的读写（`setUserGroups`、带组的用户列表）只在 manager 上，不在契约里 |

## 4. 写一个 provider（替换默认 authority 实现）

绝大多数作者**不需要**重写 authority——参考实现已覆盖单 owner 个人 bot 的全部场景。只有当你要换一套裁决模型（如接你自己的 RBAC / 外部 IAM）时才重写；那时务必把两套机制都实现完整，否则会破坏全框架的安全边界。

### 4.1 必须实现 vs 可选

`AuthorityService` 没有「可选」方法。第一方插件跨包只调用 `isOwner`、`ownerOn`（存档、触发判定与 agent 据它写发送者前缀）、`principalOf`（触及服务据它定主体）、`listUsers`，其余方法由参考实现自己的守卫与管理面使用，是替换实现时需要提供的完整面。行为侧最小可用集是：

- **必须**：`isOwner`、`ownerOn`、`originOf`、`principalOf`、`authorize`（轴 A）、`save`、`listUsers`，以及注入 commands / tools 的执行守卫（轴 B 在守卫里完成）。
- **管理面用**：`setUserLevel`、`removeUser`（权限页的等级动作与 `/level` 调）。权限组的成员（`setUserGroups`）只在参考实现上，替换实现要自己提供管理入口。
- **裁决不变量（必须保留）**：`deniedCapabilities` 硬禁 **压过 owner**；封禁先于等级与组，所属组只加放行；等级不够、所属组也不覆盖即拒，**绝不询问发起者本人**（杜绝自我提权）；`confirm:'always'` 永不被任何 skip 跳过；对每个参与者各裁决一次，有人做不了时只产生审批、由自己就能做的人批，谁都做不了照旧拒；工具的确认只经 owner 审批，发起类别按这一轮从哪里来判、不按授权身份判，人亲手发起的一轮（含它的续做与子任务，不论在哪个会话）、参与者里有人能批才能产生审批。

### 4.2 注册（provide）

DI 按名解析：同名 `'authority'` 的多家提供者中，消费方选中哪一家按「本插件偏好 > 全局偏好 > priority > 注册顺序」（见 docs/concepts/service-model.md）。要让你的实现覆盖参考实现，注册时给更高优先级：

```ts
provide.use(authority, new MyAuthority(...), { priority: 50 }); // 高于默认 0 即覆盖
```

`provide.use` 第三参支持 `priority` / `label` 等元数据；按整体框架惯例 per-entry 注册用 `entryId: '${lifecycle.use.id}/<sub>'`（authority 是单实例服务，无需子条目）。**不要**仅靠移除参考实现来「让位」——显式优先级更明确可靠。

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
import type { OriginKind } from '@aalis/api-approval';
import { authority } from '@aalis/api-authority';
import type {
  AuthorityService,
  AuthorityUserEntry,
  AuthorizeRequest,
  ExecutionGuardContext,
  OriginTurn,
  UserIdentity,
  Verdict,
} from '@aalis/api-authority';
import { commands } from '@aalis/api-commands';
import { tools } from '@aalis/api-tools';
import { definePlugin, optional, provide } from '@aalis/core';

class MyAuthority implements AuthorityService {
  isOwner(platform: string, userId?: string) { /* owners 命中判定 */ return false; }
  ownerOn(_p: string): UserIdentity | undefined { return undefined; }
  originOf(turn: OriginTurn): OriginKind {
    // 按这一轮从哪里来判：不在入站回合里为 autonomous，续做与子任务随起它的那一轮……（判据见 plugin-authority）
    return 'autonomous';
  }
  principalOf(turn: OriginTurn): 'owner' | 'other' {
    // hand 且参与者都是 owner 为 owner（判据见 plugin-authority）
    return 'other';
  }
  authorize(id: { platform: string; userId?: string }, req: AuthorizeRequest): string | null {
    // 1) deniedCapabilities 硬禁（压过 owner） 2) owner 放行 3) level >= minLevel
    return null; // null 放行 / string 拒绝原因
  }
  setUserLevel(_t: UserIdentity, _l: number) {}
  removeUser(_p: string, _u: string) {}
  listUsers(): AuthorityUserEntry[] { return []; }
  save() {}
}

export default definePlugin({
  name: '@aalis/plugin-my-authority',
  provides: [authority],
  uses: { provide, commands: optional(commands), tools: optional(tools) },
  apply({ provide, commands, tools }) {
    const impl = new MyAuthority();
    provide.use(authority, impl);
    const guard = async (g: ExecutionGuardContext): Promise<Verdict> => {
      const capability = `${g.type}:${g.name}`;
      // 每个参与者都要过：给了取用判定（g.check）时按它判、不再判确认，否则按等级裁决；有人过不了时第一方发参与者审批，
      // 这里简单起见直接拒，不能当作放行
      const judge =
        g.check ??
        ((who: UserIdentity): Verdict => {
          const denied = impl.authorize(who, { capability, visibility: g.visibility, risk: g.risk });
          return denied ? { ok: false, reason: denied } : { ok: true };
        });
      const refused = g.participants.map(judge).find(verdict => !verdict.ok);
      if (refused) return refused;
      if (g.check || !g.confirm) return { ok: true };
      // 声明了 confirm：指令调 g.confirmIntent，工具请 owner 审批（approvals.request）；做不到就拒，不能当作放行
      return { ok: false, reason: `操作已取消：${capability} 需要确认` };
    };
    // 停用时摘掉：守卫闭包里是这次激活的状态，摘掉后 commands / tools 退回 fail-closed
    commands.follow(svc => {
      svc.setExecutionGuard(guard);
      return () => svc.setExecutionGuard(undefined);
    });
    tools.follow(svc => {
      svc.setExecutionGuard(guard);
      return () => svc.setExecutionGuard(undefined);
    });
  },
});
```

## 5. 标准消费方式

### 5.1 绝大多数插件作者：不直接调 authority

工具/指令的权限**只靠声明**——在注册时标 `risk` / `visibility` / `confirm`，守卫自动生效，**无需手写 `authority.use`**：

```ts
// 工具：ToolDefinition 字段 packages/api-tools/src/index.ts
tools.use.register({
  name: 'exec', /* ... */,
  visibility: 'restricted',   // 默认拒，须 owner 或被授等级
  confirm: 'session',         // 执行前需确认：工具由 owner 审批
  // 或直接用糖：risk: 'dangerous'（= restricted + confirm:'session'）
});
// 真实例：packages/plugin-tool-system/src/tools/shell.ts（exec 工具）
// 指令：CommandDefinition 同名字段 packages/api-commands/src/index.ts
commands.use.command('level <target:string> <level:number>', '设等级', { visibility: 'restricted' }); // packages/plugin-authority/src/index.ts
```

声明展开与守卫调用：执行点 `resolveCapabilityPolicy(tool)` → `guard({ name, type, visibility, confirm, risk, ... })`，返回 string 即拦截（`packages/plugin-tools/src/tools.ts`）。

### 5.2 直接消费 authority 服务（管理面 / 自定义 surface）

业务句柄 `authority.use` 是活的，选择、缺席与固定同一家的规则见 [选择层与业务层](../core/context.md#选择层与业务层)。可选依赖先看 `present`：

```ts
if (!authority.present) throw new Error('Authority 服务不可用'); // 可选依赖：缺失要兜底
const auth = authority.use;
if (caller && !auth.isOwner(caller.platform, caller.userId)) throw new Error('只有 owner 可管理权限');
auth.setUserLevel({ platform, userId }, level);
auth.save();
```

消费方判空的真实写法见 `packages/plugin-commands/src/index.ts`（`authority.present` 为 `false` 时按非 owner、等级 0 处理）。要让 owner 在新的界面上应答审批，经 `approvals.use.registerSurface(name)` 登记审批面（见 docs/api/api-approval.md），不经 authority。

### 5.3 错误边界

- `authorize` 同步返回，`null` = 放行、`string` = 直接可展示的拒绝原因；不要把 string 当成功值。
- 守卫返回 string 时，调用方（tools）会以 `{ error }` JSON 返回给 LLM（`tools.ts`），不抛异常。

## 6. 能力 / 风险 → 影响

### 6.1 裁决优先级（轴 A，`authority-model.ts` 的 `resolveAccess`）

首个命中即决：

1. `deniedCapabilities` glob 命中 → **拒**（压过 owner，保 `deny > owner` 不变量；这是配置总闸，非 per-user）。
2. `isOwner` → **放行**（owner = ∞）。
3. 封禁（`level < 0`）→ **拒**（门槛设成负数、所属组覆盖都不放行）。
4. `level >= minLevel` → 放行。
5. 所属权限组的放行条目覆盖这个操作 → 放行；否则拒。`tool-group:` 条目按请求的 `toolGroups` 比，其余按能力串匹配（通配同 `deniedCapabilities`），写法不对的条目不命中；成员指向没定义的组不放行。

`minLevel` 解析（`authority-model.ts` `resolveMinLevel`）：`authorityOverrides[cap] > 请求声明的 minLevel（如会话设置项按字段声明的门槛，`Infinity` 即只有 owner）> risk 派生 > visibility 兜底`。另有 `meetsLevel(identity, minLevel)`：只看等级够不够（owner 恒过、封禁恒不过），不看能力、权限组与硬禁，给会话设置按层固定的门槛用。`capabilityMinLevel`（在 `@aalis/api-authority`）：`dangerous→2 / sensitive→1 / safe|未声明→0`（`DEFAULT_AUTHORITY=0`）；`visibility` 兜底仅在无 risk 时用：`restricted→RESTRICTED_LEVEL(2) / public→0`。owner 等级 `OWNER_RANK = +Infinity`。

### 6.2 确认轴（轴 B，对 owner 同样生效）

confirm 与等级**正交**，**只对已授权操作做意图确认**（不是提权入口）。守卫顺序：先 `authorize`（轴 A），过了再看 `confirm`（轴 B），见 `packages/plugin-authority/src/index.ts`。

确认怎么做（`packages/plugin-authority/src/index.ts` 的守卫）：
- 免确认只对**参与者都是 owner** 的回合（守卫上下文的 `participants`，不看物理发言者）：`confirmOverrides` 的 `'off'` 对有别人的回合回落到插件的声明，`skipConfirm` 与白名单对有别人的回合不生效。
- `confirm:'always'` → 只有 `'off'` 能免（cron 等无人可问即拒）。
- `confirm:'session'` → `skipConfirm`（scheduler 触发的指令、runtime 一次性子命令）或 `restrictedPolicy` 白名单命中时免确认；两者都**不绕 `authorize`**（仍评估等级，防提权）。
- 指令：调 `confirmIntent` 向发出者本人核对意图（plugin-commands 只给人亲手输入的指令带上）；没有就拒。
- 工具：要一道只有 owner 能批的审批，与参与者审批（有参与者自己做不了这个动作时）合成一张。带上发起回合的类别（`authority-model.ts` 的 `originKind`）与这一轮的参与者（授权身份）调 `approvals.request`；人亲手发起的一轮（含它的续做与派出的子任务，不论在哪个会话）、参与者里有 owner 才能产生，起它的那一轮不是人亲手的（定时任务、编排与它们派的子任务等）与没有 owner 参与的回合由审批服务立即拒绝、不推给任何面。批过的调用按批的人执行。审批服务不在时立即拒。

`restrictedPolicy` 白名单的 `duration` 用运行时态 `policyEnabledAt`（不持久化，重启失效，`authority-manager.ts`）。

### 6.3 网络出口（SSRF）

authority 在 `apply` 时把 `config.network` 注入进程级网络策略：`setNetworkPolicy(config.get('network') ?? {})`（`packages/plugin-authority/src/index.ts`）。SSRF 防护归属在权限域，但实际守卫在 `@aalis/util-network-guard` 的 `safeFetch`——**由 LLM/用户 URL 触发的出口必须走 `safeFetch`**，本地固定服务（ollama/onebot daemon）走裸 fetch 不受影响。tool-browser 开启 `blockPrivate` 时，浏览器网络闸对每个连接同样按这份策略判定（插件的 `allowedHosts` 只跳过地址判定，端口照判），见 docs/plugins/plugin-tool-browser.md。详见 docs/concepts/security-model.md。

## 7. 边界与注意事项

- **`risk` 在两轴里走不同路径**：守卫把 `risk` 既透传给 `authorize`（派生 minLevel）又用 `resolveCapabilityPolicy` 展开出 `confirm`（`tools.ts`）。即 `risk:'dangerous'` 同时抬高最低等级到 2 **且**要求 session 确认；只想要其一时显式写 `visibility`/`confirm` 覆盖。
- **守卫是反向注入，时序敏感**：authority 经 `commands.follow` / `tools.follow` 注入守卫（`packages/plugin-authority/src/index.ts`）。任何一方未上线时另一方退化：没 authority → tools/commands 无守卫，需要鉴权或确认的操作全拒；没 `approvals` → 需要确认的工具调用全拒。重写时保持 `follow`（provider 重启会重新触发），不要用一次性 `services.use.get`（无依赖边）。
- **`restrictedPolicy` 的生效计时是运行时态**：`policyEnabledAt` 不持久化。重启后 `restrictedPolicy` 的 duration 计时归零（需再次触发 `markPolicyEnabled`，见权限页的「免确认」动作，`src/index.ts`）。
- **owner 判定含内置本地控制台身份**：`platform ∈ {webui, cli}` 且 `userId === 'console'` 恒为 owner（`authority-manager.ts`）。这是设计而非后门——`platform` 由适配器填写，远端用户无法伪造成 `cli`/`webui`，能填这两个平台名的只有本进程内代码（已具完全能力）。因此新增平台适配器**不得**把自身 platform 命名为 `cli` 或 `webui`；暴露新的本地 surface 时也注意别误用 `console` 这个 userId。

## 8. 交叉链接

- docs/plugins/plugin-authority.md — 权限系统总览（等级与权限组的设计与配置面）。
- docs/concepts/security-model.md — 威胁模型、SSRF / `safeFetch`、插件作者责任边界。
- docs/api/api-approval.md — owner 审批：在场、排队、时限、应答核验与审计。
- docs/concepts/service-model.md — DI 按名解析、priority、覆盖同名服务。
- docs/concepts/lazy-service-access.md — 消费 authority 的业务句柄为什么是活的。
- docs/concepts/manifest-metadata.md — `provides`/`uses` 双源元数据同步。
- docs/concepts/storage-uri-grammar.md — `users.json` 等级存储经 storage 服务；storage 不是沙盒。
- docs/plugins/plugin-tools.md / docs/plugins/plugin-commands.md — 工具/指令如何声明 `risk`/`visibility`/`confirm`。
