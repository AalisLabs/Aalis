// ============================================================
// 白纸工具：paper_task 交任务（受理后交给运行驱动出队）、paper_status 查任务、paper_cancel 取消自己发起的任务、
// paper_send 把成品发回本群
//
// 都在 paper 分组、都不声明 risk（等级 0，群友可用）：门槛由房间配置、真人判据与三层上限承担，
// 封禁（负等级）由执行守卫挡住，handler 不重复查。返回值不含凭据或链接。
//
// paper_send 只发本房间发起的任务的成品（具名白纸被几个房间共用时，别的房间的按「找不到」回），类型按
// 白名单：位图走 image、MP4 走 video、单个 HTML 按 sendHtml 与大小上限走 file，远端给的原扩展名须与按文件头
// 判定的类型一致。文件名由宿主按任务名重写，附件指向白纸根里宿主命名的文件。交给网关即标为已交付：
// 出站是发完即返回，投递失败由适配器写进会话记忆，她之后的回合看得到。
// ============================================================

import type { GatewayService } from '@aalis/api-gateway';
import { type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import { type BoundTools, type ToolCallContext, wrapUntrustedContent } from '@aalis/api-tools';
import type { Events, Logger, ServiceRef } from '@aalis/core';
import type { OutgoingMessage } from '@aalis/schema-message';
import { artifactUri, EXTENSIONS } from './artifacts.js';
import { canStart, dayKey, daySpend, release, reserveFor } from './budget.js';
import type { PaperConfig } from './config.js';
import { type LedgerStore, randomHex, type TaskRecord, UNFINISHED_STATES } from './ledger.js';
import { formatSize } from './notices.js';
import {
  actorKey,
  checkEligibility,
  checkRemote,
  effectiveActor,
  type Isolation,
  type RoomPaper,
  resolveRoomPaper,
} from './rooms.js';

const MAX_TEXT = 1000;
const MAX_NAME = 40;
/** paper_status 列出结束不到这么久的任务 */
const RECENT_MS = 24 * 3600_000;
/** paper_status 里远端说明的长度 */
const STATUS_NOTE_MAX = 500;

type Artifact = TaskRecord['artifacts'][number];
type SendableType = Exclude<Artifact['type'], 'other'>;

const MIME_TYPES: Record<SendableType, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  html: 'text/html',
};

/** 各类型认的原扩展名：远端给的文件名与按文件头判定的类型不一致时不发 */
const TYPE_EXTENSIONS: Record<SendableType, readonly string[]> = {
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  gif: ['gif'],
  webp: ['webp'],
  mp4: ['mp4'],
  html: ['html', 'htm'],
};

