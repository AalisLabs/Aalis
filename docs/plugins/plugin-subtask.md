# plugin-subtask — 子任务

**包名**: `@aalis/plugin-subtask`  
**源码**: `packages/plugin-subtask/src/index.ts`

## 概述

为 AI Agent 提供子任务创建与并行协调能力。注册 `subtask` 工具组，并通过 `agent:llm:before` / `agent:turn:after` 中间件实现父/子会话的上下文注入与子任务自动完成。

## 插件声明

```typescript
export default definePlugin({
  name: '@aalis/plugin-subtask',
  subsystem: 'session',
  uses: {
    tools: optional(tools),
    events,
    hooks,
    logger,
    config,
    sessionManager: optional(sessionManager),
    messageArchive: optional(messageArchive),
    agent: optional(agent),                       // 给子会话指定模型（assignModel）
    sessionSettings: optional(sessionSettings),   // 会话设置的管理面：建子会话写下设置、父会话改子会话的设置
    document: optional(ownHostConfig),            // 「子任务模型」的全局层
  },
  apply(caps) { /* 见源码 */ },
});
```

## 注册工具组

`subtask`

| 工具 | 说明 |
|---|---|
| `create_subtask` | 创建子会话并异步派发任务（不阻塞当前会话）；`model` 参数写条目 id `<提供者实例 id>/<模型 id>` |
| `check_subtask` | 查询一个或多个子任务的当前状态和结果；状态为 `active`、`completed`、`error` 或 `stopped`（已停止），汇总里另数已停止的个数。出错的另带 `reason`（出错原因）。到期销毁了的回它最后的状态与结果一次（`destroyed` 为真） |
| `send_to_subtask` | 向子任务追加消息（追问/补充指令）；已完成或出错的重新进入进行中 |
| `set_subtask_setting` | 改一个直接子任务本会话层的一项设置（只写值，不能恢复继承）；声明 `sensitive`，每次都要确认 |
| `delete_subtask` | 递归删除子任务会话 |
| `wait_subtasks` | 阻塞直到指定子任务全部结束（完成、出错、被停止或会话已不存在）或超时；超时取 `timeout_seconds` 与 `maxWaitMs` 中的较小者（事件驱动，非轮询）。被停止的报 `stopped`，不算完成；出错的另带 `reason`（出错原因）；到期销毁了的同 `check_subtask`；`timedOut` 只在等满时还有没结束的才为真 |

除 `create_subtask` 外的五个工具只认调用所在会话的直接子任务（会话记录的 `parentId` 是调用所在会话）。别的会话的子任务、根会话与不存在的 id 一律按「子任务不存在」回，不确认存在与否：`check_subtask` 与 `wait_subtasks` 对这一项不交出状态、任务与结果，也不等它；`send_to_subtask`、`set_subtask_setting` 与 `delete_subtask` 不执行。

## 工作方式

