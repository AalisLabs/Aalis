// ============================================================
// engine.ts — DAG 执行引擎
// ============================================================

import { AsyncLocalStorage } from 'node:async_hooks';
// 副作用引入：激活 api-agent 对 @aalis/api-hooks 的 HookContextMap 的 'agent:turn:after' 增广
import type {} from '@aalis/api-agent'; // 本包唯一的 declaration merging 激活点（agent:* 钩子与 agent:prompt 贡献点）——删掉会丢键类型，不可删
import type { GatewayService } from '@aalis/api-gateway';
import type { Hooks } from '@aalis/api-hooks';
import { actingIdentity, type ToolCallRequest, type ToolService } from '@aalis/api-tools';
import type {
  AgentNodeSpec,
  NodeRunInfo,
  NodeSpec,
  SendMessageNodeSpec,
  ToolNodeSpec,
  WaitNodeSpec,
  WorkflowDef,
} from '@aalis/api-workflow';
import type { Events, Logger, ServiceSelection } from '@aalis/core';
import { TextError, type TextRef, textOf, toSource, truncateParams } from '@aalis/schema-i18n';
import type { IncomingMessage } from '@aalis/schema-message';
import { t } from './texts.js';

const MAX_OUTPUT_PREVIEW = 1000;
/** 原因最多多少字：文字对象的参数截到它（上游的整段报错可能在参数里），随运行历史落盘 */
const ERROR_MAX = 200;

/**
 * 执行一次 DAG 用到的能力：tool 节点调工具、send-message 节点经事件派发消息、agent 节点经网关送达指令并经钩子捕获它那一轮的
 * 回复。引擎不持有插件激活本身，只收这几样。
 */
export interface EngineCaps {
  tools: Pick<ServiceSelection<ToolService>, 'present' | 'use'>;
  events: Events;
  hooks: Hooks;
  /** agent 节点的送达入口：不在时 agent 节点失败 */
  gateway: Pick<ServiceSelection<GatewayService>, 'present' | 'use'>;
  logger: Logger;
}

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

/** 按节点类型校验必填字段（运行期 raw 可能缺字段）；返回原因或 null */
function nodeFieldError(node: NodeSpec): TextRef | null {
  const r = node as unknown as Record<string, unknown>;
  const id = String(r.id ?? '?');
  const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
  const missing = (field: string) => t('missingField', { id, type: node.type, field });
  switch (node.type) {
    case 'tool':
      return filled(r.tool) ? null : missing('tool');
    case 'send-message':
      if (!filled(r.content)) return missing('content');
      if (!filled(r.sessionId)) return missing('sessionId');
      return null;
    case 'wait':
      return typeof r.seconds === 'number' && Number.isFinite(r.seconds) ? null : t('missingSeconds', { id });
    case 'agent':
      return filled(r.instruction) ? null : missing('instruction');
    default:
      return t('unknownNodeType', { id, type: String(r.type ?? '?') });
  }
}

/**
 * 校验定义的节点字段与 deps 合法（必填字段齐全；不引用未知节点；不形成环）；返回原因或 null。原因给人看（工作流页），
 * 也经 workflow_define 交给模型（取原文）
 */
