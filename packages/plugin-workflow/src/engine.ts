// ============================================================
// engine.ts — DAG 执行引擎
// ============================================================

import type { Context, Logger } from '@aalis/core';
// 副作用引入：激活 plugin-agent-api 对 core HookContextMap 的 'agent:turn:after' 增广
import '@aalis/plugin-agent-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { ToolCallContext, ToolService } from '@aalis/plugin-tools-api';
import type {
  AgentNodeSpec,
  NodeRunInfo,
  NodeSpec,
  SendMessageNodeSpec,
  ToolNodeSpec,
  WaitNodeSpec,
  WorkflowDef,
} from '@aalis/plugin-workflow-api';

const MAX_OUTPUT_PREVIEW = 1000;

// ─── 模板插值 ────────────────────────────────────────

const TPL_RE = /\{\{\s*(vars|outputs)\.([\w.[\]]+)\s*\}\}/g;

/** 解析 outputs.foo.bar / outputs.foo[0].x 这类访问路径 */
function getByPath(obj: unknown, path: string): unknown {
  const tokens = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

/** 把字符串里的 {{vars.X}} / {{outputs.Y}} 替换为实际值（值为 object 时 JSON.stringify） */
function interpolateString(s: string, vars: Record<string, unknown>, outputs: Record<string, unknown>): string {
  return s.replace(TPL_RE, (_, scope, path) => {
    const root = scope === 'vars' ? vars : outputs;
    const v = getByPath(root, path);
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}

/** 递归遍历对象，对所有字符串做插值 */
function interpolateValue(v: unknown, vars: Record<string, unknown>, outputs: Record<string, unknown>): unknown {
  if (typeof v === 'string') return interpolateString(v, vars, outputs);
  if (Array.isArray(v)) return v.map(x => interpolateValue(x, vars, outputs));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = interpolateValue(vv, vars, outputs);
    }
    return out;
  }
  return v;
}

// ─── 拓扑校验 ────────────────────────────────────────

/** 按节点类型校验必填字段（运行期 raw 可能缺字段）；返回错误消息或 null */
function nodeFieldError(node: NodeSpec): string | null {
  const r = node as unknown as Record<string, unknown>;
  const id = String(r.id ?? '?');
  const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  switch (node.type) {
    case 'tool':
      return filled(r.tool) ? null : `节点 "${id}"(tool) 缺少 tool 字段`;
    case 'send-message':
      if (!filled(r.content)) return `节点 "${id}"(send-message) 缺少 content 字段`;
      if (!filled(r.sessionId)) return `节点 "${id}"(send-message) 缺少 sessionId 字段`;
      return null;
    case 'wait':
      return typeof r.seconds === 'number' && Number.isFinite(r.seconds)
        ? null
        : `节点 "${id}"(wait) 缺少数值字段 seconds`;
    case 'agent':
      return filled(r.instruction) ? null : `节点 "${id}"(agent) 缺少 instruction 字段`;
    default:
      return `节点 "${id}" 类型未知: ${String(r.type ?? '?')}`;
  }
}

/** 校验定义的节点字段与 deps 合法（必填字段齐全；不引用未知节点；不形成环）；返回错误消息或 null */
export function validateGraph(def: WorkflowDef): string | null {
  const ids = new Set(def.nodes.map(n => n.id));
  if (ids.size !== def.nodes.length) return '节点 id 重复';
  for (const n of def.nodes) {
    const fieldErr = nodeFieldError(n);
    if (fieldErr) return fieldErr;
    for (const d of n.deps ?? []) {
      if (!ids.has(d)) return `节点 "${n.id}" 引用未知 dep "${d}"`;
      if (d === n.id) return `节点 "${n.id}" 自引用`;
    }
  }
  // Kahn 检测环
  const indeg = new Map<string, number>();
  const fan = new Map<string, string[]>();
  for (const n of def.nodes) {
    indeg.set(n.id, (n.deps ?? []).length);
    fan.set(n.id, []);
  }
  for (const n of def.nodes) {
    for (const d of n.deps ?? []) fan.get(d)!.push(n.id);
  }
  const q = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  let visited = 0;
  while (q.length) {
    const id = q.shift()!;
    visited++;
    for (const c of fan.get(id) ?? []) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) q.push(c);
    }
  }
  if (visited < def.nodes.length) return '节点存在依赖环';
  return null;
}

// ─── 节点执行器 ────────────────────────────────────────

interface ExecCtx {
  ctx: Context;
  logger: Logger;
  workflowId: string;
  runId: string;
  vars: Record<string, unknown>;
  outputs: Record<string, unknown>;
  toolCallContext: ToolCallContext;
}

