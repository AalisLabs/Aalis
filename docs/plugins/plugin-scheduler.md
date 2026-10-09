# plugin-scheduler — 定时任务调度

**包名**: `@aalis/plugin-scheduler`  
**源码**: `packages/plugin-scheduler/src/index.ts`

## 概述

AI 可主动创建的定时任务系统，支持三种调度方式：cron 表达式（周期）、固定间隔秒数（周期），以及 `runAt` 指定时刻执行一次（一次性）。AI 工具与计划任务页的新建、编辑还接受 `delaySeconds`，会换算为 `runAt`。

触发的消息带 `source='scheduler'`：plugin-agent 按来源分开管理生成，不会打断同会话的用户对话；plugin-commands 把它当作受信系统源（命令免交互确认，结果写入日志）。带 `source` 的内部注入不经 trigger-policy 的计数判定（与其 `scopes` 无关），也不受 flow-control 的回复后冷却约束；目标会话禁言期内一律不说话；会话落在 flow-control 作用域内时限速照常生效，限速窗口已满时这次触发被吞掉（做影子归档），不重试。消息不带会话类型，flow-control 判作用域时先用会话已记下的类型，没有再按会话 ID 约定推断：默认 `*:group` 下，平台与会话 ID 前缀一致（如 `onebot`）的任务发往群时在作用域内；平台为默认 `internal` 的任务发往没有流控状态的群时不推断，算作用域外。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-scheduler',
  provides: [scheduler],
  uses: {
    tools,
    cronEngine,
    storage: optional(storage),
    webui: optional(webuiServer),
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
| `persistPath` | string | `'data:/scheduler-jobs.json'` | 动态任务存储路径：通过 AI 或 WebUI 创建的任务会持久化到此 storage URI，重启后自动加载。 |

静态 `jobs` 支持 `runAt` 指定一次性执行时间。省略 `name`、`sessionId` 或 `content` 时，分别使用 `unnamed`、`scheduler::<任务名>` 和空内容；省略代理身份时按静态配置任务的规则使用 `webui:console`。身份平台与用户 ID 只填写其一时仍按整组缺省处理。显式非法的启用状态、目标平台、代理身份（`actorPlatform` / `actorUserId` 写成布尔、数组、对象；数字按字符串处理）或持久化路径会阻止插件激活。

## 注册工具

| 工具 | 说明 |
|---|---|
| `scheduler_create_job` | 创建定时/周期/一次性任务（`cron`、`interval`、`delaySeconds`、`runAt` 四选一；不传 `sessionId`/`platform` 时用当前会话） |
| `scheduler_list_jobs` | 列出任务及状态，可按名称关键词、状态过滤并分页 |
| `scheduler_remove_job` | 删除任务 |
| `scheduler_pause_job` | 暂停任务 |
| `scheduler_resume_job` | 恢复已暂停的任务 |

以上工具均属 `scheduler` 工具组。创建、删除、暂停、恢复为 `dangerous` 级且每次需确认，列表为 `sensitive` 级。

## 事件

| 事件 | 说明 |
|---|---|
| `scheduler:job:start` | 定时任务开始执行 |
| `scheduler:job:done` | 定时任务执行完成 |
| `scheduler:job:error` | 定时任务执行出错 |
| `trigger:fired` | 任务触发时广播的通用触发事件（`source` 为 `scheduler:<任务名>`）；不带 `workflowId`，目前不会触发任何 workflow |

## 工作方式

1. 任务有三个来源：配置项 `jobs`（静态任务）、WebUI「计划任务」页，以及 AI 调用的 `scheduler_create_job` 工具。后两者创建的是动态任务，会持久化到 `persistPath`（只接受 storage URI，写成相对路径等其它形态时拒绝激活）。激活时读不懂该文件（不存在以外的读取错误、解析失败、内容不是数组）则本次运行不再写入它，动态任务的增删改只在内存生效，原文件保持原样，`scheduler_create_job` 的回执末尾与计划任务页保存后的结果都注明「仅本次运行生效，未写入 `<persistPath>`：它读不出来，处理办法见「需要处理」里的提示」；同时发一条 error 提示（「需要处理」与插件详情里可见），带出读不出来的原因：读文件这一步就失败（存储插件不在、`persistPath` 的根名写错、文件读不了）时写确认存储插件在运行、改对 `persistPath` 后重载本插件，内容解析不了或不是数组时写修好这个文件或移走它后重载本插件。文件不存在按全新处理。
2. cron 任务订阅 cron-engine 服务的共享 tick（可按 `timeZone` 求值）；interval 任务用固定间隔定时器；runAt 任务到点执行一次，之后动态任务被删除，静态任务被停用。scheduler 服务的 `addJob`、`setJob` 当场校验 cron，无效的抛出原因、不落盘；计划任务页的新建、编辑与 `scheduler_create_job` 都经它们，别的插件经服务新建的同样如此。配置文件与持久化文件里 cron 表达式或时区无效、订阅不上的任务不会运行：插件照常激活，任务照样列在计划任务页，另发一条 error 提示，配置文件里的任务写去配置里改、持久化文件里的任务写去计划任务页编辑，并带出原因；任务重新保存后排上了或被删掉时提示撤回。
3. `cron` / `interval` / `runAt` / `delaySeconds` 是四种互不相容的定时语义，**恰好填一个**：一个都不填报「必须填写其中之一」，填了两个以上报「互斥，只能填一个」，不会静默取其中之一。计划任务页的新建、编辑与 `scheduler_create_job` 工具同一条判据。
4. 「暂停」只对周期任务（`cron` / `interval`）有效：一次性任务一旦被暂停，到点的定时器直接跳过且不会重排，任务会永久卡住。因此**一次性任务不能暂停，只能删除重建**：运行时入口一律拒绝——创建时 `paused` 与 `runAt` / `delaySeconds` 同填直接报错，事后调 `pauseJob` 返回失败（计划任务页只对就绪的周期任务显示「暂停」）。存量持久化文件里带 `paused` 的一次性任务，启动时告警并按未暂停处理（要停掉它请改 `enabled` 或删除任务）。
5. 触发时先广播 `trigger:fired`，再向目标会话发送 `inbound:message` 事件，`source` 设为 `scheduler`。消息的 `actor` 取创建任务时固化的创建者身份，触发的 AI 按该身份的权限执行，缺失则按匿名处理（配置文件中的静态任务缺省为 `webui:console`）。

## 计划任务页

WebUI 插件详情里的「计划任务」页（`key: 'scheduler'`）：一张任务表，加一个「新建」按钮。

- 表格列出名称、调度、目标会话、状态（禁用、暂停、执行中、就绪）、下次执行（倒计时）、上次执行、执行次数与最近结果。
- 行上的动作：「立即执行」（找不到任务、或这一轮还没执行完时回错误）、「暂停」（只对就绪的周期任务显示）、「恢复」（只对暂停的任务显示）、「编辑」（只对动态任务显示，配置文件里的任务只能改配置）、「删除」（确认框）。
- 「新建」与「编辑」都是带输入的动作：调度方式（cron、固定间隔、一次性运行时间、X 秒后执行，四选一）、目标会话 ID、目标平台、消息内容、启用、暂停。编辑的任务名取这一行，表单按这一行预填，任务已不在（一次性任务执行完自删、或刚被删掉）时回错误，不借编辑重建；新建遇到同名任务拒绝，改它要用「编辑」。创建者身份取调用者（WebUI 的 owner），不从输入读。
- 任务增删、启停与每次执行前后，页面都重取。
