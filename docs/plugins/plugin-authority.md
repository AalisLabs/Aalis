# plugin-authority — 权限管理系统

**包名**: `@aalis/plugin-authority`  
**源码**: `packages/plugin-authority/src/index.ts`

## 概述

基于「数字等级」的权限管理系统：每个外部身份一个**整数等级**，每个操作一个**最低等级**，等级够即放行。单 owner 个人 bot 的「好管」权限模型。管理 owner、用户等级、受限能力的临时放行与平台级确认处理器。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-authority',
  provides: [authority],
  uses: {
    provide,
    hostConfig: optional(hostConfig),
    logger,
    lifecycle,
    webui: optional(webuiServer),
    commands: optional(commands),
    tools: optional(tools),
    storage: optional(storage),
    platform: optional(platform),
  },
  apply(caps) { /* 见源码 */ },
});
```

裁决要读整份配置文档（`owners`、`deniedCapabilities`、`confirmOverrides` 等），`host-config` 虽以 optional 声明，`apply` 内仍 `require()`：宿主未提供配置文档时本插件激活失败。其余 optional 依赖缺席时只少对应的接线。WebUI 权限页与 `/auto` 指令改动配置后经 `host-config` 的 `save()` 落盘。

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

拒绝时 `authorize` 返回可直接展示的原因：硬禁命中返回 `已被系统禁用: <cap>`；等级不足返回 `权限不足: "<cap>" 需等级 N（当前 M）`。

> 没有命名档位（受信 / 管理员 等），没有能力委托树，没有 per-user 的能力授予 / 禁用清单。只有「整数等级」一根轴。

## 确认（轴 B）

授权已过（含 owner / 等级够 / 被预先放行）但操作声明了 `confirm` 时，仍需走一次「意图确认」。确认由独立的 `plugin-session-confirm`（HITL 协调器）执行，经 `setConfirmHandler(platform, handler)` 注册进 authority（返回注销函数，注册方 dispose 时调用）；各平台（CLI / WebUI / OneBot）可注册独立确认回调，否则落到 `'*'` 通配 fallback。没有任何通道时 `requestAccess` 直接返回 false，守卫给出的拒绝原因会指出「没有确认通道」。

- 回复 `Y` = 本次放行；`YS` = 本会话放行（带时限）；其它 = 取消。
- `confirm: 'always'` = **每次都必须确认**，永不被会话记忆 / 白名单跳过（最高危；cron 等无人确认即拒）。
- 跳过判定见 `shouldSkipConfirm`：`always` 永不跳；非 `always` 可被 `skipConfirm`（系统 / 受信源如 scheduler）或 owner 本人 **auto 模式** 跳过。

权限守卫拒绝「未授权」分支时**绝不**调 `requestAccess`（那会询问发起者，造成自我提权），只查 `isPreApproved`（不问人）。

## 临时放行

当请求未直接授权 / 需确认时，依次尝试（`isTemporarilyAllowed`，先过硬禁绝对闸 `deniedCapabilities`）：

1. `restrictedPolicy` 时限白名单（`{ allow?, duration? }`）：命中即放行（自动化免确认）。`duration > 0` 时放行窗口是**运行时态**——只有 WebUI 保存策略（action `setRestrictedPolicy`）才调 `markPolicyEnabled` 开始计时，重启或直接改 `aalis.config.yaml` 都不会自动武装，此时白名单恒不生效；`duration` 缺省 / `<= 0` 则不限时。该白名单在未直接授权的救援路径（`isPreApproved`）**只对 owner 生效**；非 owner 只在已授权、仅差确认的路径上吃它（即免确认），白名单不是免授权。
2. 会话内临时授予复用：按 **platform + userId + sessionId + capability** 匹配，**不跨用户 / 不跨会话 / 不跨平台**（群内 sessionId 全群共享时不被白嫖）。
3. 确认回调（`AccessConfirmHandler`）：只在已授权、需确认的路径（`requestAccess`）上使用，未授权的救援路径止于前两步。可返回会话级临时授予（`scope:'session'`，带 `durationSeconds`（1–3600，缺省 600）/ `maxUses`）。`always` 不接受任何记忆。

相关类型：请求 `AccessRequest`、决策 `AccessDecision { allowed, grant? }`、范围 `TemporaryGrantSpec { scope: 'once' | 'session', durationSeconds?, maxUses? }`。
管理：`listTemporaryGrants()` / `revokeTemporaryGrant(id)`。

> 会话内临时授予随进程态存活（重启即失效）、**不持久化**；时长缺省 600s、上限 3600s。

## 配置项

- `config.owners`（`UserIdentity[]`）：owner 身份列表（owner = ∞，不在等级表内）。
- `config.deniedCapabilities`（glob 列表）：全局硬禁用，命中即拒，连 owner 都压过（配置总闸，非 per-user）。
- `config.authorityOverrides`（能力键 `type:name` → 整数）：owner 逐条覆盖单条操作的最低等级，无需改插件声明；传非整数则清除该条（回退默认派生）。经 WebUI 权限页改动该项时，**该能力上所有未过期的会话授予一并撤销**——否则 `authorize` 已按新门槛拒绝，而守卫的救援闸 `isPreApproved` 仍靠旧授予放行，且救援命中会直接返回放行、连确认轴（含 `always`）一起跳过。撤销由管理动作负责，不在救援口上复查：救援口恰恰在 `authorize` 拒绝之后才被调用，在那里复查等于把整条会话授予路径变成死代码（与 `setUserLevel` 降权撤销同源）。
- `config.confirmOverrides`（能力键 `type:name` → `'session' | 'always' | 'off'`）：owner 逐条覆盖确认要求；`'off'` 强制关确认。
- `config.autoConfirmUntil`（number）：auto 模式截止时间戳。`-1` = 一直；`>now` = 截止前激活；`0` / 过期 = 关（仅影响确认轴）。
- `config.restrictedPolicy`（`{ allow?, duration? }`）：受限能力的临时放行白名单（owner 自动放行的时限）。注意 `duration > 0` 的窗口只在 WebUI 保存策略时开始计时（运行时态、不持久化），重启即失效、手写 yaml 不自动武装——想让它长期有效就别填 `duration`。

`DEFAULT_AUTHORITY`（未登记身份默认等级 = 0）是常量，不可配置。某操作是否 restricted 由其工具 / 指令声明的 `visibility` 决定，可经 `authorityOverrides`（等级）/ `confirmOverrides`（确认）逐操作覆盖。

## 指令

权限管理仅 owner 可达（防自授 / 防自我提权）。

- `/authority [target]` — 查看自己或指定用户（`<platform:userId>`）的权限等级（owner 显示「等级 ∞」）。
- `/level <target> <整数>` — owner 给外部身份设等级（越大越高，`0` 默认，负数封禁）。`visibility: 'restricted'`。例：`/level onebot:12345 5`。
- `/auto [分钟|on|off]` — owner 临时免 `dangerous` 二次确认（批处理便利，仅 owner 本人）：`on` = 一直、`off`/`0` = 关、正整数 = 分钟；无参 = 查状态。`visibility: 'restricted'`。例：`/auto 30`、`/auto off`。

> 不存在 `/grant`、`/deny`、`/bind` 指令（能力委托 / 跨平台绑定模型已移除）。

## 单 token WebUI 鉴权

WebUI 鉴权为**单 token**（向后兼容的服务器持有式）：访问 token → 身份 `webui:console`（owner 语义——token 存于服务器磁盘 / 启动日志，持有 token ≈ 控制服务器 ≈ owner）。**无账户密码**（无 `setPassword` / `verifyPassword`）。

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

读取失败（文件在但读不出 / JSON 解析不了 / 不是 v5 结构，含旧的能力 / 密码 / 档位模型 v1–v4）时本次运行**拒绝写入** users.json 并记 error：`save` 写的是全量快照，坏文件被覆盖一次就意味着原有封禁 / 等级记录全丢。旧版本文件不做迁移，删除或移走该文件后重启即按全新开始；坏文件修好后重启即恢复正常写入；文件不存在（全新安装）不受影响。
