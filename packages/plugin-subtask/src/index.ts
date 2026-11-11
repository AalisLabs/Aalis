import { AsyncLocalStorage } from 'node:async_hooks';
import { agent } from '@aalis/api-agent'; // 也是本包 declaration merging 的激活点（agent:* 钩子）
import { gateway } from '@aalis/api-gateway';
import { hooks } from '@aalis/api-hooks';
import { ownHostConfig } from '@aalis/api-host-config';
import { MODEL_REF_TEXT, type ModelRef, modelRefOf } from '@aalis/api-llm';
import { historyCleared } from '@aalis/api-memory'; // 也是 declaration merging 的激活点（memory:clear 钩子）
import { messageArchive } from '@aalis/api-message-archive';
import { type SessionInfo, type SessionManagerService, sessionLabel, sessionManager } from '@aalis/api-session-manager';
import { type SessionFieldReader, sessionSettings } from '@aalis/api-session-settings';
import { actingIdentity, backgroundTasks, type ToolCallContext, tools } from '@aalis/api-tools';
import { type BoundOf, config, definePlugin, events, logger, optional } from '@aalis/core';
import { type ConfigOf, defineConfig, parseConfig } from '@aalis/schema-config';
import { toSource } from '@aalis/schema-i18n';
import { type IncomingMessage, type TurnRecord, WellKnownMetadataKeys } from '@aalis/schema-message';
import { t } from './texts.js';

// =====================================================================
// plugin-subtask —— 派发并行子会话（独立 sessionId 的子 agent）
//
// 与相邻插件的职责区分（不冲突，可组合）：
//   - plugin-workflow：声明式 DAG，编排可被回放/版本化的多步流程
//   - plugin-todo-list：单会话内的"步骤列表"，给 agent 自己规划用
//   - plugin-subtask  ：跨会话的并行子 agent，适合「拆分独立调研任务」
//   - plugin-skills   ：可加载的提示词模板，正交，可在子任务里继续使用
//
// 推荐用法见 create_subtask 的工具说明。
//
// 子会话在建立时写下父会话此刻的设置（会话设置管理面的 childMetadata），之后独立；父会话经 set_subtask_setting 改直接子会话
// 本会话层的设置。子会话的一轮结束后闲置满 idleDeleteHours 即销毁，销毁之前给父会话写回报。
// =====================================================================

/**
 * 派发与追问消息的来源：它们是内部注入，不是真人当面发的话。指令的意图确认只认同一会话里不带 source 的下一条消息，
 * 不带 source 时父会话经 send_to_subtask 发来的 y 会被当成发出者本人的确认（userId 同为 `parent:<父会话>`），
 * 父会话里的模型就能替子任务里的指令确认；要求真人当面发起的工具也会放行子任务回合。
 * 派发与追问同一个值，各自成一轮：追问排在子任务在跑的那一轮之后。
 */
const SUBTASK_SOURCE = 'subtask';

/**
 * 发给子会话的任务消息（派发与追问同一个写法）。userId 是归档用的物理来源标记（authority 查不到，等价匿名），身份：
 * - 调用在入站回合里：带着这次调用所在那一轮（fromTurn：平台、发言者、这次调用的参与者（批过的是批的人）、来源与那一轮
 *   自己的 fromTurn），不填 actor；子任务那一轮的参与者取它的，权限服务按它判子任务这一轮的主体，不按父会话里别的哪一轮；
 * - 不在入站回合里（编排的工具节点、mcp-server）：不带 fromTurn，授权身份走 actor（这次调用的唯一参与者；匿名或几个
 *   参与者时不填，子任务同样匿名）。
 * 追问那一轮按发追问那次调用的参与者，同一子任务会话各轮的身份可以不同；send_to_subtask 与 create_subtask
 * 同为 2 级加确认。
 */
function taskMessage(callCtx: ToolCallContext, sessionId: string, content: string): IncomingMessage {
  const { platform, userId, participants, inbound } = callCtx;
  const message: IncomingMessage = {
    content,
    sessionId,
    platform: platform || 'internal',
    userId: `parent:${callCtx.sessionId}`,
    source: SUBTASK_SOURCE,
  };
  if (inbound) {
    message.fromTurn = {
      platform: message.platform,
      userId,
      participants,
      source: inbound.source,
      fromTurn: inbound.fromTurn,
    };
    return message;
  }
  const identity = actingIdentity(callCtx);
  if (identity.userId) message.actor = identity;
  return message;
}

const configSchema = defineConfig({
  enabled: { type: 'boolean', label: t('enabledLabel'), default: true, onInvalid: 'error' },

  maxWaitMs: { type: 'number', label: t('maxWaitMsLabel'), default: 300000 },
  // 按会话字段：按派子任务的会话解析，能按群设；1 级可改
  model: {
    type: 'llm-ref',
    label: t('modelLabel'),
    description: t('modelDescription'),
    ...MODEL_REF_TEXT,
    session: { appliesTo: ['owner', 'room'], prominence: 'advanced', unset: t('modelUnset'), minLevel: 1 },
  },
  idleDeleteHours: { type: 'number', label: t('idleLabel'), description: t('idleDescription'), default: 24, min: 0 },
});

type PluginConfig = Pick<ConfigOf<typeof configSchema>, 'maxWaitMs' | 'idleDeleteHours'>;
type SubtaskFields = SessionFieldReader<typeof configSchema>;

const HOUR_MS = 3_600_000;
/** 到期定时器的最长延时：超过 2^31−1 毫秒的延时 Node 按 1 毫秒触发，截到一天、到点重判 */
const MAX_TIMER_MS = 24 * HOUR_MS;

/** 子任务报给父会话的状态：会话状态之外，最后一轮被停止、收口为 completed 的报成 stopped，不算完成 */
type SubtaskStatus = SessionInfo['status'] | 'stopped';

/** 交给模型与日志的子任务名：没取名的是默认名的原文 */
const nameOf = (session: SessionInfo): string => toSource(sessionLabel(session));

/**
 * 出错的子任务的出错原因（session-manager 记在 lastTurn，交给模型取原文），其余状态不带：为 undefined 的键序列化后不出现在
 * 工具结果里
 */
function errorReason(session: SessionInfo, status: SubtaskStatus): string | undefined {
  return status === 'error' ? toSource(session.lastTurn?.error) : undefined;
}

