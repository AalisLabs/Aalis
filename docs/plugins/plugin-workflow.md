# plugin-workflow — DAG 工作流编排

**包名**: `@aalis/plugin-workflow`  
**契约**: `@aalis/api-workflow`  
**源码**: `packages/plugin-workflow/src/index.ts`（引擎 `engine.ts`）

## 概述

声明式 DAG 工作流：一个工作流 = 触发器 + 节点图（`nodes` + `deps` 边）。引擎按 `deps`
拓扑分层执行，同层并行；任一节点失败整个 run 标记 `failed`。节点可声明 `out` 把字符串结果
存入 `outputs` 命名空间，供下游节点用 `{{outputs.<out>}}` 插值。

定义存 `workspace:/workflows/*.yaml`（用户/AI 资产），运行实例存 `data:/workflow-runs.json`（同一文件里还记 `once` 触发器的 `firedAt` 与定义者记录，形状 `{ runs, onceFired, definers }`）。

定义的 `id` 就是定义文件的文件名（`<id>.yaml`），只能用英文字母、数字、下划线与连字符：带 `/`、`..` 的会把写与删引到定义目录之外。定义时不合规的报错、不保存（`workflow_define` 回 `error`，工作流页「新建或覆盖」与编排服务的 `defineWorkflow` 报错）；`defsDir` 里不合规的不载入，记一条警告。删除（`workflow_remove`、工作流页「删除」、编排服务的 `removeWorkflow`）只对已载入的定义动文件，别的 id 回不存在、不碰存储。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-workflow',
  displayName: '工作流',
  subsystem: 'workflow',
  provides: [workflow],
  uses: {
    cronEngine,
    storage: optional(storage),
    tools: optional(tools),
    webui: optional(webuiServer),
    authority: optional(authority),
    events,
    hooks,
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
| `defsDir` | string | `'workspace:/workflows'` | 工作流定义目录：加载存储下的 *.yaml 定义（storage URI）；AI 通过 workflow_define 创建的定义也写入此处。 |
| `runsFile` | string | `'data:/workflow-runs.json'` | 运行历史文件：保存最近 N 条运行实例（storage URI）。 |
| `maxRuns` | number | `200` | 保留最近运行条数：超过则裁剪最旧的已结束的运行，在跑的不裁；最小 10。 |
| `enableTools` | boolean | `true` | 注册 AI 工具：开启后向 LLM 暴露 workflow_define / workflow_run 等工具。 |

## 触发器

| 类型 | 字段 | 说明 |
|---|---|---|
| `cron` | `expr` | 按 cron 表达式周期触发，经 `cron-engine` 服务订阅 |
| `interval` | `seconds` | 每隔 `seconds` 秒触发（向下取整，最小 1），经 `cron-engine` 以 `@every <N>s` 订阅 |
| `once` | `runAt` | 在指定时间触发一次，**一生只触发一次**：触发即把 `firedAt` 记入运行历史文件（`runsFile`），此后重启进程、重新注册、重复 `workflow_define` 都不再触发；**定义不存在时记录随之清除**——`workflow_remove` 清掉记录（有文件的定义删不掉文件时报错，定义与记录都保留；只在内存里的定义照常删除），手动删掉 `defsDir` 里的 yaml 也会在下次启动扫描定义后补清，同 id 重建都算新工作流。`runAt` 须能被 `Date.parse` 解析；时间已过且从未触发过，则注册时立即补触发一次。运行历史文件读不出（不存在以外的读取错误、解析失败、结构不对）时无从判断是否触发过，本次运行不安排任何 once（含 `runAt` 在未来的），也不再写入该文件，`workflow_define` 定义 once 时回执带 `note` 说明本次运行不会触发，工作流页「新建或覆盖」保存 once、「启用」启用 once 时同样显示这句说明；修复文件后重启，或用 `workflow_run` 手动执行 |
| `event` | `event`, `filter?` | 订阅指定事件；`filter` 的每个键须与事件第一个参数的同名顶层字段严格相等；事件参数数组以运行变量 `args` 注入 |
| `manual` | — | 不注册触发器，仅手动运行 |

`event` 触发器不接受负载带会话内容（会话 id、平台、正文等）的事件：消息与回复（`inbound:message`、`inbound:message:archived`、`assistant:message:archived`、`outbound:message`、`outbound:delivered`、`outbound:stream`），工具调用的参数、结果与输出（`tool:execute`、`tool:output`、`background:changed`），审批（`approval:created`、`approval:settled`），附件的识别结果（`media:processed`），待办（`todo:updated`），会话档案（`session:created`、`session:updated`、`session:completed`），会话的活动（`token:usage`、`token:request`、`llm:usage`、`gateway:phase:done`、`memory:messages-deleted`、`memory:messages-rewritten`、`history:changed`、`session:compressing`、`session:deleted`），以及 `trigger:fired` 与编排自己的运行事件（`workflow:run:start`、`workflow:run:done`、`workflow:run:error`、`workflow:node:done`）。编排按定义者的身份运行（见下文「定义者与运行身份」），事件参数插值进 `tool` 节点的参数、`agent` 节点的指令或 `send-message` 节点的正文时，内容里不可信的部分就以定义者的身份下达，转发到别的会话还会造成跨会话泄露；单是会话 id 也让订阅者看出别人的私聊在活动。

定义订阅这些事件的编排时直接报错、不保存，错误写明是哪个事件：`workflow_define` 回 `error`，工作流页「新建或覆盖」与编排服务的 `defineWorkflow` 报错。已在 `defsDir` 里的这类定义照常载入，触发器不注册，文件不改；启用着的记一条警告，写明要改掉触发器重新保存或删掉；工作流页的「启用」「停用」会重写定义文件，与定义走同一条规则，对它同样报错。这里只列第一方声明的事件。第三方插件声明的事件照常可以订阅，负载带会话内容的也一样，声明它的插件拦不住，由定义编排的人按插件的说明自己判断。

由 plugin-scheduler 的定时任务触发编排，两条路的现状：

- `trigger:fired`：plugin-scheduler 每次执行任务时广播，但不带 `workflowId`，本插件只运行带 `workflowId` 的（见下文「事件」）；`event` 触发器订阅 `trigger:fired` 又在上面的拒绝之列。
- `scheduler:job:start`、`scheduler:job:done`、`scheduler:job:error`：`event` 触发器可以订阅，事件参数是任务名（`scheduler:job:error` 另带失败原因），`{{vars.args[0]}}` 取任务名。第一个参数是字符串，`filter` 按对象的顶层字段比对，写了非空的 `filter` 就永远不触发；不写则每个定时任务执行都触发一次，选不出某一个任务。

所以没法让某一个定时任务触发编排。要按时间运行编排，用编排自己的 `cron`、`interval` 或 `once` 触发器；要在某个会话里做事，用 `send-message` 或 `agent` 节点指向那个会话。

## 节点类型

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `tool` | `tool`, `args` | 调用一个已注册工具；`args` 支持插值 |
| `send-message` | `sessionId`, `content`, `platform?` | 向会话投递 `inbound:message`（fire-and-forget，不等回复）；`platform` 默认 `internal`。正文写成指令的也不执行，当普通消息交给她 |
| `wait` | `seconds` | 等待固定秒数 |
| `agent` | `instruction`, `sessionId?`, `platform?`, `timeoutSeconds?` | 把指令派发给 agent **并等待本轮回复**；回复文本作节点结果；`platform` 默认 `workflow`。`instruction` 写成指令系统的指令也不执行，交给 agent |

`args`（递归处理其中的字符串）、`content`、`instruction`、`sessionId`、`platform` 支持 `{{vars.X}}`（运行变量）与 `{{outputs.Y}}`（上游节点输出）插值；`tool`（工具名）、`id`、`out`、`deps` 不插值。

## `agent` 节点：确定性的多智能体编排

`agent` 节点是 `send-message` 的「等回复」版：经网关把指令送进目标会话（来源 `workflow:<编排>:<节点>`），在目标会话里
单独成一轮、排在那里在跑的一轮之后；送达在节点自己的异步上下文里调用，节点只认它开的那一轮的 `agent:turn:after`（同一会话里
别的回合、同一编排别的运行的同名节点都不认），把回复经 `out` 存入
`outputs`。配合 `deps` + 插值，单个 DAG 即可表达「分解 → 依赖 → 串/并行 → 管道 → 聚合」的确定性编排流程。

- 省略 `sessionId` 时为该节点生成一次性隔离子会话 `workflow::<runId>::<nodeId>`，适合子任务场景。这个 id 只用 `::` 分段、
  不含单冒号，不会被当成 IM 房间，按节点的 `platform` 选平台档；显式指向 IM 房间（`<平台>:...`）时按房间的出生平台选档，
  节点的 `platform` 不影响选档。
- `timeoutSeconds`（默认 120）内未收到回复 → 节点失败；`outcome=error/aborted` → 节点失败；
  `outcome=silent`（agent 选择不回复）是合法结果，节点成功、输出空串。
- 立即失败、不等满超时：网关不在；指向调起这次运行的会话（经 `workflow_run` 调起时，那一轮在等这次运行，节点开不了轮）；
  指令在网关相位被吞（禁言、限速等）或排着时被放掉，没开轮。

示例：两路 agent 并行调研 → 第三个 agent 聚合（管道传值）：

```yaml
id: research-and-summarize
trigger: { type: manual }
vars:
  topic: "向量数据库选型"
nodes:
  - id: scout_a
    type: agent
    instruction: "从性能角度调研：{{vars.topic}}"
    out: a
  - id: scout_b
    type: agent
    instruction: "从成本角度调研：{{vars.topic}}"
    out: b
  - id: summarize
    type: agent
    deps: [scout_a, scout_b]
    instruction: "综合下面两份调研给出结论：\n性能：{{outputs.a}}\n成本：{{outputs.b}}"
    out: report
```

## 定义者与运行身份

每个编排记下定义者：经 `workflow_define` 定义的取调用者的授权身份（api-tools 的 `actingIdentity`；它要 owner 审批，批过的是批的人；参与者都是 owner、免了这道确认时不问，取那位 owner，见下文「注册工具」），经工作流页「新建或覆盖」保存的取登录的 owner；覆盖即换成覆盖者，启用与停用沿用原来的。定义者不写进定义文件，也不从定义文件读：它连同写进文件的那份文本的哈希记在 `runsFile` 里，载入时文本对得上才带上定义者。下面几种没有定义者：

- 经编排服务的 `defineWorkflow` 定义或覆盖的（别的插件调用的）：服务认不出调用方是谁；
- 手写进 `defsDir`、没经工作流页或 `workflow_define` 存过的定义；
- 定义文件在磁盘上被改过的；
- `runsFile` 读不出时载入的全部定义。

要让这类编排按 owner 执行，在工作流页用「新建或覆盖」存一次。只在内存里注册的定义（不写入磁盘），定义者也只在内存，重启后随定义一起没有。

工作流内部的 `tool` 节点与 `send-message`、`agent` 节点投递的消息按运行身份过权限闸。运行身份取定义者与调用者里不是 owner 的一方：调用者是 owner 时取定义者（没有即匿名），否则取调用者。两者都是 owner 才按 owner 执行，确认的豁免（见 [plugin-authority](./plugin-authority.md) 的「确认（轴 B）」）也只在这时生效；owner 调起别人定义或覆盖过的编排时，按那个人的等级执行。调用者按入口定：

| 入口 | 调用者 |
|---|---|
| `workflow_run` | 调用者的授权身份（`actingIdentity`：几个人都能做、没经审批的一轮按匿名；批过的是批的人） |
| 工作流页「立即运行」 | 登录的 owner |
| `cron`、`interval`、`once`、`event` 触发与 `trigger:fired` | 定义者 |

`event` 触发的事件参数（运行变量 `args`）与 `trigger:fired` 的 `payload` 作为运行变量进入这次按定义者身份的运行：插值进 `tool` 节点的参数、`agent` 节点的指令或 `send-message` 节点的正文时，触发方写的内容就以定义者的身份下达，订阅的事件与 `trigger:fired` 的发出方要可信。

判 owner 用权限服务（`authority`，optional）。它不在时（停用或重载的窗口）判不出谁是 owner：调用者与定义者是同一身份时按这个身份执行，否则按匿名。

## 注册工具

| 工具 | 说明 |
|---|---|
| `workflow_define` | 定义/覆盖工作流（完整 YAML）；要 owner 审批，审批卡上是 YAML 原文（见下文） |
| `workflow_run` | 手动触发一次运行，等它跑完回结果；所在的一轮被停下（停止键、`/stop`、禁言、`/clear`）时只是不再等，回 `error`「回合已中止，不再等」，运行照跑；要停这次运行，到工作流页「最近运行」里取消 |
| `workflow_list` | 列出全部定义 |
| `workflow_get_runs` | 查询最近运行历史 |
| `workflow_remove` | 删除定义（含磁盘文件） |

`workflow_define` 声明 `confirm: 'session'`，与 plugin-scheduler 的 `scheduler_create_job` 和别的要确认的操作同一规则：定义出的编排此后按定义者的身份运行，审批卡上是原文。参与者都是 owner 的回合里免了确认时（在免确认白名单 `restrictedPolicy` 里，或 `confirmOverrides` 把 `tool:workflow_define` 设为 `off`），定义不经审批，原文没经 owner 过目。不能产生审批的回合（定时任务、编排节点、mcp-server、空闲触发与主动发言等）里，要审批的定义一律被拒。工作流页「新建或覆盖」是 owner 亲手保存，不问。

## 工作流页

WebUI 插件详情里的「工作流」页（`key: 'workflows'`）：

- 概况：定义数、启用数、24 小时内的运行与失败次数（失败不含已取消的）；
- 定义表：ID、名称、触发、节点数、状态（启用或停用）、定义者（没有定义者的写「匿名」）、描述。选中一个，详情里显示它的 YAML。行动作「立即运行」（运行没有成功时回错误与原因）、「启用」「停用」（按当前状态显示其一，改写磁盘上的定义）、「删除」（确认框，连同磁盘上的定义文件；不存在时回错误）；
- 最近运行表：工作流、状态、触发来源、开始时间、用时、错误与运行 ID，列最近 50 次，更早而还在跑的接在后面。在跑的运行有行动作「取消运行」（确认框；调编排服务的 `cancelRun`，各节点怎么停见 [workflow 服务](../services/workflow.md#_7-边界与注意事项)「取消打断阻塞中的节点」）：记录留在运行历史里、状态为「已取消」；已结束的运行没有这个按钮，页面没刷新、运行已经结束时点了回「这次运行已经结束」。进程没有正常退出（崩溃、被强行结束）时还在跑的运行，下次载入运行历史时是「已取消」，错误写「进程退出时中断」，用时写「—」；
- 「新建或覆盖」：带输入的动作，粘贴完整 YAML，可选不写入磁盘。

运行与节点的错误原因按读者的语言显示（类型见 [workflow 服务](../services/workflow.md)）。定义增删、每次运行开始与结束，页面都重取。

## 事件

| 事件 | 说明 |
|---|---|
| `trigger:fired` | 订阅外部触发事件：仅当事件带 `workflowId` 时运行对应 workflow，`payload` 并入运行变量；plugin-scheduler 广播的该事件不含 `workflowId`，不会触发工作流 |
| `workflow:run:start` / `:done` / `:error` | 运行生命周期 |
| `workflow:node:done` | 单节点完成（含 `NodeRunInfo`） |

## 相关

- 定时任务（与本插件共用 `cron-engine` 服务）：[plugin-scheduler](./plugin-scheduler.md)
- 子会话分发（agent 自主编排版）：[plugin-subtask](./plugin-subtask.md)
