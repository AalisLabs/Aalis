import type { ConfigSchema, Context, PluginModule } from '@aalis/core';
import { parseEverySeconds, useCronEngine } from '@aalis/plugin-cron-engine-api';
import type { IncomingMessage } from '@aalis/plugin-message-api';
import { createStorageGateway, toStorageUri } from '@aalis/plugin-storage-api';
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
  /** cron 表达式 (5 段: 分 时 日 月 周)，支持快捷符 @hourly/@daily/@weekly/@monthly */
  cron?: string;
  /** 固定间隔秒数（与 cron 二选一），也可用 cron 的 "@every 30s" 形式表达 */
  interval?: number;
  /** 一次性任务：在该 ISO 时间执行一次，执行后自动 enabled=false。与 cron/interval 三选一。 */
  runAt?: string;
  /** 目标 sessionId（消息发往哪个会话） */
  sessionId: string;
  /** 目标平台标识 */
  platform: string;
  /**
   * 代理身份的 platform（authority 查表用），与 `platform` 解耦。
   * 由创建路径 snapshot 真实调用者身份；触发时回填到 IncomingMessage.actor.platform。
   * - WebUI/CLI/AI 调用工具创建：来自调用者 callCtx
   * - 静态 yaml jobs 缺省：webui（视作 owner 级，因为编辑配置文件本身就是 owner 行为）
   * - 老 dynamic jobs 缺省：webui（带启动 warning，便于审计）
   */
  actorPlatform?: string;
  /** 代理身份的 userId（authority 查表用）。规则同 actorPlatform，缺省 'console'。 */
  actorUserId?: string;
  /** 发送给 Agent 的消息内容 */
  content: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否处于暂停状态（运行时态，但需要随动态任务持久化，避免重启后自动恢复） */
  paused?: boolean;
  /**
   * cron 求值所用的 IANA 时区（如 `Asia/Shanghai`、`Europe/London`）。
   * 空串或未设 = 使用进程本地时区（与历史行为兼容）。仅对 cron 类任务生效；
   * interval/runAt 与时区无关（runAt 直接解析 ISO 字符串里自带的偏移）。
   */
  timeZone?: string;
}

interface SchedulerConfig {
  jobs: SchedulerJobConfig[];
  /** 动态任务持久化文件路径 */
  persistPath: string;
}

// ──────────── Cron 解析 ────────────
// 已迁移到 @aalis/plugin-cron-engine-api（normalizeCronExpr / parseEverySeconds / matchesCron）；
// scheduler 改为 inject 'cron-engine' 后调用 subscribe()/nextFireTime()。

// ──────────── 运行时状态 ────────────

interface JobRuntime {
  config: SchedulerJobConfig;
  /** 固定间隔 / 一次性 定时器 */
  timer: ReturnType<typeof setInterval> | null;
  /** cron 订阅 dispose（来自 cron-engine.subscribe） */
  cronDispose: (() => void) | null;
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
    runAt?: string;
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
  /** upsert：已存在则先 remove 再 add，用于 WebUI 表单"创建/编辑"统一入口 */
  setJob(job: SchedulerJobConfig): void;
  removeJob(name: string): boolean;
}

// ──────────── 插件元数据 ────────────

export const name = '@aalis/plugin-scheduler';
export const displayName = '定时任务';
export const subsystem = 'scheduler';

export const provides = ['scheduler'];

