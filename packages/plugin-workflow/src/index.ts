// ============================================================
// @aalis/plugin-workflow — DAG 工作流引擎
//
// 订阅 'trigger:fired' 事件 + 内置 cron/interval/event 触发器，
// 按 DAG 执行节点，结果存 data/workflow-runs.json，
// 定义存 workspace/workflows/*.yaml。
// ============================================================

import type { ConfigSchema, Context, PluginModule } from '@aalis/core';
import { createStorageGateway } from '@aalis/plugin-storage-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
// 引入 plugin-webui-api 的副作用以激活 PluginModule.extends/subsystem 类型增广
import '@aalis/plugin-webui-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';
import type { NodeRunInfo, WorkflowRun, WorkflowService } from '@aalis/plugin-workflow-api';
import { parse, stringify } from 'yaml';

import { runDag, validateGraph } from './engine.js';
import { normalizeDef, WorkflowLoader } from './loader.js';
import { RunStore } from './persistence.js';
import { TriggerManager } from './triggers.js';

// ─── 元数据 ───

export const name = '@aalis/plugin-workflow';
export const displayName = '工作流';
export const subsystem = 'workflow';

export const provides = ['workflow'];

export const inject = {
  required: ['cron-engine'],
  optional: ['tools', 'storage', 'webui'],
};

export const extends_ = {
  events: ['workflow:run:start', 'workflow:run:done', 'workflow:run:error', 'workflow:node:done', 'trigger:fired'],
};

// ─── 配置 ───

interface WorkflowConfig {
  defsDir: string;
  runsFile: string;
  maxRuns: number;
  enableTools: boolean;
}

export const configSchema: ConfigSchema = {
  defsDir: {
    type: 'string',
    label: '工作流定义目录',
    default: 'workspace:/workflows',
    description:
      '加载存储下的 *.yaml 定义（storage URI，也兼容旧【workspace/workflows】）；AI 通过 workflow_define 创建的定义也写入此处。',
  },
  runsFile: {
    type: 'string',
    label: '运行历史文件',
    default: 'data:/workflow-runs.json',
    description: '保存最近 N 条运行实例（storage URI，也兼容旧【data/workflow-runs.json】）。',
  },
  maxRuns: {
    type: 'number',
    label: '保留最近运行条数',
    default: 200,
    description: '超过则按时间裁剪最旧的；最小 10。',
  },
  enableTools: {
    type: 'boolean',
    label: '注册 AI 工具',
    default: true,
    description: '开启后向 LLM 暴露 workflow_define / workflow_run 等工具。',
  },
};

export const defaultConfig = {
  defsDir: 'workspace:/workflows',
  runsFile: 'data:/workflow-runs.json',
  maxRuns: 200,
  enableTools: true,
};

// ─── WebUI ───

const webuiPages: WebuiPage[] = [
  {
    key: 'workflows',
    label: '工作流',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M9 6h6"/><path d="M7.5 8.5L11 15.5"/><path d="M16.5 8.5L13 15.5"/></svg>',
    order: 57,
    content: [
      {
        type: 'stat',
        label: '工作流总览',
        source: 'workflowStats',
      },
      {
        type: 'table',
        label: '工作流定义',
        source: 'listWorkflowsTable',
        columns: [
          { key: 'id', label: 'ID', nowrap: true },
          { key: 'name', label: '名称' },
          { key: 'trigger', label: '触发器', nowrap: true },
          { key: 'nodeCount', label: '节点' },
          { key: 'enabled', label: '状态', nowrap: true },
          { key: 'description', label: '描述', maxWidth: 360, render: 'expandable-text' },
        ],
        actions: [
          { label: '立即运行', method: 'triggerWorkflow' },
          { label: '禁用/启用', method: 'toggleWorkflow' },
          { label: '查看 YAML', method: 'getWorkflowYaml' },
          { label: '删除', method: 'removeWorkflow', confirm: '确定删除该工作流？(同时删除磁盘文件)', danger: true },
        ],
        refresh: 60,
      },
      {
        type: 'table',
        label: '最近运行历史',
        source: 'listRunsTable',
        columns: [
          { key: 'runId', label: 'Run ID', nowrap: true },
          { key: 'workflowId', label: '工作流', nowrap: true },
          { key: 'status', label: '状态', nowrap: true },
          { key: 'triggerSource', label: '触发源', nowrap: true },
          { key: 'startedAtText', label: '开始时间', nowrap: true },
          { key: 'durationText', label: '耗时', nowrap: true },
          { key: 'error', label: '错误', maxWidth: 320, render: 'expandable-text' },
        ],
        refresh: 30,
      },
      {
        type: 'form',
        label: '新建 / 覆盖工作流（粘贴完整 YAML）',
        source: 'newWorkflowDraft',
        save: 'upsertWorkflowYaml',
        schema: {
          yaml: {
            type: 'textarea',
            label: 'YAML 定义',
            required: true,
            description:
              '完整 WorkflowDef YAML：id / name / trigger / nodes。trigger 类型支持 cron / interval / once / event / manual。' +
              '节点类型 tool / send-message / wait / agent（agent 节点派发指令给 agent 并等回复，配合 deps + {{outputs.X}} 做多智能体编排）。' +
              '保存后将立即注册触发器并持久化到 defsDir。',
          },
          persist: {
            type: 'boolean',
            label: '写入磁盘',
            default: true,
            description: '关闭后仅在内存中注册（进程重启后丢失）',
          },
        },
      },
    ],
  },
];

