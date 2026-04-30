# 任务树系统设计文档

> 本文档描述 Aalis 框架的任务拆分与 Agent 协作系统的架构设计。  
> 基于已实现的 `plugin-session-manager`（会话管理 + 树形结构）进行扩展。

---

## 一、目标与价值

当前的会话系统允许用户手动创建和管理多个独立会话。任务树系统在此基础上引入：

1. **任务拆分** — Agent 能将复杂用户请求自动分解为多个子任务
2. **并行执行** — 独立子任务在各自的子会话中并行处理
3. **结果汇总** — 子任务完成后结果汇聚到父会话，由父 Agent 综合回答
4. **人机协同** — 用户可以在 WebUI 中查看任务树、干预子任务（暂停/取消/修改指令）
5. **与 Scheduler 协作** — 定时任务也可以触发任务链（如每日报告 = 收集数据 + 分析 + 生成报告）

---

## 二、已有基础设施

### 2.1 session-manager 提供的能力

| 能力                 | 接口                                         |
| -------------------- | -------------------------------------------- |
| 创建子会话           | `createChildSession(parentId, opts)`         |
| 查询子会话           | `getChildren(parentId)`                      |
| 获取会话树           | `getTree(rootId?)`                           |
| 会话完成 + 通知父级  | `completeSession(id, result)`                |
| 会话配置覆盖         | `SessionConfig { model, tools, persona.. }`  |
| 状态管理             | `active / waiting / completed / error`       |

### 2.2 agent-default 提供的能力

| 能力                 | 说明                                         |
| -------------------- | -------------------------------------------- |
| 会话配置解析         | 从 session-manager 读取每个会话的 LLM/工具配置  |
| 工具调用循环         | 最多 N 次迭代的工具调用                        |
| 流式响应             | `outbound:stream` 事件                        |
| AbortController      | 按 `sessionId::source` 管理中断               |

### 2.3 scheduler 提供的能力

| 能力                 | 说明                                         |
| -------------------- | -------------------------------------------- |
| Cron / 定时触发      | 向指定 sessionId 发送 `inbound:message`      |
| 动态任务 CRUD        | 运行时增删改任务                              |
| 并发控制             | `maxConcurrent` 限制                          |

---

## 三、系统设计

### 3.1 新增插件：`plugin-task-orchestrator`

这是一个**可选**的高层编排插件，职责是**将任务语义映射到 session-manager 的树形结构上**。

```
┌─────────────────────────────────────────────────────┐
│               plugin-task-orchestrator               │
│                                                     │
│  TaskDefinition ──► 拆分策略 ──► 子会话创建          │
│  子会话消息注入 ──► 并行/串行执行 ──► 结果聚合        │
│  进度追踪 ──► WebUI 任务树可视化                     │
└──────────┬──────────────────────────────────────────┘
           │ 依赖
     ┌─────┴─────┐
     │           │
session-manager  agent
```

#### 设计原则

- **session-manager 不知道 task** — 它只维护会话树和生命周期
- **task-orchestrator 不执行对话** — 它只编排，实际执行交给 agent
- **agent 不知道 task** — 它只按 sessionId 处理消息（已通过 session config 获取配置）

这样三个插件的职责清晰分离：

| 插件                    | 职责         | 不关心的事            |
| ----------------------- | ------------ | --------------------- |
| `session-manager`       | 会话 CRUD + 树形结构 | 什么是"任务"       |
| `agent-default`         | 对话执行 + 工具调用  | 为什么会收到这条消息  |
| `task-orchestrator`     | 任务语义 + 执行编排  | 对话如何生成          |

### 3.2 核心类型定义

