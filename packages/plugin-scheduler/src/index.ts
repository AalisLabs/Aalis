import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ConfigSchema, Context, PluginModule } from '@aalis/core';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import type { ToolService } from '@aalis/plugin-tools-api';
import { useToolService } from '@aalis/plugin-tools-api';
import type { WebuiPage } from '@aalis/plugin-webui-api';
import { useWebuiService } from '@aalis/plugin-webui-api';

// ════════════════════════════════════════════════════════════
// plugin-scheduler — 让 AI 从"被动"变"主动"
//
// 支持 cron 表达式和固定间隔两种调度方式。
// 每个任务向指定 session 发送 inbound:message 事件，
// source='scheduler' 使其绕过流控、且不打断用户会话。
// ════════════════════════════════════════════════════════════

// ──────────── 配置类型 ────────────

interface SchedulerJobConfig {
  name: string;
  /** cron 表达式 (5 段: 分 时 日 月 周) */
  cron?: string;
  /** 固定间隔秒数（与 cron 二选一） */
  interval?: number;
  /** 目标 sessionId（消息发往哪个会话） */
  sessionId: string;
  /** 目标平台标识 */
  platform: string;
  /** 发送给 Agent 的消息内容 */
  content: string;
  /** 是否启用 */
  enabled: boolean;
}

interface SchedulerConfig {
  jobs: SchedulerJobConfig[];
  /** 同时执行的最大任务数 */
  maxConcurrent: number;
  /** 动态任务持久化文件路径 */
  persistPath: string;
}

// ──────────── Cron 解析 ────────────

function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      if (step > 0) for (let i = min; i <= max; i += step) result.add(i);
    } else if (trimmed.includes('-')) {
      const [a, b] = trimmed.split('-').map(Number);
      for (let i = a; i <= b; i++) result.add(i);
    } else {
      const n = parseInt(trimmed, 10);
      if (!Number.isNaN(n)) result.add(n);
    }
  }
  return result;
}

function matchesCron(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minute, hour, day, month, weekday] = parts;
  return (
    parseCronField(minute, 0, 59).has(date.getMinutes()) &&
    parseCronField(hour, 0, 23).has(date.getHours()) &&
    parseCronField(day, 1, 31).has(date.getDate()) &&
    parseCronField(month, 1, 12).has(date.getMonth() + 1) &&
    parseCronField(weekday, 0, 6).has(date.getDay())
  );
}

// ──────────── 运行时状态 ────────────

interface JobRuntime {
  config: SchedulerJobConfig;
  /** 固定间隔定时器 */
  timer: ReturnType<typeof setInterval> | null;
  /** 上次执行时间 */
  lastRun: number;
  /** 下次执行（预估，用于展示） */
  nextRun: number;
  /** 正在执行 */
  running: boolean;
  /** 累计执行次数 */
  runCount: number;
  /** 最近执行结果 */
  lastResult: string;
  /** 是否暂停（运行时可临时暂停，不改配置） */
  paused: boolean;
}

// ──────────── 调度器服务接口 ────────────

export interface SchedulerService {
  getJobs(): Array<{
    name: string;
    cron?: string;
    interval?: number;
    sessionId: string;
    platform: string;
    content: string;
    enabled: boolean;
    paused: boolean;
    running: boolean;
    lastRun: number;
    nextRun: number;
    runCount: number;
    lastResult: string;
  }>;
  pauseJob(name: string): boolean;
  resumeJob(name: string): boolean;
  triggerJob(name: string): Promise<boolean>;
  addJob(job: SchedulerJobConfig): void;
  removeJob(name: string): boolean;
}

// ──────────── 插件元数据 ────────────

export const name = '@aalis/plugin-scheduler';
export const displayName = '定时任务';
export const subsystem = 'scheduler';

export const provides = ['scheduler'];

export const inject = {
  optional: ['agent'],
};

export const extends_: PluginModule['extends'] = {
  events: ['scheduler:tick', 'scheduler:job:start', 'scheduler:job:done', 'scheduler:job:error'],
};

