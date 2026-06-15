# plugin-workflow — DAG 工作流编排

**包名**: `@aalis/plugin-workflow`  
**契约**: `@aalis/plugin-workflow-api`  
**源码**: `packages/plugin-workflow/src/index.ts`（引擎 `engine.ts`）

## 概述

声明式 DAG 工作流：一个工作流 = 触发器 + 节点图（`nodes` + `deps` 边）。引擎按 `deps`
拓扑分层执行，同层并行；任一节点失败整个 run 标记 `failed`。节点可声明 `out` 把字符串结果
存入 `outputs` 命名空间，供下游节点用 `{{outputs.<out>}}` 插值——这就是节点间传值的方式。

定义存 `workspace:/workflows/*.yaml`（用户/AI 资产），运行实例存 `data:/workflow-runs.json`。

## 节点类型

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `tool` | `tool`, `args` | 调用一个已注册工具；`args` 支持插值 |
| `send-message` | `sessionId`, `content`, `platform?` | 向会话投递 `inbound:message`（fire-and-forget，不等回复） |
| `wait` | `seconds` | 等待固定秒数 |
| `agent` | `instruction`, `sessionId?`, `platform?`, `timeoutSeconds?` | 把指令派发给 agent **并等待本轮回复**；回复文本作节点结果 |

所有字符串字段都支持 `{{vars.X}}`（运行变量）与 `{{outputs.Y}}`（上游节点输出）插值。

## `agent` 节点：确定性的多智能体编排

`agent` 节点是 `send-message` 的「等回复」版：派发前注册 `agent:turn:after` 监听，按目标
`sessionId` join 本轮回复（复用 `delegate_to_session` 的成熟机制），把回复经 `out` 存入
`outputs`。配合 `deps` + 插值，单个 DAG 即可表达「分解 → 依赖 → 串/并行 → 管道 → 聚合」——
这正是 [任务树系统设计](../design/task-tree-system.md) 中「确定性编排」缺口的落地形态
（无需另造 `plugin-task-orchestrator`）。

- 省略 `sessionId` 时为该节点生成一次性隔离子会话 `workflow:agent:<runId>:<nodeId>`，
  并行 agent 节点互不串扰——天然契合「子任务」语义。
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
| `trigger:fired` | 订阅外部触发源（scheduler 等）→ 运行对应 workflow |
| `workflow:run:start` / `:done` / `:error` | 运行生命周期 |
| `workflow:node:done` | 单节点完成（含 `NodeRunInfo`） |

## 相关

- 设计与缺口分析：[任务树系统设计](../design/task-tree-system.md)
- 触发源：[plugin-scheduler](./plugin-scheduler.md)
- 子会话分发（agent 自主编排版）：[plugin-subtask](./plugin-subtask.md)