const STATUS_LABELS: Partial<Record<SubtaskStatus, string>> = {
  active: '进行中',
  completed: '已完成',
  error: '出错',
  stopped: '已停止',
};

const NOT_FOUND = '子任务不存在';

/** 父会话记录 metadata 里本插件的键：到期销毁的子任务留下的回报 */
const REPORTS_KEY = 'subtask';

/**
 * 到期销毁的子任务留给父会话的回报：check_subtask、wait_subtasks 读到即删，父会话提醒列出它的那一轮回复或静默收尾后删（出错、
 * 被停止的一轮之后留着）
 */
interface SubtaskReport {
  id: string;
  name: string;
  status: SubtaskStatus;
  reason?: string;
  result?: string;
  inputContext?: string;
}

/** 一个会话记录上的回报 */
function reportsOf(session: SessionInfo | undefined): SubtaskReport[] {
  const reports = (session?.metadata?.[REPORTS_KEY] as { reports?: unknown } | undefined)?.reports;
  return Array.isArray(reports)
    ? reports.filter((r): r is SubtaskReport => typeof (r as { id?: unknown } | null)?.id === 'string')
    : [];
}

/** 子任务此刻的回报：不写没有的项 */
function reportOf(session: SessionInfo, status: SubtaskStatus): SubtaskReport {
  const reason = errorReason(session, status);
  return {
    id: session.id,
    name: nameOf(session),
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(session.result ? { result: session.result } : {}),
    ...(session.inputContext ? { inputContext: session.inputContext } : {}),
  };
}

function writeReports(sm: SessionManagerService, sessionId: string, reports: SubtaskReport[]): Promise<unknown> {
  return sm.updateSession(sessionId, { metadata: { [REPORTS_KEY]: { reports } } });
}

/** 取走调用所在会话记录上某个子任务的回报（读到即删）；只在调用方自己的记录上找，别的会话的子任务取不到 */
async function takeReport(
  sm: SessionManagerService,
  sessionId: string,
  id: string,
): Promise<SubtaskReport | undefined> {
  const reports = reportsOf(sm.getSession(sessionId));
  const report = reports.find(r => r.id === id);
  if (report)
    await writeReports(
      sm,
      sessionId,
      reports.filter(r => r !== report),
    );
  return report;
}

/**
 * 按 id 取调用所在会话的直接子任务，五个按 id 操作的工具都经这里：别的会话的子任务、根会话与不存在的一样取不到，
 * 一律按 {@link NOT_FOUND} 回，不确认存在与否，也不交出、不等、不改它们
 */
function directChild(sm: SessionManagerService, id: string, sessionId: string): SessionInfo | undefined {
  const session = sm.getSession(id);
  return session?.parentId === sessionId ? session : undefined;
}

// ===== 插件入口 =====

const uses = {
  tools: optional(tools),
  events,
  hooks,
  logger,
  config,
  sessionManager: optional(sessionManager),
  messageArchive: optional(messageArchive),
  /**
   * 给子会话写子任务模型（assignModel）；工具参数指定的模型按它的实例 id 认「模型」这一项。不在时要指定模型的子任务不建
   */
  agent: optional(agent),
  /**
   * 会话设置的管理面：建子会话之前取 childMetadata、按调用者的身份写子会话的设置（setAs：工具参数指定的模型、父会话改子会话的
   * 设置）、读本插件的子任务模型。不在时不建子会话：子会话没法写下父会话此刻的设置
   */
  sessionSettings: optional(sessionSettings),
  /** 追问经它送达（落定时知道）；不在时追问发不出 */
  gateway: optional(gateway),
  /** 按会话字段的全局层：宿主配置文档里本实例的那一段 */
  document: optional(ownHostConfig),
  /** 子会话在跑的后台任务：有的不到期销毁；不在时没有 */
  backgroundTasks: optional(backgroundTasks),
};
type Caps = BoundOf<typeof uses>;

export default definePlugin({
  name: '@aalis/plugin-subtask',
  displayName: t('displayName'),
  subsystem: 'session',
  configSchema,
  uses,
  apply(caps) {
    const parsed = parseConfig(configSchema, caps.config.use, caps.logger.use);
    if (!parsed.enabled) return;
    const cfg = {
      maxWaitMs: parsed.maxWaitMs || configSchema.maxWaitMs.default,
      idleDeleteHours: parsed.idleDeleteHours,
    };
    registerSubtask(caps, cfg, caps.sessionSettings.use.fields(configSchema, caps));
  },
});