export function validateGraph(def: WorkflowDef): TextRef | null {
  const ids = new Set(def.nodes.map(n => n.id));
  if (ids.size !== def.nodes.length) return t('duplicateNodeId');
  for (const n of def.nodes) {
    const fieldErr = nodeFieldError(n);
    if (fieldErr) return fieldErr;
    for (const d of n.deps ?? []) {
      if (!ids.has(d)) return t('unknownDep', { id: n.id, dep: d });
      if (d === n.id) return t('selfDep', { id: n.id });
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
  if (visited < def.nodes.length) return t('dependencyCycle');
  return null;
}

// ─── 节点执行器 ────────────────────────────────────────

interface ExecCtx extends EngineCaps {
  workflowId: string;
  runId: string;
  vars: Record<string, unknown>;
  outputs: Record<string, unknown>;
  toolCallContext: ToolCallRequest;
  /** 调起这次运行的会话（经 workflow_run 调起时有）：它所在的一轮在等这次运行 */
  callerSessionId?: string;
  signal: AbortSignal;
}

async function execTool(node: ToolNodeSpec, ec: ExecCtx): Promise<string> {
  if (!ec.tools.present) throw new TextError(t('noTools'));
  const service = ec.tools.use;
  const args = (interpolateValue(node.args ?? {}, ec.vars, ec.outputs) ?? {}) as Record<string, unknown>;
  // 工作流节点产出是文本：工具交给主模型看的图（images）没有消费者，只取 content
  return (await service.execute(node.tool, args, ec.toolCallContext)).content;
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
  // 授权身份透传：与 tool 节点同源（run 级的运行身份，即工具调用上下文的唯一参与者，见 index.ts 的 execute），目标会话按它的
  // 等级执行；匿名的不带。
  const runner = actingIdentity(ec.toolCallContext);
  if (runner.userId) message.actor = runner;
  await ec.events.emit('inbound:message', message);
  return `sent to ${sessionId}@${platform} (${content.length} chars)`;
}

function execWait(node: WaitNodeSpec, signal: AbortSignal): Promise<string> {
  const ms = Math.max(0, Math.floor(node.seconds * 1000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve(`waited ${node.seconds}s`);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new TextError(t('cancelled')));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

const DEFAULT_AGENT_TIMEOUT_SEC = 120;

/**
 * agent 节点：经网关把指令送进目标会话，等它开的那一轮的回复。指令带来源 `workflow:<编排>:<节点>`，在目标会话里单独成一轮，
 * 排在那里在跑的一轮之后；送达在节点自己的异步上下文里调用，agent 让那一轮跑在送达它的调用的上下文里，节点据此只认自己那一轮的
 * agent:turn:after（同一会话里别的回合、同一编排别的运行的同名节点都不认）。回复文本作为节点结果，可被 `{{outputs.X}}` 下游引用。
 *
 * 失败：outcome 为 error/aborted；指向调起这次运行的会话（那一轮在等这次运行，节点开不了轮）立即失败、不送达；网关不在时失败；
 * 送达返回（这条输入落定）时还没认到结局，就是在网关相位被吞（禁言、限速等）或被放掉，立即失败；超时；run 取消时立即停止等待
 * （已送达的回合不随之中止，照常跑完，回复不再被捕获）。
 */
async function execAgent(node: AgentNodeSpec, ec: ExecCtx): Promise<string> {
  const instruction = interpolateString(node.instruction, ec.vars, ec.outputs);
  // 省略 sessionId 时为本节点生成一次性隔离子会话。这类会话没有出生平台：平台档按入口平台选，场所为默认工作区。
  const sessionId = node.sessionId
    ? interpolateString(node.sessionId, ec.vars, ec.outputs)
    : `workflow::${ec.runId}::${node.id}`;
  const platform = interpolateString(node.platform ?? 'workflow', ec.vars, ec.outputs);
  const timeoutSec = node.timeoutSeconds && node.timeoutSeconds > 0 ? node.timeoutSeconds : DEFAULT_AGENT_TIMEOUT_SEC;
  if (sessionId === ec.callerSessionId) {
    throw new TextError(t('agentCallerSession', { session: sessionId }));
  }
  if (!ec.gateway.present) throw new TextError(t('agentNoGateway', { session: sessionId }));
  const gateway = ec.gateway.use;

  const incoming: IncomingMessage = {
    content: instruction,
    sessionId,
    source: `workflow:${ec.workflowId}:${node.id}`,
    platform,
    triggerType: 'proactive',
  };
  // 授权身份透传：同一次 run 里 tool 节点带运行身份而 agent 节点匿名是自相矛盾
  // （2026-08-24 审计），与 execSendMessage 同源补齐；匿名的不带。
  const runner = actingIdentity(ec.toolCallContext);
  if (runner.userId) incoming.actor = runner;

  // 节点自己的异步上下文：agent 在送达这条指令的调用里跑它开的那一轮
  const scope = new AsyncLocalStorage<true>();
  let captured: { reply: string; outcome: string } | undefined;
  const dispose = ec.hooks.middleware('agent:turn:after', async (data, next) => {
    await next();
    if (!captured && scope.getStore() && data.sessionId === sessionId) {
      captured = { reply: data.reply ?? '', outcome: data.outcome };
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop = () => {};
  const waiting = new Promise<'timeout' | 'cancelled'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.floor(timeoutSec * 1000));
    stop = () => resolve('cancelled');
    ec.signal.addEventListener('abort', stop, { once: true });
  });
  let end: 'delivered' | 'timeout' | 'cancelled';
  try {
    const delivered = scope.run(true, () => gateway.ingressMessage(incoming)).then(() => 'delivered' as const);
    end = await Promise.race([delivered, waiting]);
  } finally {
    clearTimeout(timer);
    ec.signal.removeEventListener('abort', stop);
    dispose();
  }

  if (captured) {
    if (captured.outcome === 'error' || captured.outcome === 'aborted') {
      throw new TextError(t('agentNotCompleted', { outcome: captured.outcome, session: sessionId }));
    }
    return captured.reply;
  }
  if (end === 'cancelled') throw new TextError(t('cancelled'));
  if (end === 'timeout') throw new TextError(t('agentTimeout', { seconds: timeoutSec, session: sessionId }));
  throw new TextError(t('agentNoTurn', { session: sessionId }));
}

async function executeNode(node: NodeSpec, ec: ExecCtx): Promise<string> {
  switch (node.type) {
    case 'tool':
      return await execTool(node, ec);
    case 'send-message':
      return await execSendMessage(node, ec);
    case 'wait':
      return await execWait(node, ec.signal);
    case 'agent':
      return await execAgent(node, ec);
  }
}

/** 接住的报错作原因：文字对象的参数截短，字符串照旧 */
export function errorReason(err: unknown): string | TextRef {
  const error = textOf(err);
  return typeof error === 'string' ? error : truncateParams(error, ERROR_MAX);
}

// ─── DAG 主调度 ────────────────────────────────────────

interface RunOptions extends EngineCaps {
  def: WorkflowDef;
  runId: string;
  vars: Record<string, unknown>;
  toolCallContext: ToolCallRequest;
  /** 调起这次运行的会话（经 workflow_run 调起时有）：指向它的 agent 节点立即失败 */
  callerSessionId?: string;
  /**
   * 取消信号：中止后不再调度新节点，阻塞中的 wait / agent 节点立即失败；tool 节点经 toolCallContext.signal 收到，
   * 是否提前返回由工具决定
   */
  signal: AbortSignal;
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
  error?: string | TextRef;
}> {
  const { def, vars, tools, events, hooks, gateway, logger, runId, callerSessionId, signal, onNodeDone } = opts;
  const outputs: Record<string, unknown> = {};
  // tool 节点经 toolCallContext.signal 收到取消
  const toolCallContext = { ...opts.toolCallContext, signal };
  const ec: ExecCtx = {
    tools,
    events,
    hooks,
    gateway,
    logger,
    workflowId: def.id,
    runId,
    vars,
    outputs,
    toolCallContext,
    callerSessionId,
    signal,
  };

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

  let firstError: string | TextRef | null = null;

  async function runOne(id: string): Promise<void> {
    const node = nodeMap.get(id)!;
    const info = nodeRuns.get(id)!;
    if (signal.aborted) {
      info.status = 'skipped';
      onNodeDone?.(info);
      return;
    }
    info.status = 'running';
    info.startedAt = Date.now();
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
      info.error = errorReason(err);
      firstError ??= truncateParams(t('nodeFailed', { id, error: info.error }), ERROR_MAX);
      logger.warn(`run=${runId} node=${id} failed: ${toSource(info.error)}`);
    } finally {
      onNodeDone?.(info);
    }
  }

  // 按层调度
  while (true) {
    if (signal.aborted || firstError) break;
    const ready = [...indeg.entries()].filter(([id, d]) => d === 0 && nodeRuns.get(id)!.status === 'pending');
    if (ready.length === 0) break;
    await Promise.all(ready.map(([id]) => runOne(id)));
    if (firstError || signal.aborted) break;
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
  if (signal.aborted) return { status: 'cancelled', nodes: allNodes, outputs, error: firstError ?? undefined };
  if (firstError) return { status: 'failed', nodes: allNodes, outputs, error: firstError };
  return { status: 'success', nodes: allNodes, outputs };
}
