import { cronEngine } from '@aalis/api-cron-engine';
import { rootSessionOf, sessionManager } from '@aalis/api-session-manager';
import { isStorageNotFound, isStorageUri, storage } from '@aalis/api-storage';
import { actingIdentity, tools } from '@aalis/api-tools';
import { type NoticeHandle, type PageContext, webuiServer } from '@aalis/api-webui';
import {
  type BoundOf,
  config,
  definePlugin,
  defineService,
  events,
  lifecycle,
  logger,
  optional,
  provide,
} from '@aalis/core';
import { type ConfigOf, configError, defineConfig, parseConfig } from '@aalis/schema-config';
import { TextError, type TextRef, textClauses, textOf, toSource } from '@aalis/schema-i18n';
import type { IncomingMessage } from '@aalis/schema-message';
import { parseEverySeconds, validateIntervalSeconds } from '@aalis/util-cron';
import { t } from './texts.js';

// ════════════════════════════════════════════════════════════
// plugin-scheduler — 让 AI 从"被动"变"主动"
//
// 支持三种调度方式：cron 表达式、固定间隔，以及 runAt 指定时刻执行一次。
// 每个任务向指定 session 发送 inbound:message 事件，
// source='scheduler' 使其跳过触发策略、不受回复后冷却（禁言与限速照样生效），在 agent 里单独成一轮、排在在跑的一轮之后。
// ════════════════════════════════════════════════════════════

// ──────────── 配置类型 ────────────

interface SchedulerJobConfig {
  name: string;
  /** cron 表达式 (5 段: 分 时 日 月 周)，支持快捷符 @hourly/@daily/@weekly/@monthly */
  cron?: string;
  /** 固定间隔秒数（与 cron / runAt 互斥），也可用 cron 的 "@every 30s" 形式表达 */
  interval?: number;
  /**
   * 一次性任务：在该 ISO 时间执行一次，执行后自动 enabled=false。
   * 与 cron / interval 互斥（入口还接受 delaySeconds，会换算成本字段）。
   */
  runAt?: string;
  /** 目标 sessionId（消息发往哪个会话） */
  sessionId: string;
  /** 目标平台标识 */
  platform: string;
  /**
   * 代理身份的 platform（authority 查表用），与 `platform` 解耦。
   * 由创建路径 snapshot 真实调用者身份；触发时回填到 IncomingMessage.actor.platform。
   * - WebUI/CLI/AI 调用工具创建：来自调用者 callCtx，**调用者匿名则留空**
   * - 静态 yaml jobs：与 actorUserId 成对填写；都不写为 webui:console（owner 级，因为编辑配置文件本身就是 owner 行为）；
   *   只写一项是配置错误，这条任务不载入
   * - 老 dynamic jobs 缺省：**留空 = 匿名**（带启动 warning，便于审计）
   *
   * 留空即匿名（defaultAuthority）。触发路径不会为空值发明身份——owner 只能来自显式来源。
   */
  actorPlatform?: string;
  /** 代理身份的 userId（authority 查表用）。规则同 actorPlatform，留空即匿名。 */
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
// 解析在 @aalis/util-cron（parseEverySeconds 等）；
// scheduler 声明 cronEngine 后调用 subscribe()/nextFireTime()。

/** setTimeout 的 delay 上限（32 位有符号毫秒，约 24.8 天）；超过即溢出成立即触发 */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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
  /** 最近执行结果：还没执行过时为空串 */
  lastResult: string | TextRef;
  /** 是否暂停（运行时可临时暂停，不改配置） */
  paused: boolean;
}

// ──────────── 调度器服务接口 ────────────

/** 任务触发时的消息声明 ownerApproved，内容里的指令照常执行：经 addJob、setJob 交来的内容要是 owner 过目过原文的 */
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
    /** 最近执行结果，给人看：可以是文字对象（@aalis/schema-i18n），还没执行过时为空串 */
    lastResult: string | TextRef;
  }>;
  pauseJob(name: string): boolean;
  resumeJob(name: string): boolean;
  triggerJob(name: string): Promise<boolean>;
  /** 名字是配置文件里写了的、cron 或固定间隔无效时抛出原因，不收下 */
  addJob(job: SchedulerJobConfig): void;
  /**
   * upsert：已存在则先 remove 再 add；计划任务页的新建与编辑都经它。名字是配置文件里写了的、cron 或固定间隔无效时抛出原因，
   * 原任务不变
   */
  setJob(job: SchedulerJobConfig): void;
  removeJob(name: string): boolean;
}

// ----- 服务描述符（调用型：业务层就是提供者的形状）-----
export const scheduler = defineService<SchedulerService>('scheduler');

// ──────────── 插件元数据 ────────────

