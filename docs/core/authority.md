# 权限系统 — 数字等级单轴

管理调用者身份、操作裁决、与受限操作的临时放行/意图确认。

**源码**: `packages/plugin-authority/src/index.ts`（实现 + 守卫 + 指令 + WebUI actions）/ `packages/plugin-authority-api/src/index.ts`（契约）
纯判定逻辑见 `packages/plugin-authority/src/authority-model.ts`，策略层见 `authority-manager.ts`，数据层见 `user-store.ts`。

> 2026 模型重写：**取消能力委托图与角色链**，改为单 owner 个人 bot 的「好管」数字等级。
> 每个外部身份一个**整数等级**（越大越高，默认 0，封禁=负数）；每个操作一个**最低等级**
> （由 risk 派生、owner 可逐条覆盖成任意整数）。owner = ∞（不在等级轴上，靠 owners 列表归属），
> 永不被任何有限门槛锁出。**没有**子委托树、**没有** per-user 能力 grant/deny 清单。

## 两条正交轴

权限判定拆成两条互不干扰的轴：

- **轴 A · 授权（谁能用）**：用户**等级**对比操作**最低等级**。决定「这个身份有没有资格运行」。
- **轴 B · 确认（是不是你本人此刻要）**：HITL 意图确认，与等级正交，**owner 也吃**——抵御
  owner 会话内提示注入借权静默调高危。决定「执行前要不要有人点头」。

`risk` 声明一次性给两轴设默认：`dangerous` = restricted（轴 A 门槛抬高）+ `confirm:'session'`（轴 B 需确认）。

## capability 词汇

裁决以细粒度能力串（`CapabilityId`，glob，`*` 通配任意字符段）为单位，守卫合成的主能力形如 `<type>:<name>`：

| 形状 | 产出者 | 示例 |
|---|---|---|
| `tool:<name>` | 工具注册 | `tool:file.write` |
| `command:<name>` | 指令注册 | `command:shutdown` |

`config.deniedCapabilities`（全局硬禁）与 `config.authorityOverrides` / `config.confirmOverrides`
（按操作键 `type:name` 调门槛/确认）都以这套能力串作键。

## owner 与可见性

- **owner = ∞**：不入等级轴，靠 `owners` 列表归属；任何有限门槛都压不过它（防自锁）。判定见
  `authority-manager.ts` `isOwner`：`config.owners`（`UserIdentity[]`）命中即 owner；且 `webui` / `cli`
  的 `console` 身份恒为 owner（单 token / 单终端语义——持有即等同控制服务器）。
  **owner 不能被设成有限等级**（不入 users 表）。
- 每个操作声明默认**可见性**：`public`（默认所有人可用，门槛 0）或 `restricted`（默认禁止，
  兜底门槛 `RESTRICTED_LEVEL = 2`），类型 `CapabilityVisibility`。
- 可见性只在**拿不到 `risk` 声明时**作最低等级的兜底（`public→0` / `restricted→2`）。

## 最低等级解析

操作的最低等级 `minLevel` 解析优先级（`resolveMinLevel`，纯函数）：

```
authorityOverrides[capability]（owner 设任意整数） > risk 派生 > visibility 兜底
```

- **risk 派生**（`riskToLevel`）：`safe → 0` · `sensitive → 1` · `dangerous → 2`。
- **visibility 兜底**（仅无 risk 时）：`public → 0` · `restricted → 2`。
- **authorityOverrides** 覆盖一切：owner 可把任意操作的门槛设成任意整数，无需改插件声明。

## 裁决：authorize 统一闸

任何 surface（tool / command / scheduler）的敏感操作在边界统一调用：

```typescript
authority.authorize(identity, { capability, visibility, risk })
// → null 放行 | string 拒绝原因
```

裁决纯函数 `resolveAccess`，**优先级**（首个命中赢）：

```
deniedCapabilities（全局硬禁，压过 owner）  >  owner(∞)  >  level >= minLevel
```

