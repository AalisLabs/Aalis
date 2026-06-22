# plugin-authority — 权限管理系统

**包名**: `@aalis/plugin-authority`  
**源码**: `packages/plugin-authority/src/index.ts`

## 概述

基于「数字等级」的权限管理系统：每个外部身份一个**整数等级**，每个操作一个**最低等级**，等级够即放行。单 owner 个人 bot 的「好管」权限模型。管理 owner、用户等级、受限能力的临时放行与平台级确认处理器。

## 插件声明

```typescript
meta.name = '@aalis/plugin-authority'
meta.provides = ['authority']
meta.inject = { optional: ['commands', 'tools'] }
```

## 两轴正交模型

权限裁决拆成两条互不相干的轴：

- **轴 A · 授权（authorize）**：「谁可以跑它」——按数字等级裁决。
- **轴 B · 确认（confirm / HITL）**：「这次确实是你的意图吗」——意图确认，**owner 也吃**（防提示词注入借权）。

操作声明的 `risk` 同时设定两轴默认：`dangerous` ⇒ `restricted` + `confirm:'session'`。两轴各自独立判定，互不替代。

## 等级模型（轴 A）

- **owner** = 等级 ∞（`OWNER_RANK`，正无穷），**不在等级轴上**，靠 `config.owners`（`UserIdentity[]`）归属，永不可设成有限等级、永不被任何门槛锁出。webui/cli 的 `console` 恒为 owner。
- 每个外部身份一个**整数等级**：默认 `0`（`DEFAULT_AUTHORITY`），越大越高，**封禁 = 负数**（自然连 `minLevel=0` 都过不了）。
- 每个操作一个**最低等级**（`minLevel`），由 `resolveMinLevel` 派生（首个命中赢）：
  1. `authorityOverrides[capability]`（owner 逐条覆盖成任意整数）
  2. `risk` 派生：`safe→0` · `sensitive→1` · `dangerous→2`
  3. `visibility` 兜底（拿不到 risk 时）：`public→0` · `restricted→2`（`RESTRICTED_LEVEL`）
- 裁决 `resolveAccess`（首个命中赢，对齐 Claude Code deny→allow）：
  1. 全局硬禁 `deniedCapabilities` glob 命中 → **拒**（压过一切，连 owner 都压过）
  2. owner → 放行
  3. `level >= minLevel` → 放行；否则拒

纯判定逻辑见 `packages/plugin-authority/src/authority-model.ts`（`resolveMinLevel` / `resolveAccess`，纯函数、无副作用）。能力串形如 `command:<name>` / `tool:<name>` / `storage:...`。

> 没有命名档位（受信 / 管理员 等），没有能力委托树，没有 per-user 的能力授予 / 禁用清单。只有「整数等级」一根轴。

## 确认（轴 B）

授权已过（含 owner / 等级够 / 被预先放行）但操作声明了 `confirm` 时，仍需走一次「意图确认」。确认由独立的 `plugin-session-confirm`（HITL 协调器）执行，经 `setConfirmHandler(platform, handler)` 注册进 authority；各平台（CLI / WebUI / OneBot）可注册独立确认回调，否则落到 `'*'` 通配 fallback。

- 回复 `Y` = 本次放行；`YS` = 本会话放行（带时限）；其它 = 取消。
- `confirm: 'always'` = **每次都必须确认**，永不被会话记忆 / 白名单跳过（最高危；cron 等无人确认即拒）。
- 跳过判定见 `shouldSkipConfirm`：`always` 永不跳；非 `always` 可被 `skipConfirm`（系统 / 受信源如 scheduler）或 owner 本人 **auto 模式** 跳过。

权限守卫拒绝「未授权」分支时**绝不**调 `requestAccess`（那会询问发起者，造成自我提权），只查 `isPreApproved`（不问人）。

## 临时放行

当请求未直接授权 / 需确认时，依次尝试（`isTemporarilyAllowed`，先过硬禁绝对闸 `deniedCapabilities`）：