```typescript
// packages/core/src/types/task.ts

/** 任务定义：描述一个需要 Agent 执行的工作单元 */
interface TaskDefinition {
  /** 任务唯一 ID（由 orchestrator 生成） */
  id: string;
  /** 所属会话 ID（此任务在哪个子会话中执行） */
  sessionId: string;
  /** 父任务 ID（根任务为 undefined） */
  parentTaskId?: string;
  /** 任务标题 */
  title: string;
  /** 任务详细指令（发送给 Agent 的 prompt） */
  instruction: string;
  /** 任务状态 */
  status: 'pending' | 'running' | 'waiting-children' | 'completed' | 'failed' | 'cancelled';
  /** 执行优先级（影响排队顺序） */
  priority: number;
  /** 依赖的其他任务 ID 列表（只有全部完成后才开始本任务） */
  dependencies: string[];
  /** 子任务 ID 列表 */
  children: string[];
  /** 执行策略 */
  strategy: TaskStrategy;
  /** 任务结果（完成后填充） */
  result?: TaskResult;
  /** 重试次数上限 */
  maxRetries: number;
  /** 当前重试次数 */
  retryCount: number;
  /** 超时时间(ms)，0 = 无超时 */
  timeout: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  updatedAt: number;
  /** 扩展元数据（创建者、来源等） */
  metadata?: Record<string, unknown>;
}

/** 任务执行策略 */
interface TaskStrategy {
  /** 子任务的执行模式 */
  mode: 'sequential' | 'parallel' | 'pipeline';
  /** parallel 模式下的最大并发数 */
  maxConcurrency?: number;
  /** pipeline 模式下，前一个任务的 result 如何传递给后一个（模板字符串） */
  pipeTemplate?: string;
  /** 子任务全部完成后的汇总模式 */
  aggregation: 'concat' | 'summary' | 'custom';
  /** custom 汇总时的提示模板 */
  aggregationPrompt?: string;
}

/** 任务结果 */
interface TaskResult {
  /** 是否成功 */
  success: boolean;
  /** 结果文本（Agent 的最终回复） */
  content: string;
  /** 结构化输出（如果有） */
  data?: Record<string, unknown>;
  /** 完成时间 */
  completedAt: number;
  /** 耗时 ms */
  duration: number;
  /** 使用的 token 数 */
  tokensUsed?: number;
}

/** 任务编排服务接口 */
interface TaskOrchestratorService {
  // ---- 任务 CRUD ----

  /** 创建一个根任务（会自动创建对应会话） */
  createTask(opts: {
    title: string;
    instruction: string;
    sessionConfig?: SessionConfig;
    strategy?: Partial<TaskStrategy>;
    parentTaskId?: string;
    dependencies?: string[];
    timeout?: number;
    metadata?: Record<string, unknown>;
  }): Promise<TaskDefinition>;

  /** 获取任务 */
  getTask(taskId: string): TaskDefinition | undefined;

  /** 列出任务（按状态过滤） */
  listTasks(filter?: {
    parentTaskId?: string | null;
    status?: TaskDefinition['status'] | TaskDefinition['status'][];
  }): TaskDefinition[];

  /** 取消任务（级联取消所有子任务） */
  cancelTask(taskId: string, reason?: string): Promise<void>;

  // ---- 任务拆分 ----

  /**
   * 请求 Agent 拆分任务
   *
   * 向指定任务的会话发送拆分指令，Agent 通过工具调用
   * `task_decompose` 返回子任务列表，orchestrator 据此创建子任务。
   */
  decomposeTask(taskId: string): Promise<TaskDefinition[]>;

  // ---- 执行控制 ----

  /** 启动任务（执行或等待依赖） */
  startTask(taskId: string): Promise<void>;

  /** 暂停任务 */
  pauseTask(taskId: string): Promise<void>;

  /** 恢复任务 */
  resumeTask(taskId: string): Promise<void>;

  // ---- 查询 ----

  /** 获取任务树 */
  getTaskTree(rootTaskId?: string): TaskTreeNode[];

  /** 获取任务进度（递归统计子任务完成率） */
  getProgress(taskId: string): { total: number; completed: number; running: number; failed: number };
}

/** 任务树节点 */
interface TaskTreeNode {
  task: TaskDefinition;
  children: TaskTreeNode[];
}
```

### 3.3 工具定义：让 Agent 能拆分任务

task-orchestrator 注册以下工具供 Agent 调用：