export const configSchema = defineConfig({
  jobs: {
    type: 'array',
    onInvalid: 'error',
    label: t('jobsLabel'),
    description: t('jobsDescription'),
    items: {
      name: { type: 'string', label: t('jobNameLabel') },
      cron: {
        type: 'string',
        label: t('cronLabel'),
        description: t('cronDescription'),
      },
      interval: {
        type: 'number',
        label: t('intervalLabel'),
        description: t('intervalDescription'),
      },
      runAt: {
        type: 'string',
        label: t('runAtLabel'),
        description: t('runAtDescription'),
      },
      sessionId: {
        type: 'string',
        label: t('sessionIdLabel'),
        description: t('sessionIdDescription'),
      },
      platform: {
        type: 'string',
        onInvalid: 'error',
        label: t('platformLabel'),
        required: true,
        description: t('platformDescription'),
        default: 'internal',
      },
      actorPlatform: {
        type: 'string',
        onInvalid: 'error',
        label: t('actorPlatformLabel'),
        description: t('actorPlatformDescription'),
      },
      actorUserId: {
        type: 'string',
        onInvalid: 'error',
        label: t('actorUserIdLabel'),
        description: t('actorUserIdDescription'),
      },
      content: {
        type: 'string',
        label: t('contentLabel'),
        default: '',
        description: t('contentDescription'),
      },
      enabled: { type: 'boolean', label: t('enabledLabel'), default: true, onInvalid: 'error' },
      timeZone: {
        type: 'string',
        label: t('timeZoneLabel'),
        description: t('timeZoneDescription'),
      },
    },
    default: [],
  },
  persistPath: {
    type: 'string',
    onInvalid: 'error',
    label: t('persistPathLabel'),
    default: 'data:/scheduler-jobs.json',
    description: t('persistPathDescription'),
  },
});

// ──────────── WebUI 页面 ────────────

/** 新建与编辑共用的输入：调度方式（四选一）、目标会话与内容。新建另收任务名，编辑的任务名取这一行 */
const JOB_FIELDS = defineConfig({
  cron: {
    type: 'string',
    label: t('cronLabel'),
    description: t('fieldCronDescription'),
  },
  interval: { type: 'number', label: t('fieldIntervalLabel'), description: t('fieldIntervalDescription') },
  runAt: {
    type: 'string',
    label: t('runAtLabel'),
    description: t('fieldRunAtDescription'),
  },
  delaySeconds: {
    type: 'number',
    label: t('delaySecondsLabel'),
    description: t('delaySecondsDescription'),
  },
  sessionId: { type: 'string', label: t('sessionIdLabel'), required: true },
  platform: { type: 'string', label: t('platformLabel'), default: 'internal' },
  content: { type: 'textarea', label: t('contentLabel'), required: true, description: t('fieldContentDescription') },
  enabled: { type: 'boolean', label: t('enabledLabel'), default: true },
  paused: {
    type: 'boolean',
    label: t('paused'),
    default: false,
    description: t('pausedDescription'),
  },
});
type JobInput = ConfigOf<typeof JOB_FIELDS>;

/** 单个会话最多几个计划任务（防资源耗尽）；编辑已有任务不计入 */
const MAX_JOBS_PER_SESSION = 20;

// ──────────── 插件入口 ────────────

const uses = {
  // tools 必须先就绪，否则下方 register tool 全部静默丢失（optional 不参与激活闸）
  tools,
  // 共享 cron tick 与表达式校验
  cronEngine,
  /** 动态任务的持久化出口；没有 storage 时任务只活在本次激活里（读写各自降级） */
  storage: optional(storage),
  /** 计划任务页的登记口；无 WebUI 时调度照常运行 */
  webui: optional(webuiServer),
  /** 认调用所在的会话是不是子会话（在子会话里建任务要写明目标）；没有会话管理就没有子会话 */
  sessionManager: optional(sessionManager),
  events,
  lifecycle,
  logger,
  config,
  provide,
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-scheduler',
  displayName: t('displayName'),
  subsystem: 'scheduler',
  extends: {
    events: ['scheduler:job:start', 'scheduler:job:done', 'scheduler:job:error'],
  },
  configSchema,
  provides: [scheduler],
  uses,
  apply: run,
});

