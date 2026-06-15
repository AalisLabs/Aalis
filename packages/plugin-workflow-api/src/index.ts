// ============================================================
// @aalis/plugin-workflow-api
//
// Workflow 插件的公共契约：DSL 类型、运行实例类型、服务接口。
// 实际执行引擎由 @aalis/plugin-workflow 提供。
//
// 设计要点：
//   - 工作流 = 触发器 + DAG（节点 + deps 边）
//   - 节点类型：tool / send-message / wait / agent；后续可扩 decision / parallel-fanout
//   - DAG 引擎按 deps 拓扑分层并行执行；任一节点失败整个 run 标记 failed
//   - 节点可声明 `out`，将 string 结果存入 outputs 命名空间，供下游 `{{outputs.X}}` 插值
//   - 工作流"定义"是用户/AI 资产，存 workspace；"运行实例"是运行时，存 data
// ============================================================

import type { Context } from '@aalis/core';

// ============ 触发器 ============

export type TriggerSpec =
  | { type: 'cron'; expr: string }
  | { type: 'interval'; seconds: number }
  | { type: 'once'; runAt: string }
  | { type: 'event'; event: string; filter?: Record<string, unknown> }
  | { type: 'manual' };

// ============ 节点 ============

export type NodeType = 'tool' | 'send-message' | 'wait' | 'agent';

interface BaseNodeSpec {
  /** 节点唯一 id（在工作流内） */
  id: string;
  /** 节点类型 */
  type: NodeType;
  /** 上游依赖节点 id 列表；空数组表示根节点 */
  deps?: string[];
  /** 把节点结果存入 outputs[out]，供下游 {{outputs.<out>}} 插值 */
  out?: string;
}

export interface ToolNodeSpec extends BaseNodeSpec {
  type: 'tool';
  /** 工具名（必须已注册） */
  tool: string;
  /** 工具参数；字符串值会被插值（{{vars.X}} / {{outputs.Y}}） */
  args?: Record<string, unknown>;
}

export interface SendMessageNodeSpec extends BaseNodeSpec {
  type: 'send-message';
  sessionId: string;
  platform?: string;
  /** 消息内容；支持插值 */
  content: string;
}

export interface WaitNodeSpec extends BaseNodeSpec {
  type: 'wait';
  /** 等待秒数 */
  seconds: number;
}

/**
 * agent 节点：把一段指令派发给 agent 处理并**等待其回复**，回复文本作为节点结果。
 *
 * 与 send-message 的区别：send-message 是 fire-and-forget；agent 节点会注册
 * `agent:turn:after` 监听、join 目标会话本轮回复，从而把"一个子任务 = 一次 agent 调用"
 * 接入 DAG——配合 deps/串并行/`{{outputs.X}}` 插值即可表达"分解→依赖→管道→聚合"的确定性编排。
 */
export interface AgentNodeSpec extends BaseNodeSpec {
  type: 'agent';
  /** 交给 agent 处理的指令/任务正文；支持插值（{{vars.X}} / {{outputs.Y}}） */
  instruction: string;
  /**
   * 目标会话 id；支持插值。省略时为本节点生成一次性隔离子会话
   * （`workflow:agent:<runId>:<nodeId>`），互不串扰，适合"子任务"语义。
   */
  sessionId?: string;
  /** 平台标识；默认 'workflow' */
  platform?: string;
  /** 等待 agent 回复的超时秒数；默认 120。超时则该节点失败。 */
  timeoutSeconds?: number;
}

export type NodeSpec = ToolNodeSpec | SendMessageNodeSpec | WaitNodeSpec | AgentNodeSpec;

// ============ 工作流定义 ============

export interface WorkflowDef {
  /** 工作流唯一 id（文件名/外部引用键） */
  id: string;
  /** 显示名 */
  name?: string;
  /** 描述 */
  description?: string;
  /** 默认变量；运行时可覆盖 */
  vars?: Record<string, unknown>;
  /** 触发器；manual 表示仅手动调用 */
  trigger: TriggerSpec;
  /** DAG 节点 */
  nodes: NodeSpec[];
  /** 是否启用 */
  enabled?: boolean;
}

// ============ 运行实例 ============

export type RunStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export type NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface NodeRunInfo {
  id: string;
  type: NodeType;
  status: NodeStatus;
  startedAt?: number;
  finishedAt?: number;
  /** 节点输出（截断后的字符串展示） */
  output?: string;
  /** 失败原因 */
  error?: string;
}

export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: RunStatus;
  /** 触发来源（cron/interval/event/manual） */
  triggerSource: string;
  startedAt: number;
  finishedAt?: number;
  /** 实例变量（trigger payload + 运行时传入） */
  vars: Record<string, unknown>;
  /** 节点运行明细 */
  nodes: NodeRunInfo[];
  /** 整体错误（首个失败的简要） */
  error?: string;
}

// ============ 服务接口 ============

export interface WorkflowService {
  /** 列出全部工作流定义 */
  listWorkflows(): WorkflowDef[];
  /** 按 id 获取定义 */
  getWorkflow(id: string): WorkflowDef | undefined;
  /** 注册/覆盖一个工作流定义；persist=true 时同步写入 workspace/workflows/<id>.yaml */
  defineWorkflow(def: WorkflowDef, opts?: { persist?: boolean }): Promise<void>;
  /** 删除工作流（若 persist 文件存在则删除） */
  removeWorkflow(id: string): Promise<boolean>;
  /** 手动触发一次运行；vars 与定义中的 vars 浅合并 */
  runWorkflow(id: string, vars?: Record<string, unknown>, triggerSource?: string): Promise<WorkflowRun>;
  /** 取消一个运行中的实例（若执行引擎支持） */
  cancelRun(runId: string): boolean;
  /** 获取运行实例（含历史） */
  getRun(runId: string): WorkflowRun | undefined;
  /** 列出最近 N 个运行实例（按时间倒序） */
  listRuns(limit?: number, workflowId?: string): WorkflowRun[];
}

// ============ Helper ============

export function useWorkflowService(ctx: Context): WorkflowService | undefined {
  return ctx.getService<WorkflowService>('workflow');
}

// ============ 事件契约 ============

declare module '@aalis/core' {
  interface AalisEvents {
    /** 触发器触发 — 由 scheduler/event/webhook 等触发源发出，workflow 订阅 */
    'trigger:fired': [
      info: {
        /** 触发器来源标识（如 scheduler:job-name / event:session:end） */
        source: string;
        /** 触发器类型 */
        type: 'cron' | 'interval' | 'event' | 'webhook' | 'manual';
        /** 关联的工作流 id（若触发器只服务一个 workflow） */
        workflowId?: string;
        /** 透传给运行实例 vars 的负载 */
        payload?: Record<string, unknown>;
      },
    ];
    'workflow:run:start': [run: WorkflowRun];
    'workflow:run:done': [run: WorkflowRun];
    'workflow:run:error': [run: WorkflowRun];
    'workflow:node:done': [info: { runId: string; node: NodeRunInfo }];
  }
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    workflow: WorkflowService;
  }
}
