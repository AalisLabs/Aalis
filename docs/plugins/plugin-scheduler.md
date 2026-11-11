# plugin-scheduler — 定时任务调度

**包名**: `@aalis/plugin-scheduler`  
**源码**: `packages/plugin-scheduler/src/index.ts`

## 概述

AI 可主动创建的定时任务系统，支持三种调度方式：cron 表达式（周期）、固定间隔秒数（周期），以及 `runAt` 指定时刻执行一次（一次性）。AI 工具与计划任务页的新建、编辑还接受 `delaySeconds`，会换算为 `runAt`。

触发的消息带 `source='scheduler'`：在 plugin-agent 里单独成一轮，排在同会话在跑的一轮之后，不打断用户对话。消息同时声明 `ownerApproved`（schema-message）：任务内容来自 owner 写的配置与计划任务页，或经 owner 审批的 `scheduler_create_job`，算作 owner 亲手写的，plugin-commands 照常解析其中的指令，结果写入日志；创建者是 owner 的任务免 `session` 档的交互确认，别人建的任务里需要确认的指令直接拒绝（见 [plugin-authority](./plugin-authority.md) 的「确认（轴 B）」）。例外：参与者都是 owner 的回合里 `scheduler_create_job` 免了确认时（在 `restrictedPolicy` 免确认白名单里，或配置的 `confirmOverrides` 把 `tool:scheduler_create_job` 设为 `off`），建任务不经审批，任务内容（模型写出的）没经 owner 过目原文，触发时照样声明 `ownerApproved`，其中的指令照样以 owner 的身份执行，与审批过的任务不作区分（见 [安全模型](../concepts/security-model.md#注入的文字不执行指令)）。别的插件经 `scheduler` 服务的 `addJob`、`setJob` 建的任务同样声明，交来的内容要是 owner 过目过原文的。带 `source` 的内部注入不经 trigger-policy 的计数判定（与它的生效范围无关），也不受 flow-control 的回复后冷却约束；目标会话禁言期内一律不说话；会话在 flow-control 的生效范围内时限速照常生效，限速窗口已满时这次触发被吞掉（做影子归档），不重试。内部注入没有网关算的聊天窗口，flow-control 判生效范围时先取会话管理记下的聊天窗口，没有再用流控状态里记下的：默认的多方房间下，发往已收录的群的任务在生效范围内（平台为默认 `internal` 的也一样，按群记下的出生平台算）；发往会话表里没有记录的会话时没有聊天窗口，在生效范围外。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-scheduler',
  provides: [scheduler],
  uses: {
    tools,
    cronEngine,
    storage,
    webui: optional(webuiServer),
    sessionManager: optional(sessionManager),
    events,
    lifecycle,
    logger,
    config,
    provide,
  },
  apply(caps) { /* 见源码 */ },
});
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `jobs` | array | `[]` | 计划任务列表：配置定时/周期性任务，让 AI 主动执行计划。 |
| `persistPath` | string | `'data:/scheduler-jobs.json'` | 动态任务存储路径：AI 或 WebUI 创建的任务与配置里一次性任务的执行记录存在这里（storage URI），重启后自动加载。 |

静态 `jobs` 支持 `runAt` 指定一次性执行时间。省略 `name`、`sessionId` 或 `content` 时，分别使用 `unnamed`、`scheduler::<任务名>` 和空内容；省略执行身份时按静态配置任务的规则使用 `webui:console`。执行身份与目标平台无关，权限服务按 `actorPlatform` 与 `actorUserId` 这一对身份裁决能力。身份平台与用户 ID 要成对填写：只填写其一是配置错误，这条任务不载入，日志记一条错误、WebUI 出一条「需要处理」提示；配置文件里写了的名字归配置文件，持久化里同名的动态任务不顶替它，经服务的 `addJob`、`setJob`（计划任务页、`scheduler_create_job` 与别的插件）新建同名的任务时报「来自配置文件」。显式非法的启用状态、目标平台、执行身份（`actorPlatform` / `actorUserId` 写成布尔、数组、对象；数字按字符串处理）或持久化路径会阻止插件激活。

## 注册工具

| 工具 | 说明 |
|---|---|
| `scheduler_create_job` | 创建定时/周期/一次性任务（`cron`、`interval`、`delaySeconds`、`runAt` 四选一；不传 `sessionId`/`platform` 时用当前会话，子会话里例外，见下文） |
| `scheduler_list_jobs` | 列出任务及状态，可按名称关键词、状态过滤并分页 |
| `scheduler_remove_job` | 删除任务 |
| `scheduler_pause_job` | 暂停任务 |
| `scheduler_resume_job` | 恢复已暂停的任务 |

以上工具均属 `scheduler` 工具组。创建、删除、暂停、恢复为 `dangerous` 级（2 级加确认），与子任务、编排、停后台任务同一规则：别人单独发起的一轮没人能批，拒绝；有 owner 在的一轮出审批卡给她批；她一个人的回合在免确认白名单（`restrictedPolicy`）里不问。列表只看不改，2 级、不确认（`visibility: 'restricted'`）。

在子会话里调 `scheduler_create_job` 不传 `sessionId` 时报错，要写明目标：子会话没有窗口，删掉后发往它的任务会静默丢失。报错里给出根会话的 id 作候选，照传即发回根会话。子会话按会话记录的 `parentId` 认：编排的 `agent` 节点省略 `sessionId` 时用的一次性会话（`workflow::<运行 id>::<节点 id>`）没有 `parentId`，不在这条规则里，在那里不传 `sessionId` 照旧发往这个一次性会话。

## 事件

