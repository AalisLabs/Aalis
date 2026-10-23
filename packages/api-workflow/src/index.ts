import { defineService } from '@aalis/core';
// ============================================================
// @aalis/api-workflow
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

import type {} from '@aalis/core'; // declaration merging 锚点（下方 AalisEvents 增强）
import type { TextRef } from '@aalis/schema-i18n';

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
   * （`workflow::<runId>::<nodeId>`，不含单冒号，不会被当成房间会话），适合"子任务"语义（推荐）。指令在目标会话里单独成一轮，
   * 排在那里在跑的一轮之后；指向调起这次运行的会话时节点立即失败（那一轮在等这次运行，节点开不了轮）
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
  /** 失败原因：可以是文字对象（读法同 {@link WorkflowRun.error}） */
  error?: string | TextRef;
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
  /**
   * 整体错误（首个失败的简要）：可以是文字对象（@aalis/schema-i18n），给人看的经出口按读者语言渲染，交给模型与写日志的
   * 取 toSource；随运行历史落盘
   */
  error?: string | TextRef;
}

// ============ 服务接口 ============

export interface WorkflowService {
  /** 列出全部工作流定义 */
  listWorkflows(): WorkflowDef[];
  /** 按 id 获取定义 */
  getWorkflow(id: string): WorkflowDef | undefined;
  /**
   * 注册/覆盖一个工作流定义；persist 不为 false 时（缺省即写）同步写入 workspace/workflows/<id>.yaml。
   * 经这里定义或覆盖的没有定义者（运行身份见 {@link WorkflowService.runWorkflow}）：服务认不出调用方是谁，定义者只由实现
   * 自己认证过调用者的入口记下。event 触发器订阅不可作触发源的事件（负载带会话内容，列表由实现定）时抛错、不保存
   */
  defineWorkflow(def: WorkflowDef, opts?: { persist?: boolean }): Promise<void>;
  /** 删除工作流（若 persist 文件存在则删除；有文件的定义删不掉文件时抛错） */
  removeWorkflow(id: string): Promise<boolean>;
  /** 手动触发一次运行；vars 与定义中的 vars 浅合并 */
  runWorkflow(
    id: string,
    vars?: Record<string, unknown>,
    triggerSource?: string,
    /**
     * 调用者身份（缺省=匿名）。内部工具与投递的消息按定义者与调用者里不是 owner 的一方裁决：调用者是 owner 时取定义者
     * （没有即匿名），否则取调用者。定时与事件触发以定义者作调用者。sessionId 是调起这次运行的会话（经 workflow_run 调起时
     * 有）：它所在的一轮在等这次运行，指向它的 agent 节点立即失败
     */
    caller?: { platform?: string; userId?: string; sessionId?: string },
  ): Promise<WorkflowRun>;
  /** 取消一个运行中的实例（若执行引擎支持） */
  cancelRun(runId: string): boolean;
  /** 获取运行实例（含历史） */
  getRun(runId: string): WorkflowRun | undefined;
  /** 列出最近 N 个运行实例（按时间倒序） */
  listRuns(limit?: number, workflowId?: string): WorkflowRun[];
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

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const workflow = defineService<WorkflowService>('workflow');