function registerSubtask(
  {
    tools,
    events,
    hooks,
    logger,
    sessionManager,
    messageArchive,
    agent,
    sessionSettings,
    gateway,
    backgroundTasks,
  }: Caps,
  cfg: PluginConfig,
  fields: SubtaskFields,
): void {
  // ---- 到期销毁的记录（见文末「到期销毁」）----
  /** 在飞的回合数 */
  const inflight = new Map<string, number>();
  /** 发出了还没落定的追问（所在的一轮结束、被放掉、在网关相位被挡下都算落定）的条数 */
  const followUps = new Map<string, number>();
  /**
   * 追问开的那一轮跑在送达它的调用的异步上下文里，回合结束时据此认出这一轮是不是追问开的。每条追问一个令牌，落定时从 live 里删：
   * 那一轮里起的异步工作（转后台的工具、定时器）继承同一个上下文，之后它们开的一轮拿到的是已落定的令牌，不算追问开的
   */
  const followUpTurn = new AsyncLocalStorage<object>();
  const live = new Set<object>();
  /** 有追问落定时通知的：wait_subtasks 据此重判 */
  const onFollowUpSettled = new Set<() => void>();
  /** 一条追问落定：没有别的了就重排到期（到点时它还没落定的那次判定没有重排） */
  function followUpSettled(childId: string): void {
    const rest = (followUps.get(childId) ?? 1) - 1;
    if (rest > 0) followUps.set(childId, rest);
    else {
      followUps.delete(childId);
      if (!inflight.has(childId)) schedule(childId);
    }
    for (const listener of onFollowUpSettled) listener();
  }
  /**
   * 子任务此刻的状态：还有没落定的追问时按进行中（会话管理在它前后两轮之间可能已把状态收口成已完成）；最后一轮被停止、收口为
   * completed 的报成 stopped
   */
  const statusOf = (session: SessionInfo): SubtaskStatus =>
    followUps.has(session.id)
      ? 'active'
      : session.status === 'completed' && session.lastTurn?.outcome === 'aborted'
        ? 'stopped'
        : session.status;
  /** 本插件记下的一轮结束时刻；重启或重载之后没有，取会话记录上的 lastTurn.endedAt */
  const endedAt = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 父会话这一轮的提醒里列出过的回报（子会话 id）：这一轮回复或静默收尾时删 */
  const listed = new Map<string, Set<string>>();
  /** 一轮的结局（回合 id → 结局）：agent:turn:after 记下，同一轮的 agent:turn:before 收尾时取走 */
  const outcomes = new Map<string, TurnRecord['outcome']>();
  /**
   * 子会话还在时 check_subtask、wait_subtasks 交出过的结果（子会话 id → 那一份回报）：到期销毁时同一份不再写回报。只记在内存里，
   * 重启或重载之后到期的照样写回报
   */
  const taken = new Map<string, string>();

  /**
   * 查一个子任务（check_subtask、wait_subtasks）：还在的直接子任务取此刻的回报，结束了的记下交出过这一份，并取走到期销毁这一拍里
   * 已写进调用所在会话记录的同一条回报；已销毁的取走调用所在会话记录上的回报
   */
  async function lookup(
    sm: SessionManagerService,
    id: string,
    sessionId: string,
  ): Promise<{ report: SubtaskReport; destroyed: boolean } | undefined> {
    const session = directChild(sm, id, sessionId);
    if (session) {
      const report = reportOf(session, statusOf(session));
      if (report.status !== 'active') {
        taken.set(id, JSON.stringify(report));
        await takeReport(sm, sessionId, id);
      }
      return { report, destroyed: false };
    }
    const report = await takeReport(sm, sessionId, id);
    return report && { report, destroyed: true };
  }

  /** 跟随中的会话管理：定时器只在它在场时排 */
  let tracked: SessionManagerService | undefined;

  // 注册工具分组
  tools.use.registerGroup({
    name: 'subtask',
    label: t('groupLabel'),
    summary: t('groupSummary'),
    description: '创建、管理和协调子任务会话，支持并行执行',
  });

  // ---- create_subtask ----
  tools.use.register({
    groups: ['subtask'],
    // 子任务替发起的人在后台接着做（每个是一条独立的 LLM 会话链）：建、追问、改设置与删都与编排、定时任务、停后台任务同一规则，
    // 2 级加确认。别人单独发起的没人能批即拒；owner 一个人的回合在免确认白名单里不问，常连续派几个并行子任务的把它加进白名单
    risk: 'dangerous',
    definition: {
      type: 'function',
      function: {
        name: 'create_subtask',
        description: [
          '创建一个子任务会话并异步派发任务。子任务将在独立会话中并行执行，不阻塞当前会话。',
          '返回子任务 ID，后续可用 check_subtask 查询状态或 wait_subtasks 等待完成。',
          '你可以连续调用多次 create_subtask 来创建多个并行子任务。',
          '',
          '【重要协作规范】',
          '1. task 描述中应写清：(a) 具体任务内容 (b) 要用到的共享资源 (c) 子任务负责的范围',
          '2. 创建完所有子任务后，必须立即调用 wait_subtasks 等待结果，不要在未等待的情况下继续主任务',
          '3. 子任务无法调用 create_subtask（不可嵌套）',
          '',
          '【模型选择】可选 model 参数为子任务指定更便宜/轻量的模型，写条目 id「<提供者实例 id>/<模型 id>」，与 /model 列出的写法相同：',
          '- 适合轻量模型的任务：语法检查、格式转换、摄取信息、翻译、简单总结、文档快速审阅',
          '- 依然需要父同模型的任务：复杂推理、多步规划、代码生成、独立决策',
          '- 不填则用本会话的子任务模型，没设时与本会话的模型相同',
          '',
          '子任务交回结果（一轮结束，不论回复、出错还是被停止）后闲置一段时间没人追问就会销毁，销毁后要重新创建。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: '要派发给子任务的详细任务描述/指令',
            },
            name: {
              type: 'string',
              description: '子任务显示名称（可选，默认自动生成）',
            },
            model: {
              type: 'string',
              description:
                '可选：为子任务指定模型，写条目 id「<提供者实例 id>/<模型 id>」（模型 id 里可以有斜杠）；不填则用本会话的子任务模型，没设时与本会话的模型相同。',
            },
          },
          required: ['task'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' });
      const sm = sessionManager.use;

      const task = String(args.task || '');
      if (!task) return JSON.stringify({ error: '缺少任务描述' });

      const parentId = callCtx.sessionId;

      // 防止子任务嵌套创建子任务
      const parentSession = sm.getSession(parentId);
      if (parentSession?.parentId) {
        return JSON.stringify({ error: '子任务中不能再创建子任务。请直接完成当前任务，由父会话负责任务拆分和协调。' });
      }

      // 子会话在建立时写下本会话此刻的设置：会话设置不在时写不下，照常建的话本会话那一层的收窄就丢了
      if (!sessionSettings.present) {
        return JSON.stringify({ error: '会话设置不在，不能创建子任务：子会话要在创建时写下本会话此刻的设置' });
      }

      // 子会话的对话模型：工具参数 › 本会话此刻生效的子任务模型 › 随设置写下的本会话此刻的模型（不另指定）
      const text = String(args.model ?? '').trim();
      const argModel = text ? modelRefOf(text) : undefined;
      if (text && !argModel) {
        return JSON.stringify({
          error: `model 写法不对：${text}。写成「<提供者实例 id>/<模型 id>」，与 /model 列出的相同`,
        });
      }
      const model: ModelRef | undefined = argModel ?? fields.get(parentId, { platform: callCtx.platform }).model;
      if (model && !agent.present) {
        return JSON.stringify({ error: '要给子任务指定模型，但 agent 服务不在，不能创建子任务' });
      }

      // 没给名字的不起名：显示名由读者按建档时间给（sessionLabel）
      const taskName = args.name ? String(args.name) : undefined;

      try {
        const child = await sm.createChildSession(parentId, {
          name: taskName,
          title: taskName,
          inputContext: task,
          metadata: sessionSettings.use.childMetadata(parentId, { platform: callCtx.platform }),
        });
        if (model) {
          try {
            // 工具参数按这次调用的授权身份写，与 set_subtask_setting 同一条路：agent「模型」这一项与本会话层的门槛都判，owner 在
            // 操作门槛里调高的照算。子任务模型是能改它的人设下的，由 agent 直接写
            if (argModel) {
              const agentId = agent.list().find(entry => entry.selected)?.id;
              const receipt = await sessionSettings.use.setAs(
                actingIdentity(callCtx),
                child.id,
                `${agentId}/llm`,
                text,
              );
              if (!receipt.ok) throw new Error(toSource(receipt.text));
            } else await agent.use.assignModel(child.id, model);
          } catch (err) {
            await sm.deleteSession(child.id);
            throw new Error(`给子会话指定模型失败（${err instanceof Error ? err.message : String(err)}）`, {
              cause: err,
            });
          }
        }

        // 异步派发任务消息，触发 agent 处理（不等待完成）
        events.use.emit('inbound:message', taskMessage(callCtx, child.id, task)).catch(err => {
          logger.use.warn(`子任务消息派发失败 (${child.id}):`, err);
        });

        const name = nameOf(child);
        return JSON.stringify({
          subtaskId: child.id,
          name,
          status: 'active',
          message: `子任务 "${name}" 已创建并开始执行`,
        });
      } catch (err) {
        return JSON.stringify({ error: `创建子任务失败: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  // ---- check_subtask ----
  tools.use.register({
    groups: ['subtask'],
    // 只看不改：2 级、不确认，低于 2 级的看不到别人派出的子任务的任务与结果
    visibility: 'restricted',
    definition: {
      type: 'function',
      function: {
        name: 'check_subtask',
        description: [
          '查询一个或多个子任务的当前状态和结果。',
          '返回每个子任务的状态（active=进行中, completed=已完成, error=出错, stopped=已停止）、结果摘要等；出错的带 reason（出错原因）。',
          '如果有子任务状态为 error，可在它销毁之前用 send_to_subtask 重新发送指令让其重试，已完成或出错的会重新进入进行中。',
          '子任务交回结果后闲置一段时间没人追问就会销毁：销毁之后这里回它最后的状态与结果一次（destroyed 为 true），再查就是不存在，要接着做得重新创建。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '要查询的子任务 ID 列表',
            },
          },
          required: ['subtask_ids'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' });
      const sm = sessionManager.use;

      const ids = (args.subtask_ids as string[]) || [];
      if (ids.length === 0) {
        return JSON.stringify({
          error: '缺少 subtask_ids 参数。正确用法: { "subtask_ids": ["<子任务ID1>", "<子任务ID2>"] }',
        });
      }
      const results = [];
      for (const id of ids) {
        const found = await lookup(sm, id, callCtx.sessionId);
        if (!found) {
          results.push({ id, error: NOT_FOUND });
          continue;
        }
        const { report, destroyed } = found;
        results.push({
          id,
          name: report.name,
          status: report.status,
          statusLabel: STATUS_LABELS[report.status] ?? report.status,
          reason: report.reason,
          result: report.result ?? null,
          inputContext: report.inputContext ?? null,
          ...(destroyed ? { destroyed: true } : {}),
        });
      }

      const summary = {
        total: results.length,
        active: results.filter(r => !('error' in r) && r.status === 'active').length,
        completed: results.filter(r => !('error' in r) && r.status === 'completed').length,
        errored: results.filter(r => !('error' in r) && r.status === 'error').length,
        stopped: results.filter(r => !('error' in r) && r.status === 'stopped').length,
      };

      return JSON.stringify({ summary, subtasks: results });
    },
  });

  // ---- send_to_subtask ----
  tools.use.register({
    groups: ['subtask'],
    // 追问让子任务再跑一轮：与 create_subtask 同一规则
    risk: 'dangerous',
    definition: {
      type: 'function',
      function: {
        name: 'send_to_subtask',
        description: [
          '向子任务会话发送追加消息（追问、补充指令等）。',
          '消息将作为父会话用户身份注入子任务，触发子任务 agent 继续处理。',
          '子任务如已完成或出错，将被重新激活为 active 状态，闲置计时从这一轮结束重新算；已销毁的子任务要重新创建。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_id: {
              type: 'string',
              description: '子任务会话 ID',
            },
            message: {
              type: 'string',
              description: '要发送给子任务的消息内容',
            },
          },
          required: ['subtask_id', 'message'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' });
      const sm = sessionManager.use;

      const subtaskId = String(args.subtask_id || '');
      const message = String(args.message || '');
      if (!subtaskId || !message) return JSON.stringify({ error: '缺少子任务 ID 或消息内容' });
      if (!gateway.present) return JSON.stringify({ error: '消息网关不可用，追问发不出' });

      // 只向直接子任务发：防越权向任意会话注入消息、重激活已完成的会话
      const session = directChild(sm, subtaskId, callCtx.sessionId);
      if (!session) return JSON.stringify({ error: `${NOT_FOUND}: ${subtaskId}` });

      // 已完成或出错的重新激活；归档的不翻（与回合开始时同一口径）
      if (session.status === 'completed' || session.status === 'error') {
        await sm.updateSession(subtaskId, { status: 'active' });
      }
      // 经网关送达、不等：发出到落定之间不判到期、这期间结束的一轮不交回，追问排在子任务在跑的那一轮之后另开一轮
      followUps.set(subtaskId, (followUps.get(subtaskId) ?? 0) + 1);
      const token = {};
      live.add(token);
      followUpTurn
        .run(token, () => gateway.use.ingressMessage(taskMessage(callCtx, subtaskId, message)))
        .catch(err => logger.use.warn(`向子任务发送消息失败 (${subtaskId}):`, err))
        .finally(() => {
          live.delete(token);
          followUpSettled(subtaskId);
        });

      return JSON.stringify({
        subtaskId,
        sent: true,
        message: `消息已发送到子任务 "${nameOf(session)}"`,
      });
    },
  });

  // ---- set_subtask_setting ----
  tools.use.register({
    groups: ['subtask'],
    // 模型给自己派的子会话放权等于自己给自己授权：与 create_subtask 同一规则，要 owner 确认（免确认只对以 owner 身份做的事
    // 生效），项的门槛另按这一轮发起的人逐项判
    risk: 'dangerous',
    definition: {
      type: 'function',
      function: {
        name: 'set_subtask_setting',
        description: [
          '改一个直接子任务（本会话派出的子会话，不含它再派出的）这个会话自己那一层的一项设置，下一轮起生效。',
          '写法同 /session.set：key 是项名，几个插件同名时写「<实例 id>/<键>」；value 是取值的文字，模型写「<提供者实例 id>/<模型 id>」，列表用逗号分隔；列表与映射写 []、文字传空串即设成空。',
          '只写值，不能恢复继承。项写错、不适用或重名时，回执列出能改的项。每次调用都要 owner 确认。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_id: { type: 'string', description: '子任务 ID' },
            key: { type: 'string', description: '项名，如 persona；同名时写「<实例 id>/<键>」' },
            value: { type: 'string', description: '取值的文字；空列表写 []，空文字传空串' },
          },
          required: ['subtask_id', 'key', 'value'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' });
      if (!sessionSettings.present) return JSON.stringify({ error: '会话设置不在，改不了子任务的设置' });
      const sm = sessionManager.use;

      const subtaskId = String(args.subtask_id || '').trim();
      const key = String(args.key || '').trim();
      if (!subtaskId || !key) return JSON.stringify({ error: '缺少子任务 ID 或项名' });

      const session = directChild(sm, subtaskId, callCtx.sessionId);
      if (!session) return JSON.stringify({ error: `${NOT_FOUND}: ${subtaskId}` });

      // 门槛按这次调用的授权身份：几个人的一轮是无主体，这一项声明了确认，多人的一轮里经 owner 批过，参与者已换成她
      const receipt = await sessionSettings.use.setAs(
        actingIdentity(callCtx),
        subtaskId,
        key,
        String(args.value ?? ''),
      );
      // 给模型的一律原文
      return toSource(receipt.text);
    },
  });

  // ---- delete_subtask ----
  tools.use.register({
    groups: ['subtask'],
    // 销毁子任务会话连同它没做完的事：与 create_subtask 同一规则
    risk: 'dangerous',
    definition: {
      type: 'function',
      function: {
        name: 'delete_subtask',
        description: [
          '删除指定的子任务会话及其所有子会话（递归删除）。',
          '只能删除当前会话的直接子任务，不能删除根会话或其他会话的子任务。',
          '删除后会话的消息历史也会被一并清除。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_id: {
              type: 'string',
              description: '要删除的子任务 ID',
            },
          },
          required: ['subtask_id'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' });
      const sm = sessionManager.use;

      const subtaskId = String(args.subtask_id || '').trim();
      if (!subtaskId) return JSON.stringify({ error: '缺少子任务 ID' });

      const session = directChild(sm, subtaskId, callCtx.sessionId);
      if (!session) return JSON.stringify({ error: `${NOT_FOUND}: ${subtaskId}` });

      try {
        const name = nameOf(session);
        await sm.deleteSession(subtaskId);
        return JSON.stringify({
          subtaskId,
          name,
          deleted: true,
          message: `子任务 "${name}" (${subtaskId}) 已删除`,
        });
      } catch (err) {
        return JSON.stringify({ error: `删除失败: ${err instanceof Error ? err.message : String(err)}` });
      }
    },
  });

  // ---- wait_subtasks ----
  tools.use.register({
    groups: ['subtask'],
    // 只看不改：同 check_subtask
    visibility: 'restricted',
    definition: {
      type: 'function',
      function: {
        name: 'wait_subtasks',
        description: [
          '等待指定的子任务全部完成。阻塞直到所有子任务完成或超时。',
          '返回每个子任务的状态和结果摘要，出错的带 reason（出错原因）。超时后仍返回当前状态（部分可能未完成）。被停止的子任务状态为 stopped（已停止），不算完成。',
          '',
          '【必须调用】创建子任务后，必须调用此工具等待所有子任务完成。',
          '不等待就继续主任务会导致：子任务结果丢失、文档内容不完整、最终输出质量差。',
          '调用后请检查返回的 allCompleted 字段和每个子任务的 result，确认所有子任务均成功完成。',
          '如有子任务失败或超时，可在它销毁之前使用 send_to_subtask 补充指令后再次等待，已完成或出错的会重新进入进行中。',
          '交回结果后闲置到期而销毁的子任务，这里回它最后的状态与结果一次（destroyed 为 true），之后就是不存在，要重新创建。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subtask_ids: {
              type: 'array',
              items: { type: 'string' },
              description: '要等待的子任务 ID 列表',
            },
            timeout_seconds: {
              type: 'number',
              description: `超时时间（秒）。缺省取插件配置 maxWaitMs（当前 ${Math.round(cfg.maxWaitMs / 1000)} 秒）；传入时最终取二者较小者。`,
            },
          },
          required: ['subtask_ids'],
          additionalProperties: false,
        },
      },
    },
    handler: async (args, callCtx) => {
      if (!sessionManager.present) return JSON.stringify({ error: 'session-manager 服务不可用' });
      const sm = sessionManager.use;

      const ids = (args.subtask_ids as string[]) || [];
      if (ids.length === 0) {
        return JSON.stringify({
          error: '缺少 subtask_ids 参数。正确用法: { "subtask_ids": ["<子任务ID1>", "<子任务ID2>"] }',
        });
      }

      const timeoutSec = Number(args.timeout_seconds) || cfg.maxWaitMs / 1000;
      const timeoutMs = Math.min(timeoutSec * 1000, cfg.maxWaitMs);

      // 先检查是否已经全部结束（避免不必要的等待）；不是本会话直接子任务的不等
      const isTerminal = (id: string) => {
        const s = directChild(sm, id, callCtx.sessionId);
        const status = s && statusOf(s);
        return !status || status === 'completed' || status === 'error' || status === 'stopped';
      };

      const { signal } = callCtx;
      if (!ids.every(isTerminal) && !signal?.aborted) {
        // 事件驱动 + 超时，替代轮询：会话完成、状态变了、被删（结果里按不存在回）或追问落定时重判；调用被中止（这一轮被停止键、
        // 禁言、/clear 等停下，或本插件停用、重启）时不再等，这一轮才落定得了
        await new Promise<void>(resolve => {
          const pending = new Set(ids.filter(id => !isTerminal(id)));
          const disposers: Array<() => void> = [];
          const finish = () => {
            clearTimeout(timer);
            for (const dispose of disposers) dispose();
            onFollowUpSettled.delete(recheck);
            signal?.removeEventListener('abort', finish);
            resolve();
          };
          const recheck = () => {
            for (const id of pending) if (isTerminal(id)) pending.delete(id);
            if (pending.size === 0) finish();
          };
          const timer = setTimeout(finish, timeoutMs);
          disposers.push(
            events.use.on('session:completed', recheck),
            events.use.on('session:updated', recheck),
            events.use.on('session:deleted', recheck),
          );
          onFollowUpSettled.add(recheck);
          signal?.addEventListener('abort', finish, { once: true });
        });
      }
      if (signal?.aborted) return JSON.stringify({ error: '调用已中止，不再等' });

      // 收集结果：等着时销毁了的取回报
      const results = [];
      for (const id of ids) {
        const found = await lookup(sm, id, callCtx.sessionId);
        if (!found) {
          results.push({ id, error: NOT_FOUND });
          continue;
        }
        const { report, destroyed } = found;
        results.push({
          id,
          name: report.name,
          status: report.status,
          reason: report.reason,
          inputContext: report.inputContext ?? null,
          result: report.result ?? null,
          completed: report.status === 'completed',
          ...(destroyed ? { destroyed: true } : {}),
        });
      }

      const allCompleted = results.every(r => 'completed' in r && r.completed);
      // 出错、被停止的已经结束，不算超时：只有等满时还没结束的才算
      const timedOut = !ids.every(isTerminal);

      return JSON.stringify({
        allCompleted,
        timedOut,
        subtasks: results,
      });
    },
  });

  // ---- 子任务的系统提示增强 ----
  // 当 agent 处理子任务消息时，在系统提示中注入子任务上下文
  const SUBTASK_CONTEXT_MARKER = '--- 子任务上下文 ---';
  const PARENT_CONTEXT_MARKER = '--- 活跃子任务提醒 ---';
  /** 提醒消息的 injector 标识：每轮重注时按它摘旧、token 统计按它归桶 */
  const PARENT_STATUS_INJECTOR = 'subtask/parent-status';

  hooks.use.middleware('agent:llm:before', async (data, next) => {
    if (!sessionManager.present) {
      await next();
      return;
    }
    const sm = sessionManager.use;

    const sessionId = data.sessionId;
    if (!sessionId) {
      await next();
      return;
    }

    const session = sm.getSession(sessionId);
    const messages = data.messages;
    if (!messages || messages.length === 0) {
      await next();
      return;
    }

    // 找到第一个 system 消息
    const sysMsg = messages.find(m => m.role === 'system');
    if (!sysMsg || typeof sysMsg.content !== 'string') {
      await next();
      return;
    }

    // ---- 子任务侧：注入子任务上下文 ----
    if (session?.parentId) {
      // 幂等检查：避免多轮工具调用中重复注入
      if (!sysMsg.content.includes(SUBTASK_CONTEXT_MARKER)) {
        const subtaskContext = [
          `\n\n--- 子任务上下文 ---`,
          `你正在一个子任务会话中执行独立任务。`,
          `子任务名称: ${nameOf(session)}`,
          session.inputContext ? `任务指令: ${session.inputContext}` : '',
          '',
          '回答规则：',
          '- 像普通对话一样正常回答问题或完成任务即可',
          '- 系统会自动将你的最终回复作为任务结果报告给父会话',
          '- 请给出完整、有价值的回答，因为你的回复内容将直接成为子任务结果',
          '',
          '协作规则：',
          '- 严格只操作你负责的范围（如指定的部分），不要越界修改其他部分',
          '- 完成后请在回复中汇报你做了什么（如做了哪些改动、内容摘要等），方便父会话整合',
          '--- 子任务上下文结束 ---',
        ]
          .filter(Boolean)
          .join('\n');

        (sysMsg as { content: string }).content += subtaskContext;
        const prevContributions = (sysMsg.metadata?._tokenContributions as Record<string, number>) ?? {};
        (sysMsg as { metadata?: Record<string, unknown> }).metadata = {
          ...sysMsg.metadata,
          _tokenContributions: { ...prevContributions, subtask: subtaskContext.length },
        };
      }
    }

    // ---- 父会话侧：注入活跃子任务提醒 ----
    //
    // 子任务状态/结果每轮都在变，故用**独立 system 消息插在列表尾部**：绝不 `+=` 进
    // messages[0]（persona 系统提示）尾部——碰第 0 条消息会让 provider 前缀缓存从它
    // 内部就断，人设 + 头部材料 + 整段历史全部作废，「父会话 + 有子任务」的会话享受
    // 不到任何历史缓存；尾部插入则不碰前缀字节。同时保证「每轮重注最新状态」——
    // 工具循环中 wait_subtasks 返回后，下一轮 LLM 看到的是刷新过的状态而非首轮快照
    // （这也是它不走 agent:prompt 贡献点的原因：贡献按全局键幂等，物化一次后同回合
    // 不再刷新）。
    // 子会话销毁之后，它的回报在父会话记录上：也要列出，否则最后一个子会话销毁后回报就没人列
    if (!session?.parentId && session) {
      const children = session.children;
      // 子会话还在的回报不列：写回报与撤回之间（这一拍里有追问）它还活着，不能说成已销毁
      const destroyed = reportsOf(session).filter(report => !sm.getSession(report.id));
      if (children.length > 0 || destroyed.length > 0) {
        const activeChildren: string[] = [];
        const completedChildren: string[] = [];
        const errorChildren: string[] = [];
        const stoppedChildren: string[] = [];

        for (const childId of children) {
          const child = sm.getSession(childId);
          if (!child) continue;
          const status = statusOf(child);
          if (status === 'active') {
            activeChildren.push(`  - [进行中] ${nameOf(child)} (ID: ${childId})`);
          } else if (status === 'completed') {
            const resultPreview = child.result ?? '(无结果)';
            completedChildren.push(`  - [已完成] ${nameOf(child)} (ID: ${childId}): ${resultPreview}`);
          } else if (status === 'error') {
            // 不取 result：出错时它若有值，是此前某一轮回复收口时留下的结果，不是这次出错的详情
            const reason = toSource(child.lastTurn?.error) ?? '(无错误详情)';
            errorChildren.push(`  - [出错] ${nameOf(child)} (ID: ${childId}): ${reason}`);
          } else if (status === 'stopped') {
            stoppedChildren.push(`  - [已停止] ${nameOf(child)} (ID: ${childId})`);
          }
        }

        // 每轮重注：先摘上一轮的提醒消息（按 injector 识别，替代旧的字符串手术）
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].metadata?.injector === PARENT_STATUS_INJECTOR) messages.splice(i, 1);
        }

        if (
          activeChildren.length > 0 ||
          completedChildren.length > 0 ||
          errorChildren.length > 0 ||
          stoppedChildren.length > 0 ||
          destroyed.length > 0
        ) {
          const lines: string[] = [PARENT_CONTEXT_MARKER];

          if (activeChildren.length > 0) {
            lines.push(`⚠️ 你有 ${activeChildren.length} 个子任务正在执行：`);
            lines.push(...activeChildren);
            lines.push('');
            lines.push('你必须调用 wait_subtasks 等待这些子任务完成后再继续。不要忽略进行中的子任务。');
          }

          if (errorChildren.length > 0) {
            lines.push(`❌ 以下子任务执行出错：`);
            lines.push(...errorChildren);
            lines.push('');
            lines.push(
              '可在销毁之前使用 send_to_subtask 向出错的子任务发送修正指令让其重试（已完成或出错的会重新进入进行中），或使用 check_subtask 查看详细状态；销毁了的要重新创建。',
            );
          }

          if (stoppedChildren.length > 0) {
            lines.push(`以下子任务已被停止：`);
            lines.push(...stoppedChildren);
          }

          if (completedChildren.length > 0) {
            lines.push(`以下子任务已完成，请检查结果：`);
            lines.push(...completedChildren);
          }

          if (destroyed.length > 0) {
            lines.push(
              '以下子任务交回结果后闲置到期，已销毁；这是它们最后的状态与结果，只列这一轮，要接着做得重新创建：',
            );
            for (const report of destroyed) {
              const detail = report.status === 'error' ? (report.reason ?? '(无错误详情)') : report.result;
              const label = STATUS_LABELS[report.status] ?? report.status;
              lines.push(`  - [${label}] ${report.name} (ID: ${report.id})${detail ? `: ${detail}` : ''}`);
            }
            // 干跑（用量快照）不算列出：那不是这一轮给模型看的
            if (!data.dryRun) {
              const ids = listed.get(sessionId) ?? new Set<string>();
              for (const report of destroyed) ids.add(report.id);
              listed.set(sessionId, ids);
            }
          }

          lines.push('--- 活跃子任务提醒结束 ---');
          // 首轮（最后一条是当前 user 消息）插它前面；工具轮/proactive 轮（尾部是
          // tool/assistant/system）追加到末尾 = 决策点前，状态最新鲜的位置
          const insertAt = messages[messages.length - 1]?.role === 'user' ? messages.length - 1 : messages.length;
          messages.splice(insertAt, 0, {
            role: 'system',
            content: lines.join('\n'),
            metadata: { injector: PARENT_STATUS_INJECTOR },
          });
        }
      }
    }

    await next();
  });

  // ---- 子任务自动完成 ----
  // 当子任务 agent 正常回复后，自动将回复内容作为结果完成会话
  // 同时在子会话历史中合成一条 tool call 记录，展示"报告给父会话"的流程
  hooks.use.middleware('agent:turn:after', async (data, next) => {
    await next();

    // 仅在本轮真正产生回复时回报父会话；silent / aborted 不应触发自动完成
    if (data.outcome !== 'replied') return;

    if (!sessionManager.present) return;
    const sm = sessionManager.use;

    const session = sm.getSession(data.sessionId);
    if (!session?.parentId) return; // 非子任务
    if (session.status === 'completed' || session.status === 'error') return; // 已完成
    // 还有不在这一轮里的追问没落定（追问开的一轮只有它自己那一条）：这一轮的回复不交回、不完成，等追问那一轮
    const own = followUpTurn.getStore();
    if ((followUps.get(data.sessionId) ?? 0) > (own && live.has(own) ? 1 : 0)) return;

    const result = data.reply;
    if (!result || result.trim().length === 0) return;

    try {
      // 在子会话历史中合成 tool call 记录，展示报告流程
      const archive = messageArchive.present ? messageArchive.use : undefined;
      if (archive) {
        const syntheticToolCallId = `report-${Date.now()}`;
        // 两条都带这一轮的回合 id：连对话回滚这一轮时随它删
        const metadata = { [WellKnownMetadataKeys.TurnId]: data.turnId };
        // 合成 assistant 消息（含 tool_calls）
        await archive.saveMessage(data.sessionId, {
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: syntheticToolCallId,
              type: 'function',
              function: {
                name: 'report_to_parent',
                arguments: JSON.stringify({ result: result.trim() }),
              },
            },
          ],
          timestamp: Date.now(),
          metadata,
        });
        // 合成 tool 结果消息
        await archive.saveMessage(data.sessionId, {
          role: 'tool',
          content: JSON.stringify({ success: true, message: '结果已报告给父会话' }),
          toolCallId: syntheticToolCallId,
          timestamp: Date.now(),
          metadata,
        });
      }

      await sm.completeSession(data.sessionId, result.trim());
      logger.use.info(`子任务自动完成: ${nameOf(session)} (${data.sessionId})`);
    } catch (err) {
      logger.use.warn(`子任务自动完成失败 (${data.sessionId}):`, err);
    }
  });

  // ---- 到期销毁 ----
  // 子会话的一轮结束（不论结局）满 idleDeleteHours 就删掉，追问让它在下一轮结束时重新计时，从没跑过一轮的不计时。在飞的一轮与
  // 发出还没落定的追问由本插件自己记，不看会话状态（归档的子会话跑一轮时状态不翻；追问之前那一轮先把状态收口了）。有在跑的
  // 后台任务的同样不删：正常结束的由结束通知开的那一轮收尾时重排，被停止、中断的不发结束通知，结束时重排。
  // 删除只在定时器里做：删除要等这个会话的回合收尾，在回合里删就互相等。销毁之前把回报写进父会话记录

  /** 这个子会话有在跑的后台任务：正常结束时结束通知开一轮，那一轮收尾时重新计时 */
  const hasRunningTask = (sessionId: string) =>
    backgroundTasks.present && backgroundTasks.use.list({ sessionId }).some(task => task.status === 'running');

  /** 起点：一轮结束的时刻；从没跑过一轮的没有 */
  const startOf = (child: SessionInfo) => endedAt.get(child.id) ?? child.lastTurn?.endedAt;

  /** 排这个子会话的到期定时器（离到期还差多久与一天取较短的，到点重判）；不是子会话或不计时的不排 */
  function schedule(childId: string): void {
    clearTimeout(timers.get(childId));
    timers.delete(childId);
    const child = tracked?.getSession(childId);
    const start = child?.parentId === undefined ? undefined : startOf(child);
    if (start === undefined) return;
    const left = start + cfg.idleDeleteHours * HOUR_MS - Date.now();
    timers.set(
      childId,
      setTimeout(() => void expire(childId), Math.min(Math.max(left, 0), MAX_TIMER_MS)),
    );
  }

  /**
   * 到点重判：一轮在飞、追问还没落定或有在跑的后台任务的等那一轮收尾、追问落定、任务结束时再排；没到期的再排；到期的写回报、删掉（父会话在它还在时已经取走
   * 过同一份结果的不写回报）。写回报要等一拍：这一拍里发出的追问让它忙起来（或会话管理换了）时撤回这条回报、不删，由那一轮收尾
   * 或追问落定时重新排
   */
  async function expire(childId: string): Promise<void> {
    timers.delete(childId);
    const sm = tracked;
    const child = sm?.getSession(childId);
    if (!sm || child?.parentId === undefined) return;
    const busy = () => inflight.has(childId) || followUps.has(childId) || hasRunningTask(childId);
    if (busy()) return;
    const start = startOf(child);
    if (start === undefined) return;
    if (Date.now() < start + cfg.idleDeleteHours * HOUR_MS) {
      schedule(childId);
      return;
    }
    const parentId = child.parentId;
    /** 父会话记录上别的子任务的回报 */
    const others = () => reportsOf(sm.getSession(parentId)).filter(r => r.id !== childId);
    const report = reportOf(child, statusOf(child));
    // 父会话在它还在时已经取走过这一份结果：不再写回报
    const fresh = taken.get(childId) !== JSON.stringify(report);
    try {
      if (fresh && sm.getSession(parentId)) await writeReports(sm, parentId, [...others(), report]);
      if (busy() || tracked !== sm) {
        if (sm.getSession(parentId)) await writeReports(sm, parentId, others());
        return;
      }
      await sm.deleteSession(childId);
      logger.use.info(`子任务交回结果后闲置到期，已销毁: ${nameOf(child)} (${childId})`);
    } catch (err) {
      logger.use.warn(`子任务到期销毁失败 (${childId}):`, err);
    }
  }

  /** 这个会话这一轮的提醒里列出过的回报：这一轮回复或静默收尾时删 */
  async function dropListed(sessionId: string): Promise<void> {
    const ids = listed.get(sessionId);
    const sm = tracked;
    if (!ids || !sm) return;
    listed.delete(sessionId);
    const reports = reportsOf(sm.getSession(sessionId));
    const rest = reports.filter(r => !ids.has(r.id));
    if (rest.length === reports.length) return;
    try {
      await writeReports(sm, sessionId, rest);
    } catch (err) {
      logger.use.warn(`删除已列出的子任务回报失败 (${sessionId}):`, err);
    }
  }

  hooks.use.middleware('agent:turn:after', async (data, next) => {
    outcomes.set(data.turnId, data.outcome);
    await next();
  });

  // 一轮从开始（agent:turn:before）到它的 next 返回为止：子会话记在飞，结束时记下时刻、排定时器；父会话这一轮回复或静默收尾时
  // 删掉这一轮列出过的回报，出错、被停止（或没走到 agent:turn:after）的模型没交出什么，回报留着、下一轮照常列出
  hooks.use.middleware('agent:turn:before', async (data, next) => {
    const { sessionId, turnId } = data;
    const { source } = data.inputs[0].message;
    const sm = sessionManager.present ? sessionManager.use : undefined;
    const session = sm?.getSession(sessionId);
    // 已删的子会话：发出、还没开轮的派发与追问不跑（这一轮不归档）
    if (sm && source === SUBTASK_SOURCE && !session) return;
    const child = session?.parentId !== undefined;
    if (child) inflight.set(sessionId, (inflight.get(sessionId) ?? 0) + 1);
    try {
      await next();
    } finally {
      if (child) {
        const rest = (inflight.get(sessionId) ?? 1) - 1;
        if (rest > 0) inflight.set(sessionId, rest);
        else inflight.delete(sessionId);
        if (tracked?.getSession(sessionId)) {
          endedAt.set(sessionId, Date.now());
          schedule(sessionId);
        }
      }
      const outcome = outcomes.get(turnId);
      outcomes.delete(turnId);
      if (outcome === 'replied' || outcome === 'silent') await dropListed(sessionId);
      else listed.delete(sessionId);
    }
  });

  // 后台任务被停止或中断：不发结束通知、不开一轮，就在这时重排（正常结束的由结束通知那一轮收尾时重排）；不是子会话的不排
  events.use.on('background:changed', change => {
    if (!('task' in change)) return;
    const { sessionId, status } = change.task;
    if ((status === 'stopped' || status === 'aborted') && !inflight.has(sessionId)) schedule(sessionId);
  });

  events.use.on('session:deleted', sessionId => {
    clearTimeout(timers.get(sessionId));
    timers.delete(sessionId);
    followUps.delete(sessionId);
    endedAt.delete(sessionId);
    listed.delete(sessionId);
    taken.delete(sessionId);
  });

  // 父会话的消息历史清成了：回报一并清掉（在 next 之后看结果，与会话管理连带删除子会话同一判法）；会话不在表里时什么都不做
  hooks.use.middleware('memory:clear', async (data, next) => {
    await next();
    if (!historyCleared(data)) return;
    const sm = sessionManager.present ? sessionManager.use : undefined;
    if (!sm) return;
    const targets = data.scope === 'all' ? sm.listSessions() : [sm.getSession(data.sessionId ?? '')];
    for (const session of targets) {
      if (session && reportsOf(session).length > 0) await writeReports(sm, session.id, []);
    }
  });

  // 会话管理上线（含本插件激活、会话管理晚到）时扫一遍子会话排定时器；下线与关闭时撤掉
  sessionManager.follow(sm => {
    tracked = sm;
    for (const session of sm.listSessions()) if (session.parentId !== undefined) schedule(session.id);
    return () => {
      tracked = undefined;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  });

  logger.use.info('子任务工具已注册');
}
