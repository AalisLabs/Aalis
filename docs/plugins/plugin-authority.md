# plugin-authority — 权限管理系统

**包名**: `@aalis/plugin-authority`  
**源码**: `packages/plugin-authority/src/index.ts`

## 概述

基于「数字等级」的权限管理系统：每个外部身份一个**整数等级**，每个操作一个**最低等级**，等级够即放行。单 owner 个人 bot 的「好管」权限模型。管理 owner、用户等级与免确认白名单，并在执行守卫里完成确认：工具交给 owner 审批，指令向发出者本人核对意图。

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
    approvals: optional(approvals),
  },
  apply(caps) { /* 见源码 */ },
});
```

裁决要读整份配置文档（`owners`、`deniedCapabilities`、`confirmOverrides` 等），`host-config` 虽以 optional 声明，`apply` 内仍 `require()`：宿主未提供配置文档时本插件激活失败。其余 optional 依赖缺席时只少对应的接线；`approvals` 缺席时需要确认的工具调用一律拒绝。WebUI 权限页改动配置后经 `host-config` 的 `save()` 落盘。

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
- 裁决 `resolveAccess`（首个命中即定，硬禁先于放行）：
  1. 全局硬禁 `deniedCapabilities` glob 命中 → **拒**（压过一切，连 owner 都压过）
  2. owner → 放行
  3. `level >= minLevel` → 放行；否则拒

纯判定逻辑见 `packages/plugin-authority/src/authority-model.ts`（`resolveMinLevel` / `resolveAccess`，纯函数、无副作用）。能力串形如 `command:<name>` / `tool:<name>` / `storage:...`。

拒绝时 `authorize` 返回可直接展示的原因：硬禁命中返回 `已被系统禁用: <cap>`；等级不足返回 `权限不足: "<cap>" 需等级 N（当前 M）`。

> 没有命名档位（受信 / 管理员 等），没有能力委托树，没有 per-user 的能力授予 / 禁用清单。只有「整数等级」一根轴。

## 确认（轴 B）

授权已过（owner 或等级够）但操作声明了 `confirm`（经 `confirmOverrides` 覆盖后）时，仍要有人确认。守卫的判定顺序：

1. **可免的确认**：`confirm` 为 `session` 时，`skipConfirm` 的受信来源（scheduler 触发的指令：owner 建任务时已经授权；runtime 一次性子命令：owner 在本机终端亲手输入）与 `restrictedPolicy` 白名单命中的能力免确认。`confirm: 'always'` 什么都免不掉（cron 等无人可问的上下文即拒）。
2. **指令**：确认的是发出者本人的意图。plugin-commands 给人亲手输入的指令带上 `confirmIntent`，在同一会话里问发出者，只认他在这个会话里的下一条消息，带 `source` 的注入不认，60 秒不回即取消。没有 `confirmIntent` 的指令（编排投递等带 `source` 的注入）无从确认，直接拒。不走 owner 审批：群成员在私聊里用 `/clear` 清自己的记忆照样能确认。
3. **工具**：确认是 owner 审批。守卫算出发起回合的类别（见下节），调 `approvals.request`；只有 owner 本人与 owner 链的延续能产生审批，其余由审批服务立即拒绝、不推给任何面，并记进审批审计。批准则执行，拒绝时把审批服务给的话作为工具结果回给模型。审批服务不在时立即拒并说明原因。

等级不够或命中硬禁即拒，没有别的放行口：发起者本人不能靠确认给自己提权，白名单也不放宽授权。

### 发起回合的类别

按回合的来源判，不按授权身份判：owner 建的定时任务会把创建者回填成 `actor`，按 `actor` 判它就成了 owner。判据是执行守卫上下文里的 `inbound`（agent 工具循环填写）、`actor` 与会话 id（`originKind`，`packages/plugin-authority/src/authority-model.ts`）：

按下面的顺序判，先命中的算：

1. 调用不在由入站消息驱动的回合里（编排的节点、mcp-server 等）：`autonomous`；
2. `source: 'subtask'`：`subtask`；
3. 群房间，以及对端不是 owner 的私聊（按会话 id 判，子任务按它所在的房间算）：`room`，不论谁发言，owner 在 WebUI 里驱动房间也一样；
4. 真人消息（没有 `source`）：带 `actor` 的是触发器把这一轮记成了自发的（例如频率触发），为 `autonomous`；否则发言者是 owner 为 `owner`，不是为 `other`；
5. 宿主通知延续某次工具调用（`hostNotice.callerUserId`）：那次调用的发言者与授权身份都是 owner 为 `owner-chain`，否则 `other`；
6. 其余带 `source` 的注入（定时任务、编排、空闲与主动发言、不延续调用的宿主通知）：`autonomous`。

## 配置项

- `config.owners`（`UserIdentity[]`）：owner 身份列表（owner = ∞，不在等级表内）。
- `config.deniedCapabilities`（glob 列表）：全局硬禁用，命中即拒，连 owner 都压过（配置总闸，非 per-user）。
- `config.authorityOverrides`（能力键 `type:name` → 整数）：owner 逐条覆盖单条操作的最低等级，无需改插件声明；传非整数则清除该条（回退默认派生）。
- `config.confirmOverrides`（能力键 `type:name` → `'session' | 'always' | 'off'`）：owner 逐条覆盖确认要求；`'off'` 强制关确认。
- `config.restrictedPolicy`（`{ allow?, duration? }`）：免确认白名单（能力 glob，`['*']` 全放），给自动化用。只免 `session` 档的确认，`always` 照常确认；不放宽授权，等级不够的照样拒。注意 `duration > 0` 的窗口只在权限页往白名单里加规则（动作 `waiveConfirm`，调 `markPolicyEnabled`）时开始计时（运行时态、不持久化），重启即失效、手写 yaml 不自动武装——想让它长期有效就别填 `duration`。权限页不改 `duration`，原值保留。

`DEFAULT_AUTHORITY`（未登记身份默认等级 = 0）是常量，不可配置。某操作是否 restricted 由其工具 / 指令声明的 `visibility` 决定，可经 `authorityOverrides`（等级）/ `confirmOverrides`（确认）逐操作覆盖。

## 指令

权限管理仅 owner 可达（防自授 / 防自我提权）。

- `/authority [target]` — 查看自己或指定用户（`<platform:userId>`）的权限等级（owner 显示「等级 ∞」）。
- `/level <target> <整数>` — owner 给外部身份设等级（越大越高，`0` 默认，负数封禁）。`visibility: 'restricted'`。例：`/level onebot:12345 5`。

> 不存在 `/grant`、`/deny`、`/bind` 指令（能力委托 / 跨平台绑定模型已移除）。

## 单 token WebUI 鉴权

WebUI 鉴权为**单 token**（向后兼容的服务器持有式）：访问 token → 身份 `webui:console`（owner 语义——token 存于服务器磁盘 / 启动日志，持有 token ≈ 控制服务器 ≈ owner）。**无账户密码**（无 `setPassword` / `verifyPassword`）。

## 权限页

放在 WebUI 设置里的声明式页面（`key: 'authority'`，位置 `settings`），四个标签，改动都用「动作带输入」：

| 标签 | 内容 | 动作 |
|---|---|---|
| 用户 | 登记了等级的外部身份（owner 不列）：身份、等级、备注 | 行上「设等级」（输入等级，按这一行预填）、「删除记录」（destructive：删掉封禁记录就等于解封）；「加用户」（输入平台、用户 ID、等级） |
| Owner | 配置里的 `owners`（本机控制台恒为 owner，不列） | 行上「移除」（destructive）；「加 owner」（输入平台与用户 ID，已经是 owner 的拒收） |
| 操作门槛 | 指令与工具按所属插件分组：操作数、已改门槛的数量。选中一组，详情列出这一组的每个操作：默认门槛（权限服务按风险派生，不含覆盖）、生效门槛、确认要求 | 组那一行上「整组设门槛」，操作那一行上「设门槛」；输入最低等级，留空恢复默认。写进 `authorityOverrides` |
| 禁用与免确认 | `deniedCapabilities` 与 `restrictedPolicy.allow` 里的规则 | 行上「移除」；「禁用」「免确认」（输入能力键或通配，重复的拒收） |

- 等级改动（设等级、加用户、删除记录）与 `/level` 走同一个流程：先等等级表的首次读取落定，改完等落盘，没落盘时回执注明原因（见下文「用户数据」）。改宿主配置的动作先改运行态（即刻生效）再等 `save()`，保存失败时动作回错误，写明改动已在本次运行中生效、没写进配置文件及原因。每次改动后页面重取，保存失败时也一样。
- 只有 owner 能调页面动作，由 webui-server 的闸门保证（单 token 下身份恒为 `webui:console`），处理函数不另核调用者。
- 确认覆盖（`confirmOverrides`）不在页上，照旧从配置生效，随工作会话的模式另定。

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

读取失败（文件在但读不出 / JSON 解析不了 / 不是 v5 结构，含旧的能力 / 密码 / 档位模型 v1–v4）时本次运行**拒绝写入** users.json 并记 error：`save` 写的是全量快照，坏文件被覆盖一次就意味着原有封禁 / 等级记录全丢。旧版本文件不做迁移，删除或移走该文件后重启即按全新开始；坏文件修好后重启即恢复正常写入；文件不存在（全新安装）不受影响。拒写期间 `/level` 与权限页的等级动作仍在内存中生效，`/level` 的回复与这几个动作返回的那句结果末尾注明「仅本次运行生效，未写入 users.json（加载失败，见日志）」，界面把这句结果显示给 owner。

storage 晚于本插件上线时，首次读取在 storage 上线后异步进行；storage 重新上线（热重载、换提供者）时再读一次。重读以文件内容重建等级表：运行中从文件里删掉的记录随之消失，手工改过的值以文件为准；自上次成功写入以来改过或删过的用户以内存为准，读完后一并写入；读取开始时尚未写完、读取期间才写入成功的改动同样以内存为准。首次读取落定（读完、文件不存在或判为读不懂）之前不写盘，包括 storage 刚上线、读取尚未发起的间隙：这时内存里还没有文件里的记录，写下去的全量快照会覆盖原有记录。storage 上线前（首次读取尚未开始）改等级、删记录也以内存为准，`/level` 的回复与权限页等级动作的结果末尾注明「未写入 users.json（等级表尚未载入），载入后写入」；首次读取落定后按正常路径写入，删掉的记录不随文件回来，改等级保留文件里的备注，降为 0 级也一样（这时即使没有备注，记录也以 0 级留在文件里；首次读取落定且未因读取失败拒写时，降为 0 级且无备注才清掉整条记录）。首次读取发起之前（storage 未上线，或刚上线、读取尚未发起）停机或卸载，这些改动不写入；读取已发起时，停机与卸载等它落定后写入。文件不存在时保留内存里的等级表。`/level` 与权限页的等级动作先等进行中的读取完成再改，写入结束后才回复。写入失败（storage 不在线、权限不足、磁盘写满）时记 error，改动留在内存，下次保存（再次改等级、storage 重新上线后的重读、停机或卸载）时重写；回复末尾注明「未写入 users.json（写入失败，见日志），下次保存时重试」。