1. `config.deniedCapabilities`（glob）命中即拒——**连 owner 都压过**（配置总闸、系统级硬禁用，慎用；非 per-user）。
2. owner（∞）→ 放行。
3. 用户**等级 >= 操作 minLevel** → 放行；否则拒（封禁=负数自然连 `minLevel=0` 都不过）。

拒绝原因区分硬禁（`已被系统禁用: <cap>`）与等级不足（`权限不足: "<cap>" 需等级 N（当前 M）`）。

## 执行守卫：两轴正交闸

`apply()` 内的 `guard` 是 commands / tools surface 的适配器，经 `setExecutionGuard` 注入；
`plugin-commands` / `plugin-tools` 执行前各调一次。它按顺序跑两轴：

```
轴 A · authorize（等级裁决；系统源也评估，防绕过提权）
  └─ 拒：skipConfirm 直接返原因；否则查 isPreApproved（白名单 / 该用户本会话已有授予）救一手，
        仍无 → 硬拒。**绝不**让发起者本人弹确认自我提权。
轴 B · confirm（仅对**已授权**操作做意图确认；owner 也吃，防注入借权）
  └─ shouldSkipConfirm 决定是否跳过：
       · confirm:'always' → 永不跳（最高危：每次有人确认；cron 无人确认即拒）
       · skipConfirm（系统/受信源如 scheduler，无人可点）→ 跳
       · owner 本人 且 auto 模式激活 → 跳
     不跳则走 requestAccess 等确认；被拒 → `操作已取消`。
```

owner 可经 `config.confirmOverrides`（操作键 → `session` / `always` / `'off'`）覆盖确认要求，
`'off'` 强制关确认（便于自动化）；经 `config.authorityOverrides` 覆盖等级门槛。

## 确认轴（HITL）由 plugin-session-confirm 协调

轴 B 的实际交互**不在本插件**：`plugin-session-confirm` 是 HITL 协调器，经
`setConfirmHandler('*', …)`（gateway 总线覆盖 onebot / cli / 任何会话型平台）注册进 authority。
回复语义：

- `Y` = 本次放行一次；
- `YS` = 本会话放行（带时限/限次的会话临时授予）；
- 其它 = 取消。
- `confirm:'always'` 的操作**每次都问**，不接受白名单/会话记忆（`requestAccess` 里 `always` 分支不复用、不创建会话授予）。

## auto 自动确认模式

owner 临时免 dangerous 二次确认（批处理便利，类 Claude Code auto），存
`config.autoConfirmUntil`（epoch ms 截止；`-1`=一直；`0`/缺省=关）。`autoConfirmActive` 纯函数判活。
**只影响轴 B 确认、只对 owner 本人生效**，不动等级 / deny，且 `always` 确认不被它跳过。

## 受限操作的临时放行（requestAccess）

`requestAccess` 走临时放行流程（`always` 时跳过前两步）：

```
requestAccess(request)
  ├─ ① restrictedPolicy 白名单（config.restrictedPolicy.allow glob + duration 时限，
  │     markPolicyEnabled 记起点）→ 通过（自动化免确认）
  ├─ ② 会话内临时授予复用（按 userId + sessionId + capability 匹配——
  │     群内 sessionId 全群共享时不跨用户白嫖；一次会话的临时批准不跨会话泄漏）→ 通过
  └─ ③ 确认处理器 confirmHandlers[platform] ?? ['*']（CLI 终端 / WebUI 弹窗 / session-confirm）→ 交互确认
        批准可返回 { allowed: true, grant: { scope:'session', durationSeconds, maxUses } } 建立会话内临时授予
```

`isPreApproved`（守卫「未授权」分支专用）只查 ①②，**绝不询问发起者本人**——杜绝低档用户对超档操作自我确认提权。
`listTemporaryGrants` / `revokeTemporaryGrant` 查看/撤销生效中的临时授予。会话授予时长上限 3600s（缺省 600s），
随进程态存活（重启即失效），不持久化。