| 事件 | 说明 |
|---|---|
| `scheduler:job:start` | 定时任务开始执行 |
| `scheduler:job:done` | 定时任务执行完成 |
| `scheduler:job:error` | 定时任务执行出错 |
| `trigger:fired` | 任务触发时广播的通用触发事件（`source` 为 `scheduler:<任务名>`）；不带 `workflowId`，目前不会触发任何 workflow |

## 工作方式

1. 任务有三个来源：配置项 `jobs`（静态任务）、WebUI「计划任务」页，以及 AI 调用的 `scheduler_create_job` 工具。后两者创建的是动态任务，会持久化到 `persistPath`（只接受 storage URI，写成相对路径等其它形态时拒绝激活）；配置里一次性任务的执行记录也在这个文件里。文件是一个对象：`jobs` 是动态任务数组，`onceFired` 是配置里一次性任务的执行记录（任务名到执行过的那次 `runAt` 原文）。激活时读不懂该文件（不存在以外的读取错误、解析失败、结构不对）则本次运行不再写入它，动态任务的增删改只在内存生效，配置里的一次性任务执行过没有无从判断、本次运行不安排，原文件保持原样，`scheduler_create_job` 的回执末尾与计划任务页保存后的结果都注明「仅本次运行生效，未写入 `<persistPath>`：它读不出来，处理办法见「需要处理」里的提示」；同时发一条 error 提示（「需要处理」与插件详情里可见），带出读不出来的原因：读文件这一步就失败（`persistPath` 的根名写错、文件读不了）时写改对 `persistPath`、确认文件能读取后重载本插件，内容解析不了或结构不对时写修好这个文件或移走它后重载本插件（移走后执行记录随之没了，配置里过了时间的一次性任务会再执行一次）。文件不存在按全新处理。
2. cron 任务订阅 cron-engine 服务的共享 tick（可按 `timeZone` 求值）；interval 任务用固定间隔定时器；runAt 任务到点执行一次：动态任务执行前先从 `persistPath` 删掉，执行期间仍列在计划任务页（显示在跑），执行完从页上消失，执行途中重载本插件、改配置、storage 重启或停机都不会再执行一遍；配置里的任务执行前把「任务名 + `runAt`」记进 `persistPath`，执行完停用，之后每次激活（宿主重启、重载本插件、改配置、storage 重启）见到记录都不再执行，过了 `runAt` 而没有记录的（如宿主停机时错过）激活时补执行一次，配置里改了 `runAt` 算新的一次。scheduler 服务的 `addJob`、`setJob` 当场校验 cron 与固定间隔，无效的抛出原因、不落盘；计划任务页的新建、编辑与 `scheduler_create_job` 都经它们，别的插件经服务新建的同样如此。固定间隔（含 `@every`）要是不小于 5 秒、不超过 2147483 秒（约 24.8 天）的数：更短的会占满调度、耗尽资源；间隔交给定时器，超过 2^31-1 毫秒会溢出成每毫秒触发一次。配置文件与持久化文件里 cron 表达式或时区无效、订阅不上，或固定间隔无效的任务不会运行：插件照常激活，任务照样列在计划任务页，另发一条 error 提示，配置文件里的任务写去配置里改、持久化文件里的任务写去计划任务页编辑，并带出原因；任务重新保存后排上了或被删掉时提示撤回。
3. `cron` / `interval` / `runAt` / `delaySeconds` 是四种互不相容的定时语义，**恰好填一个**：一个都不填报「必须填写其中之一」，填了两个以上报「互斥，只能填一个」，不会静默取其中之一。计划任务页的新建、编辑与 `scheduler_create_job` 工具同一条判据。
4. 「暂停」只对周期任务（`cron` / `interval`）有效：一次性任务一旦被暂停，到点的定时器直接跳过且不会重排，任务会永久卡住。因此**一次性任务不能暂停，只能删除重建**：运行时入口一律拒绝——创建时 `paused` 与 `runAt` / `delaySeconds` 同填直接报错，事后调 `pauseJob` 返回失败（计划任务页只对就绪的周期任务显示「暂停」）。存量持久化文件里带 `paused` 的一次性任务，启动时告警并按未暂停处理（要停掉它请改 `enabled` 或删除任务）。
5. 触发时先广播 `trigger:fired`，再向目标会话发送 `inbound:message` 事件，`source` 设为 `scheduler`。消息的 `actor` 取创建任务时固化的创建者身份，触发的 AI 按该身份的权限执行，缺失则按匿名处理（配置文件中的静态任务缺省为 `webui:console`）。

## 计划任务页

WebUI 插件详情里的「计划任务」页（`key: 'scheduler'`）：一张任务表，加一个「新建」按钮。

- 表格列出名称、调度、目标会话、状态（禁用、暂停、执行中、就绪）、下次执行（倒计时）、上次执行、执行次数与最近结果。
- 行上的动作：「立即执行」（找不到任务、或这一轮还没执行完时回错误）、「暂停」（只对就绪的周期任务显示）、「恢复」（只对暂停的任务显示）、「编辑」（只对动态任务显示，配置文件里的任务只能改配置）、「删除」（确认框）。
- 「新建」与「编辑」都是带输入的动作：调度方式（cron、固定间隔、一次性运行时间、X 秒后执行，四选一）、目标会话 ID、目标平台、消息内容、启用、暂停。编辑的任务名取这一行，表单按这一行预填，任务已不在（一次性任务执行完自删、或刚被删掉）时回错误，不借编辑重建；新建遇到同名任务拒绝，改它要用「编辑」。创建者身份取调用者（WebUI 的 owner），不从输入读。
- 任务增删、启停与每次执行前后，页面都重取。