async function execTool(node: ToolNodeSpec, ec: ExecCtx): Promise<string> {
  const tools = ec.ctx.getService<ToolService>('tools');
  if (!tools) throw new Error("'tools' 服务不可用");
  const args = (interpolateValue(node.args ?? {}, ec.vars, ec.outputs) ?? {}) as Record<string, unknown>;
  return await tools.execute(node.tool, args, ec.toolCallContext);
}

async function execSendMessage(node: SendMessageNodeSpec, ec: ExecCtx): Promise<string> {
  const content = interpolateString(node.content, ec.vars, ec.outputs);
  const sessionId = interpolateString(node.sessionId, ec.vars, ec.outputs);
  const platform = interpolateString(node.platform ?? 'internal', ec.vars, ec.outputs);
  const message: IncomingMessage = {
    content,
    sessionId,
    platform,
    source: `workflow:${ec.workflowId}`,
  };
  await ec.ctx.emit('inbound:message', message);
  return `sent to ${sessionId}@${platform} (${content.length} chars)`;
}

async function execWait(node: WaitNodeSpec): Promise<string> {
  const ms = Math.max(0, Math.floor(node.seconds * 1000));
  await new Promise<void>(resolve => setTimeout(resolve, ms));
  return `waited ${node.seconds}s`;
}

const DEFAULT_AGENT_TIMEOUT_SEC = 120;

/**
 * agent 节点：派发指令给 agent 并等待本轮回复（复用 delegate_to_session 的 join 机制）。
 * 在 emit 前注册 `agent:turn:after` 监听，按目标 sessionId 捕获首条回复；超时或
 * outcome=error/aborted 抛错（=> 节点失败）。回复文本作为节点结果，可被 `{{outputs.X}}` 下游引用。
 *
 * 注意事项（见 AgentNodeSpec 文档）：
 * - `source` 含 nodeId（`workflow:<wf>:<nodeId>`）以隔离 agent 的并发 lane——否则同一会话上的
 *   两个 agent 回合会因 lane 相同而互相 abort。但**显式指定相同 sessionId 的并行 agent 节点**仍会
 *   因 `agent:turn:after` 按 sessionId 匹配而串扰捕获——省略 sessionId（默认一次性子会话）可彻底避免。
 * - 等待期间不感知 run 取消（与 wait 节点一致），最长阻塞至 timeoutSeconds。
 * - 若目标 platform/sessionType 落入 trigger-policy / flow-control 生效 scope，proactive 消息可能被
 *   吞掉而永不回 `agent:turn:after`，节点会等满超时才失败——放宽 scope 时需为编排消息留通路。
 */
async function execAgent(node: AgentNodeSpec, ec: ExecCtx): Promise<string> {
  const instruction = interpolateString(node.instruction, ec.vars, ec.outputs);
  // 省略 sessionId 时为本节点生成一次性隔离子会话，确保并行 agent 节点互不串扰、join 不混淆。
  const sessionId = node.sessionId
    ? interpolateString(node.sessionId, ec.vars, ec.outputs)
    : `workflow:agent:${ec.runId}:${node.id}`;
  const platform = interpolateString(node.platform ?? 'workflow', ec.vars, ec.outputs);
  const timeoutSec = node.timeoutSeconds && node.timeoutSeconds > 0 ? node.timeoutSeconds : DEFAULT_AGENT_TIMEOUT_SEC;
  const timeoutMs = Math.floor(timeoutSec * 1000);

  let captured: { reply: string; outcome: string } | undefined;
  let resolveWait: (() => void) | undefined;
  const waitPromise = new Promise<void>(resolve => {
    resolveWait = resolve;
  });
  // 注册必须在 emit 之前，避免目标 agent 同步回复时错过监听窗口。
  const dispose = ec.ctx.middleware('agent:turn:after', async (data, next) => {
    await next();
    if (captured) return;
    if (data.sessionId !== sessionId) return;
    captured = { reply: data.reply ?? '', outcome: data.outcome };
    resolveWait?.();
  });

  const incoming: IncomingMessage = {
    content: instruction,
    sessionId,
    // source 含 nodeId：隔离 agent 的并发 lane（laneKey=sessionId::source），
    // 避免同会话上的两个 agent 节点回合互相 abort。
    source: `workflow:${ec.workflowId}:${node.id}`,
    platform,
    triggerType: 'proactive',
  };

  const timeoutHandle = setTimeout(() => resolveWait?.(), timeoutMs);
  try {
    await ec.ctx.emit('inbound:message', incoming);
    await waitPromise;
  } finally {
    clearTimeout(timeoutHandle);
    dispose();
  }

  if (!captured) {
    throw new Error(`agent 节点超时（${timeoutSec}s 内未收到 agent:turn:after，会话=${sessionId}）`);
  }
  if (captured.outcome === 'error' || captured.outcome === 'aborted') {
    throw new Error(`agent 节点未正常完成（outcome=${captured.outcome}，会话=${sessionId}）`);
  }
  return captured.reply;
}