```typescript
// task_decompose — Agent 决定如何拆分当前任务
{
  function: {
    name: 'task_decompose',
    description: '将当前任务分解为多个子任务。每个子任务将在独立会话中执行。',
    parameters: {
      type: 'object',
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '子任务标题' },
              instruction: { type: 'string', description: '子任务详细指令' },
              dependencies: {
                type: 'array', items: { type: 'string' },
                description: '依赖的其他子任务标题（按标题引用）'
              },
            },
            required: ['title', 'instruction'],
          },
          description: '子任务列表',
        },
        strategy: {
          type: 'string',
          enum: ['parallel', 'sequential', 'pipeline'],
          description: '执行模式：parallel=并行 sequential=顺序 pipeline=流水线'
        },
      },
      required: ['subtasks'],
    },
  },
  groups: ['task-orchestration'],
}

// task_report — 子任务 Agent 汇报当前进度或结论
{
  function: {
    name: 'task_report',
    description: '汇报当前子任务的执行结论。调用后子任务标记为完成。',
    parameters: {
      type: 'object',
      properties: {
        result: { type: 'string', description: '任务结论/结果' },
        data: {
          type: 'object',
          description: '可选的结构化数据（key-value）',
        },
      },
      required: ['result'],
    },
  },
  groups: ['task-orchestration'],
}
```

### 3.4 执行流程

#### 3.4.1 用户发起复杂任务

```
用户: "帮我研究最近一周加密货币市场趋势，并生成投资建议报告"
  │
  ▼
[Agent 判断需要拆分] ──► 调用 task_decompose 工具
  │
  ▼ task-orchestrator 收到工具调用结果：
  │
  │   subtasks: [
  │     { title: "收集市场数据", instruction: "获取BTC/ETH..价格变化" },
  │     { title: "分析市场趋势", instruction: "基于数据分析...", dependencies: ["收集市场数据"] },
  │     { title: "生成投资报告", instruction: "综合分析...", dependencies: ["分析市场趋势"] },
  │   ]
  │   strategy: "pipeline"
  │
  ▼ orchestrator 执行：
  │
  ├─ 1. 为每个子任务创建子会话 (session-manager.createChildSession)
  ├─ 2. 配置每个子会话的工具集 (如：数据收集启用 web_search)
  ├─ 3. 将父任务状态改为 waiting-children
  │
  ▼ 按依赖图执行：
  │
  │  ┌────────────────────────────────────────────────────────────┐
  │  │ 子会话-1: "收集市场数据"                                    │
  │  │   → agent 处理 → 调用 web_search → task_report(结果)       │
  │  │   → session:completed 事件                                 │
  │  └──────────────────────┬─────────────────────────────────────┘
  │                         │ 完成后触发依赖任务
  │  ┌──────────────────────▼─────────────────────────────────────┐
  │  │ 子会话-2: "分析市场趋势"                                    │
  │  │   instruction 中包含子会话-1 的 result                      │
  │  │   → agent 处理 → task_report(分析结论)                     │
  │  └──────────────────────┬─────────────────────────────────────┘
  │                         │
  │  ┌──────────────────────▼─────────────────────────────────────┐
  │  │ 子会话-3: "生成投资报告"                                    │
  │  │   instruction 中包含子会话-2 的 result                      │
  │  │   → agent 处理 → task_report(最终报告)                     │
  │  └──────────────────────┬─────────────────────────────────────┘
  │                         │
  ▼ 所有子任务完成 → orchestrator 聚合结果
  │
  ▼ 聚合结果注入父会话 → Agent 用聚合结果回复用户
```

#### 3.4.2 与 Scheduler 协作

```
Scheduler (每日 09:00 触发)
  │
  ├─ 配置: { sessionId: "daily-report-session", content: "生成每日市场报告" }
  │
  ▼ inbound:message → Agent 处理
  │
  ├─ Agent 判断需要拆分（同上流程）
  ├─ task_decompose → 创建子任务
  ├─ 并行收集各数据源
  ├─ 汇总生成报告
  │
  ▼ 最终结果可以：
    ├─ 写入 memory（供后续查询）
    ├─ 通过 onebot 推送到群
    └─ 保存为文件
```

### 3.5 并发与执行引擎

```typescript
class TaskExecutionEngine {
  /** 正在执行的任务（sessionId → taskId） */
  private running = new Map<string, string>();
  /** 等待队列（按 priority 排序） */
  private queue: TaskDefinition[] = [];
  /** 最大并发执行数 */
  private maxConcurrent: number;

  /**
   * 调度循环
   * 
   * 每当任务完成/取消时触发，检查：
   * 1. running.size < maxConcurrent?
   * 2. queue 中有哪些任务的 dependencies 全部完成了？
   * 3. 取出优先级最高的满足条件的任务，执行
   */
  tick(): void { ... }

  /**
   * 执行单个任务
   *
   * 1. 创建 AbortController（用于超时/取消）
   * 2. 向任务对应的 sessionId 发送 inbound:message 事件
   * 3. 监听 session:completed 事件（等待 task_report）
   * 4. 超时则标记为 failed 并取消子任务
   */
  async executeTask(task: TaskDefinition): Promise<void> { ... }

  /**
   * 聚合子任务结果
   *
   * 根据 strategy.aggregation:
   * - concat: 按顺序拼接所有子结果
   * - summary: 让 Agent 对所有子结果做一次汇总
   * - custom: 使用 aggregationPrompt 模板
   */
  async aggregate(parentTask: TaskDefinition): Promise<string> { ... }
}
```

