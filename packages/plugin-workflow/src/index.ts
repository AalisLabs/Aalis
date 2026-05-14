// ============================================================
// @aalis/plugin-workflow — DAG 工作流引擎
//
// 订阅 'trigger:fired' 事件 + 内置 cron/interval/event 触发器，
// 按 DAG 执行节点，结果存 data/workflow-runs.json，
// 定义存 workspace/workflows/*.yaml。
// ============================================================

import type { ConfigSchema, Context } from '@aalis/core';
import type { ToolService } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
// 引入 plugin-webui-api 的副作用以激活 PluginModule.extends/subsystem 类型增广
import '@aalis/plugin-webui-api';
import type { NodeRunInfo, WorkflowRun, WorkflowService } from '@aalis/plugin-workflow-api';
import { parse } from 'yaml';

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
  optional: ['tools', 'storage'],
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
    default: 'workspace/workflows',
    description: '加载 workspace/workflows/*.yaml；AI 通过 workflow_define 创建的定义也写入此处。',
  },
  runsFile: {
    type: 'string',
    label: '运行历史文件',
    default: 'data/workflow-runs.json',
    description: '保存最近 N 条运行实例；用于 workflow_get_runs 查询。',
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
  defsDir: 'workspace/workflows',
  runsFile: 'data/workflow-runs.json',
  maxRuns: 200,
  enableTools: true,
};

function resolveConfig(raw: Record<string, unknown>): WorkflowConfig {
  return {
    defsDir: typeof raw.defsDir === 'string' ? raw.defsDir : 'workspace/workflows',
    runsFile: typeof raw.runsFile === 'string' ? raw.runsFile : 'data/workflow-runs.json',
    maxRuns: typeof raw.maxRuns === 'number' && raw.maxRuns > 0 ? raw.maxRuns : 200,
    enableTools: raw.enableTools !== false,
  };
}

// ─── apply ───

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('workflow');

  const loader = new WorkflowLoader(config.defsDir, logger);
  loader.loadAll();

  const runStore = new RunStore(config.runsFile, config.maxRuns, logger);

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
        toolCallContext: {
          sessionId: `workflow::${workflowId}`,
          platform: 'workflow',
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
        loader.saveDef(def);
      } else {
        loader.putMemory(def);
      }
      triggers.register(def);
      logger.info(`workflow 已定义: ${def.id} (持久化=${opts?.persist !== false})`);
    },
    async removeWorkflow(id) {
      triggers.unregister(id);
      return loader.removeDef(id);
    },
    async runWorkflow(id, vars, source) {
      return await runById(id, vars ?? {}, source ?? 'manual');
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

  // ── 清理 ──
  ctx.on('dispose', () => {
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
          ' 节点支持类型 tool / send-message / wait；deps 形成 DAG；字符串值支持 {{vars.X}} 与 {{outputs.Y}} 插值。',
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
    handler: async args => {
      try {
        const run = await service.runWorkflow(
          String(args.id),
          (args.vars as Record<string, unknown>) ?? {},
          'manual:tool',
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