export const configSchema: ConfigSchema = {
  jobs: {
    type: 'array',
    label: '计划任务列表',
    description: '配置定时/周期性任务，让 AI 主动执行计划。',
    items: {
      name: { type: 'string', label: '任务名称', required: true },
      cron: {
        type: 'string',
        label: 'Cron 表达式',
        description: '5 段格式: 分 时 日 月 周 (如 "0 9 * * *" = 每天 9:00)。与"固定间隔"二选一。',
      },
      interval: {
        type: 'number',
        label: '固定间隔(秒)',
        description: '每隔 N 秒执行一次。与"Cron 表达式"二选一。',
      },
      sessionId: {
        type: 'string',
        label: '目标会话 ID',
        required: true,
        description: '任务消息发往的会话 ID。可以是真实群/用户会话，也可以自定义（如 scheduler::daily）。',
      },
      platform: {
        type: 'string',
        label: '目标平台',
        required: true,
        description: '任务消息的平台标识（如 internal、webui、onebot）。',
        default: 'internal',
      },
      content: {
        type: 'string',
        label: '消息内容',
        required: true,
        description: '发送给 Agent 的指令/提示内容。',
      },
      enabled: { type: 'boolean', label: '启用', default: true },
    },
    default: [],
  },
  maxConcurrent: {
    type: 'number',
    label: '最大并发任务数',
    default: 3,
    description: '同时执行的任务数量上限，超出时排队等待。',
  },
  persistPath: {
    type: 'string',
    label: '动态任务存储路径',
    default: 'data/scheduler-jobs.json',
    description: '通过 AI 或 WebUI 创建的任务会持久化到此文件，重启后自动加载。',
  },
};

export const defaultConfig = {
  jobs: [] as Record<string, unknown>[],
  maxConcurrent: 3,
  persistPath: 'data/scheduler-jobs.json',
};

// ──────────── WebUI 页面 ────────────

const webuiPages: WebuiPage[] = [
  {
    key: 'scheduler',
    label: '计划任务',
    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>',
    order: 55,
    content: [
      {
        type: 'table',
        label: '任务列表',
        source: 'listJobs',
        columns: [
          { key: 'name', label: '名称' },
          { key: 'schedule', label: '调度规则' },
          { key: 'sessionId', label: '目标会话' },
          { key: 'status', label: '状态' },
          { key: 'nextRun', label: '下次执行', render: 'countdown' },
          { key: 'lastRunText', label: '上次执行' },
          { key: 'runCount', label: '执行次数' },
          { key: 'lastResult', label: '最近结果' },
        ],
        actions: [
          { label: '立即执行', method: 'triggerJob' },
          { label: '暂停', method: 'pauseJob' },
          { label: '恢复', method: 'resumeJob' },
          { label: '删除', method: 'removeJob', confirm: '确定删除该任务？', danger: true },
        ],
        refresh: 30,
      },
    ],
  },
];

// ──────────── WebUI Handlers ────────────

export const actions: PluginModule['actions'] = {
  async listJobs(ctx) {
    const svc = ctx.getService<SchedulerService>('scheduler');
    if (!svc) return [];
    return svc.getJobs().map(j => {
      const ready = j.enabled && !j.paused && !j.running;
      return {
        ...j,
        nextRun: ready ? j.nextRun : 0,
        schedule: j.cron ?? `每 ${j.interval}s`,
        status: !j.enabled ? '❌ 禁用' : j.paused ? '⏸ 暂停' : j.running ? '⏳ 执行中' : '✅ 就绪',
        lastRunText: j.lastRun ? new Date(j.lastRun).toLocaleString('zh-CN') : '从未',
      };
    });
  },
  async triggerJob(ctx, args) {
    const svc = ctx.getService<SchedulerService>('scheduler');
    return svc?.triggerJob(args.name as string);
  },
  async pauseJob(ctx, args) {
    const svc = ctx.getService<SchedulerService>('scheduler');
    return svc?.pauseJob(args.name as string);
  },
  async resumeJob(ctx, args) {
    const svc = ctx.getService<SchedulerService>('scheduler');
    return svc?.resumeJob(args.name as string);
  },
  async removeJob(ctx, args) {
    const svc = ctx.getService<SchedulerService>('scheduler');
    return svc?.removeJob(args.name as string);
  },
};

// ──────────── 插件入口 ────────────

