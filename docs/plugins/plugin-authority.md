# plugin-authority — 权限管理系统

**包名**: `@aalis/plugin-authority`  
**源码**: `packages/plugin-authority/src/index.ts`

## 概述

基于「数字等级」的权限管理系统：每个外部身份一个**整数等级**，每个操作一个**最低等级**，等级够即放行；身份另可属于任意几个**权限组**（具名的放行集合），所属组里有条目覆盖的操作也放行。单 owner 个人 bot 的「好管」权限模型。管理 owner、用户等级、权限组与免确认白名单，并在执行守卫里完成确认：工具交给 owner 审批，指令向发出者本人核对意图。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-authority',
  provides: [authority],
  uses: {
    provide,
    hostConfig: optional(hostConfig),
    events,
    logger,
    lifecycle,
    webui: optional(webuiServer),
    commands: optional(commands),
    tools: optional(tools),
    storage: optional(storage),
    approvals: optional(approvals),
    sessionFields: optional(sessionFields),
    contributions: optional(contributions),
  },
  apply(caps) { /* 见源码 */ },
});
```

裁决要读整份配置文档（`owners`、`deniedCapabilities`、`confirmOverrides` 等），`host-config` 虽以 optional 声明，`apply` 内照样经 `hostConfig.use` 读取：宿主未提供配置文档时访问它的成员抛 `ServiceUnavailableError`，本插件激活失败。其余 optional 依赖缺席时只少对应的接线；`approvals` 缺席时需要确认的工具调用一律拒绝；`contributions` 用来交付权限页的两个可选项来源，缺席时页上的多选没有选项。WebUI 权限页改动配置后经 `host-config` 的 `save()` 落盘。

## 两轴正交模型

权限裁决拆成两条互不相干的轴：

- **轴 A · 授权（authorize）**：「谁可以跑它」——按等级与权限组裁决。
- **轴 B · 确认（confirm / HITL）**：「这次确实是你的意图吗」——意图确认，**owner 也吃**（防提示词注入借权）。

操作声明的 `risk` 同时设定两轴默认：`dangerous` ⇒ `restricted` + `confirm:'session'`。两轴各自独立判定，互不替代。

## 等级模型（轴 A）

- **owner** = 等级 ∞（`OWNER_RANK`，正无穷），**不在等级轴上**，靠 `config.owners`（`UserIdentity[]`）归属，永不可设成有限等级、永不被任何门槛锁出。webui/cli 的 `console` 恒为 owner。
- 每个外部身份一个**整数等级**：默认 `0`（`DEFAULT_AUTHORITY`），越大越高，**封禁 = 负数**（封禁先判，见下方裁决第 3 步）。
- 每个操作一个**最低等级**（`minLevel`），由 `resolveMinLevel` 派生（首个命中赢）：
  1. `authorityOverrides[capability]`（owner 逐条覆盖成任意整数）
  2. `risk` 派生：`safe→0` · `sensitive→1` · `dangerous→2`
  3. `visibility` 兜底（拿不到 risk 时）：`public→0` · `restricted→2`（`RESTRICTED_LEVEL`）
- 裁决 `resolveAccess`（首个命中即定，硬禁先于放行）：
  1. 全局硬禁 `deniedCapabilities` glob 命中 → **拒**（压过一切，连 owner 都压过）
  2. owner → 放行
  3. 封禁（等级小于 0）→ **拒**（操作门槛设成负数、所属组覆盖也不放行）
  4. `level >= minLevel` → 放行
  5. 所属权限组里有条目覆盖这个操作 → 放行；否则拒

纯判定逻辑见 `packages/plugin-authority/src/authority-model.ts`（`resolveMinLevel` / `resolveAccess`，纯函数、无副作用）。能力串形如 `command:<name>` / `tool:<name>`。

拒绝时 `authorize` 返回可直接展示的原因：硬禁命中返回 `已被系统禁用：<cap>`；等级不足（所属组也不覆盖）返回 `权限不足："<cap>" 需等级 N（当前 M）`。

> 没有命名档位（受信 / 管理员 等），没有能力委托树，没有按人禁用的清单。按人放行用权限组（见下节），它只加放行。

## 权限组

等级之外的具名放行集合：一个人一个等级，同时可以属于任意几个组，组之间合起来算。组定义在宿主配置 `authorityGroups`（组名 → 放行条目），成员关系记在 users.json 的用户记录里（`groups`）。

- **放行条目**三种写法：`tool:<工具名>`、`command:<指令名>`（都可用 `*` 通配，同 `deniedCapabilities`），`tool-group:<工具分组名>`（工具的分组里有它即覆盖，指令没有工具分组，不覆盖）。裸 `*` 与别的前缀不收。工具的分组由 plugin-tools 随守卫上下文交给权限服务（`toolGroups`）。
- **组名**只收字母、数字、连字符、下划线与中文，不以连字符开头；不收空白与 `<>`；`__proto__`、`constructor`、`prototype` 是保留名，不能作组名。组没有备注。
- **只加放行**：等级不够的操作，所属组里有一条覆盖它即放行；硬禁与封禁照旧先拒。按授权身份判（守卫上下文的参与者，每个参与者各判一次），与等级同一个身份。组不放宽确认：需要确认的工具对不是 owner 的成员照旧要 owner 审批，不能产生审批的直接拒。
- **组不开工具分组闸**：分组闸在守卫之前，会话没开某个工具分组时，组里写了 `tool-group:` 也看不到那组工具。
- **本地效果**：触及（reach）接线之前，组与等级一样：成员在开了 `system`、`code-runner`、`skills` 等分组的会话里，能用不需确认的本机读与执行（如 `file_read`、`run_python`、`skill_create`），和给他相应等级一样。
- 通配与 `tool-group:` 会纳入以后新登记的工具。
- **写法不对与没定义的组失败关闭**：权限页写入时，写法不对的条目与这次新加的、没定义的组当场报错；手改配置写错的条目不命中任何操作，不做运行期告警。成员记录指向没定义的组时，那个组不放行任何东西。
- **删组不级联**：成员记录里的组名保留，不再放行；用户表把它标成「未定义」；之后建同名组即恢复这些成员。设成员时这个人原有的组即使已被删掉也照收，原样保存不受影响。
- 平台身份（如群主、管理员）自动进组、组只在某个群生效，这两样不做。

## 多人的一轮：逐动作审批

守卫上下文的 `participants` 是这一轮的参与者（授权身份；agent 按 api-authority 的 `originTurnOf` 算，指令一路是发出者）。等级与权限组对每个参与者各裁决一次，按这个动作三分：

- 都能做：往下判确认；
- 有人能做、有人做不了：这一个调用要一道参与者审批，凡自己就能做这个动作的人都能批，批的人替它担保、拿到的不超过他本来就有的；这一轮里别的动作照常各自判；
- 都做不了：照旧拒，不产生审批，这一轮里没有人能为它担保。只有一位参与者时拒绝语是等级裁决的那句，几位时是「这一轮的参与者里没有人能做这件事」。

一轮里能做的因此不超过参与者里最高的那位，低的人借不到高的人不经审批的权限；按动作判也不用把权限排出高低，权限组让两个人各能做对方做不了的事时照样判得出。经审批放行的调用按批的人执行：守卫回 `{ ok: true, by }`，`by` 是批的人，他就是参与者之一时取那个参与者的身份（owner 的各个身份算一个），执行器把这次调用的参与者换成他。

工具执行中经 `approveFor` 交来的取用判定（取别的会话的东西、不属于任何会话的本机文件，见 [api-tools](../api/api-tools.md#toolcallcontext)）按同一条三分，判据换成它：有人过不了时发一道参与者审批（能批的是过得了的人），都过不了回第一位的原因；确认在调用开始时已经判过，不再判。

## 确认（轴 B）

授权已过（owner 或等级够）但操作声明了 `confirm`（经 `confirmOverrides` 覆盖后）时，仍要有人确认。守卫的判定顺序：

1. **可免的确认**：只对参与者都是 owner 的回合（参与者取守卫上下文的 `participants`，不看物理发言者）。`confirm` 为 `session` 时，`skipConfirm` 的受信来源（scheduler 触发的指令：owner 建任务时已经授权；runtime 一次性子命令：owner 在本机终端亲手输入）与 `restrictedPolicy` 白名单命中的能力免确认；`confirmOverrides` 设为 `'off'` 的能力连 `always` 也免。照旧免的是 owner 本人、owner 派的子任务、owner 建的定时任务、定义者与调用者都是 owner 的编排（运行身份见 [plugin-workflow](./plugin-workflow.md#定义者与运行身份)）。别人发起的回合照旧确认：群成员、别人的私聊里对方发起的、创建者不是 owner 的定时任务、MCP 客户端（`mcp:mcp-client` 不是 owner）、没有授权主体的回合（空闲触发、主动发言、不延续调用的宿主通知等，授权身份是匿名），以及定义者不是 owner 或没有定义者的编排。owner 在群里亲手发起（含没点名、被频率触发挑中的话）、从 WebUI 往房间插话的回合，授权身份也是 owner，照旧免；有别人的话一起进来的一轮不免，落到下一条与参与者审批合成的那一张。其余情形 `always` 每次确认，cron 等无人可问的上下文即拒。
2. **指令**：确认的是发出者本人的意图。plugin-commands 给人亲手输入的指令带上 `confirmIntent`，在同一会话里问发出者，只认他在这个会话里的下一条消息，带 `source` 的注入不认，60 秒不回即取消。没有 `confirmIntent` 的指令（适配器没给发出者的消息）无从确认，直接拒。不走 owner 审批：1 级成员在私聊里用 `/clear` 清自己的记忆照样能确认。
3. **工具**：确认是一道只有 owner 能批的审批，与参与者审批合成一次。守卫算出发起回合的类别（见下节），带上这一轮的参与者调 `approvals.request`；类别为 `hand` 且参与者里有 owner（不论在哪个会话）才能产生，其余由审批服务立即拒绝、不推给任何面，并记进审批审计。批准则按 owner 执行，拒绝时把审批服务给的话作为工具结果回给模型，只拒这一个调用。审批服务不在时立即拒并说明原因。只有 owner 能批的审批推给覆盖它的在场审批面：WebUI 与终端；owner 经哪个机器人账号发起的（私聊里、群里都算），装了 [plugin-chat-approval](./plugin-chat-approval.md) 时也推到她与这个账号的私聊，owner 在那里引用审批消息回复「同意」或「拒绝 原因」即结；不发进有别人的群窗口。参与者审批推给 WebUI、终端与这一轮所在聊天的群窗口，不到她的 IM 私聊。

参与者都命中硬禁、封禁，或等级不够、所属组也不覆盖即拒：发起者本人不能靠确认给自己提权，白名单也不放宽授权。

### 发起回合的类别

只看这一轮从哪里来，不看会话类型与受众，不判是不是 owner，不读会话记录；也不按授权身份判：owner 建的定时任务会把创建者回填成 `actor`，按它判就成了 owner 亲手。判据是执行守卫上下文里的 `inbound`（agent 工具循环填写）与参与者有没有账号（`originKind`，`packages/plugin-authority/src/authority-model.ts`）。权限服务以 `originOf(turn)` 对外给出同一个判定，执行守卫据它定审批的发起类别。是不是 owner 由用到类别的地方按身份判：审批服务看参与者里有没有 owner，这一轮的主体见下节。

按下面的顺序判，先命中的算：

1. 调用不在由入站消息驱动的回合里（编排的节点、mcp-server 等）：`autonomous`；
2. 续做与入站回合里派出的子任务（带起它的那一轮 `inbound.fromTurn`，如后台任务结束通知开的一轮、子任务插件的任务消息与追问）：与起它的那一轮同一类别，按那一轮的事实再判一次，不按通知或任务消息上的身份推。子任务里转后台的调用的续做经起它的子任务那一轮递归到派它的那一轮；
3. 其余带 `source` 的注入（定时任务、编排、空闲与主动发言、不延续调用的宿主通知、平台请求事件，以及不在入站回合里派出、没带 `fromTurn` 的子任务，如编排的工具节点、mcp-server 派的）：`autonomous`；
4. 人亲手发来的消息（没有 `source`，含群里没点名、被频率触发挑中的插话，几条一起进来的也是）：`hand`，不论在哪个会话、是谁；参与者都没有账号的（没有人的消息）是她自己开口，失败关闭为 `autonomous`。

### 这一轮的主体

权限服务的 `principalOf(turn)` 定这一轮的主体（`owner` 或 `other`），触及服务（[plugin-reach](./plugin-reach.md)）据它定本地效果。判据在类别之上按身份判（`principalKind`，与 `originKind` 同在 `authority-model.ts`）：

- 类别为 `hand` 且参与者（授权身份）都是 owner 为 `owner`，否则 `other`（owner 与别人同在的一轮也是）。续做与子任务的类别随起它的那一轮，参与者是那一轮交来的（批过的调用是批的人），不另判：派它的若是 owner 建的定时任务，参与者是 owner，类别却是 `autonomous`，主体为 `other`；
- 其余（`autonomous`）为 `other`。

## 配置项

- `config.owners`（`UserIdentity[]`）：owner 身份列表（owner = ∞，不在等级表内）。
- `config.deniedCapabilities`（glob 列表）：全局硬禁用，命中即拒，连 owner 都压过（配置总闸，非 per-user）。
- `config.authorityOverrides`（能力键 `type:name` → 整数）：owner 逐条覆盖单条操作的最低等级，无需改插件声明；传非整数则清除该条（回退默认派生）。
- `config.confirmOverrides`（能力键 `type:name` → `'session' | 'always' | 'off'`）：owner 逐条覆盖确认要求；`'off'` 关掉确认，只对参与者都是 owner 的回合生效，有别人的回落到插件的声明。
- `config.authorityGroups`（组名 → 放行条目列表）：权限组的定义，见上文「权限组」。成员在 users.json 里设，经 `/perm` 或权限页。
- `config.restrictedPolicy`（`{ allow?, duration? }`）：免确认白名单（能力 glob，`['*']` 全放），给自动化用。只免 `session` 档的确认，`always` 照常确认；只对参与者都是 owner 的回合生效，别人发起的、有别人的话一起进来的照旧要 owner 批准；不放宽授权，等级不够、所属组也不覆盖的照样拒。注意 `duration > 0` 的窗口只在权限页往白名单里加规则（动作 `waiveConfirm`，调 `markPolicyEnabled`）时开始计时（运行时态、不持久化），重启即失效、手写 yaml 不自动武装——想让它长期有效就别填 `duration`。权限页不改 `duration`，原值保留。

`DEFAULT_AUTHORITY`（未登记身份默认等级 = 0）是常量，不可配置。某操作是否 restricted 由其工具 / 指令声明的 `visibility` 决定，可经 `authorityOverrides`（等级）/ `confirmOverrides`（确认）逐操作覆盖。

## 指令

权限管理仅 owner 可达（防自授 / 防自我提权）。

- `/authority [target]` — 查看自己或指定用户（`<platform:userId>`）的权限等级（owner 显示「等级 ∞」）；有所属组时多一行「所属权限组」，没定义的组标「未定义」。
- `/level <target> <整数>` — owner 给外部身份设等级（越大越高，`0` 默认，负数封禁）。`visibility: 'restricted'`。例：`/level onebot:12345 5`、封禁 `/level onebot:12345 -1`。
- `/perm <target> [组名…]` — owner 覆盖式设外部身份所属的权限组，组名用空格隔开，不给组名即清空；这次新加的组没定义时回原因并列出已有的组，原有的组即使已被删掉也照收。`visibility: 'restricted'`。例：`/perm onebot:12345 helpers`。组的定义只在权限页与配置里改，没有指令。

> 不存在 `/grant`、`/deny`、`/bind` 指令（能力委托 / 跨平台绑定模型已移除）。

## 单 token WebUI 鉴权

WebUI 鉴权为**单 token**（向后兼容的服务器持有式）：访问 token → 身份 `webui:console`（owner 语义——token 存于服务器磁盘（数据目录的 `state/webui/`，启动日志只给文件位置），持有 token ≈ 控制服务器 ≈ owner）。**无账户密码**（无 `setPassword` / `verifyPassword`）。

## 权限页

放在 WebUI 设置里的声明式页面（`key: 'authority'`，位置 `settings`），五个标签，改动都用「动作带输入」：

| 标签 | 内容 | 动作 |
|---|---|---|
| 用户 | 登记了等级或组的外部身份（owner 不列）：身份、等级、权限组（没定义的组标「未定义」）、备注 | 行上「设等级」（输入等级，按这一行预填）、「设权限组」（多选组，按这一行预填，覆盖式，不选即清空；已被删掉的原有组标「（未定义）」，原样保存照收，新加没定义的组报错）、「删除记录」（destructive：删掉封禁记录就等于解封，所属权限组一并清掉）；「加用户」（输入平台、用户 ID、等级） |
| 权限组 | `authorityGroups` 里的组：组名、放行条目、成员数；说明写明组只加放行、不开工具分组闸、需要确认的工具对不是 owner 的成员照旧用不了、本地效果，以及通配与 `tool-group:` 会纳入以后新登记的工具 | 行上「改条目」（按这一行预填，整组替换）、「删除」（destructive，不级联）；「建组」（输入组名与放行条目）。放行条目是多选，可选项来源 `authority-operations` 列全部指令与工具的能力键与每个已登记工具分组的 `tool-group:<名>`，也能手写通配；写法不对的当场报错 |
| Owner | 配置里的 `owners`（本机控制台恒为 owner，不列） | 行上「移除」（destructive）；「加 owner」（输入平台与用户 ID，已经是 owner 的拒收） |
| 操作门槛 | 指令、工具与会话设置项按所属插件（设置项按插件实例）分组：操作数、已改门槛的数量。选中一组，详情列出这一组的每个操作：默认门槛（指令与工具按风险派生，设置项按字段声明的 `minLevel`，没写的写「只有 owner」；不含覆盖）、生效门槛、确认要求（`session` 显示「每次（白名单可免）」，`always` 显示「每次（只有确认覆盖设为 off 能免）」） | 组那一行上「整组设门槛」，操作那一行上「设门槛」；输入最低等级，留空恢复默认。写进 `authorityOverrides` |
| 禁用与免确认 | `deniedCapabilities` 与 `restrictedPolicy.allow` 里的规则；说明写明免确认只对以 owner 身份做的事生效 | 行上「移除」；「禁用」「免确认」（输入能力键或通配，重复的拒收） |

- 设权限组的可选项来源是 `authority-groups`：已定义的组名，加上成员记录里指向的、已被删掉的组名（标「（未定义）」）。两个来源都经贡献点 `webui:options` 交付，WebUI 客户端不认本插件。
- 等级与组成员的改动（设等级、设权限组、加用户、删除记录）与 `/level`、`/perm` 走同一个流程：先等等级表的首次读取落定，改完等落盘，没落盘时回执注明原因（见下文「用户数据」）。改宿主配置的动作先改运行态（即刻生效）再等 `save()`，保存失败时动作回错误，写明改动已在本次运行中生效、没写进配置文件及原因。每次改动后页面重取，保存失败时也一样。
- 只有 owner 能调页面动作，由 webui-server 的闸门保证（单 token 下身份恒为 `webui:console`），处理函数不另核调用者。
- 确认覆盖（`confirmOverrides`）不在页上，照旧从配置生效，随工作会话的模式另定。

## 用户数据（users.json v5）

```jsonc
{
  "version": 5,
  "users": {
    "<platform>:<userId>": {
      "level": 5,              // 整数：越大越高；缺省 0；封禁=负数；owner 不入表
      "note": "...",           // 可选备注（这人是谁）
      "groups": ["helpers"]    // 可选：所属权限组的组名，组定义在宿主配置 authorityGroups
    }
  }
}
```

记录里**没有**能力 glob、密码、绑定、委托树。等级为默认（0）、无备注且没有组时直接清记录，保持文件精简。`groups` 读取时只留非空字符串的组名并去重，别的值丢掉；空数组即没有组，写盘时省掉；没有这个字段的旧记录即没有组（仍是 version 5，不迁移）。首次读取落定前清空组，读完之后仍为空（内存里的清空盖过文件里的组）；清空之后记录里什么都不剩时，读完即清掉这条记录。

读取失败（文件在但读不出 / JSON 解析不了 / 不是 v5 结构，含旧的能力 / 密码 / 档位模型 v1–v4）时本次运行**拒绝写入** users.json 并记 error：`save` 写的是全量快照，坏文件被覆盖一次就意味着原有封禁 / 等级记录全丢。旧版本文件不做迁移，删除或移走该文件后重启即按全新开始；坏文件修好后重启即恢复正常写入；文件不存在（全新安装）不受影响。读取失败时文件里的封禁与等级没有载入，本插件发一条 error 提示（「需要处理」与插件详情里可见）：标题写 users.json 读不出来、封禁与等级没有载入，说明写修好数据目录里的 `state/users.json`（能读取、是 version 5 的完好 JSON）后重启、不要里面的记录就移走再重启，末尾带出读不出来的原因（读取的报错、JSON 解析错误，或不是 v5 结构时的 version）；重读成功后提示撤回。拒写期间 `/level`、`/perm` 与权限页的等级和组成员动作仍在内存中生效，`/level`、`/perm` 的回复与这几个动作返回的那句结果末尾注明「仅本次运行生效，未写入 users.json：它读不出来，修好数据目录里的 state/users.json 后重启」，界面把这句结果显示给 owner。

storage 晚于本插件上线时，首次读取在 storage 上线后异步进行；storage 重新上线（热重载、换提供者）时再读一次。重读以文件内容重建等级表：运行中从文件里删掉的记录随之消失，手工改过的值以文件为准；自上次成功写入以来改过或删过的用户以内存为准，读完后一并写入；读取开始时尚未写完、读取期间才写入成功的改动同样以内存为准。首次读取落定（读完、文件不存在或判为读不懂）之前不写盘，包括 storage 刚上线、读取尚未发起的间隙：这时内存里还没有文件里的记录，写下去的全量快照会覆盖原有记录。storage 上线前（首次读取尚未开始）改等级、改组、删记录也以内存为准，`/level`、`/perm` 的回复与权限页等级和组成员动作的结果末尾注明「未写入 users.json（等级表尚未载入），载入后写入」；首次读取落定后按正常路径写入，删掉的记录不随文件回来，改等级保留文件里的备注，降为 0 级也一样（这时即使没有备注，记录也以 0 级留在文件里；首次读取落定且未因读取失败拒写时，降为 0 级且无备注才清掉整条记录）。首次读取发起之前（storage 未上线，或刚上线、读取尚未发起）停机或卸载，这些改动不写入；读取已发起时，停机与卸载等它落定后写入。文件不存在时保留内存里的等级表。`/level`、`/perm` 与权限页的等级和组成员动作先等进行中的读取完成再改，写入结束后才回复。写入失败（storage 不在线、权限不足、磁盘写满）时记 error，改动留在内存，下次保存（再次改等级、storage 重新上线后的重读、停机或卸载）时重写；回复末尾注明「未写入 users.json（写入失败，见日志），下次保存时重试」。