/** 不发的成品按原扩展名说明原因 */
const REFUSED_EXTENSIONS: ReadonlyArray<{ exts: readonly string[]; reason: string }> = [
  {
    exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst'],
    reason: '压缩包（包括工程包）不发，里面可能夹带可执行文件',
  },
  { exts: ['exe', 'dll', 'so', 'dylib', 'com', 'scr', 'jar'], reason: '可执行文件不发' },
  { exts: ['msi', 'dmg', 'pkg', 'apk', 'ipa', 'deb', 'rpm', 'appimage'], reason: '安装包不发' },
  {
    exts: ['sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'vbs', 'js', 'mjs', 'cjs', 'py', 'rb', 'pl', 'php'],
    reason: '脚本不发，打开就可能被执行',
  },
  { exts: ['lnk', 'url', 'webloc', 'desktop'], reason: '快捷方式不发，它可能指向别的程序或网址' },
  { exts: ['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam'], reason: '带宏的 Office 文档不发' },
  { exts: ['svg', 'svgz'], reason: 'SVG 能内嵌脚本，不发；要图请让远端另导出 PNG' },
];

interface PaperToolDeps {
  tools: BoundTools;
  sessionManager: ServiceRef<SessionManagerService>;
  remote: ServiceRef<RemoteAgentProvider>;
  gateway: ServiceRef<GatewayService>;
  events: Events;
  ledger: LedgerStore;
  isolation: Isolation;
  cfg: PaperConfig;
  logger: Logger;
  signal: AbortSignal;
  now: () => number;
  /** 受理后交给运行驱动：这块白纸没在跑就开始出队 */
  kick: (paperId: string) => void;
}

const fail = (error: string) => JSON.stringify({ ok: false, error });
const done = (fields: Record<string, unknown>) => JSON.stringify({ ok: true, ...fields });

function codePoints(s: string): string[] {
  return [...s];
}

/** 任务名：去掉控制字符与格式字符（含双向控制符、零宽字符），截到 40 字 */
function sanitizeName(value: unknown): string {
  const cleaned = (typeof value === 'string' ? value : '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  return codePoints(cleaned).slice(0, MAX_NAME).join('').trim();
}

/**
 * 回显中和尖括号：onebot 出站对所有来源都按 `<image url>`、`<video url>`、`<at>` 等标记解析，
 * 不中和的话回显会被渲染成图片、视频或 @（包括 `<at id="all">`），群里看到的就和发给远端的正文不一致。
 */
function neutralize(s: string): string {
  return s.replace(/</g, '＜').replace(/>/g, '＞');
}

function truncate(s: string, max: number): string {
  const chars = codePoints(s);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

function byCreated(a: TaskRecord, b: TaskRecord): number {
  return a.createdAt - b.createdAt;
}

/** 远端给的相对路径里文件名的扩展名（小写，没有则为空串） */
function extensionOf(rel: string): string {
  const base = rel.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** 这件成品能不能发；不能时返回原因 */
function sendRefusal(artifact: Artifact, cfg: PaperConfig): string | undefined {
  const ext = extensionOf(artifact.rel);
  if (artifact.type === 'other') {
    const refused = REFUSED_EXTENSIONS.find(r => r.exts.includes(ext));
    return refused?.reason ?? '只发 PNG、JPEG、GIF、WebP 图片、MP4 视频与单个 HTML 网页，这件成品不是这几种';
  }
  if (artifact.type === 'html') {
    if (!cfg.sendHtml) return 'owner 没有开启发送网页（sendHtml），这件成品不发';
    if (artifact.sizeBytes > cfg.sendHtmlMaxBytes) {
      return `网页 ${formatSize(artifact.sizeBytes)}，超过发送上限 ${formatSize(cfg.sendHtmlMaxBytes)}`;
    }
  }
  if (!TYPE_EXTENSIONS[artifact.type].includes(ext)) {
    return `原文件的扩展名（${ext ? `.${ext}` : '无'}）与文件内容（${artifact.type}）不一致，不发`;
  }
  return undefined;
}

/**
 * 发出去的文件名：任务名去掉控制与格式字符（含双向控制符、零宽字符）、路径分隔符与 :*?"<>|，
 * 首尾去点和空格，截到 40 字；空了用 aalis-paper
 */
function fileBaseName(name: string): string {
  const trim = (s: string) => s.replace(/^[.\s]+|[.\s]+$/gu, '');
  const cleaned = trim(name.replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, ''));
  return trim(codePoints(cleaned).slice(0, MAX_NAME).join('')) || 'aalis-paper';
}

function newTaskId(ledger: LedgerStore): string {
  let id: string;
  do id = `t-${randomHex(4)}`;
  while (ledger.data.tasks[id]);
  return id;
}

export function registerPaperTools(deps: PaperToolDeps): void {
  const { tools, ledger, cfg } = deps;

  const tasksOn = (paperId: string) => Object.values(deps.ledger.data.tasks).filter(t => t.paperId === paperId);
  const queueOf = (paperId: string) =>
    tasksOn(paperId)
      .filter(t => t.state === 'queued')
      .sort(byCreated);

  /** 房间与资格；不满足时给出失败结果 */
  const enter = async (
    ctx: ToolCallContext,
    kind: 'initiate' | 'use',
  ): Promise<{ paper: RoomPaper } | { refused: string }> => {
    const sm = deps.sessionManager.require();
    const refused = checkEligibility(sm, ctx, kind);
    if (refused) return { refused };
    const paper = await resolveRoomPaper(sm, cfg, ctx.sessionId, ctx.platform);
    return 'unavailable' in paper ? { refused: paper.unavailable } : { paper };
  };

  /** 经网关发出；网关不在场时改走 outbound:message 事件（出站中间件链被跳过） */
  async function dispatch(message: OutgoingMessage): Promise<void> {
    const gateway = deps.gateway.current;
    if (gateway) {
      await gateway.dispatchOutbound(message);
      return;
    }
    deps.logger.warn('gateway 服务不在场，白纸出站改走 outbound:message 事件（出站中间件链被跳过）');
    await deps.events.emit('outbound:message', message);
  }

  async function echo(ctx: ToolCallContext, name: string, text: string): Promise<void> {
    await dispatch({
      sessionId: ctx.sessionId,
      platform: ctx.platform,
      content: neutralize(`交给远端：${name}\n${text}`),
      source: 'system',
    });
  }

  async function paperTask(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return fail('text 不能为空');
    const length = codePoints(text).length;
    if (length > MAX_TEXT) return fail(`text 最多 ${MAX_TEXT} 字，现在 ${length} 字`);
    const name = sanitizeName(args.name);
    if (!name) return fail('name 不能为空（去掉控制字符之后）');

    const entered = await enter(ctx, 'initiate');
    if ('refused' in entered) return fail(entered.refused);
    const { paper } = entered;
    const remote = await checkRemote({
      paper,
      remote: deps.remote,
      ledger,
      isolation: deps.isolation,
      signal: deps.signal,
    });
    if ('unavailable' in remote) return fail(remote.unavailable);

    let accepted = false;
    const result = await ledger.exclusive(async () => {
      const now = deps.now();
      const day = dayKey(now, cfg.budgetTimeZone);
      const initiator = effectiveActor(ctx);
      const user = actorKey(initiator);
      const reserve = reserveFor(ledger.data, paper.paperId, cfg.reserveDefaultCents);
      const budget = canStart(
        ledger.data,
        day,
        ctx.sessionId,
        user,
        {
          globalCents: cfg.globalDailyCents,
          roomCents: paper.room.remoteAgentRoomDailyCents,
          userCents: paper.room.remoteAgentUserDailyCents,
          userTasks: paper.room.remoteAgentUserDailyTasks,
        },
        reserve,
      );
      if (!budget.ok) return fail(budget.reason);

      const open = tasksOn(paper.paperId).filter(t => UNFINISHED_STATES.has(t.state));
      if (open.length >= paper.spec.maxWaiting) {
        return fail(`这块白纸已有 ${open.length} 件未结束的任务（上限 ${paper.spec.maxWaiting}），等前面的做完再交`);
      }
      const maxPerUser = paper.spec.maxPerUser;
      if (maxPerUser !== undefined && open.filter(t => actorKey(t.initiator) === user).length >= maxPerUser) {
        return fail(`你在这块白纸上已有 ${maxPerUser} 件未结束的任务（每人上限 ${maxPerUser}），等做完再交`);
      }

      try {
        await echo(ctx, name, text);
      } catch (err) {
        return fail(`回显没有发出去，任务未受理：${err instanceof Error ? err.message : String(err)}`);
      }

      const id = newTaskId(ledger);
      ledger.data.tasks[id] = {
        id,
        paperId: paper.paperId,
        room: ctx.sessionId,
        platform: ctx.platform ?? '',
        initiator,
        name,
        text,
        state: 'queued',
        createdAt: now,
        artifacts: [],
        delivered: false,
      };
      ledger.data.reserves[id] = { cents: reserve, day, room: ctx.sessionId, user };
      const users = daySpend(ledger.data, day).users;
      users[user] ??= { cents: 0, tasks: 0 };
      const counts = users[user];
      counts.tasks += 1;
      try {
        await ledger.save();
      } catch (err) {
        delete ledger.data.tasks[id];
        release(ledger.data, id);
        counts.tasks -= 1;
        deps.logger.error(`白纸账本写入失败，任务未受理: ${err}`);
        return fail('白纸账本写入失败，任务未受理');
      }
      deps.logger.info(`白纸受理任务 ${id}（${paper.paperId}，房间 ${ctx.sessionId}，发起者 ${user}）`);
      accepted = true;
      return done({ taskId: id, position: queueOf(paper.paperId).findIndex(t => t.id === id) + 1 });
    });
    if (accepted) deps.kick(paper.paperId);
    return result;
  }

  async function paperStatus(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    const entered = await enter(ctx, 'use');
    if ('refused' in entered) return fail(entered.refused);
    if (ledger.failure) return fail('白纸账本读取失败，等 owner 处理');
    const { paper } = entered;
    const now = deps.now();
    const queue = queueOf(paper.paperId);
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';

    let mine: TaskRecord[];
    let others: TaskRecord[] = [];
    if (taskId) {
      // 别的房间发起的任务按「找不到」回，不承认它存在
      const task = ledger.data.tasks[taskId];
      if (!task || task.paperId !== paper.paperId || task.room !== ctx.sessionId) {
        return fail(`本房间的白纸上没有任务 ${taskId}`);
      }
      mine = [task];
    } else {
      const visible = tasksOn(paper.paperId)
        .filter(t => UNFINISHED_STATES.has(t.state) || (t.endedAt ?? 0) >= now - RECENT_MS)
        .sort(byCreated);
      mine = visible.filter(t => t.room === ctx.sessionId);
      others = visible.filter(t => t.room !== ctx.sessionId);
    }

    const rows = mine.map(t => {
      const position = queue.indexOf(t) + 1;
      return {
        taskId: t.id,
        name: t.name,
        text: t.text,
        state: t.state,
        ...(position > 0 ? { position } : {}),
        ...(t.startedAt !== undefined ? { durationSec: Math.round(((t.endedAt ?? now) - t.startedAt) / 1000) } : {}),
        ...(t.costCents !== undefined ? { costCents: t.costCents } : {}),
        ...(t.artifacts.length > 0
          ? { artifacts: t.artifacts.map(a => ({ id: a.id, type: a.type, sizeBytes: a.sizeBytes })) }
          : {}),
        ...(t.error ? { error: t.error } : {}),
        ...(t.cancelledVia ? { cancelledVia: t.cancelledVia } : {}),
      };
    });
    const summary: Record<string, unknown> = { paper: paper.spec.name ?? '本房间的白纸', tasks: rows };
    if (others.length > 0) {
      const states: Record<string, number> = {};
      for (const t of others) states[t.state] = (states[t.state] ?? 0) + 1;
      summary.otherRooms = { count: others.length, states };
    }
    // 远端说明放在所有宿主写的内容之后：不可信框声明正文延续到结果末尾
    const notes = mine
      .filter(t => t.resultText)
      .map(t => wrapUntrustedContent(truncate(t.resultText ?? '', STATUS_NOTE_MAX), `远端代理对任务 ${t.id} 的说明`));
    return [JSON.stringify(summary, null, 2), ...notes].join('\n\n');
  }

  async function paperCancel(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    const refused = checkEligibility(deps.sessionManager.require(), ctx, 'initiate');
    if (refused) return fail(refused);
    if (ledger.failure) return fail('白纸账本读取失败，等 owner 处理');
    const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : '';
    if (!taskId) return fail('task_id 不能为空');
    const user = actorKey(effectiveActor(ctx));

    type Running = { agentId: string; runId: string; via: TaskRecord['cancelledVia'] };
    const step = await ledger.exclusive(async (): Promise<string | Running> => {
      const task = ledger.data.tasks[taskId];
      if (!task) return fail(`没有任务 ${taskId}`);
      if (actorKey(task.initiator) !== user) return fail('只能取消自己发起的任务');
      switch (task.state) {
        case 'queued': {
          const reserve = ledger.data.reserves[taskId];
          task.state = 'cancelled';
          task.endedAt = deps.now();
          task.cancelledVia = 'tool';
          release(ledger.data, taskId);
          try {
            await ledger.save();
          } catch (err) {
            task.state = 'queued';
            delete task.endedAt;
            delete task.cancelledVia;
            if (reserve) ledger.data.reserves[taskId] = reserve;
            deps.logger.error(`白纸账本写入失败，任务未取消: ${err}`);
            return fail('白纸账本写入失败，任务未取消');
          }
          return done({ taskId, state: 'cancelled' });
        }
        case 'running': {
          if (!task.agentId || !task.runId) return fail('这件任务的远端轮次未知，取消不了，请 owner 在 WebUI 处理');
          // 先记下取消来源（同到点取消）：远端可能在取消请求返回之前就交出终态，那时再记就晚了，这件会被
          // 当成别处取消而发出通知。取消失败时还原；这一轮最终不是 cancelled 时由运行驱动清掉
          const via = task.cancelledVia;
          task.cancelledVia = 'tool';
          return { agentId: task.agentId, runId: task.runId, via };
        }
        case 'starting':
          return fail('这件任务正在开轮，稍后再取消');
        case 'collecting':
          return fail('这一轮已经结束，正在取回成品，取消不了');
        default:
          return fail(`这件任务已经结束（${task.state}）`);
      }
    });
    if (typeof step === 'string') return step;

    // 运行中：请远端取消这一轮。网络调用不占账本锁；费用照常等终态入账，预留到那时再释放
    const restore = () =>
      ledger.exclusive(async () => {
        const task = ledger.data.tasks[taskId];
        if (task && UNFINISHED_STATES.has(task.state) && task.cancelledVia === 'tool') task.cancelledVia = step.via;
      });
    const providerType = ledger.data.agents[step.agentId]?.providerType ?? '';
    const provider = resolveRemoteAgent(deps.remote, providerType);
    if (!provider) {
      await restore();
      return fail(`远端代理「${providerType}」不在场，取消不了`);
    }
    try {
      await provider.instance.cancelRun(step.agentId, step.runId, deps.signal);
    } catch (err) {
      await restore();
      return fail(`远端取消失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return ledger.exclusive(async () => {
      const task = ledger.data.tasks[taskId];
      if (task && UNFINISHED_STATES.has(task.state)) {
        await ledger.save().catch(err => deps.logger.error(`白纸账本写入失败（取消标记）: ${err}`));
      }
      return done({ taskId, message: '已请远端取消这一轮；费用按实际发生的入账' });
    });
  }

  async function paperSend(args: Record<string, unknown>, ctx: ToolCallContext): Promise<string> {
    const artifactId = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : '';
    if (!artifactId) return fail('artifact_id 不能为空');
    const entered = await enter(ctx, 'use');
    if ('refused' in entered) return fail(entered.refused);
    if (ledger.failure) return fail('白纸账本读取失败，等 owner 处理');
    // 别的白纸上的、同一具名白纸上别的房间发起的任务的成品，一律按「找不到」回，不承认它存在
    const task = tasksOn(entered.paper.paperId).find(
      t => t.room === ctx.sessionId && t.artifacts.some(a => a.id === artifactId),
    );
    const artifact = task?.artifacts.find(a => a.id === artifactId);
    if (!task || !artifact) return fail(`本房间的白纸上没有成品 ${artifactId}`);
    if (task.artifactsCleared) return fail(`成品 ${artifactId} 已随白纸清空删除`);
    const refused = sendRefusal(artifact, cfg);
    if (refused) return fail(refused);

    const type = artifact.type as SendableType;
    const message: OutgoingMessage = {
      sessionId: ctx.sessionId,
      platform: ctx.platform,
      content: '',
      attachments: [
        {
          kind: type === 'mp4' ? 'video' : type === 'html' ? 'file' : 'image',
          data: artifactUri(task.paperId, task.id, artifact),
          name: `${fileBaseName(task.name)}.${EXTENSIONS[type]}`,
          mimeType: MIME_TYPES[type],
        },
      ],
      source: 'agent',
    };
    try {
      await dispatch(message);
    } catch (err) {
      return fail(`没有交给发送队列：${err instanceof Error ? err.message : String(err)}`);
    }
    await ledger.exclusive(async () => {
      if (task.delivered) return;
      task.delivered = true;
      await ledger.save().catch(err => deps.logger.error(`白纸账本写入失败（已交付标记）: ${err}`));
    });
    deps.logger.info(`白纸任务 ${task.id} 的成品 ${artifactId} 已交给发送队列（房间 ${ctx.sessionId}）`);
    return done({
      taskId: task.id,
      artifactId,
      message: '已交给发送队列；不代表对方已收到，投递失败时之后的回合会看到投递失败记录',
    });
  }

  tools.registerGroup({ name: 'paper', label: '白纸', description: '把任务交给远端代理并取回成品' });

  tools.register({
    groups: ['paper'],
    definition: {
      type: 'function',
      function: {
        name: 'paper_task',
        description:
          '把一件要写代码、做网页、做图或动画的任务交给远端代理（白纸）去做。只在群友当面提出需求时用；' +
          '原文会先在本群回显，完成后宿主会在本群通知你，再用 paper_send 按成品编号发回。每件任务都花钱，有每日上限。',
        parameters: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: `交给远端的任务原文，最多 ${MAX_TEXT} 字：写清要做什么、交付什么（如单个 index.html、GIF、MP4）`,
            },
            name: { type: 'string', description: `简短的任务名，最多 ${MAX_NAME} 字` },
          },
          required: ['text', 'name'],
        },
      },
    },
    handler: paperTask,
  });

  tools.register({
    groups: ['paper'],
    definition: {
      type: 'function',
      function: {
        name: 'paper_status',
        description:
          '查看本房间所用白纸上排队、进行中与 24 小时内结束的任务：原文、状态、用时、费用与成品清单。' +
          '同一块白纸上别的房间的任务只给件数。给 task_id 时只看本房间的这一件（含远端说明）。',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string', description: '可选：任务编号（t-开头）' } },
        },
      },
    },
    handler: paperStatus,
  });

  tools.register({
    groups: ['paper'],
    definition: {
      type: 'function',
      function: {
        name: 'paper_cancel',
        description: '取消自己当面交给白纸的任务：排队中的直接移出；运行中的请远端取消这一轮，已发生的费用照常入账。',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string', description: '任务编号（t-开头）' } },
          required: ['task_id'],
        },
      },
    },
    handler: paperCancel,
  });

  tools.register({
    groups: ['paper'],
    definition: {
      type: 'function',
      function: {
        name: 'paper_send',
        description:
          '把白纸成品发回本群：artifact_id 用完成通知、待交付提示或 paper_status 里的成品编号。' +
          '只发 PNG、JPEG、GIF、WebP 图片、MP4 视频与单个 HTML 网页；结果只表示已交给发送队列，不代表对方已收到。',
        parameters: {
          type: 'object',
          properties: { artifact_id: { type: 'string', description: '成品编号（a-开头）' } },
          required: ['artifact_id'],
        },
      },
    },
    handler: paperSend,
  });
}