async function executeNode(node: NodeSpec, ec: ExecCtx): Promise<string> {
  switch (node.type) {
    case 'tool':
      return await execTool(node, ec);
    case 'send-message':
      return await execSendMessage(node, ec);
    case 'wait':
      return await execWait(node);
    case 'agent':
      return await execAgent(node, ec);
    default: {
      const _exhaustive: never = node;
      throw new Error(`未知节点类型: ${(_exhaustive as { type: string }).type}`);
    }
  }
}

// ─── DAG 主调度 ────────────────────────────────────────

interface RunOptions {
  ctx: Context;
  logger: Logger;
  def: WorkflowDef;
  runId: string;
  triggerSource: string;
  vars: Record<string, unknown>;
  toolCallContext: ToolCallContext;
  /** 取消信号容器；外部置 cancelled=true 后引擎不再调度新节点 */
  cancelToken: { cancelled: boolean };
  /** 节点完成回调（用于持久化进度 + 发事件） */
  onNodeDone?: (info: NodeRunInfo) => void;
}

/**
 * 按 deps 拓扑分批执行；每一批可并行；失败立即终止后续批次。
 * 返回最终的 WorkflowRun（不含 runId/workflowId/startedAt 等元数据，由 caller 填充）。
 */
export async function runDag(opts: RunOptions): Promise<{
  status: 'success' | 'failed' | 'cancelled';
  nodes: NodeRunInfo[];
  outputs: Record<string, unknown>;
  error?: string;
}> {
  const { def, vars, ctx, logger, runId, toolCallContext, cancelToken, onNodeDone } = opts;
  const outputs: Record<string, unknown> = {};

  const nodeMap = new Map(def.nodes.map(n => [n.id, n]));
  const indeg = new Map<string, number>();
  const fan = new Map<string, string[]>();
  for (const n of def.nodes) {
    indeg.set(n.id, (n.deps ?? []).length);
    fan.set(n.id, []);
  }
  for (const n of def.nodes) {
    for (const d of n.deps ?? []) fan.get(d)!.push(n.id);
  }

  const nodeRuns = new Map<string, NodeRunInfo>();
  for (const n of def.nodes) nodeRuns.set(n.id, { id: n.id, type: n.type, status: 'pending' });

  let firstError: string | null = null;

  async function runOne(id: string): Promise<void> {
    const node = nodeMap.get(id)!;
    const info = nodeRuns.get(id)!;
    if (cancelToken.cancelled) {
      info.status = 'skipped';
      onNodeDone?.(info);
      return;
    }
    info.status = 'running';
    info.startedAt = Date.now();
    const ec: ExecCtx = { ctx, logger, workflowId: def.id, runId, vars, outputs, toolCallContext };
    try {
      const result = await executeNode(node, ec);
      info.status = 'success';
      info.finishedAt = Date.now();
      info.output = result.length > MAX_OUTPUT_PREVIEW ? `${result.slice(0, MAX_OUTPUT_PREVIEW)}…` : result;
      if (node.out) outputs[node.out] = result;
      logger.debug(`run=${runId} node=${id} ok (${info.finishedAt - info.startedAt}ms)`);
    } catch (err) {
      info.status = 'failed';
      info.finishedAt = Date.now();
      info.error = err instanceof Error ? err.message : String(err);
      firstError ??= `节点 "${id}" 失败: ${info.error}`;
      logger.warn(`run=${runId} node=${id} failed: ${info.error}`);
    } finally {
      onNodeDone?.(info);
    }
  }

  // 按层调度
  while (true) {
    if (cancelToken.cancelled || firstError) break;
    const ready = [...indeg.entries()].filter(([id, d]) => d === 0 && nodeRuns.get(id)!.status === 'pending');
    if (ready.length === 0) break;
    await Promise.all(ready.map(([id]) => runOne(id)));
    if (firstError || cancelToken.cancelled) break;
    // 把成功节点的下游 indeg 减一
    for (const [id] of ready) {
      const st = nodeRuns.get(id)!.status;
      if (st === 'success') {
        for (const c of fan.get(id) ?? []) indeg.set(c, indeg.get(c)! - 1);
      }
    }
  }

  // 标记未运行的为 skipped
  for (const info of nodeRuns.values()) {
    if (info.status === 'pending') info.status = 'skipped';
  }

  const allNodes = def.nodes.map(n => nodeRuns.get(n.id)!);
  if (cancelToken.cancelled) return { status: 'cancelled', nodes: allNodes, outputs, error: firstError ?? undefined };
  if (firstError) return { status: 'failed', nodes: allNodes, outputs, error: firstError };
  return { status: 'success', nodes: allNodes, outputs };
}
