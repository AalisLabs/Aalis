# plugin-workflow — DAG 工作流编排

**包名**: `@aalis/plugin-workflow`  
**契约**: `@aalis/api-workflow`  
**源码**: `packages/plugin-workflow/src/index.ts`（引擎 `engine.ts`）

## 概述

声明式 DAG 工作流：一个工作流 = 触发器 + 节点图（`nodes` + `deps` 边）。引擎按 `deps`
拓扑分层执行，同层并行；任一节点失败整个 run 标记 `failed`。节点可声明 `out` 把字符串结果
存入 `outputs` 命名空间，供下游节点用 `{{outputs.<out>}}` 插值。

定义存 `workspace:/workflows/*.yaml`（用户/AI 资产），运行实例存 `data:/workflow-runs.json`（同一文件里还记 `once` 触发器的 `firedAt`，形状 `{ runs, onceFired }`）。

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
| `defsDir` | string | `'workspace:/workflows'` | 工作流定义目录：加载存储下的 *.yaml 定义（storage URI，也兼容旧【workspace/workflows】）；AI 通过 workflow_define 创建的定义也写入此处。 |
| `runsFile` | string | `'data:/workflow-runs.json'` | 运行历史文件：保存最近 N 条运行实例（storage URI，也兼容旧【data/workflow-runs.json】）。 |
| `maxRuns` | number | `200` | 保留最近运行条数：超过则按时间裁剪最旧的；最小 10。 |
| `enableTools` | boolean | `true` | 注册 AI 工具：开启后向 LLM 暴露 workflow_define / workflow_run 等工具。 |

## 触发器

| 类型 | 字段 | 说明 |
|---|---|---|
| `cron` | `expr` | 按 cron 表达式周期触发，经 `cron-engine` 服务订阅 |
| `interval` | `seconds` | 每隔 `seconds` 秒触发（向下取整，最小 1），经 `cron-engine` 以 `@every <N>s` 订阅 |
| `once` | `runAt` | 在指定时间触发一次，**一生只触发一次**：触发即把 `firedAt` 记入运行历史文件（`runsFile`），此后重启进程、重新注册、重复 `workflow_define` 都不再触发；**定义不存在时记账随之清除**——`workflow_remove` 清账，手动删掉 `defsDir` 里的 yaml 也会在下次启动扫描定义后补清，同 id 重建都算新工作流。`runAt` 须能被 `Date.parse` 解析；时间已过且从未触发过，则注册时立即补触发一次 |
| `event` | `event`, `filter?` | 订阅指定事件；`filter` 的每个键须与事件第一个参数的同名顶层字段严格相等；事件参数数组以运行变量 `args` 注入 |
| `manual` | — | 不注册触发器，仅手动运行 |

`event` 触发器不接受 `inbound:message`、`outbound:message`、`inbound:command`：这些事件承载会话内容，若被 `send-message` 节点转发到其它会话会造成跨会话泄露。订阅这些事件的触发器不会注册，仅记录警告。

## 节点类型

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `tool` | `tool`, `args` | 调用一个已注册工具；`args` 支持插值 |
| `send-message` | `sessionId`, `content`, `platform?` | 向会话投递 `inbound:message`（fire-and-forget，不等回复）；`platform` 默认 `internal` |
| `wait` | `seconds` | 等待固定秒数 |
| `agent` | `instruction`, `sessionId?`, `platform?`, `timeoutSeconds?` | 把指令派发给 agent **并等待本轮回复**；回复文本作节点结果；`platform` 默认 `workflow` |

`args`（递归处理其中的字符串）、`content`、`instruction`、`sessionId`、`platform` 支持 `{{vars.X}}`（运行变量）与 `{{outputs.Y}}`（上游节点输出）插值；`tool`（工具名）、`id`、`out`、`deps` 不插值。

## `agent` 节点：确定性的多智能体编排

`agent` 节点是 `send-message` 的「等回复」版：派发前注册 `agent:turn:after` 监听，按目标
`sessionId` 捕获本轮回复（与 `delegate_to_session` 相同的 join 方式），把回复经 `out` 存入
`outputs`。配合 `deps` + 插值，单个 DAG 即可表达「分解 → 依赖 → 串/并行 → 管道 → 聚合」的确定性编排流程。

- 省略 `sessionId` 时为该节点生成一次性隔离子会话 `workflow:agent:<runId>:<nodeId>`，
  并行 agent 节点互不串扰，适合子任务场景。
- `timeoutSeconds`（默认 120）内未收到回复 → 节点失败；`outcome=error/aborted` → 节点失败；
  `outcome=silent`（agent 选择不回复）是合法结果，节点成功、输出空串。

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

## 注册工具

| 工具 | 说明 |
|---|---|
| `workflow_define` | 定义/覆盖工作流（完整 YAML） |
| `workflow_run` | 手动触发一次运行 |
| `workflow_list` | 列出全部定义 |
| `workflow_get_runs` | 查询最近运行历史 |
| `workflow_remove` | 删除定义（含磁盘文件） |

## 事件

| 事件 | 说明 |
|---|---|
| `trigger:fired` | 订阅外部触发事件：仅当事件带 `workflowId` 时运行对应 workflow，`payload` 并入运行变量；plugin-scheduler 广播的该事件不含 `workflowId`，不会触发工作流 |
| `workflow:run:start` / `:done` / `:error` | 运行生命周期 |
| `workflow:node:done` | 单节点完成（含 `NodeRunInfo`） |

## 相关

- 定时任务（与本插件共用 `cron-engine` 服务）：[plugin-scheduler](./plugin-scheduler.md)
- 子会话分发（agent 自主编排版）：[plugin-subtask](./plugin-subtask.md)