async function run(caps: Caps): Promise<void> {
  const cfg = parseConfig(configSchema, caps.config.use, caps.logger.use);
  const { cronEngine, storage, webui, sessionManager, events, lifecycle, logger, provide, tools } = caps;
  const config = resolveConfig(cfg);

  const runtimes = new Map<string, JobRuntime>();

  // 配置中定义的任务名称集合（不需要持久化）
  const configJobNames = new Set(config.jobs.map(j => j.name));
  // 动态任务集合（需要持久化）
  const dynamicJobs = new Map<string, SchedulerJobConfig>();

  // ── 持久化读写 （经 storage 抽象，默认 data:/scheduler-jobs.json） ──

  const persistUri = config.persistPath;
  /**
   * 激活时那次读失败了、又不是「文件不存在」（storage 不在场、读错误、解析失败、结构不对）：写的是整表，
   * 此后一律拒写，否则下一次增删改就把原有动态任务冲掉。只在激活时读一次，storage 迟到也不重读。
   */
  let loadFailed = false;
  /**
   * 拒写期间新建或改动的任务只在内存、重启即失：回执末尾如实注明（AI 工具与计划任务页同一附注，工具取原文），
   * 文件正常时没有
   */
  const persistNote = (): TextRef | undefined => (loadFailed ? t('notPersisted', { uri: persistUri }) : undefined);

  // 先读完持久化任务再登记页面：登记之后到服务就绪之间不再有等待，页面一出现取数与动作就可用
  const persisted = await loadDynamicJobs();

  // ── 计划任务页：动作是本次激活的闭包，直接操作本插件自己的调度表；登记随激活撤回 ──

  /**
   * 新建与编辑共用：调度方式恰好一个（四者是互不相容的定时语义，多填时取哪个都是猜），与 scheduler_create_job
   * 工具路径同一条判据与同一份 delaySeconds 换算。actor 取闸门放行后的调用者，不从输入读，免得伪造他人身份
   */
  function saveJob(name: string, input: JobInput, caller: PageContext['caller'], creating: boolean): TextRef {
    const cron = input.cron?.trim() || undefined;
    const interval = input.interval !== undefined && input.interval > 0 ? input.interval : undefined;
    const delaySeconds =
      input.delaySeconds !== undefined && input.delaySeconds > 0 ? Math.floor(input.delaySeconds) : undefined;
    const rawRunAt = input.runAt?.trim() || undefined;
    const provided = [cron, interval, delaySeconds, rawRunAt].filter(v => v !== undefined).length;
    if (provided === 0) throw new TextError(t('scheduleMissing'));
    if (provided > 1) throw new TextError(t('scheduleConflict'));
    const runAt = delaySeconds !== undefined ? new Date(Date.now() + delaySeconds * 1000).toISOString() : rawRunAt;
    // 一次性任务被暂停时到点的定时器直接跳过，之后既不重排也不自删，任务就永久卡死在那里
    if (input.paused && runAt) throw new TextError(t('pauseOneShot'));
    // 防误填高频任务：挡住 interval:0.5 这类会占满调度的间隔
    if (interval !== undefined && interval < 5) throw new TextError(t('intervalTooShort'));
    const sessionId = input.sessionId.trim();
    if (!sessionId) throw new TextError(t('sessionIdEmpty'));
    const content = input.content.trim();
    if (!content) throw new TextError(t('contentEmpty'));
    if (creating) {
      const all = service.getJobs();
      if (all.some(j => j.name === name)) throw new TextError(t('duplicateName', { name }));
      if (all.filter(j => j.sessionId === sessionId).length >= MAX_JOBS_PER_SESSION) {
        throw new TextError(t('tooManyJobs', { max: MAX_JOBS_PER_SESSION }));
      }
    }
    service.setJob({
      name,
      cron,
      interval,
      runAt,
      sessionId,
      platform: input.platform,
      actorPlatform: caller.platform,
      actorUserId: caller.userId,
      content,
      enabled: input.enabled,
      paused: input.paused,
    });
    const note = persistNote();
    return note ? textClauses([t('jobSaved', { name }), note]) : t('jobSaved', { name });
  }

  const jobsPage = webui.use.definePage({
    key: 'scheduler',
    title: t('pageTitle'),
    icon: 'clock',
    actions: {
      createJob: {
        label: t('create'),
        effect: 'write',
        input: {
          name: { type: 'string', label: t('name'), required: true, description: t('nameDescription') },
          ...JOB_FIELDS,
        },
        handler({ input, ctx }) {
          const name = input.name.trim();
          if (!name) throw new TextError(t('nameEmpty'));
          return saveJob(name, input, ctx.caller, true);
        },
      },
      editJob: {
        label: t('edit'),
        effect: 'write',
        row: true,
        input: JOB_FIELDS,
        handler({ rowKey, input, ctx }) {
          if (!service.getJobs().some(j => j.name === rowKey)) throw new TextError(t('jobMissing', { name: rowKey }));
          return saveJob(rowKey, input, ctx.caller, false);
        },
      },
      triggerJob: {
        label: t('triggerNow'),
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          // 这一轮还没执行完时 triggerJob 直接跳过；与它置 running 在同一个同步段里判，没有竞态
          if (service.getJobs().find(j => j.name === rowKey)?.running) {
            throw new TextError(t('jobRunning', { name: rowKey }));
          }
          if (!(await service.triggerJob(rowKey))) throw new TextError(t('jobMissing', { name: rowKey }));
          return t('triggered', { name: rowKey });
        },
      },
      pauseJob: {
        label: t('pause'),
        effect: 'write',
        row: true,
        handler({ rowKey }) {
          if (!service.pauseJob(rowKey)) throw new TextError(t('cannotPause'));
          return t('pausedReceipt', { name: rowKey });
        },
      },
      resumeJob: {
        label: t('resume'),
        effect: 'write',
        row: true,
        handler({ rowKey }) {
          if (!service.resumeJob(rowKey)) throw new TextError(t('jobMissing', { name: rowKey }));
          return t('resumed', { name: rowKey });
        },
      },
      removeJob: {
        label: t('delete'),
        effect: 'destructive',
        confirm: t('deleteConfirm'),
        row: true,
        handler({ rowKey }) {
          if (!service.removeJob(rowKey)) throw new TextError(t('jobMissing', { name: rowKey }));
          return t('deleted', { name: rowKey });
        },
      },
    },
    content: [
      {
        type: 'table',
        id: 'jobs',
        rowKey: 'name',
        empty: t('noJobs'),
        columns: [
          { key: 'name', label: t('name'), primary: true },
          { key: 'schedule', label: t('schedule') },
          { key: 'sessionId', label: t('target') },
          { key: 'status', label: t('status'), kind: 'status', primary: true },
          { key: 'nextRun', label: t('nextRun'), kind: 'countdown' },
          { key: 'lastRun', label: t('lastRun'), kind: 'time' },
          { key: 'runCount', label: t('runCount') },
          { key: 'lastResult', label: t('lastResult'), kind: 'long-text' },
        ],
        rowActions: [
          { action: 'triggerJob' },
          { action: 'pauseJob', visibleWhen: 'pausable' },
          { action: 'resumeJob', visibleWhen: 'paused' },
          { action: 'editJob', visibleWhen: 'editable' },
          { action: 'removeJob' },
        ],
        data: () =>
          service.getJobs().map(j => {
            const ready = j.enabled && !j.paused && !j.running;
            return {
              name: j.name,
              cron: j.cron,
              interval: j.interval,
              runAt: j.runAt,
              sessionId: j.sessionId,
              platform: j.platform,
              content: j.content,
              enabled: j.enabled,
              paused: j.paused,
              schedule:
                j.cron ??
                (j.interval
                  ? t('everySeconds', { seconds: j.interval })
                  : j.runAt
                    ? t('oneShot', { at: j.runAt })
                    : t('unset')),
              status: !j.enabled
                ? { text: t('statusDisabled'), state: 'inactive' as const }
                : j.paused
                  ? { text: t('paused'), state: 'inactive' as const }
                  : j.running
                    ? { text: t('statusRunning'), state: 'running' as const }
                    : { text: t('statusReady') },
              nextRun: ready && j.nextRun > 0 ? j.nextRun : undefined,
              lastRun: j.lastRun || undefined,
              runCount: j.runCount,
              lastResult: j.lastResult,
              pausable: ready && !!(j.cron || j.interval),
              editable: !configJobNames.has(j.name),
            };
          }),
      },
      { type: 'actions', actions: ['createJob'] },
    ],
  });

  async function loadDynamicJobs(): Promise<SchedulerJobConfig[]> {
    /** 失败出在读文件这一步（存储插件不在、persistPath 的根名写错、文件读不了），文件内容未必有错 */
    let reading = true;
    try {
      let raw: string;
      try {
        raw = (await storage.use.readFile(persistUri, 'utf-8')) as string;
      } catch (err) {
        // 只有「文件不存在」算全新；「未知存储根」等其它失败不能当成空表
        if (isStorageNotFound(err)) return [];
        throw err;
      }
      reading = false;
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) {
        throw new TextError(t('notArray', { got: data === null ? 'null' : typeof data }));
      }
      // biome-ignore lint/suspicious/noExplicitAny: 从 JSON 文件反序列化的原始字段，手动校验转型
      return data.map((j: any) => {
        const hasActor =
          typeof j.actorPlatform === 'string' &&
          j.actorPlatform.trim().length > 0 &&
          typeof j.actorUserId === 'string' &&
          j.actorUserId.trim().length > 0;
        if (!hasActor) {
          // 缺 actor 一律降为**匿名**（defaultAuthority），绝不补 owner。
          // `saveDynamicJobs` 的 JSON.stringify 会丢掉 undefined 键，匿名创建的任务落盘后
          // 与无 actor 字段的老任务同形；此处补 owner 即等于给它开一条提权通道。
          // 「创建者未知」不等于「创建者是 owner」。
          logger.use.warn(
            `持久化任务 "${j.name}" 缺少 actor 身份，已按匿名（最低权限）运行；如需更高权限请在 WebUI 中显式设置创建者身份`,
          );
        }
        return {
          name: String(j.name ?? 'unnamed'),
          cron: j.cron as string | undefined,
          interval: j.interval as number | undefined,
          runAt: j.runAt as string | undefined,
          sessionId: String(j.sessionId ?? 'internal'),
          platform: String(j.platform ?? 'internal'),
          actorPlatform: hasActor ? String(j.actorPlatform).trim() : undefined,
          actorUserId: hasActor ? String(j.actorUserId).trim() : undefined,
          content: String(j.content ?? ''),
          enabled: j.enabled !== false,
          paused: j.paused === true,
        };
      });
    } catch (err) {
      loadFailed = true;
      logger.use.warn(`加载持久化任务失败，本次运行不再写入该文件: ${err}`);
      // 里面的任务全没加载、新改动也不落盘：只记日志用户看不到
      webui.use.notify({
        id: 'jobs-load',
        level: 'error',
        title: t('loadFailedTitle', { uri: persistUri }),
        detail: t(reading ? 'loadFailedReading' : 'loadFailedContent', { error: textOf(err) }),
      });
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
    if (loadFailed) {
      logger.use.warn(`持久化任务上次加载失败，跳过写入以免覆盖原有任务（本次改动仅在内存生效）: ${persistUri}`);
      return;
    }
    const jobs = [...dynamicJobs.values()];
    const payload = JSON.stringify(jobs, null, 2);
    saveChain = saveChain
      .then(() => storage.use.writeFile(persistUri, payload))
      .then(
        () => {
          logger.use.debug(`已持久化 ${jobs.length} 个动态任务`);
        },
        err => {
          logger.use.warn(`持久化任务失败: ${err}`);
        },
      );
  }

  // ── 发送调度消息 ──

  async function executeJob(rt: JobRuntime): Promise<void> {
    if (rt.running) return;

    rt.running = true;
    jobsPage.invalidate();
    const jobName = rt.config.name;

    try {
      logger.use.info(`执行任务: ${jobName}`);
      await events.use.emit('scheduler:job:start', jobName);

      // 通用触发事件：供 workflow 等订阅者使用
      // （任务本身仍走 inbound:message 投递，这里同时广播 trigger:fired，
      //  便于平滑迁移到 plugin-workflow）
      // biome-ignore lint/suspicious/noExplicitAny: 事件类型由 api-workflow 增广，scheduler 不直接依赖
      await events.use.emit('trigger:fired' as any, {
        source: `scheduler:${jobName}`,
        type: rt.config.cron ? 'cron' : 'interval',
        payload: {
          jobName,
          sessionId: rt.config.sessionId,
          platform: rt.config.platform,
          content: rt.config.content,
        },
      });

      // 内容由 owner 写下或审批（见 SchedulerService；owner 免了 scheduler_create_job 的确认时例外，见 security-model），声明 ownerApproved
      const message: IncomingMessage = {
        content: rt.config.content,
        sessionId: rt.config.sessionId,
        platform: rt.config.platform,
        source: 'scheduler',
        ownerApproved: true,
      };
      // 注入代理身份：authority 守卫优先读 actor 而非 platform/userId，
      // 从而让 scheduler 触发的 AI 走**创建者**的权限等级。
      //
      // **只透传，不发明身份**：缺省留空 = 匿名（defaultAuthority）。
      // 这里回填 `webui:console` 就是 owner 快速通道（authority-manager 的 isOwner），
      // 而 AI 建任务时 actor 取自可选的 `callCtx.userId` —— 匿名入站下必然为空。
      const actorPlatform = rt.config.actorPlatform?.trim();
      const actorUserId = rt.config.actorUserId?.trim();
      if (actorPlatform && actorUserId) {
        message.actor = { platform: actorPlatform, userId: actorUserId };
      }

      await events.use.emit('inbound:message', message);

      rt.lastRun = Date.now();
      rt.runCount++;
      rt.lastResult = t('jobSucceeded');
      await events.use.emit('scheduler:job:done', jobName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rt.lastResult = t('jobFailed', { error: textOf(err) });
      logger.use.error(`任务 "${jobName}" 执行失败: ${msg}`);
      await events.use.emit('scheduler:job:error', jobName, msg);
    } finally {
      rt.running = false;
      jobsPage.invalidate();
    }
  }

  // ── 估算下次执行时间 ──

  function estimateNextRun(job: SchedulerJobConfig, lastRun: number): number {
    if (job.runAt) {
      const ms = Date.parse(job.runAt);
      return Number.isFinite(ms) ? ms : 0;
    }
    if (job.interval) {
      // 间隔无效的任务没有排上（见 initJob），不知道下次
      return validateIntervalSeconds(job.interval) ? 0 : (lastRun || Date.now()) + job.interval * 1000;
    }
    if (job.cron) {
      const tz = job.timeZone?.trim() || undefined;
      // 每次求值取当前提供者：cron-engine 换人后不会算在旧实例上。时区无效时它同步抛错：这只是展示用的估计，
      // 按「不知道」处理，任务排不上的原因由订阅失败的提示报出
      try {
        return cronEngine.use.nextFireTime(job.cron, new Date(), undefined, tz ? { timeZone: tz } : undefined) ?? 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  // ── 初始化所有任务 ──

  /** cron 订阅不上、固定间隔无效，永远不会运行的任务各一条提示：任务重排或删掉时撤回 */
  const unscheduled = new Map<string, NoticeHandle>();
  function clearUnscheduled(name: string): void {
    unscheduled.get(name)?.clear();
    unscheduled.delete(name);
  }
  /** 发「没有排上」的提示：配置文件里的任务写去配置里改，别的写去计划任务页编辑，带出原因 */
  function markUnscheduled(name: string, reason: string | TextRef): void {
    const fromConfig = configJobNames.has(name);
    unscheduled.set(
      name,
      webui.use.notify({
        id: `unscheduled:${name}`,
        level: 'error',
        title: t('unscheduledTitle', { name }),
        detail: t(fromConfig ? 'unscheduledInConfig' : 'unscheduledOnPage', { error: reason }),
        open: fromConfig ? 'config' : { page: 'scheduler' },
      }),
    );
  }

  function initJob(jobCfg: SchedulerJobConfig): void {
    if (runtimes.has(jobCfg.name)) return;
    clearUnscheduled(jobCfg.name);

    // 归一化 cron 快捷符；"@every Ns" 转成 interval 通道
    if (jobCfg.cron) {
      const everySec = parseEverySeconds(jobCfg.cron);
      if (everySec > 0) {
        jobCfg.interval = everySec;
        jobCfg.cron = undefined;
      }
      // 5 字段 cron 与别名（如 @daily）都直接交给 cron-engine.subscribe 处理，不必预先 normalize
    }

    // 一次性任务带 paused：暂停对它没有可用语义（到点定时器直接跳过且不重排 = 永久卡住），
    // 创建口与 pauseJob 都已拒绝这种组合，但存量持久化文件里可能还留着；启动时告警并按未暂停处理
    // （要停掉它请改 enabled 或直接删除）。
    if (jobCfg.runAt && !jobCfg.cron && !jobCfg.interval && jobCfg.paused) {
      logger.use.warn(`任务 "${jobCfg.name}" 是一次性任务却带 paused，暂停对其无可用语义；已按未暂停处理`);
      jobCfg.paused = false;
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

    // 固定间隔调度。间隔无效（不是大于 0 的数，或超过定时器能排的上限、溢出成每毫秒触发）的不排、发提示：服务入口已当场
    // 拒收，这里只剩配置文件与存量文件里的任务
    if (jobCfg.interval !== undefined && jobCfg.enabled) {
      const problem = validateIntervalSeconds(jobCfg.interval);
      if (problem) {
        logger.use.warn(`任务 ${jobCfg.name} 的固定间隔无效: ${toSource(problem)}`);
        markUnscheduled(jobCfg.name, problem);
      } else {
        rt.timer = setInterval(() => {
          if (!rt.paused) {
            executeJob(rt);
            rt.nextRun = estimateNextRun(rt.config, Date.now());
          }
        }, jobCfg.interval * 1000);
      }
    }

    // cron 任务：订阅到共享 cron-engine
    if (jobCfg.cron && jobCfg.enabled) {
      try {
        const tz = jobCfg.timeZone?.trim() || undefined;
        rt.cronDispose = cronEngine.use.subscribe(
          jobCfg.cron,
          () => {
            if (rt.paused || !rt.config.enabled) return;
            executeJob(rt);
            rt.nextRun = estimateNextRun(rt.config, rt.lastRun);
          },
          tz ? { timeZone: tz } : undefined,
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.use.warn(`任务 ${jobCfg.name} cron 订阅失败: ${reason}`);
        markUnscheduled(jobCfg.name, textOf(err));
      }
    }

    // 一次性任务：到点用 setTimeout 触发一次，执行完 disable 并持久化
    if (jobCfg.runAt && jobCfg.enabled) {
      const targetMs = Date.parse(jobCfg.runAt);
      if (Number.isFinite(targetMs)) {
        const delay = targetMs - Date.now();
        if (delay <= 0) {
          // 已过期：立即执行一次，然后 disable（与下面未到点分支同一判据，暂停态不执行）
          setImmediate(() => {
            if (!rt.paused) {
              executeJob(rt).finally(() => disableOneShot(rt));
            }
          });
        } else {
          // 远期 runAt 分段重排：delay 超过 2^31-1ms 会溢出成立即触发。每段最多排到上限，
          // 段末未到点就续排下一段，到点才执行
          const arm = (wait: number): void => {
            rt.timer = setTimeout(() => {
              const remain = targetMs - Date.now();
              if (remain > 0) {
                arm(Math.min(remain, MAX_TIMEOUT_MS));
                return;
              }
              if (!rt.paused) {
                executeJob(rt).finally(() => disableOneShot(rt));
              }
            }, wait) as unknown as ReturnType<typeof setInterval>;
          };
          arm(Math.min(delay, MAX_TIMEOUT_MS));
        }
      } else {
        logger.use.warn(`任务 ${jobCfg.name} 的 runAt 无法解析: ${jobCfg.runAt}`);
      }
    }

    runtimes.set(jobCfg.name, rt);
    jobsPage.invalidate();
    const scheduleHint = jobCfg.cron
      ? `(cron: ${jobCfg.cron})`
      : jobCfg.interval
        ? `(interval: ${jobCfg.interval}s)`
        : jobCfg.runAt
          ? `(runAt: ${jobCfg.runAt})`
          : '(no schedule)';
    logger.use.info(`任务已注册: ${jobCfg.name} ${scheduleHint}`);
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
      jobsPage.invalidate();
      logger.use.info(`一次性任务已执行完毕并删除: ${jobName}`);
      return;
    }
    // 静态配置任务：不删，仅标记 enabled=false（yaml 才是权威源）
    rt.config.enabled = false;
    rt.paused = true;
    jobsPage.invalidate();
    logger.use.info(`一次性任务已执行完毕并停用（静态）: ${jobName}`);
  }

  // 静态 YAML 任务的「创建者」是编辑配置文件的人——那本身就是 owner 行为，故两项都不写时补 owner。
  // **这是全插件唯一允许推断 owner 的地方**：来源是配置文件（只有能写盘的人才改得动），
  // 不是运行时输入。补在此处而非触发时，是为了让「谁是 actor」在任务入表那一刻就定死，
  // 触发路径只透传、不再有第二次机会发明身份。YAML 显式写 actor 则用其值（可降权）。
  for (const job of config.jobs) {
    const p = job.actorPlatform?.trim();
    const u = job.actorUserId?.trim();
    if (!p !== !u) {
      // 只写了一半：写执行身份通常是为了降权，补成 owner 与作者意图相反，另一半也无从知道，所以这条不载入
      logger.use.error(
        `任务 "${job.name}" 只写了 actorPlatform、actorUserId 其中一个，两者须成对填写；这条任务没有载入`,
      );
      unscheduled.set(
        job.name,
        webui.use.notify({
          id: `unscheduled:${job.name}`,
          level: 'error',
          title: t('halfActorTitle', { name: job.name }),
          detail: t('halfActorDetail'),
          open: 'config',
        }),
      );
      continue;
    }
    initJob(p && u ? job : { ...job, actorPlatform: 'webui', actorUserId: 'console' });
  }

  // 持久化的动态任务：配置文件里写了的名字归配置文件，那一条没载入也不让同名的动态任务顶上来；
  // 文件里重名的只认第一条
  for (const job of persisted) {
    if (!configJobNames.has(job.name) && !runtimes.has(job.name)) {
      dynamicJobs.set(job.name, job);
      initJob(job);
    }
  }
  if (persisted.length > 0) {
    logger.use.info(`已加载 ${persisted.length} 个持久化任务`);
  }

  // ── 注册 scheduler 服务 ──

  /**
   * 配置文件里写了的名字归配置文件（那一条没载入也一样）：页面、工具与别的插件经服务新建与修改时都不能用它，免得顶替它、
   * 撤掉它的错误提示，又因名字在配置里不落盘、重启就没了
   */
  function rejectConfigName(name: string): void {
    if (configJobNames.has(name)) throw new TextError(t('fromConfig', { name }));
  }

  /**
   * 无效的 cron 与固定间隔当场拒收：收下了也订阅不上、永远不会运行，或者间隔超过定时器能排的上限、溢出成每毫秒触发，还会落进
   * 持久化文件。页面、工具与别的插件都经服务新建与修改
   */
  function rejectInvalidSchedule(job: SchedulerJobConfig): void {
    if (job.cron) {
      const checked = cronEngine.use.validate(job.cron);
      if (!checked.ok) throw typeof checked.text === 'string' ? new Error(checked.text) : new TextError(checked.text);
    }
    if (job.interval !== undefined) {
      const problem = validateIntervalSeconds(job.interval);
      if (problem) throw new TextError(problem);
    }
  }

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
      // 一次性任务被暂停会永久卡住（到点的定时器直接跳过且不重排），与创建口同一判据：直接拒绝
      if (rt.config.runAt && !rt.config.cron && !rt.config.interval) {
        logger.use.warn(`一次性任务不能暂停: ${jobName}（只能删除重建）`);
        return false;
      }
      rt.paused = true;
      rt.config.paused = true;
      if (dynamicJobs.has(jobName)) {
        dynamicJobs.set(jobName, { ...rt.config });
        saveDynamicJobs();
      }
      jobsPage.invalidate();
      logger.use.info(`任务已暂停: ${jobName}`);
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
      jobsPage.invalidate();
      logger.use.info(`任务已恢复: ${jobName}`);
      return true;
    },
    async triggerJob(jobName) {
      const rt = runtimes.get(jobName);
      if (!rt) return false;
      await executeJob(rt);
      return true;
    },
    addJob(job) {
      rejectConfigName(job.name);
      rejectInvalidSchedule(job);
      initJob(job);
      dynamicJobs.set(job.name, job);
      saveDynamicJobs();
    },
    setJob(job) {
      // upsert：先 remove 再 add
      rejectConfigName(job.name);
      rejectInvalidSchedule(job);
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
      clearUnscheduled(jobName);
      jobsPage.invalidate();
      logger.use.info(`任务已删除: ${jobName}`);
      return true;
    },
  };

  provide.use(scheduler, service);

  // ── 注册 AI 工具：让 Agent 可以自主创建/管理任务 ──

  tools.use.registerGroup({
    name: 'scheduler',
    label: t('displayName'),
    summary: t('groupSummary'),
    description: '创建、查看和取消定时/周期性自主行动计划',
  });

  tools.use.register({
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
            sessionId: {
              type: 'string',
              description: '任务消息发往的会话 ID。不传则默认使用当前会话（子任务里必须传）。',
            },
            platform: { type: 'string', description: '目标平台标识。不传则默认使用当前平台。' },
            content: { type: 'string', description: '届时发送给自己的指令/提示内容' },
          },
          required: ['name', 'content'],
        },
      },
    },
    // 建任务 = 让 AI 在未来自主行动，且 actor 身份在此固化（见 resolveActor）。
    // 写类：restricted + 确认，与别的要确认的操作同一规则（参与者都是 owner 且在免确认白名单里的回合免）。
    risk: 'dangerous',
    confirm: 'session',
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
      const target = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
      const here = sessionManager.present ? sessionManager.use.getSession(callCtx.sessionId) : undefined;
      // 子会话没有窗口，删掉后发往它的任务就静默丢了：在子会话里不按默认发回当前会话，要写明目标；根会话的 id 作候选
      if (!target && here?.parentId) {
        const root = rootSessionOf(here, id => sessionManager.use.getSession(id));
        const candidate = root ? `；要发回根会话，sessionId 写 "${root.id}"` : '';
        return JSON.stringify({
          error: `在子任务里建定时任务必须写明目标会话 sessionId：子任务的会话删掉后，发往它的任务会静默丢失${candidate}`,
        });
      }
      // 安全关键：创建者强制取这次调用的授权身份（api-tools 的 actingIdentity），不从 args 读取：即使 LLM 在 prompt 中尝试
      // 伪造身份也会被忽略。只有一位参与者时是他（代人执行的回合，如子任务链、workflow 或定时任务驱动的，就是被代的人）；
      // 这一项声明了确认，多人的一轮里经 owner 批过，参与者已换成她；没有单一身份的是无主体，任务按匿名（defaultAuthority）
      // 运行，实现权限的自然传递与不可提升
      const creator = actingIdentity(callCtx);
      const job: SchedulerJobConfig = {
        name: args.name as string,
        cron: hasCron ? (args.cron as string).trim() : undefined,
        interval: hasInterval ? (args.interval as number) : undefined,
        runAt,
        sessionId: target || callCtx.sessionId,
        platform: (args.platform as string) || callCtx.platform || 'internal',
        actorPlatform: creator.platform,
        actorUserId: creator.userId || undefined,
        content: args.content as string,
        enabled: true,
      };
      if (runtimes.has(job.name)) return JSON.stringify({ error: `任务 "${job.name}" 已存在` });
      try {
        service.addJob(job);
      } catch (err) {
        return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      const scheduleDesc = job.cron
        ? `cron="${job.cron}"`
        : job.interval
          ? `每 ${job.interval}s 重复`
          : job.runAt
            ? `一次性 @ ${job.runAt}`
            : '?';
      const note = persistNote();
      return JSON.stringify({
        ok: true,
        message: `任务 "${job.name}" 已创建 (${scheduleDesc})，目标会话: ${job.sessionId} (${job.platform})${note ? `；${toSource(note)}` : ''}`,
      });
    },
  });

  tools.use.register({
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
    // 只看不改：任务清单含 sessionId / prompt，2 级、不确认，低于 2 级的看不到
    visibility: 'restricted',
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

  tools.use.register({
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
    // 删类：删掉定时任务不可逆（无回收站）。
    risk: 'dangerous',
    confirm: 'session',
    handler: async args => {
      const ok = service.removeJob(args.name as string);
      return JSON.stringify({ ok, message: ok ? '已删除' : '任务不存在' });
    },
  });

  tools.use.register({
    groups: ['scheduler'],
    definition: {
      type: 'function',
      function: {
        name: 'scheduler_pause_job',
        description:
          '暂停一个正在运行的计划任务。暂停后任务不会被触发，但保留配置，可随时恢复。一次性任务（runAt / delaySeconds）不能暂停，只能删除重建。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要暂停的任务名称' },
          },
          required: ['name'],
        },
      },
    },
    // 改状态类：暂停等于静默停掉一条自主行动，用户不会收到任何提示。
    risk: 'dangerous',
    confirm: 'session',
    handler: async args => {
      const ok = service.pauseJob(args.name as string);
      return JSON.stringify({ ok, message: ok ? '已暂停' : '任务不存在，或是一次性任务（不能暂停，只能删除重建）' });
    },
  });

  tools.use.register({
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
    // 改状态类：恢复会让一条被停掉的自主行动重新开始跑。
    risk: 'dangerous',
    confirm: 'session',
    handler: async args => {
      const ok = service.resumeJob(args.name as string);
      return JSON.stringify({ ok, message: ok ? '已恢复' : '任务不存在' });
    },
  });

  // ── 清理 ──

  lifecycle.use.onDispose(() => {
    for (const rt of runtimes.values()) {
      if (rt.timer) clearInterval(rt.timer);
      if (rt.cronDispose) rt.cronDispose();
    }
    runtimes.clear();
  });

  logger.use.info(`计划任务调度器已启动 (${config.jobs.length} 个任务)`);
}

// ──────────── 辅助函数 ────────────

export function resolveConfig(cfg: ConfigOf<typeof configSchema>): SchedulerConfig {
  return {
    jobs: cfg.jobs.map(j => ({
      ...j,
      name: j.name ?? 'unnamed',
      sessionId: j.sessionId ?? `scheduler::${j.name ?? 'default'}`,
    })),
    persistPath: resolvePersistPath(cfg.persistPath),
  };
}

/** persistPath 只接受 storage URI；留空用 schema 默认值，其它写法拒绝激活。 */
function resolvePersistPath(input: string): string {
  const s = input.trim();
  if (!s) return configSchema.persistPath.default;
  if (!isStorageUri(s)) {
    throw configError(t('badPersistPath', { value: s }));
  }
  return s;
}

// ----- 事件类型（declaration merging）-----
declare module '@aalis/core' {
  interface AalisEvents {
    /** 任务开始执行 */
    'scheduler:job:start': [jobName: string];
    /** 任务执行成功 */
    'scheduler:job:done': [jobName: string];
    /** 任务执行失败 */
    'scheduler:job:error': [jobName: string, message: string];
  }
}