// ─── 工具函数（与 actions 共享） ───

function triggerSummary(t: { type: string; expr?: string; seconds?: number; runAt?: string; event?: string }): string {
  switch (t.type) {
    case 'cron':
      return `cron ${t.expr ?? ''}`.trim();
    case 'interval':
      return `每 ${t.seconds ?? '?'}s`;
    case 'once':
      return `一次性@${t.runAt ?? '?'}`;
    case 'event':
      return `event:${t.event ?? '?'}`;
    case 'manual':
      return '手动';
    default:
      return t.type;
  }
}

function fmtTs(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(ts);
  }
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export const actions: PluginModule['actions'] = {
  async workflowStats(ctx) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return { value: 0, hint: 'workflow 服务未就绪' };
    const defs = svc.listWorkflows();
    const enabled = defs.filter(d => d.enabled !== false).length;
    const runs = svc.listRuns(200);
    const last24h = runs.filter(r => Date.now() - r.startedAt < 86_400_000);
    const failed24h = last24h.filter(r => r.status === 'failed' || r.status === 'cancelled').length;
    return {
      value: defs.length,
      hint: `启用 ${enabled} · 24h 运行 ${last24h.length} · 失败 ${failed24h}`,
    };
  },
  async listWorkflowsTable(ctx) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return [];
    const runs = svc.listRuns(200);
    const lastByWf = new Map<string, number>();
    for (const r of runs) {
      const prev = lastByWf.get(r.workflowId) ?? 0;
      if (r.startedAt > prev) lastByWf.set(r.workflowId, r.startedAt);
    }
    return svc.listWorkflows().map(d => ({
      id: d.id,
      name: d.name ?? d.id,
      trigger: triggerSummary(d.trigger),
      nodeCount: d.nodes.length,
      enabled: d.enabled === false ? '⏸ 禁用' : '✅ 启用',
      description: d.description ?? '',
      lastRun: lastByWf.get(d.id) ?? 0,
    }));
  },
  async listRunsTable(ctx) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return [];
    return svc.listRuns(50).map(r => {
      const dur = (r.finishedAt ?? Date.now()) - r.startedAt;
      const statusIcon =
        r.status === 'success' ? '✅' : r.status === 'failed' ? '❌' : r.status === 'cancelled' ? '⏹' : '⏳';
      return {
        runId: r.runId,
        workflowId: r.workflowId,
        status: `${statusIcon} ${r.status}`,
        triggerSource: r.triggerSource,
        startedAtText: fmtTs(r.startedAt),
        durationText: fmtDuration(dur),
        error: r.error ?? '',
      };
    });
  },
  async triggerWorkflow(ctx, args) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return { ok: false, error: 'workflow 服务未就绪' };
    try {
      const run = await svc.runWorkflow(String(args.id), {}, 'manual:webui');
      return {
        ok: true,
        runId: run.runId,
        status: run.status,
        durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
        error: run.error,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  async toggleWorkflow(ctx, args) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return { ok: false, error: 'workflow 服务未就绪' };
    const def = svc.getWorkflow(String(args.id));
    if (!def) return { ok: false, error: '工作流不存在' };
    const next = { ...def, enabled: def.enabled === false };
    try {
      await svc.defineWorkflow(next, { persist: true });
      return { ok: true, enabled: next.enabled };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
  async getWorkflowYaml(ctx, args) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return { error: 'workflow 服务未就绪' };
    const def = svc.getWorkflow(String(args.id));
    if (!def) return { error: '工作流不存在' };
    return { id: def.id, yaml: stringify(def) };
  },
  async removeWorkflow(ctx, args) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return { ok: false, error: 'workflow 服务未就绪' };
    const ok = await svc.removeWorkflow(String(args.id));
    return { ok, message: ok ? '已删除' : '不存在' };
  },
  async newWorkflowDraft() {
    return {
      yaml: `id: my-workflow
name: 示例工作流
description: 描述这个工作流的作用
trigger:
  type: manual
vars:
  greeting: hello
nodes:
  - id: say
    type: send-message
    sessionId: internal:demo
    platform: internal
    content: "{{vars.greeting}}, world!"
`,
      persist: true,
    };
  },
  async upsertWorkflowYaml(ctx, args) {
    const svc = ctx.getService<WorkflowService>('workflow');
    if (!svc) return { ok: false, error: 'workflow 服务未就绪' };
    const yamlText = String(args.yaml ?? '').trim();
    if (!yamlText) return { ok: false, error: 'yaml 不能为空' };
    let raw: unknown;
    try {
      raw = parse(yamlText);
    } catch (err) {
      return { ok: false, error: `YAML 解析失败: ${err instanceof Error ? err.message : err}` };
    }
    const def = normalizeDef(raw, `wf-${Date.now()}`);
    if (!def) return { ok: false, error: '定义不合法：缺少 trigger 或 nodes' };
    try {
      await svc.defineWorkflow(def, { persist: args.persist !== false });
      return { ok: true, id: def.id, nodes: def.nodes.length };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

function toUri(input: string, fallback: string): string {
  const s = String(input ?? '').trim();
  if (!s) return fallback;
  if (s.includes(':/')) return s;
  const cleaned = s.replace(/^\.?\/+/, '');
  const idx = cleaned.indexOf('/');
  return idx > 0 ? `${cleaned.slice(0, idx)}:/${cleaned.slice(idx + 1)}` : `${cleaned}:/`;
}

function resolveConfig(raw: Record<string, unknown>): WorkflowConfig {
  return {
    defsDir: toUri(typeof raw.defsDir === 'string' ? raw.defsDir : '', 'workspace:/workflows'),
    runsFile: toUri(typeof raw.runsFile === 'string' ? raw.runsFile : '', 'data:/workflow-runs.json'),
    maxRuns: typeof raw.maxRuns === 'number' && raw.maxRuns > 0 ? raw.maxRuns : 200,
    enableTools: raw.enableTools !== false,
  };
}

// ─── apply ───

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('workflow');
  const storage = createStorageGateway(ctx);

  const loader = new WorkflowLoader(storage, config.defsDir, logger);
  await loader.loadAll();

  const runStore = new RunStore(storage, config.runsFile, config.maxRuns, logger);
  await runStore.init();

  const cancelTokens = new Map<string, { cancelled: boolean }>();

  // ── 触发管理器：内部 cron/interval/event 监听 ──
  const triggers = new TriggerManager(ctx, logger, (workflowId, source) => {
    // 异步触发，不阻塞触发源
    runById(workflowId, {}, source).catch(err => {
      logger.error(
        `触发执行 workflow=${workflowId} source=${source} 失败: ${err instanceof Error ? err.message : err}`,
      );
    });
  });
  for (const def of loader.list()) triggers.register(def);

  // ── 订阅外部 trigger:fired（来自 scheduler / 其他触发源）──
  ctx.on('trigger:fired', info => {
    if (!info?.workflowId) return;
    runById(info.workflowId, info.payload ?? {}, info.source ?? `trigger:${info.type}`).catch(err => {
      logger.error(`trigger:fired workflow=${info.workflowId} 执行失败: ${err instanceof Error ? err.message : err}`);
    });
  });

  // ── 核心：跑一次 workflow ──
  async function runById(
    workflowId: string,
    extraVars: Record<string, unknown>,
    triggerSource: string,
    caller?: { platform?: string; userId?: string },
  ): Promise<WorkflowRun> {
    const def = loader.get(workflowId);
    if (!def) throw new Error(`workflow "${workflowId}" 不存在`);
    if (def.enabled === false) throw new Error(`workflow "${workflowId}" 已禁用`);

    const runId = `${workflowId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const vars = { ...(def.vars ?? {}), ...extraVars };
    const cancelToken = { cancelled: false };
    cancelTokens.set(runId, cancelToken);

    const run: WorkflowRun = {
      runId,
      workflowId,
      status: 'running',
      triggerSource,
      startedAt: Date.now(),
      vars,
      nodes: def.nodes.map(n => ({ id: n.id, type: n.type, status: 'pending' })),
    };
    runStore.add(run);
    await ctx.emit('workflow:run:start', run);
    logger.info(`run=${runId} 启动 (trigger=${triggerSource})`);

    try {
      const result = await runDag({
        ctx,
        logger,
        def,
        runId,
        triggerSource,
        vars,
        // 运行时身份：经 workflow_run 工具触发时透传【调用者】身份，使工作流内部工具
        // 按【调用者】的权限等级过 authority 闸（而非匿名 level-0）；owner 定义、谁调按谁裁决，
        // 杜绝借他人 workflow 提权。cron/event/webui 触发无调用者 → 保持匿名（仅能跑 public 工具）。
        toolCallContext: {
          sessionId: `workflow::${workflowId}`,
          platform: caller?.platform ?? 'workflow',
          userId: caller?.userId,
        },
        cancelToken,
        onNodeDone: (info: NodeRunInfo) => {
          const idx = run.nodes.findIndex(n => n.id === info.id);
          if (idx >= 0) run.nodes[idx] = info;
          ctx.emit('workflow:node:done', { runId, node: info }).catch(() => {});
        },
      });
      run.status = result.status;
      run.nodes = result.nodes;
      run.error = result.error;
      run.finishedAt = Date.now();
      runStore.update(run);
      if (result.status === 'success') {
        await ctx.emit('workflow:run:done', run);
        logger.info(`run=${runId} 完成 (${run.finishedAt - run.startedAt}ms)`);
      } else {
        await ctx.emit('workflow:run:error', run);
        logger.warn(`run=${runId} ${result.status}: ${result.error ?? ''}`);
      }
    } catch (err) {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = Date.now();
      runStore.update(run);
      await ctx.emit('workflow:run:error', run);
      logger.error(`run=${runId} 异常: ${run.error}`);
    } finally {
      cancelTokens.delete(runId);
    }
    return run;
  }

  // ── WorkflowService ──
  const service: WorkflowService = {
    listWorkflows() {
      return loader.list();
    },
    getWorkflow(id) {
      return loader.get(id);
    },
    async defineWorkflow(def, opts) {
      const err = validateGraph(def);
      if (err) throw new Error(err);
      // 重新触发器
      if (opts?.persist !== false) {
        await loader.saveDef(def);
      } else {
        loader.putMemory(def);
      }
      triggers.register(def);
      logger.info(`workflow 已定义: ${def.id} (持久化=${opts?.persist !== false})`);
    },
    async removeWorkflow(id) {
      triggers.unregister(id);
      return await loader.removeDef(id);
    },
    async runWorkflow(id, vars, source, caller) {
      return await runById(id, vars ?? {}, source ?? 'manual', caller);
    },
    cancelRun(runId) {
      const t = cancelTokens.get(runId);
      if (!t) return false;
      t.cancelled = true;
      return true;
    },
    getRun(runId) {
      return runStore.get(runId);
    },
    listRuns(limit, workflowId) {
      return runStore.list(limit, workflowId);
    },
  };

  ctx.provide('workflow', service);

  // ── AI 工具 ──
  if (config.enableTools && ctx.getService<ToolService>('tools')) {
    registerTools(ctx, service);
  }

  // ── WebUI ──
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  // ── 清理 ──
  ctx.onDispose(() => {
    triggers.dispose();
    cancelTokens.clear();
  });

  logger.info(`工作流插件已启动 (${loader.list().length} 个定义已加载)`);
}

// ─── AI 工具注册 ───

function registerTools(ctx: Context, service: WorkflowService): void {
  const tools = useToolService(ctx);
  tools.registerGroup({ name: 'workflow', label: '工作流', description: '定义、运行、查询自主工作流（DAG）' });

  tools.register({
    groups: ['workflow'],
    definition: {
      type: 'function',
      function: {
        name: 'workflow_define',
        description:
          '定义或覆盖一个工作流。yaml 字段为完整的 WorkflowDef YAML 字符串，包含 id/trigger/nodes 等。' +
          ' 节点支持类型 tool / send-message / wait / agent；deps 形成 DAG；字符串值支持 {{vars.X}} 与 {{outputs.Y}} 插值。' +
          ' agent 节点（instruction 必填，可选 sessionId/platform/timeoutSeconds）会把指令派发给 agent 并等待其回复，' +
          '回复经 out 存入 outputs 供下游插值——用 deps + agent 节点即可表达"分解→依赖→串/并行→管道→聚合"的确定性多智能体编排。',
        parameters: {
          type: 'object',
          properties: {
            yaml: { type: 'string', description: '完整的 workflow YAML 文本' },
            persist: { type: 'boolean', description: '是否写入磁盘（默认 true）' },
          },
          required: ['yaml'],
        },
      },
    },
    handler: async args => {
      const yamlText = String(args.yaml ?? '');
      let raw: unknown;
      try {
        raw = parse(yamlText);
      } catch (e) {
        return JSON.stringify({ error: `YAML 解析失败: ${e instanceof Error ? e.message : e}` });
      }
      const def = normalizeDef(raw, `wf-${Date.now()}`);
      if (!def) return JSON.stringify({ error: '定义不合法：缺少 trigger 或 nodes' });
      try {
        await service.defineWorkflow(def, { persist: args.persist !== false });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
      return JSON.stringify({ ok: true, id: def.id, nodes: def.nodes.length, trigger: def.trigger.type });
    },
  });

  tools.register({
    groups: ['workflow'],
    definition: {
      type: 'function',
      function: {
        name: 'workflow_list',
        description: '列出全部工作流定义。',
        parameters: { type: 'object', properties: {} },
      },
    },
    handler: async () => {
      const list = service.listWorkflows().map(d => ({
        id: d.id,
        name: d.name,
        description: d.description,
        trigger: d.trigger,
        nodeCount: d.nodes.length,
        enabled: d.enabled !== false,
      }));
      return JSON.stringify({ total: list.length, workflows: list });
    },
  });

  tools.register({
    groups: ['workflow'],
    definition: {
      type: 'function',
      function: {
        name: 'workflow_run',
        description: '手动触发一次工作流执行；vars 与定义中的 vars 浅合并后提供给节点插值。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'workflow id' },
            vars: { type: 'object', description: '本次运行的额外变量（可选）' },
          },
          required: ['id'],
        },
      },
    },
    handler: async (args, callCtx) => {
      try {
        // 透传调用者身份：工作流内部工具按调用者权限跑（owner 定义、谁调用按谁的档位裁决）。
        const run = await service.runWorkflow(
          String(args.id),
          (args.vars as Record<string, unknown>) ?? {},
          'manual:tool',
          { platform: callCtx.platform, userId: callCtx.userId },
        );
        return JSON.stringify({
          ok: true,
          runId: run.runId,
          status: run.status,
          durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
          nodes: run.nodes.map(n => ({ id: n.id, status: n.status, error: n.error })),
          error: run.error,
        });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
  });

  tools.register({
    groups: ['workflow'],
    definition: {
      type: 'function',
      function: {
        name: 'workflow_get_runs',
        description: '查询最近的工作流运行历史（按时间倒序）。',
        parameters: {
          type: 'object',
          properties: {
            workflowId: { type: 'string', description: '只看某个 workflow（可选）' },
            limit: { type: 'number', description: '返回条数（默认 20）' },
          },
        },
      },
    },
    handler: async args => {
      const runs = service.listRuns(
        typeof args.limit === 'number' ? args.limit : 20,
        typeof args.workflowId === 'string' ? args.workflowId : undefined,
      );
      return JSON.stringify({
        total: runs.length,
        runs: runs.map(r => ({
          runId: r.runId,
          workflowId: r.workflowId,
          status: r.status,
          triggerSource: r.triggerSource,
          startedAt: new Date(r.startedAt).toISOString(),
          durationMs: (r.finishedAt ?? Date.now()) - r.startedAt,
          error: r.error,
        })),
      });
    },
  });

  tools.register({
    groups: ['workflow'],
    definition: {
      type: 'function',
      function: {
        name: 'workflow_remove',
        description: '删除一个工作流定义（同时停止其触发器；持久化文件也会被删除）。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'workflow id' },
          },
          required: ['id'],
        },
      },
    },
    handler: async args => {
      const ok = await service.removeWorkflow(String(args.id));
      return JSON.stringify({ ok, message: ok ? '已删除' : '不存在' });
    },
  });
}

// ─── 重导出 API（便于外部 import 类型）───
export type {
  NodeSpec,
  TriggerSpec,
  WorkflowDef,
  WorkflowRun,
  WorkflowService,
} from '@aalis/plugin-workflow-api';