### 3.6 超时与错误处理

| 场景 | 处理策略 |
|------|---------|
| 子任务超时 | 标记为 `failed`，检查父任务策略是否允许忽略 |
| 子任务失败 | 重试（最多 maxRetries 次），最终失败则通知父 |
| 父任务所有子任务完成但有失败 | 根据策略决定：retry / skip / fail-parent |
| Agent 没有调用 task_report | 超时后由 orchestrator 读取会话最后一条消息作为 result |
| 用户手动取消 | 级联 cancelTask，中止所有运行中子任务的 AbortController |

### 3.7 WebUI 扩展

task-orchestrator 通过 `webuiPages` 注册独立页面：

```
┌──────────────────────────────────────────────────────┐
│  任务管理                                             │
│                                                      │
│  [新建任务]                                           │
│                                                      │
│  ┌─ 📋 每日市场报告  ● running                       │
│  │   ├─ 📊 收集数据     ✅ completed (2.3s)          │
│  │   ├─ 📈 分析趋势     ⏳ running...                │
│  │   └─ 📝 生成报告     ○ pending (等待: 分析趋势)    │
│  │                                                   │
│  │   进度: ████████░░░░░ 33% (1/3 完成)              │
│  │                                                   │
│  └─ 🔍 查看详情 | ⏸ 暂停 | ❌ 取消                   │
│                                                      │
│  ┌─ 📋 代码审查     ✅ completed                     │
│  └─ ...archived tasks...                             │
└──────────────────────────────────────────────────────┘
```

---

## 四、与现有系统的交互协议

### 4.1 task-orchestrator → session-manager

```
创建子任务:
  orchestrator.createTask({ parentTaskId, ... })
    → sessionManager.createChildSession(parentSessionId, { config, name })
    → 返回子会话 ID，存入 TaskDefinition.sessionId

子任务完成:
  session:completed 事件
    → orchestrator 监听 → 更新 TaskDefinition.status/result
    → 检查依赖图 → 触发下个任务 or 聚合

删除任务:
  orchestrator.cancelTask(taskId)
    → sessionManager.completeSession(sessionId) 或 deleteSession
```

### 4.2 task-orchestrator → agent

```
执行子任务:
  向 sessionId 发送 inbound:message 事件
  Agent 按正常流程处理（session config 已通过 session-manager 设置）

Agent → orchestrator:
  Agent 调用 task_decompose 工具 → orchestrator 拦截并创建子任务
  Agent 调用 task_report 工具 → orchestrator 标记任务完成
```

### 4.3 task-orchestrator → scheduler

```
方案 A: Scheduler 作为触发源
  scheduler job → inbound:message → agent → task_decompose → orchestrator

方案 B: Orchestrator 直接集成 (推荐)
  orchestrator 可注册自己的定时任务，定时创建根任务：
  
  ctx.getService('scheduler')?.addJob({
    name: 'daily-market-report',
    cron: '0 9 * * *',
    sessionId: reportSessionId,
    content: '生成每日市场报告',
    ...
  })
```

推荐方案 A — scheduler 只负责定时触发，orchestrator 只负责编排。  
两者通过 sessionId 和 inbound:message 事件解耦。

---

## 五、逐步实施路线

### Phase 1: 核心类型 + 基础编排（当前可实现）

1. 在 `core/types/` 添加 `TaskDefinition`、`TaskOrchestratorService` 类型
2. 创建 `plugin-task-orchestrator`，实现：
   - 任务 CRUD（内存 Map + metadata 持久化）
   - 注册 `task_decompose` / `task_report` 工具
   - 基础执行引擎（sequential + parallel）
   - 依赖追踪（拓扑排序 + 完成触发）
   - `session:completed` 监听 → 任务状态流转