export const inject = {
  // 'tools' 必须先就绪，否则下方 register tool 全部静默丢失（optional 不参与拓扑排序）
  // 'cron-engine' 提供共享 cron tick 与表达式校验
  required: ['tools', 'cron-engine'],
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
        description: '任务消息的平台标识（如 internal、webui、onebot）。仅用于消息路由。',
        default: 'internal',
      },
      actorPlatform: {
        type: 'string',
        label: '执行身份-平台',
        description:
          '代理身份的 platform（与目标平台解耦）。authority 按 (actorPlatform, actorUserId) 联合裁决能力。留空 = webui。',
        default: 'webui',
      },
      actorUserId: {
        type: 'string',
        label: '执行身份-用户 ID',
        description: '代理身份的 userId。留空 = console（与 actorPlatform=webui 组合即 owner，拥有一切能力）。',
        default: 'console',
      },
      content: {
        type: 'string',
        label: '消息内容',
        required: true,
        description: '发送给 Agent 的指令/提示内容。',
      },
      enabled: { type: 'boolean', label: '启用', default: true },
      timeZone: {
        type: 'string',
        label: '时区 (IANA)',
        description: 'cron 求值所用时区，如 Asia/Shanghai、Europe/London。留空 = 进程本地时区。仅对 cron 类任务生效。',
      },
    },
    default: [],
  },
  persistPath: {
    type: 'string',
    label: '动态任务存储路径',
    default: 'data:/scheduler-jobs.json',
    description:
      '通过 AI 或 WebUI 创建的任务会持久化到此 storage URI，重启后自动加载。也兼容旧格式 “data/scheduler-jobs.json”。',
  },
};