1. `restrictedPolicy` 时限白名单（`{ allow?, duration? }`）：命中即放行（自动化免确认；`markPolicyEnabled` 记开启时间，`duration` 秒内有效）。
2. 会话内临时授予复用：按 **userId + sessionId + capability** 匹配，**不跨用户 / 不跨会话泄漏**（群内 sessionId 全群共享时不被白嫖）。
3. 确认回调（`AccessConfirmHandler`）：可返回会话级临时授予（`scope:'session'`，带 `durationSeconds`（1–3600，缺省 600）/ `maxUses`）。`always` 不接受任何记忆。

相关类型：请求 `AccessRequest`、决策 `AccessDecision { allowed, grant? }`、范围 `TemporaryGrantSpec { scope: 'once' | 'session', durationSeconds?, maxUses? }`。
管理：`listTemporaryGrants()` / `revokeTemporaryGrant(id)`。

## 配置项

- `config.owners`（`UserIdentity[]`）：owner 身份列表（owner = ∞，不在等级表内）。
- `config.deniedCapabilities`（glob 列表）：全局硬禁用，命中即拒，连 owner 都压过（配置总闸，非 per-user）。
- `config.authorityOverrides`（能力键 `type:name` → 整数）：owner 逐条覆盖单条操作的最低等级，无需改插件声明；传非整数则清除该条（回退默认派生）。
- `config.confirmOverrides`（能力键 `type:name` → `'session' | 'always' | 'off'`）：owner 逐条覆盖确认要求；`'off'` 强制关确认。
- `config.autoConfirmUntil`（number）：auto 模式截止时间戳。`-1` = 一直；`>now` = 截止前激活；`0` / 过期 = 关（仅影响确认轴）。
- `config.restrictedPolicy`（`{ allow?, duration? }`）：受限能力的临时放行白名单（owner 自动放行的时限）。

`DEFAULT_AUTHORITY`（未登记身份默认等级 = 0）是常量，不可配置。某操作是否 restricted 由其工具 / 指令声明的 `visibility` 决定，可经 `authorityOverrides`（等级）/ `confirmOverrides`（确认）逐操作覆盖。

## 指令

权限管理仅 owner 可达（防自授 / 防自我提权）。

- `/authority [target]` — 查看自己或指定用户（`<platform:userId>`）的权限等级（owner 显示「等级 ∞」）。
- `/level <target> <整数>` — owner 给外部身份设等级（越大越高，`0` 默认，负数封禁）。`visibility: 'restricted'`。例：`/level onebot:12345 5`。
- `/auto [分钟|on|off]` — owner 临时免 `dangerous` 二次确认（批处理便利，仅 owner 本人）：`on` = 一直、`off`/`0` = 关、正整数 = 分钟；无参 = 查状态。`visibility: 'restricted'`。例：`/auto 30`、`/auto off`。

> 不存在 `/grant`、`/deny`、`/bind` 指令（能力委托 / 跨平台绑定模型已移除）。

## WebUI 权限管理页

owner-only 的「权限管理」页（`renderer: 'authority'`，order 50）。`getOverview` 返回：用户等级表、owner 列表、平台清单、`deniedCapabilities`、`authorityOverrides`、`defaultAuthority`、`confirmOverrides`、`autoConfirmUntil`、`restrictedPolicy`、临时放行清单，以及指令 + 工具的操作清单（带 `pluginName/type/visibility/confirm/risk`，供前端按插件分组、显示两轴默认）。

操作处理器（均 owner-only，校验 `isOwner(caller)`）：`setUserLevel` / `deleteUser` / `setOwners` / `setAuthorityOverride` / `setConfirmOverride` / `setAutoConfirm` / `setRestrictedPolicy` / `revokeTemporaryGrant` / `setConfig`（更新 `deniedCapabilities`）。

## 用户数据（users.json v5）

```jsonc
{
  "version": 5,
  "users": {
    "<platform>:<userId>": {
      "level": 5,        // 整数：越大越高；缺省 0；封禁=负数；owner 不入表
      "note": "..."      // 可选备注（这人是谁）
    }
  }
}
```

记录里**没有**能力 glob、密码、绑定、委托树。等级为默认（0）且无备注时直接清记录，保持文件精简。
迁移策略为**全新开始**：非 v5 文件（含旧的能力 / 密码 / 档位模型 v1–v4）直接丢弃，不做迁移（0.5.0 未发布）。