3. webuiPages 注册任务列表页

### Phase 2: 智能拆分 + 汇总

4. Agent prompt engineering — 在系统提示中说明何时应该拆分任务
5. 实现 `summary` 聚合模式（聚合时再次调用 LLM）
6. pipeline 模式（前一个结果注入后一个的 instruction）

### Phase 3: 高级功能

7. 超时 / 重试 / 错误恢复
8. WebUI 任务树可视化（展开/折叠、实时进度）
9. 用户干预 API（修改正在执行的子任务指令、增加子任务）
10. 与 scheduler 集成（定时任务自动触发任务链）

### Phase 4: Context Scope 隔离

11. 利用 `ServiceContainer.createScope()` 为每个子任务创建隔离的 Context
12. 每个子任务可以拥有完全独立的服务栈（不同的 LLM、不同的 memory）
13. 适合安全敏感场景（子任务之间不能互相访问数据）

---

## 六、潜在问题与决策点

### Q1: 任务 ID 与会话 ID 的关系

**方案**: 1 任务 = 1 会话。`TaskDefinition.sessionId` 直接关联。  
**好处**: 简单、直观，任务的所有对话历史就是会话历史。  
**代价**: 如果一个任务需要多次对话交互（比如需要用户确认），需要额外机制。  
**决定**: 采用 1:1 映射，多次交互在同一会话内完成。

### Q2: Agent 如何知道"该拆分了"

**方案**: 不强制，而是**通过系统提示词引导**。
- 系统提示中加入："当任务复杂时，你可以使用 task_decompose 工具将其分解为子任务"
- Agent 自行判断何时拆分
- orchestrator 也可以提供 `decomposeTask()` API，由外部（如 UI 按钮）主动触发拆分

### Q3: 递归拆分的深度限制

**方案**: `TaskStrategy` 中增加 `maxDepth?: number`，默认 3。  
每次 `task_decompose` 时检查当前深度，超过则拒绝并让 Agent 直接执行。

### Q4: 结果聚合的质量

**方案**: 
- `concat` 模式适合信息收集型任务
- `summary` 模式再调一次 LLM 做综合，适合需要分析的场景
- 聚合 prompt 模板支持自定义，用户可以精确控制聚合方式

### Q5: 子任务失败时的降级策略

**方案**: `TaskStrategy` 中增加 `failurePolicy`:
```typescript
failurePolicy: 'fail-parent' | 'skip-and-continue' | 'retry-then-skip';
```

---

## 七、核心事件扩展

```typescript
// 新增事件
declare module '@aalis/core' {
  interface AalisEvents {
    'task:created':    [task: TaskDefinition];
    'task:started':    [task: TaskDefinition];
    'task:completed':  [task: TaskDefinition];
    'task:failed':     [task: TaskDefinition, error: string];
    'task:cancelled':  [task: TaskDefinition, reason?: string];
    'task:progress':   [taskId: string, progress: { total: number; completed: number }];
  }
}
```

---

## 八、总结

```
                                用户请求
                                   │
                    ┌──────────────▼──────────────┐
                    │       Agent (root session)   │
                    │   "这个任务需要拆分"          │
                    │   → 调用 task_decompose      │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │     Task Orchestrator        │
                    │   创建子任务 + 子会话         │
                    │   管理依赖图 + 并发调度       │
                    └──┬────────┬────────┬────────┘
                       │        │        │
              ┌────────▼┐ ┌────▼────┐ ┌─▼────────┐
              │ 子任务-1 │ │ 子任务-2│ │ 子任务-3  │
              │ (子会话) │ │ (子会话)│ │ (子会话)  │
              │ Agent独立│ │ Agent  │ │ Agent独立 │
              │ 处理+工具│ │ 独立处理│ │ 处理+工具 │
              └────┬─────┘ └───┬────┘ └────┬─────┘
                   │           │           │
                   └───────────┼───────────┘
                               │ session:completed
                    ┌──────────▼──────────────┐
                    │     Task Orchestrator    │
                    │   聚合结果 → 回复用户     │
                    └─────────────────────────┘
```

**核心理念**: 任务树系统是 session-manager 之上的一层语义层。session-manager 管结构，agent 管执行，task-orchestrator 管编排。三者通过事件和服务接口解耦，各自可独立演进。