export const defaultConfig = {
  jobs: [] as Record<string, unknown>[],
  persistPath: 'data:/scheduler-jobs.json',
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
      {
        type: 'form',
        label: '新建 / 编辑任务',
        source: 'newJobDraft',
        save: 'upsertJob',
        schema: {
          name: {
            type: 'string',
            label: '名称',
            required: true,
            description: '任务唯一标识；填已有动态任务名会覆盖（配置文件中的静态任务无法覆盖）',
          },
          cron: {
            type: 'string',
            label: 'Cron 表达式',
            description: '5 字段或别名：@hourly / @daily / @weekly / @every 30s；与 interval、runAt 三选一',
          },
          interval: { type: 'number', label: '固定间隔（秒）', description: '与 cron / runAt / delaySeconds 四选一' },
          runAt: {
            type: 'string',
            label: '一次性运行时间',
            description: 'ISO 字符串，如 2026-05-19T10:00:00；执行一次后自动删除',
          },
          delaySeconds: {
            type: 'number',
            label: 'X 秒后执行一次',
            description: '与 cron / interval / runAt 四选一；填写后会转换为 runAt = now + N 秒，执行一次后自动删除',
          },
          sessionId: { type: 'string', label: '目标会话 ID', required: true },
          platform: { type: 'string', label: '目标平台', default: 'internal' },
          content: { type: 'textarea', label: '消息内容', required: true, description: '届时发送给自己的指令/提示' },
          enabled: { type: 'boolean', label: '启用', default: true },
          paused: {
            type: 'boolean',
            label: '创建后立即暂停',
            default: false,
            description: '勾选后任务创建但不会自动运行，需手动「恢复」',
          },
        },
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
        schedule: j.cron ?? (j.interval ? `每 ${j.interval}s` : j.runAt ? `一次性@${j.runAt}` : '未设置'),
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
  async newJobDraft() {
    return {
      name: '',
      cron: '',
      interval: 0,
      runAt: '',
      delaySeconds: 0,
      sessionId: '',
      platform: 'internal',
      content: '',
      enabled: true,
      paused: false,
    };
  },
  async upsertJob(ctx, args, caller) {
    const svc = ctx.getService<SchedulerService>('scheduler');
    if (!svc) return { ok: false, error: 'scheduler 服务未就绪' };
    const name = String(args.name ?? '').trim();
    if (!name) return { ok: false, error: '任务名称不能为空' };
    const cron = String(args.cron ?? '').trim() || undefined;
    const interval = Number(args.interval) > 0 ? Number(args.interval) : undefined;
    const runAt = String(args.runAt ?? '').trim() || undefined;
    if (!cron && !interval && !runAt) {
      return { ok: false, error: 'cron / interval / runAt 必须填写其中之一' };
    }
    const sessionId = String(args.sessionId ?? '').trim();
    if (!sessionId) return { ok: false, error: 'sessionId 不能为空' };
    const content = String(args.content ?? '').trim();
    if (!content) return { ok: false, error: 'content 不能为空' };
    try {
      // actor 从权限闸放行后的 caller 快照（登录账户或单 token 模式的 webui:console），
      // 不从 args 读取，避免 WebUI 调用方伪造他人身份。
      const actor = caller ?? { platform: 'webui', userId: 'console' };
      svc.setJob({
        name,
        cron,
        interval,
        runAt,
        sessionId,
        platform: String(args.platform ?? 'internal'),
        actorPlatform: actor.platform,
        actorUserId: actor.userId,
        content,
        enabled: args.enabled !== false,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

// ──────────── 插件入口 ────────────

export async function apply(ctx: Context, rawConfig: Record<string, unknown>): Promise<void> {
  const config = resolveConfig(rawConfig);
  const logger = ctx.logger.child('scheduler');
  const cronEngine = useCronEngine(ctx);

  // 注册 WebUI 页面
  const webui = useWebuiService(ctx);
  for (const page of webuiPages) webui.registerPage(page);

  const runtimes = new Map<string, JobRuntime>();

  // 配置中定义的任务名称集合（不需要持久化）
  const configJobNames = new Set(config.jobs.map(j => j.name));
  // 动态任务集合（需要持久化）
  const dynamicJobs = new Map<string, SchedulerJobConfig>();

  // ── 持久化读写 （经 storage 抽象，默认 data:/scheduler-jobs.json） ──

  const storage = createStorageGateway(ctx);
  const persistUri = toStorageUri(config.persistPath);

  async function loadDynamicJobs(): Promise<SchedulerJobConfig[]> {
    try {
      let raw: string;
      try {
        raw = (await storage.readFile(persistUri, 'utf-8')) as string;
      } catch {
        return [];
      }
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return [];
      // biome-ignore lint/suspicious/noExplicitAny: 从 JSON 文件反序列化的原始字段，手动校验转型
      return data.map((j: any) => {
        const hasActor =
          typeof j.actorPlatform === 'string' &&
          j.actorPlatform.trim().length > 0 &&
          typeof j.actorUserId === 'string' &&
          j.actorUserId.trim().length > 0;
        if (!hasActor) {
          // 兼容老的持久化 jobs（升级前没有 actor 字段）：默认 webui:console（owner 级）。
          // 与 WebUI 新建任务默认值一致，因为这些 dynamic jobs 历史上都是从 WebUI 创建的。
          logger.warn(
            `持久化任务 "${j.name}" 缺少 actor 身份，已补全为 webui:console；如需限制权限请在 WebUI 中显式修改`,
          );
        }
        return {
          name: String(j.name ?? 'unnamed'),
          cron: j.cron as string | undefined,
          interval: j.interval as number | undefined,
          runAt: j.runAt as string | undefined,
          sessionId: String(j.sessionId ?? 'internal'),
          platform: String(j.platform ?? 'internal'),
          actorPlatform: hasActor ? String(j.actorPlatform).trim() : 'webui',
          actorUserId: hasActor ? String(j.actorUserId).trim() : 'console',
          content: String(j.content ?? ''),
          enabled: j.enabled !== false,
          paused: j.paused === true,
        };
      });
    } catch (err) {
      logger.warn(`加载持久化任务失败: ${err}`);
      return [];
    }
  }

  /**
   * 串行化下发 storage.writeFile（fire-and-forget）：
   * - SchedulerService 接口保留同步语义，调用方不需 await；
   * - 使用 chain 串行避免并发写产生中间态；
   * - storage.writeFile 会自动 mkdir 父目录。
   */
  let saveChain: Promise<void> = Promise.resolve();
  function saveDynamicJobs(): void {
    const jobs = [...dynamicJobs.values()];
    const payload = JSON.stringify(jobs, null, 2);
    saveChain = saveChain
      .then(() => storage.writeFile(persistUri, payload))
      .then(
        () => {
          logger.debug(`已持久化 ${jobs.length} 个动态任务`);
        },
        err => {
          logger.warn(`持久化任务失败: ${err}`);
        },
      );
  }

  // ── 发送调度消息 ──

  async function executeJob(rt: JobRuntime): Promise<void> {
    if (rt.running) return;

    rt.running = true;
    const jobName = rt.config.name;

    try {
      logger.info(`执行任务: ${jobName}`);
      await ctx.emit('scheduler:job:start', jobName);

      // 通用触发事件：供 workflow 等订阅者使用
      // （即使本任务用的是旧版 inbound:message，也同时广播 trigger:fired，
      //  便于平滑迁移到 plugin-workflow）
      // biome-ignore lint/suspicious/noExplicitAny: 事件类型由 plugin-workflow-api 增广，scheduler 不直接依赖
      await ctx.emit('trigger:fired' as any, {
        source: `scheduler:${jobName}`,
        type: rt.config.cron ? 'cron' : 'interval',
        payload: {
          jobName,
          sessionId: rt.config.sessionId,
          platform: rt.config.platform,
          content: rt.config.content,
        },
      });

      const message: IncomingMessage = {
        content: rt.config.content,
        sessionId: rt.config.sessionId,
        platform: rt.config.platform,
        source: 'scheduler',
      };
      // 注入代理身份：authority 守卫优先读 actor 而非 platform/userId，
      // 从而让 scheduler 触发的 AI 走创建者的权限等级（而非匿名 defaultAuthority）。
      // actorPlatform/actorUserId 在 setJob 时已固化为创建者身份，AI 无法绕过。
      if (rt.config.actorPlatform && rt.config.actorUserId) {
        message.actor = { platform: rt.config.actorPlatform, userId: rt.config.actorUserId };
      }

      await ctx.emit('inbound:message', message);

      rt.lastRun = Date.now();
      rt.runCount++;
      rt.lastResult = '成功';
      await ctx.emit('scheduler:job:done', jobName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rt.lastResult = `失败: ${msg}`;
      logger.error(`任务 "${jobName}" 执行失败: ${msg}`);
      await ctx.emit('scheduler:job:error', jobName, msg);
    } finally {
      rt.running = false;
    }
  }

  // ── 估算下次执行时间 ──

  function estimateNextRun(job: SchedulerJobConfig, lastRun: number): number {
    if (job.runAt) {
      const ms = Date.parse(job.runAt);
      return Number.isFinite(ms) ? ms : 0;
    }
    if (job.interval) {
      return (lastRun || Date.now()) + job.interval * 1000;
    }
    if (job.cron) {
      const tz = job.timeZone?.trim() || undefined;
      return cronEngine.nextFireTime(job.cron, new Date(), undefined, tz ? { timeZone: tz } : undefined) ?? 0;
    }
    return 0;
  }

  // ── 初始化所有任务 ──

  function initJob(jobCfg: SchedulerJobConfig): void {
    if (runtimes.has(jobCfg.name)) return;

    // 归一化 cron 快捷符；"@every Ns" 转成 interval 通道
    if (jobCfg.cron) {
      const everySec = parseEverySeconds(jobCfg.cron);
      if (everySec > 0) {
        jobCfg.interval = everySec;
        jobCfg.cron = undefined;
      }
      // 5 字段 cron 与别名（如 @daily）都直接交给 cron-engine.subscribe 处理，不必预先 normalize
    }

    const rt: JobRuntime = {
      config: jobCfg,
      timer: null,
      cronDispose: null,
      lastRun: 0,
      nextRun: estimateNextRun(jobCfg, 0),
      running: false,
      runCount: 0,
      lastResult: '',
      // 优先采用持久化的 paused 字段；若未设置则回落到 enabled 状态（禁用即视作暂停）
      paused: jobCfg.paused === true || !jobCfg.enabled,
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

    // cron 任务：订阅到共享 cron-engine
    if (jobCfg.cron && jobCfg.enabled) {
      try {
        const tz = jobCfg.timeZone?.trim() || undefined;
        rt.cronDispose = cronEngine.subscribe(
          jobCfg.cron,
          () => {
            if (rt.paused || !rt.config.enabled) return;
            executeJob(rt);
            rt.nextRun = estimateNextRun(rt.config, rt.lastRun);
          },
          tz ? { timeZone: tz } : undefined,
        );
      } catch (err) {
        logger.warn(`任务 ${jobCfg.name} cron 订阅失败: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 一次性任务：到点用 setTimeout 触发一次，执行完 disable 并持久化
    if (jobCfg.runAt && jobCfg.enabled) {
      const targetMs = Date.parse(jobCfg.runAt);
      if (Number.isFinite(targetMs)) {
        const delay = targetMs - Date.now();
        if (delay <= 0) {
          // 已过期：立即执行一次，然后 disable
          setImmediate(() => {
            executeJob(rt).finally(() => disableOneShot(rt));
          });
        } else {
          rt.timer = setTimeout(() => {
            if (!rt.paused) {
              executeJob(rt).finally(() => disableOneShot(rt));
            }
          }, delay) as unknown as ReturnType<typeof setInterval>;
        }
      } else {
        logger.warn(`任务 ${jobCfg.name} 的 runAt 无法解析: ${jobCfg.runAt}`);
      }
    }

    runtimes.set(jobCfg.name, rt);
    const scheduleHint = jobCfg.cron
      ? `(cron: ${jobCfg.cron})`
      : jobCfg.interval
        ? `(interval: ${jobCfg.interval}s)`
        : jobCfg.runAt
          ? `(runAt: ${jobCfg.runAt})`
          : '(no schedule)';
    logger.info(`任务已注册: ${jobCfg.name} ${scheduleHint}`);
  }

  /** 一次性任务执行完后的清理：动态任务直接删除；静态 yaml 任务仅标记 enabled=false */
  function disableOneShot(rt: JobRuntime): void {
    const jobName = rt.config.name;
    if (dynamicJobs.has(jobName)) {
      if (rt.timer) clearTimeout(rt.timer as unknown as ReturnType<typeof setTimeout>);
      if (rt.cronDispose) rt.cronDispose();
      runtimes.delete(jobName);
      dynamicJobs.delete(jobName);
      saveDynamicJobs();
      logger.info(`一次性任务已执行完毕并删除: ${jobName}`);
      return;
    }
    // 静态配置任务：不删，仅标记 enabled=false（yaml 才是权威源）
    rt.config.enabled = false;
    rt.paused = true;
    logger.info(`一次性任务已执行完毕并停用（静态）: ${jobName}`);
  }

  for (const job of config.jobs) {
    initJob(job);
  }

  // 加载持久化的动态任务
  const persisted = await loadDynamicJobs();
  for (const job of persisted) {
    if (!runtimes.has(job.name)) {
      dynamicJobs.set(job.name, job);
      initJob(job);
    }
  }
  if (persisted.length > 0) {
    logger.info(`已加载 ${persisted.length} 个持久化任务`);
  }

  // ── 注册 scheduler 服务 ──

  const service: SchedulerService = {
    getJobs() {
      return [...runtimes.values()].map(rt => ({
        name: rt.config.name,
        cron: rt.config.cron,
        interval: rt.config.interval,
        runAt: rt.config.runAt,
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
      rt.config.paused = true;
      if (dynamicJobs.has(jobName)) {
        dynamicJobs.set(jobName, { ...rt.config });
        saveDynamicJobs();
      }
      logger.info(`任务已暂停: ${jobName}`);
      return true;
    },
    resumeJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      rt.paused = false;
      rt.config.paused = false;
      rt.nextRun = estimateNextRun(rt.config, rt.lastRun);
      if (dynamicJobs.has(jobName)) {
        dynamicJobs.set(jobName, { ...rt.config });
        saveDynamicJobs();
      }
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
    setJob(job) {
      // upsert：先 remove 再 add；命中 config 静态任务时不允许覆盖
      if (configJobNames.has(job.name)) {
        throw new Error(`任务 "${job.name}" 来自配置文件，无法通过 setJob 覆盖`);
      }
      const existed = runtimes.get(job.name);
      if (existed) {
        if (existed.timer) clearInterval(existed.timer);
        if (existed.cronDispose) existed.cronDispose();
        runtimes.delete(job.name);
      }
      initJob(job);
      dynamicJobs.set(job.name, job);
      saveDynamicJobs();
    },
    removeJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      if (rt.timer) clearInterval(rt.timer);
      if (rt.cronDispose) rt.cronDispose();
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
  // tools 已在 inject.required 中声明，必然就绪
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
          '创建一个新的定时/周期/一次性自主行动计划。务必按"用户意图"选择参数：\n' +
          '  • interval=N → 每 N 秒重复执行（循环任务，不会自动停）；\n' +
          '  • delaySeconds=N → N 秒后执行一次后自动停止（"X 分钟后提醒我"用这个）；\n' +
          '  • runAt="2026-05-19T15:46:44+08:00" → 指定 ISO 时间执行一次后停止；\n' +
          '  • cron="0 9 * * *" → 按 cron 周期重复（每天 9 点之类）。\n' +
          '四者互斥、必须恰好提供一个。不传 sessionId 和 platform 时，默认使用当前会话。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '任务名称（唯一标识）' },
            cron: {
              type: 'string',
              description: 'Cron 表达式 (分 时 日 月 周)，如 "0 9 * * *" 表示每天9点。循环任务。',
            },
            interval: {
              type: 'number',
              description: '固定间隔秒数，到点重复触发（循环任务，永不停）。要"X 秒后只提醒一次"请用 delaySeconds。',
            },
            delaySeconds: {
              type: 'number',
              description:
                '相对延迟秒数：从现在起 N 秒后执行一次，执行后自动停止。最适合"X 分钟/秒后提醒我"这类自然语言诉求。',
            },
            runAt: {
              type: 'string',
              description: 'ISO 8601 绝对时间，到点执行一次后自动停止。例："2026-05-19T15:46:44+08:00"。',
            },
            sessionId: { type: 'string', description: '任务消息发往的会话 ID。不传则默认使用当前会话。' },
            platform: { type: 'string', description: '目标平台标识。不传则默认使用当前平台。' },
            content: { type: 'string', description: '届时发送给自己的指令/提示内容' },
          },
          required: ['name', 'content'],
        },
      },
    },
    handler: async (args, callCtx) => {
      // 互斥校验：cron / interval / delaySeconds / runAt 必须恰好提供一个
      const hasCron = typeof args.cron === 'string' && args.cron.trim().length > 0;
      const hasInterval = typeof args.interval === 'number' && args.interval > 0;
      const hasDelay = typeof args.delaySeconds === 'number' && args.delaySeconds > 0;
      const hasRunAt = typeof args.runAt === 'string' && args.runAt.trim().length > 0;
      const provided = [hasCron, hasInterval, hasDelay, hasRunAt].filter(Boolean).length;
      if (provided === 0) {
        return JSON.stringify({ error: '必须指定 cron / interval / delaySeconds / runAt 其中之一' });
      }
      if (provided > 1) {
        return JSON.stringify({ error: 'cron / interval / delaySeconds / runAt 互斥，只能提供一个' });
      }
      // delaySeconds → runAt 转换
      let runAt = hasRunAt ? (args.runAt as string).trim() : undefined;
      if (hasDelay) {
        runAt = new Date(Date.now() + Math.floor(args.delaySeconds as number) * 1000).toISOString();
      }
      const job: SchedulerJobConfig = {
        name: args.name as string,
        cron: hasCron ? (args.cron as string).trim() : undefined,
        interval: hasInterval ? (args.interval as number) : undefined,
        runAt,
        sessionId: (args.sessionId as string) || callCtx.sessionId,
        platform: (args.platform as string) || callCtx.platform || 'internal',
        // 安全关键：actor 强制从 callCtx snapshot，不从 args 读取。
        // 这样即使 LLM 在 prompt 中尝试伪造身份，也会被忽略——它只能以当前调用者的身份创建任务。
        // callCtx.userId 可能为 undefined（如父任务也是匿名触发），此时子任务也匿名（defaultAuthority），
        // 实现权限的自然传递与不可提升。
        actorPlatform: callCtx.platform,
        actorUserId: callCtx.userId,
        content: args.content as string,
        enabled: true,
      };
      if (runtimes.has(job.name)) return JSON.stringify({ error: `任务 "${job.name}" 已存在` });
      service.addJob(job);
      const scheduleDesc = job.cron
        ? `cron="${job.cron}"`
        : job.interval
          ? `每 ${job.interval}s 重复`
          : job.runAt
            ? `一次性 @ ${job.runAt}`
            : '?';
      return JSON.stringify({
        ok: true,
        message: `任务 "${job.name}" 已创建 (${scheduleDesc})，目标会话: ${job.sessionId} (${job.platform})`,
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
          '列出计划任务及其状态，支持按名称关键词、启用状态过滤与分页。任务多时务必使用 keyword 或翻页（offset+limit）避免返回过多数据。翻页：下次调用传 offset = 上次 offset + limit，直到返回的 has_more=false。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '可选：按任务名称子串模糊匹配（不区分大小写）' },
            status: {
              type: 'string',
              enum: ['enabled', 'disabled', 'paused', 'running', 'all'],
              description: '可选：按状态过滤，默认 all',
            },
            limit: { type: 'number', description: '本页最多返回条数，默认 30' },
            offset: { type: 'number', description: '跳过前 N 条用于翻页，默认 0' },
          },
        },
      },
    },
    handler: async args => {
      const all = service.getJobs().map(j => ({
        name: j.name,
        schedule: j.cron ?? (j.interval ? `每 ${j.interval}s` : j.runAt ? `一次性@${j.runAt}` : '未设置'),
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
      const limit = Math.max(1, Math.floor(Number(args.limit) || 30));
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
      const matched = filtered.length;
      const jobs = filtered.slice(offset, offset + limit);
      return JSON.stringify({
        total: all.length,
        matched,
        limit,
        offset,
        returned: jobs.length,
        has_more: offset + jobs.length < matched,
        ...(keyword ? { keyword } : {}),
        ...(status !== 'all' ? { status } : {}),
        jobs,
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

  // ── 清理 ──

  ctx.onDispose(() => {
    for (const rt of runtimes.values()) {
      if (rt.timer) clearInterval(rt.timer);
      if (rt.cronDispose) rt.cronDispose();
    }
    runtimes.clear();
  });

  logger.info(`计划任务调度器已启动 (${config.jobs.length} 个任务)`);
}

// ──────────── 辅助函数 ────────────

export function resolveConfig(raw: Record<string, unknown>): SchedulerConfig {
  const rawJobs = Array.isArray(raw.jobs) ? raw.jobs : [];
  return {
    // biome-ignore lint/suspicious/noExplicitAny: 从 YAML 反序列化的原始字段，手动校验转型
    jobs: rawJobs.map((j: any) => ({
      name: String(j.name ?? 'unnamed'),
      cron: j.cron as string | undefined,
      interval: j.interval as number | undefined,
      // schema 声明的这些字段此前在映射时被丢弃 → runAt 一次性任务不调度、timeZone 失效、
      // 静态任务无法降权（被强制按默认 owner 身份跑）。透传回来，默认值在触发时回填。
      runAt: j.runAt as string | undefined,
      sessionId: String(j.sessionId ?? `scheduler::${j.name ?? 'default'}`),
      platform: String(j.platform ?? 'internal'),
      actorPlatform: j.actorPlatform as string | undefined,
      actorUserId: j.actorUserId as string | undefined,
      timeZone: j.timeZone as string | undefined,
      content: String(j.content ?? ''),
      enabled: j.enabled !== false,
    })),
    persistPath: (raw.persistPath as string) ?? 'data:/scheduler-jobs.json',
  };
}

// ----- 服务类型注册（declaration merging）-----
declare module '@aalis/core' {
  interface ServiceTypeMap {
    scheduler: SchedulerService;
  }
  interface AalisEvents {
    /** 任务开始执行 */
    'scheduler:job:start': [jobName: string];
    /** 任务执行成功 */
    'scheduler:job:done': [jobName: string];
    /** 任务执行失败 */
    'scheduler:job:error': [jobName: string, message: string];
  }
}