1. `create_subtask` 在 `session-manager` 中创建子会话，建之前调会话设置管理面的 `childMetadata`，把父会话此刻每一项适用于子会话的生效值写进子会话自己那一层（见 [plugin-session-settings](./plugin-session-settings.md) 的「子会话」），之后父会话与上面各层再改都不影响它。子会话的模型按「工具参数 `model` › 父会话此刻生效的「子任务模型」 › 父会话此刻实际在用的模型」取：前两者有值时建好后经 agent 的 `assignModel` 写进子会话那一层（写失败就删掉刚建的子会话、回错误），都没有时就是随设置写下的那一个。然后发送 `inbound:message` 事件触发子任务 agent 处理。子会话中不能再调用 `create_subtask`
   - 会话设置不在时回错误、不建；要指定模型而 agent 不在时回错误、不建。`model` 写法不对（不是 `<提供者实例 id>/<模型 id>`）时回错误；指向的模型之后被删掉，这个子任务的回合报「配置指向的模型不存在」
   - 派发与 `send_to_subtask` 的追问都是内部注入：`source` 为 `subtask`，`userId` 为 `parent:<父会话 id>`（归档用的来源标记，authority 查不到，等价匿名）。在入站回合里派出的带着派它的那一轮（`fromTurn`，见 [schema-message](../api/schema-message.md#起它的那一轮-fromturn)），不带 `actor`：子任务那一轮的参与者取派它的那次调用的参与者（批过的是批的人，几个人都能做、没经审批的是那几个人，子任务里照同样的逐动作规则判，审批不上浮），权限服务按那一轮判这一轮的主体（[plugin-authority](./plugin-authority.md#这一轮的主体)），不按父会话里别的哪一轮；不在入站回合里派出的（编排的工具节点、mcp-server）不带 `fromTurn`，授权身份走 `actor`（调用的唯一参与者，即 api-tools 的 `actingIdentity`；匿名或几个参与者时不带，子任务同样匿名）。它们不经触发判定、不查回复后冷却；带着 `source`，正文写成指令的也不执行，当普通消息交给子任务，指令的意图确认也不认它们；要求真人当面发起的工具（白纸的交任务与取消）拒绝子任务回合。派发与追问共用一条 lane，追问会打断子任务正在跑的那一轮
   - 子任务回合里需要确认的工具调用不转给 owner 审批，立即拒绝并写明原因（「子任务里需要确认的操作不上浮，请在发起它的会话里执行」），需要确认的操作由父会话自己做
   - 子会话没有窗口：她在子任务里说的话不交给平台，不发进父会话所在的群或私聊，只进子会话的历史（WebUI 经会话服务的时间线看），父会话靠子任务的结果与提醒拿到结果
2. 子会话的系统提示由 `agent:llm:before` 中间件注入子任务上下文（任务指令、共享资源规则）
3. 父会话侧不改动首条系统提示（避免破坏 provider 前缀缓存），而是在消息列表尾部插入一条独立的 system 消息"活跃子任务提醒"，列出进行中、出错、已停止和已完成的子任务；最后一条是 user 消息时插在它之前，否则追加到末尾。每轮先移除上一轮的提醒，再按最新状态重新生成
4. 子任务 agent 本轮以 `replied` 结束、回复非空且子会话尚未完成或出错时，`agent:turn:after` 中间件以该回复为结果调用 `sm.completeSession`；若 `message-archive` 服务可用，调用前还会在子会话历史中合成一条 `report_to_parent` tool call 记录及其结果消息
5. 子会话的收口由 session-manager 做，与根会话同一套：最后一轮出错收口为 `error`，被停止、静默的收口为 `completed`，并记下这一轮（`lastTurn`）。被停止的子会话（`completed` 且 `lastTurn.outcome` 为 `aborted`）三处都报已停止（`stopped`），不算完成：`check_subtask`、`wait_subtasks` 与父会话的子任务提醒。出错的子会话三处都带出 `lastTurn.error` 里的原因（工具结果的 `reason` 键，提醒里写在名字后面）；没有原因时两个工具不带 `reason`，提醒写「(无错误详情)」。不拿 `result` 充当原因：出错时它若有值，是此前某一轮回复收口时留下的结果
6. `wait_subtasks` 监听 `session:completed` / `session:updated` / `session:deleted` 事件等待全部子任务终结；子会话出错、被停止或到期销毁时随即返回，不等到超时
7. **到期销毁**：子会话的一轮结束（回复、出错或被停止都算）后闲置满 `idleDeleteHours`，就连同它的对话记录、各插件按会话存的数据和它下面的子会话一起删掉；追问一次在下一轮结束时重新计时，从没跑过一轮的不计时，重启不丢（按记下的最近一轮结束时间重算）。在飞的一轮与发出还没开跑的追问由本插件自己记：这期间不销毁，一轮一直不收尾时同样不判到期。删除只在定时器里做，删除时这一轮当场停下（agent 在 `session:deleted` 里中止它）
8. **回报**：到期销毁之前，把子任务最后的状态、出错原因、结果与任务写进父会话记录（`metadata.subtask`）。父会话经 `check_subtask`、`wait_subtasks` 读到即删，父会话提醒里列出它的那一轮结束后删；父会话在它还在时已经取走过同一份结果的不再写。父会话的消息历史被清空时回报一并清掉。每到期销毁一个子会话，父会话在会话列表里被顶到前面一次
9. **父会话改子会话的设置**：`set_subtask_setting` 经会话设置管理面的 `setAs` 写直接子会话本会话层的一项，与在那个子会话里用 `/session.set` 是同一份实现：认项、文字读法（列表与映射写 `[]`、文字传空串即设成空）、门槛（按这一轮发起的人判）与回执。项写错、不适用或重名时回执列出能改的项。声明 `sensitive` 加 `confirm: 'session'`：模型给自己派的子会话放权等于自授，要有人确认；owner 配了免确认时以 owner 身份做的不弹，群里别人发起的回合发不起审批、用不了它
10. 清空（`/clear`）一个会话时它的子会话一并删除（会话管理做），删除父会话同样连带子会话

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 启用子任务工具 |
| `maxWaitMs` | number | `300000` | 单次等待最大时长 (ms) |
| `model` | 模型 | 不设 | 「子任务模型」：可按会话设（适用 owner 会话与房间，1 级能改），按派子任务的会话取，能按群设；`create_subtask` 的 `model` 参数压过它；没设时写「不另指定（与本会话相同）」 |
| `idleDeleteHours` | number | `24` | 交回后闲置销毁（小时），不设上限；0 即一轮结束立即销毁 |

## 相关插件

会话历史读取已拆分到独立插件：[plugin-tool-session](./plugin-tool-session.md)。

## 配置校验

`enabled` 的显式无效类型会报配置错误，避免悄悄启用工具。`maxWaitMs` 接受数字字符串；0 仍取默认值，负数仍保留现有超时语义。