export function apply(ctx: Context, rawConfig: Record<string, unknown>): void {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('scheduler');

  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  const runtimes = new Map<string, JobRuntime>();
  let runningCount = 0;
  let cronInterval: ReturnType<typeof setInterval> | null = null;

  // 配置中定义的任务名称集合（不需要持久化）
  const configJobNames = new Set(config.jobs.map(j => j.name));
  // 动态任务集合（需要持久化）
  const dynamicJobs = new Map<string, SchedulerJobConfig>();

  // ── 持久化读写 ──

  const persistFile = resolve(process.cwd(), config.persistPath);

  function loadDynamicJobs(): SchedulerJobConfig[] {
    try {
      if (!existsSync(persistFile)) return [];
      const data = JSON.parse(readFileSync(persistFile, 'utf-8'));
      if (!Array.isArray(data)) return [];
      return data.map((j: any) => ({
        name: String(j.name ?? 'unnamed'),
        cron: j.cron as string | undefined,
        interval: j.interval as number | undefined,
        sessionId: String(j.sessionId ?? 'internal'),
        platform: String(j.platform ?? 'internal'),
        content: String(j.content ?? ''),
        enabled: j.enabled !== false,
      }));
    } catch (err) {
      logger.warn(`加载持久化任务失败: ${err}`);
      return [];
    }
  }

  function saveDynamicJobs(): void {
    try {
      const dir = dirname(persistFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const jobs = [...dynamicJobs.values()];
      writeFileSync(persistFile, JSON.stringify(jobs, null, 2), 'utf-8');
      logger.debug(`已持久化 ${jobs.length} 个动态任务`);
    } catch (err) {
      logger.warn(`持久化任务失败: ${err}`);
    }
  }

  // ── 发送调度消息 ──

  async function executeJob(rt: JobRuntime): Promise<void> {
    if (rt.running) return;
    if (runningCount >= config.maxConcurrent) {
      rt.lastResult = '跳过: 并发达上限';
      return;
    }

    rt.running = true;
    runningCount++;
    const jobName = rt.config.name;

    try {
      logger.info(`执行任务: ${jobName}`);
      await ctx.emit('scheduler:job:start' as any, jobName);

      const message: IncomingMessage = {
        content: rt.config.content,
        sessionId: rt.config.sessionId,
        platform: rt.config.platform,
        source: 'scheduler',
      };

      await ctx.emit('inbound:message', message);

      rt.lastRun = Date.now();
      rt.runCount++;
      rt.lastResult = '成功';
      await ctx.emit('scheduler:job:done' as any, jobName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rt.lastResult = `失败: ${msg}`;
      logger.error(`任务 "${jobName}" 执行失败: ${msg}`);
      await ctx.emit('scheduler:job:error' as any, jobName, msg);
    } finally {
      rt.running = false;
      runningCount--;
    }
  }

  // ── 估算下次执行时间 ──

  function estimateNextRun(job: SchedulerJobConfig, lastRun: number): number {
    if (job.interval) {
      return (lastRun || Date.now()) + job.interval * 1000;
    }
    // cron: 简单估算——从当前时间起逐分钟检查
    if (job.cron) {
      const now = new Date();
      for (let offset = 1; offset <= 1440; offset++) {
        const candidate = new Date(now.getTime() + offset * 60_000);
        candidate.setSeconds(0, 0);
        if (matchesCron(job.cron, candidate)) return candidate.getTime();
      }
    }
    return 0;
  }

  // ── 初始化所有任务 ──

  function initJob(jobCfg: SchedulerJobConfig): void {
    if (runtimes.has(jobCfg.name)) return;

    const rt: JobRuntime = {
      config: jobCfg,
      timer: null,
      lastRun: 0,
      nextRun: estimateNextRun(jobCfg, 0),
      running: false,
      runCount: 0,
      lastResult: '',
      paused: !jobCfg.enabled,
    };

    // 固定间隔调度
    if (jobCfg.interval && jobCfg.interval > 0 && jobCfg.enabled) {
      rt.timer = setInterval(() => {
        if (!rt.paused) {
          executeJob(rt);
          rt.nextRun = estimateNextRun(rt.config, Date.now());
        }
      }, jobCfg.interval * 1000);
    }

    // 如果是 cron 任务，确保 cron 主循环已启动
    if (jobCfg.cron && jobCfg.enabled) {
      ensureCronLoop();
    }

    runtimes.set(jobCfg.name, rt);
    logger.info(
      `任务已注册: ${jobCfg.name} ${jobCfg.cron ? `(cron: ${jobCfg.cron})` : `(interval: ${jobCfg.interval}s)`}`,
    );
  }

  for (const job of config.jobs) {
    initJob(job);
  }

  // 加载持久化的动态任务
  const persisted = loadDynamicJobs();
  for (const job of persisted) {
    if (!runtimes.has(job.name)) {
      dynamicJobs.set(job.name, job);
      initJob(job);
    }
  }
  if (persisted.length > 0) {
    logger.info(`已加载 ${persisted.length} 个持久化任务`);
  }

  // ── Cron 主循环（每 60 秒检查一次） ──

  /** 启动 cron 主循环（幂等，已启动则跳过） */
  function ensureCronLoop(): void {
    if (cronInterval) return;
    // 对齐到下一分钟的 00 秒
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds();
    setTimeout(() => {
      cronTick();
      cronInterval = setInterval(cronTick, 60_000);
    }, msToNextMinute);
    logger.debug('Cron 主循环已启动');
  }

  const hasCronJobs = config.jobs.some(j => j.cron && j.enabled);
  if (hasCronJobs) {
    ensureCronLoop();
  }

  function cronTick(): void {
    const now = new Date();
    now.setSeconds(0, 0);
    for (const rt of runtimes.values()) {
      if (!rt.config.cron || rt.paused || !rt.config.enabled) continue;
      if (matchesCron(rt.config.cron, now)) {
        executeJob(rt);
      }
      // 每次 tick 后更新所有 cron 任务的下次执行时间
      rt.nextRun = estimateNextRun(rt.config, rt.lastRun);
    }
    ctx.emit('scheduler:tick' as any).catch(() => {});
  }

  // ── 注册 scheduler 服务 ──

  const service: SchedulerService = {
    getJobs() {
      return [...runtimes.values()].map(rt => ({
        name: rt.config.name,
        cron: rt.config.cron,
        interval: rt.config.interval,
        sessionId: rt.config.sessionId,
        platform: rt.config.platform,
        content: rt.config.content,
        enabled: rt.config.enabled,
        paused: rt.paused,
        running: rt.running,
        lastRun: rt.lastRun,
        nextRun: rt.nextRun,
        runCount: rt.runCount,
        lastResult: rt.lastResult,
      }));
    },
    pauseJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      rt.paused = true;
      logger.info(`任务已暂停: ${jobName}`);
      return true;
    },
    resumeJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      rt.paused = false;
      rt.nextRun = estimateNextRun(rt.config, rt.lastRun);
      logger.info(`任务已恢复: ${jobName}`);
      return true;
    },
    async triggerJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      await executeJob(rt);
      return true;
    },
    addJob(job) {
      initJob(job);
      // 非配置中定义的任务需要持久化
      if (!configJobNames.has(job.name)) {
        dynamicJobs.set(job.name, job);
        saveDynamicJobs();
      }
    },
    removeJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      if (rt.timer) clearInterval(rt.timer);
      runtimes.delete(jobName);
      if (dynamicJobs.has(jobName)) {
        dynamicJobs.delete(jobName);
        saveDynamicJobs();
      }
      logger.info(`任务已删除: ${jobName}`);
      return true;
    },
  };

  ctx.provide('scheduler', service);

  // ── 注册 AI 工具：让 Agent 可以自主创建/管理任务 ──

  if (ctx.getService<ToolService>('tools')) {
    useToolService(ctx).registerGroup({
      name: 'scheduler',
      label: '定时任务',
      description: '创建、查看和取消定时/周期性自主行动计划',
    });

    useToolService(ctx).register({
      groups: ['scheduler'],
      definition: {
        type: 'function',
        function: {
          name: 'scheduler_create_job',
          description:
            '创建一个新的定时/周期性自主行动计划。可以用来安排自己将来要做的事情。不传 sessionId 和 platform 时，默认使用当前会话。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '任务名称（唯一标识）' },
              cron: {
                type: 'string',
                description: 'Cron 表达式 (分 时 日 月 周)，如 "0 9 * * *" 表示每天9点。与 interval 二选一。',
              },
              interval: { type: 'number', description: '固定间隔秒数。与 cron 二选一。' },
              sessionId: { type: 'string', description: '任务消息发往的会话 ID。不传则默认使用当前会话。' },
              platform: { type: 'string', description: '目标平台标识。不传则默认使用当前平台。' },
              content: { type: 'string', description: '届时发送给自己的指令/提示内容' },
            },
            required: ['name', 'content'],
          },
        },
      },
      handler: async (args, callCtx) => {
        const job: SchedulerJobConfig = {
          name: args.name as string,
          cron: args.cron as string | undefined,
          interval: args.interval as number | undefined,
          sessionId: (args.sessionId as string) || callCtx.sessionId,
          platform: (args.platform as string) || callCtx.platform || 'internal',
          content: args.content as string,
          enabled: true,
        };
        if (!job.cron && !job.interval) return JSON.stringify({ error: '必须指定 cron 或 interval' });
        if (runtimes.has(job.name)) return JSON.stringify({ error: `任务 "${job.name}" 已存在` });
        service.addJob(job);
        return JSON.stringify({
          ok: true,
          message: `任务 "${job.name}" 已创建，目标会话: ${job.sessionId} (${job.platform})`,
        });
      },
    });

    useToolService(ctx).register({
      groups: ['scheduler'],
      definition: {
        type: 'function',
        function: {
          name: 'scheduler_list_jobs',
          description:
            '列出计划任务及其状态，支持按名称关键词、启用状态过滤与分页。任务多时务必使用 keyword 或分页避免返回过多数据。',
          parameters: {
            type: 'object',
            properties: {
              keyword: { type: 'string', description: '可选：按任务名称子串模糊匹配（不区分大小写）' },
              status: {
                type: 'string',
                enum: ['enabled', 'disabled', 'paused', 'running', 'all'],
                description: '可选：按状态过滤，默认 all',
              },
              page: { type: 'number', description: '页码，从 1 开始，默认 1' },
              pageSize: { type: 'number', description: '每页条数，默认 30（可自行设定）' },
            },
          },
        },
      },
      handler: async args => {
        const all = service.getJobs().map(j => ({
          name: j.name,
          schedule: j.cron ?? `每 ${j.interval}s`,
          sessionId: j.sessionId,
          enabled: j.enabled,
          paused: j.paused,
          running: j.running,
          lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
          runCount: j.runCount,
        }));
        const keyword = typeof args.keyword === 'string' ? args.keyword.trim().toLowerCase() : '';
        const status = typeof args.status === 'string' ? args.status : 'all';
        const filtered = all.filter(j => {
          if (keyword && !j.name.toLowerCase().includes(keyword)) return false;
          if (status === 'enabled' && !j.enabled) return false;
          if (status === 'disabled' && j.enabled) return false;
          if (status === 'paused' && !j.paused) return false;
          if (status === 'running' && !j.running) return false;
          return true;
        });
        const page = Math.max(1, Math.floor(Number(args.page) || 1));
        const pageSize = Math.max(1, Math.floor(Number(args.pageSize) || 30));
        const matched = filtered.length;
        const totalPages = Math.max(1, Math.ceil(matched / pageSize));
        const curPage = Math.min(page, totalPages);
        const start = (curPage - 1) * pageSize;
        return JSON.stringify({
          total: all.length,
          matched,
          page: curPage,
          pageSize,
          totalPages,
          hasMore: curPage < totalPages,
          ...(keyword ? { keyword } : {}),
          ...(status !== 'all' ? { status } : {}),
          jobs: filtered.slice(start, start + pageSize),
        });
      },
    });

    useToolService(ctx).register({
      groups: ['scheduler'],
      definition: {
        type: 'function',
        function: {
          name: 'scheduler_remove_job',
          description: '删除一个计划任务。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要删除的任务名称' },
            },
            required: ['name'],
          },
        },
      },
      handler: async args => {
        const ok = service.removeJob(args.name as string);
        return JSON.stringify({ ok, message: ok ? '已删除' : '任务不存在' });
      },
    });

    useToolService(ctx).register({
      groups: ['scheduler'],
      definition: {
        type: 'function',
        function: {
          name: 'scheduler_pause_job',
          description: '暂停一个正在运行的计划任务。暂停后任务不会被触发，但保留配置，可随时恢复。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要暂停的任务名称' },
            },
            required: ['name'],
          },
        },
      },
      handler: async args => {
        const ok = service.pauseJob(args.name as string);
        return JSON.stringify({ ok, message: ok ? '已暂停' : '任务不存在' });
      },
    });

    useToolService(ctx).register({
      groups: ['scheduler'],
      definition: {
        type: 'function',
        function: {
          name: 'scheduler_resume_job',
          description: '恢复一个已暂停的计划任务。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要恢复的任务名称' },
            },
            required: ['name'],
          },
        },
      },
      handler: async args => {
        const ok = service.resumeJob(args.name as string);
        return JSON.stringify({ ok, message: ok ? '已恢复' : '任务不存在' });
      },
    });
  }

  // ── 清理 ──

  ctx.on('dispose', () => {
    for (const rt of runtimes.values()) {
      if (rt.timer) clearInterval(rt.timer);
    }
    runtimes.clear();
    if (cronInterval) clearInterval(cronInterval);
  });

  logger.info(`计划任务调度器已启动 (${config.jobs.length} 个任务, 最大并发 ${config.maxConcurrent})`);
}

// ──────────── 辅助函数 ────────────

function resolveConfig(raw: Record<string, unknown>): SchedulerConfig {
  const rawJobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  return {
    jobs: rawJobs.map((j: any) => ({
      name: String(j.name ?? 'unnamed'),
      cron: j.cron as string | undefined,
      interval: j.interval as number | undefined,
      sessionId: String(j.sessionId ?? `scheduler::${j.name ?? 'default'}`),
      platform: String(j.platform ?? 'internal'),
      content: String(j.content ?? ''),
      enabled: j.enabled !== false,
    })),
    maxConcurrent: (raw.maxConcurrent as number) ?? 3,
    persistPath: (raw.persistPath as string) ?? 'data/scheduler-jobs.json',
  };
}