## 命令

| 命令 | 谁可用 | 作用 |
|---|---|---|
| `/authority [target]` | 所有人 | 查看自己或指定 `platform:userId` 的等级（owner 显示 ∞） |
| `/level <platform:userId> <整数>` | 仅 owner（`visibility:'restricted'`） | 设外部身份等级（越大越高；0 默认，负数封禁） |
| `/auto [分钟\|off\|on]` | 仅 owner 本人（`visibility:'restricted'`） | 切 auto 自动确认：`on`=一直 / `off`=关 / 数字=分钟 |

> 已删除、不再存在的命令：`/grant`、`/deny`（无 per-user 能力授予/禁用）、`/bind`（无跨平台账户绑定）。

## WebUI 权限页（仅 owner）

`actions`（`index.ts` 导出）支撑权限页，关键操作均**仅 owner 可达**（caller 非 owner 即抛「只有 owner 可管理权限」，防自我提权）：

- `getOverview` — 用户等级 + owner 列表 + 平台 + 操作清单（指令 + 工具，带 visibility/confirm/risk）
  + `deniedCapabilities` / `authorityOverrides` / `confirmOverrides` / `autoConfirmUntil` / `restrictedPolicy` / 临时授予。
- `setUserLevel` / `deleteUser` — 设/删外部身份等级记录。
- `setOwners` — 改 owner 列表。
- `setAuthorityOverride` / `setConfirmOverride` — 逐操作覆盖门槛等级 / 确认要求（传非法值即清该条，回退默认派生）。
- `setAutoConfirm` — 切 auto 模式（`minutes`：`-1`=一直 / `0`=关 / `N`=分钟）。
- `setRestrictedPolicy` — 改受限能力临时放行策略。
- `revokeTemporaryGrant` — 撤销一条临时授予。
- `setConfig` — 改 `deniedCapabilities` 清单。

单 owner 终态**无委托树**，故权限页无委托关系图。

## 单 token WebUI 鉴权

WebUI 鉴权为**单 token**（向后兼容的服务器持有式）：访问 token → 身份 `webui:console`（owner 语义——
token 存于服务器磁盘/启动日志，持有 token ≈ 控制服务器 ≈ owner）。**无账户密码**（无 `setPassword`/`verifyPassword`），
**无跨平台账户绑定**（无 `/bind`、无身份 links）。

## 数据持久化（users.json v5）

```json
{
  "version": 5,
  "users": {
    "onebot:12345": { "level": 5, "note": "管理员小李" },
    "qq:789": { "level": -1 }
  }
}
```

- 仅 `level`（整数）+ 可选 `note`；**无能力 glob、无密码、无绑定 links、无委托父 grantedBy**。
- owner **不入表**（靠 `owners` 配置归属）。`level=0` 且无 `note` 的记录直接清除（保持文件精简）。
- **迁移策略：净化丢弃**——非 v5 文件（含旧 v1–v4 能力/密码/档位模型）一律丢弃重来，不做迁移。

## 关键方法速览

```typescript
authority.isOwner('onebot', '12345');                                  // → boolean（owner = ∞）
authority.authorize({ platform, userId }, { capability: 'tool:x', visibility: 'restricted', risk: 'dangerous' });
authority.setUserLevel({ platform: 'onebot', userId: '12345' }, 5);    // owner 设外部身份等级（覆盖式整数）
authority.removeUser('qq', '789');                                     // 删记录（回退默认 0）
authority.isPreApproved(accessRequest);                                // 未授权分支：白名单/会话授予救一手，不问人
authority.requestAccess(accessRequest);                               // 受限能力临时放行流程（含确认）
authority.listTemporaryGrants();                                       // 生效中的临时授予
authority.revokeTemporaryGrant(id);
authority.setConfirmHandler('*', handler);                             // session-confirm 注册确认协调器
authority.listUsers();  // → [{ platform, userId, isOwner, level, note? }]
authority.save();       // 落盘 data:/users.json（v5）
```
