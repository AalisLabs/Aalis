// ============================================================
// WebUI 白纸页与群会话里的白纸面板
//
// 白纸页（插件详情）分「白纸」「创作日志」两个标签。「白纸」：白纸表选中一块看它的属性、任务与成品，同一标签里另有今天的
// 花费与告警。会话面板只在开了白纸的房间出现：本群白纸的状态与今天的花费、进行中的任务、最近的成品，动作有取消与恢复。
// 管理动作（换新、归档代理、清空、恢复、不带旧工程继续、取消、放弃跟踪、核销预留、告警已读）都交给运行驱动，与定期检查、
// 工具走同一把锁；取消不看发起者；账本读取失败时一律不做。
//
// 成品按存储地址交给宿主：文件列由宿主签发下载句柄，一律当附件以 octet-stream 下发，文件名是宿主生成的产物 id 加判定类型的
// 扩展名，不用远端给的路径；判定为位图的另给预览列，宿主经 /api/media 按文件头再核一次。创作日志在插件数据里，详情显示
// 最近的记录（原文的代码块）与它的位置（两个文字组件：位置一句按读者语言，代码块不能作文字对象的参数）。工程包不经 WebUI
// 下载，白纸详情里显示它在本机的位置。
// 账本每次落盘后两页都重取；未读告警数与账本读取失败发提示。
// ============================================================

import type { PublishService } from '@aalis/api-publish';
import { type EgressReport, type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { StorageService } from '@aalis/api-storage';
import { type BoundWebui, type InfoItem, markdownCode, type NoticeHandle, type StatusValue } from '@aalis/api-webui';
import type { ServiceSelection } from '@aalis/core';
import { TextError, type TextRef, textOf } from '@aalis/schema-i18n';
import { artifactUri, bundleUri, paperDirUri, usageOf } from './artifacts.js';
import { dayKey, paperBudgetUsage } from './budget.js';
import { egressName, type PaperConfig, type PaperSpec, specOf } from './config.js';
import type { PaperDriver } from './driver.js';
import { type AgentRecord, type AlertRecord, type LedgerStore, type TaskRecord, UNFINISHED_STATES } from './ledger.js';
import { currentProgress } from './progress.js';
import { actorKey, type PaperFields, paperLabel, resolveRoomPaper, sharingRooms } from './rooms.js';
import { t } from './texts.js';
import { named, taskStateName } from './util.js';

const PAGE_KEY = 'paper';
/** 能在页面里预览的位图；宿主经 /api/media 按文件头再核一次 */
const BITMAPS: ReadonlySet<TaskRecord['artifacts'][number]['type']> = new Set(['png', 'jpeg', 'gif', 'webp']);
/** 会话面板里「最近的成品」最多几件 */
const RECENT_ARTIFACTS = 10;
/** 创作日志的详情显示最近几条记录 */
const RECENT_LOG_RECORDS = 20;

const VIA_TEXT: Record<NonNullable<TaskRecord['cancelledVia']>, TextRef> = {
  tool: t('viaTool'),
  webui: t('viaWebui'),
  timeout: t('viaTimeout'),
};

function taskStatus(task: TaskRecord): StatusValue {
  const base = taskStateName(task.state);
  const text = task.error
    ? t('stateWithError', { state: base, error: task.error })
    : task.cancelledVia
      ? t('annotated', { text: base, note: named(VIA_TEXT, task.cancelledVia) })
      : base;
  if (task.state === 'failed') return { text, state: 'error' };
  if (task.state === 'cancelled') return { text, state: 'inactive' };
  return UNFINISHED_STATES.has(task.state) ? { text, state: 'running' } : { text };
}

/** 绑定代理的状态（存储里的值照旧） */
const AGENT_STATES: Record<AgentRecord['state'], TextRef> = {
  creating: t('agentCreating'),
  active: t('agentActive'),
  archived: t('agentArchived'),
  retired: t('agentRetired'),
};

/** 告警的类别（存储里的值照旧） */
const ALERT_KINDS: Record<AlertRecord['kind'], TextRef> = {
  'unknown-run': t('alertUnknownRun'),
  'unknown-agent': t('alertUnknownAgent'),
  'cost-missing': t('alertCostMissing'),
  provider: t('alertProvider'),
  'delete-failed': t('alertDeleteFailed'),
  'cancel-failed': t('alertCancelFailed'),
  'storage-full': t('alertStorageFull'),
  'cost-estimated': t('alertCostEstimated'),
  'claim-unverified': t('alertClaimUnverified'),
  'claim-failed': t('alertClaimFailed'),
};

/** 成品的类型：其余是文件格式名，原样显示 */
const ARTIFACT_TYPES: Record<'other', TextRef> = { other: t('artifactOther') };

const PUBLICATION_TEXT: Record<NonNullable<TaskRecord['publication']>['state'], TextRef> = {
  pending: t('publicationPending'),
  submitted: t('publicationSubmitted'),
  live: t('publicationLive'),
  failed: t('publicationFailed'),
};

/** 任务的发布状态：目标与进度，没能上线的带原因 */
function publicationStatus({ target, state, reason }: NonNullable<TaskRecord['publication']>): TextRef {
  const label = named(PUBLICATION_TEXT, state);
  return reason
    ? t('publicationWithReason', { target, state: label, reason })
    : t('publicationState', { target, state: label });
}

/** 白纸的状态：停开写明原因 */
const paperStatus = (halted: { detail: string | TextRef } | undefined): StatusValue =>
  halted ? { text: t('paperHalted', { detail: halted.detail }), state: 'error' } : { text: t('paperOk') };

const TASK_COLUMNS = [
  { key: 'name', label: t('taskName'), primary: true },
  { key: 'state', label: t('status'), kind: 'status', primary: true },
  { key: 'progress', label: t('latestActivity') },
  { key: 'progressAt', label: t('activityAt'), kind: 'time' },
  { key: 'initiator', label: t('initiator') },
] as const;

const ARTIFACT_COLUMNS = [
  { key: 'file', label: t('file'), kind: 'file', primary: true },
  { key: 'preview', label: t('preview'), kind: 'image' },
  { key: 'task', label: t('task') },
  { key: 'type', label: t('type') },
  { key: 'size', label: t('size') },
] as const;

export function registerPaperPage(deps: {
  webui: BoundWebui;
  driver: PaperDriver;
  ledger: LedgerStore;
  storage: StorageService & Required<Pick<StorageService, 'resolveLocalPath'>>;
  remote: ServiceSelection<RemoteAgentProvider>;
  publish: ServiceSelection<PublishService>;
  sessionManager: ServiceSelection<SessionManagerService>;
  fields: PaperFields;
  cfg: PaperConfig;
  signal: AbortSignal;
  now: () => number;
}): void {
  const { webui, driver, ledger, storage, cfg } = deps;
  const today = () => dayKey(deps.now(), cfg.budgetTimeZone);
  const byNewest = (a: TaskRecord, b: TaskRecord) => b.createdAt - a.createdAt;

  /** 页面上列出的白纸：配置里的具名白纸，加上账本里出现过的 */
  const paperIds = (): string[] => {
    const ids = new Set([...cfg.papers.keys()].map(name => `n:${name}`));
    for (const id of Object.keys(ledger.data.papers)) ids.add(id);
    for (const task of Object.values(ledger.data.tasks)) ids.add(task.paperId);
    return [...ids];
  };
  /** 行动作与详情带来的白纸 id：只认页面上列得出的，免得给不存在的白纸建出账本条目 */
  const knownPaper = (paperId: string): string => {
    if (!paperIds().includes(paperId)) throw new TextError(t('noSuchPaper'));
    return paperId;
  };
  const tasksOf = (pick: (task: TaskRecord) => boolean) => Object.values(ledger.data.tasks).filter(pick).sort(byNewest);

  function taskRow(task: TaskRecord) {
    const progress = currentProgress(task, true);
    const publication = task.publication;
    return {
      id: task.id,
      name: task.name,
      state: taskStatus(task),
      progress: progress?.activity ?? '',
      progressAt: progress?.at,
      room: task.room,
      initiator: actorKey(task.initiator),
      duration: task.startedAt !== undefined ? t('elapsed', { ms: (task.endedAt ?? deps.now()) - task.startedAt }) : '',
      cost:
        task.costCents ??
        (ledger.data.reserves[task.id] ? t('reservedCents', { cents: ledger.data.reserves[task.id].cents }) : ''),
      text: task.text,
      publication: publication ? publicationStatus(publication) : t('noPublication'),
      cancellable: task.state === 'queued' || task.state === 'running',
      abandonable: driver.abandonRefusal(task) === undefined,
      writeOffable: !UNFINISHED_STATES.has(task.state) && Object.hasOwn(ledger.data.reserves, task.id),
    };
  }

  /** 成品行：文件交存储地址（宿主签发句柄），位图另给预览；已随清空删除的不列 */
  const artifactRows = (tasks: TaskRecord[]) =>
    tasks
      .filter(task => !task.artifactsCleared)
      .flatMap(task =>
        task.artifacts.map(artifact => {
          const uri = artifactUri(task.paperId, task.id, artifact);
          return {
            key: `${task.id}/${artifact.id}`,
            file: uri,
            preview: BITMAPS.has(artifact.type) ? uri : undefined,
            task: task.name,
            type: named(ARTIFACT_TYPES, artifact.type),
            size: t('sizeValue', { bytes: artifact.sizeBytes }),
            rel: artifact.rel,
          };
        }),
      );

  async function egressText(paperId: string): Promise<string | TextRef> {
    const spec = specOf(cfg, paperId);
    if (!spec?.remoteAgentType) return '';
    const provider = resolveRemoteAgent(deps.remote, spec.remoteAgentType);
    if (!provider) return t('providerAbsent');
    let egress: EgressReport;
    try {
      egress = await provider.use.egress(deps.signal);
    } catch (err) {
      return t('readFailed', { error: textOf(err) });
    }
    const shown = { mode: egressName(egress.mode), ceiling: egressName(spec.remoteAgentEgress) };
    return t(egress.source === 'owner-config' ? 'egressUnverified' : 'egressVerified', shown);
  }

  async function usageText(paperId: string): Promise<string | TextRef> {
    try {
      const used = await usageOf(storage, paperDirUri(paperId));
      return t('usageValue', { used, limit: cfg.artifacts.maxPaperBytes });
    } catch (err) {
      return t('readFailed', { error: textOf(err) });
    }
  }

  async function bundleText(paperId: string): Promise<string | TextRef> {
    const uri = bundleUri(paperId);
    let size: number;
    try {
      size = (await storage.stat(uri)).size;
    } catch {
      return '';
    }
    let where = uri;
    try {
      where = await storage.resolveLocalPath(uri);
    } catch {
      // 存储提供者给不出本机路径时显示 URI
    }
    return t('annotated', { text: where, note: t('sizeValue', { bytes: size }) });
  }

  /** 这块白纸的每日额度一句话 */
  const budgetLimit = (spec: PaperSpec | undefined) =>
    !spec
      ? t('paperGone')
      : spec.dailyCents === undefined
        ? cfg.globalDailyCents === undefined
          ? t('budgetUnlimited')
          : t('budgetShared')
        : spec.dailyCents === 0
          ? t('budgetZero')
          : t('budgetCents', { cents: spec.dailyCents });

  /** 允许的发布目标一个个列出：地址与能不能用；作品站给的不可用原因原样作参数 */
  function publishTargetsText(spec: PaperSpec | undefined): TextRef {
    if (!spec) return t('paperGoneParen');
    if (spec.publishTargets.length === 0) return t('publishForbidden');
    const noted = (text: string | TextRef, note: TextRef) => t('annotated', { text, note });
    if (!deps.publish.present) {
      return t('items', { items: spec.publishTargets.map(name => noted(name, t('publishServiceAbsent'))) });
    }
    const service = deps.publish.use;
    try {
      const allowed = new Set(spec.publishTargets);
      const byName = new Map(
        service
          .listSurfaces()
          .filter(surface => allowed.has(surface.name))
          .map(surface => [surface.name, surface]),
      );
      const items = spec.publishTargets.map(name => {
        const surface = byName.get(name);
        if (!surface) return noted(name, t('unregistered'));
        const title = surface.label && surface.label !== name ? t('targetTitle', { name, label: surface.label }) : name;
        const where = surface.baseUrl ? t('targetUrl', { title, url: surface.baseUrl }) : title;
        const state = surface.available
          ? t('available')
          : surface.reason
            ? t('unavailableBecause', { reason: surface.reason })
            : t('unavailable');
        return noted(where, state);
      });
      return t('items', { items });
    } catch {
      return t('targetsReadFailed');
    }
  }

  async function paperInfo(paperId: string): Promise<InfoItem[]> {
    const state = ledger.data.papers[paperId];
    const spec = specOf(cfg, paperId);
    const { spentCents, unattributedCents, reservedCents } = paperBudgetUsage(ledger.data, today(), paperId);
    const { labels, shared } = sharingRooms(deps.sessionManager.use, deps.fields, ledger.data, paperId);
    const budget = { limit: budgetLimit(spec), spent: spentCents, reserved: reservedCents };
    return [
      {
        label: t('sharingRooms'),
        // 不共用时至多一个房间
        value: shared ? t('sharedRooms', { count: labels.length, rooms: labels }) : (labels[0] ?? ''),
      },
      { label: t('remoteType'), value: spec ? spec.remoteAgentType || t('notConfigured') : t('paperGoneParen') },
      { label: t('egress'), value: await egressText(paperId) },
      { label: t('availableTargets'), value: publishTargetsText(spec) },
      {
        label: t('defaultTargetLabel'),
        value: !spec?.publishTargets.length
          ? t('publishForbidden')
          : (spec.defaultPublishTarget ??
            (spec.publishTargets.length === 1 ? spec.publishTargets[0] : t('chooseEachTime'))),
      },
      {
        label: t('dailyBudget'),
        value:
          unattributedCents > 0
            ? t('dailyBudgetUnattributed', { ...budget, unattributed: unattributedCents })
            : t('dailyBudgetValue', budget),
      },
      { label: t('usage'), value: await usageText(paperId) },
      { label: t('bundle'), value: await bundleText(paperId) },
      {
        label: t('haltReason'),
        value: state?.halted ? t('haltedAt', { detail: state.halted.detail, at: state.halted.at }) : '',
      },
    ];
  }

  function spendRows() {
    const day = today();
    const spend = ledger.data.spend[day] ?? { global: 0, rooms: {}, users: {} };
    const reserves = Object.values(ledger.data.reserves);
    const todays = Object.values(ledger.data.tasks).filter(task => dayKey(task.createdAt, cfg.budgetTimeZone) === day);
    const sum = (list: Array<{ cents: number }>) => list.reduce((total, r) => total + r.cents, 0);
    const rooms = new Set([
      ...Object.keys(spend.rooms),
      ...reserves.map(r => r.room),
      ...todays.map(task => task.room),
    ]);
    const users = new Set([
      ...Object.keys(spend.users),
      ...reserves.map(r => r.user),
      ...todays.map(task => actorKey(task.initiator)),
    ]);
    return [
      {
        key: 'global',
        scope:
          cfg.globalDailyCents === undefined
            ? t('globalScope', { day })
            : t('globalScopeLimit', { day, cents: cfg.globalDailyCents }),
        cents: spend.global,
        tasks: todays.length,
        reserved: sum(reserves),
      },
      ...[...rooms].map(room => ({
        key: `room:${room}`,
        scope: t('roomScope', { room }),
        cents: spend.rooms[room] ?? 0,
        tasks: todays.filter(task => task.room === room).length,
        reserved: sum(reserves.filter(r => r.room === room)),
      })),
      ...[...users].map(user => ({
        key: `user:${user}`,
        scope: t('initiatorScope', { user }),
        cents: spend.users[user]?.cents ?? 0,
        tasks: todays.filter(task => actorKey(task.initiator) === user).length,
        reserved: sum(reserves.filter(r => r.user === user)),
      })),
    ];
  }

  // ----- 动作 -----

  const writable = () => {
    if (ledger.failure) throw new TextError(t('ledgerDown'));
  };
  /** 白纸上的动作：驱动回原因即拒绝 */
  const onPaper =
    (run: (paperId: string) => Promise<TextRef | undefined>, message: TextRef) =>
    async ({ rowKey }: { rowKey: string }) => {
      writable();
      const refused = await run(knownPaper(rowKey));
      if (refused) throw new TextError(refused);
      return message;
    };
  const onTask =
    (run: (taskId: string) => Promise<TextRef | undefined>, message: TextRef) =>
    async ({ rowKey }: { rowKey: string }) => {
      writable();
      const refused = await run(rowKey);
      if (refused) throw new TextError(refused);
      return message;
    };
  async function cancelTask(taskId: string): Promise<TextRef> {
    writable();
    const result = await driver.cancel(taskId, 'webui');
    if (!result.ok) throw new TextError(result.error);
    return result.message ?? t('cancelled');
  }
  /** 创作日志的任务 id：只认宿主生成的形状，免得拼进存储路径 */
  const logTaskId = (id: string) => {
    if (!/^t-[a-f0-9]{8}$/.test(id)) throw new TextError(t('badTaskId'));
    return id;
  };
  const logClearable = (taskId: string) => {
    const task = ledger.data.tasks[taskId];
    return !(
      task &&
      (UNFINISHED_STATES.has(task.state) ||
        task.publication?.state === 'pending' ||
        task.publication?.state === 'submitted')
    );
  };

  const page = webui.definePage({
    key: PAGE_KEY,
    title: t('paper'),
    icon: 'file',
    actions: {
      rotatePaper: {
        label: t('rotate'),
        effect: 'destructive',
        confirm: t('rotateConfirm'),
        row: true,
        handler: onPaper(async paperId => {
          await driver.rotate(paperId);
          return undefined;
        }, t('rotated')),
      },
      archivePaper: {
        label: t('archiveAgent'),
        effect: 'write',
        row: true,
        handler: onPaper(paperId => driver.archive(paperId), t('archived')),
      },
      clearPaper: {
        label: t('clear'),
        effect: 'destructive',
        confirm: t('clearConfirm'),
        row: true,
        handler: onPaper(paperId => driver.clear(paperId), t('cleared')),
      },
      resumePaper: {
        label: t('resume'),
        effect: 'write',
        row: true,
        handler: onPaper(async paperId => ((await driver.resume(paperId)) ? undefined : t('notHalted')), t('resumed')),
      },
      freshStartPaper: {
        label: t('freshStart'),
        effect: 'destructive',
        confirm: t('freshStartConfirm'),
        row: true,
        handler: onPaper(paperId => driver.freshStart(paperId), t('freshStarted')),
      },
      cancelTask: {
        label: t('cancelTask'),
        effect: 'destructive',
        confirm: t('cancelConfirm'),
        row: true,
        handler: ({ rowKey }) => cancelTask(rowKey),
      },
      abandonTask: {
        label: t('abandon'),
        effect: 'destructive',
        confirm: t('abandonConfirm'),
        row: true,
        handler: onTask(taskId => driver.abandon(taskId), t('abandoned')),
      },
      writeOffReserve: {
        label: t('writeOff'),
        effect: 'destructive',
        confirm: t('writeOffConfirm'),
        row: true,
        handler: onTask(taskId => driver.writeOff(taskId), t('writtenOff')),
      },
      acknowledgeAlert: {
        label: t('markRead'),
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          writable();
          if (!(await driver.acknowledge(rowKey))) throw new TextError(t('noUnreadAlert'));
          return t('markedRead');
        },
      },
      clearTaskLog: {
        label: t('deleteLog'),
        effect: 'destructive',
        confirm: t('deleteLogConfirm'),
        row: true,
        async handler({ rowKey }) {
          const id = logTaskId(rowKey);
          if (!logClearable(id)) throw new TextError(t('logBusy'));
          try {
            await driver.journal.remove(id);
          } catch (err) {
            throw new TextError(t('deleteLogFailed', { error: textOf(err) }));
          }
          page.invalidate('logs');
          return t('logDeleted');
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'papers',
          title: t('papersTab'),
          content: [
            {
              type: 'table',
              id: 'papers',
              rowKey: 'paperId',
              empty: t('noPapers'),
              columns: [
                { key: 'name', label: t('nameLabel'), primary: true },
                { key: 'status', label: t('status'), kind: 'status', primary: true },
                { key: 'agent', label: t('boundAgent') },
                { key: 'spent', label: t('spentToday') },
              ],
              rowActions: [
                { action: 'resumePaper', visibleWhen: 'halted' },
                { action: 'archivePaper' },
                { action: 'rotatePaper' },
                { action: 'freshStartPaper' },
                { action: 'clearPaper' },
              ],
              data: () =>
                paperIds().map(paperId => {
                  const state = ledger.data.papers[paperId];
                  const agent = state?.binding ? ledger.data.agents[state.binding] : undefined;
                  return {
                    paperId,
                    name: paperLabel(paperId),
                    status: paperStatus(state?.halted),
                    agent: agent ? t('annotated', { text: agent.name, note: named(AGENT_STATES, agent.state) }) : '',
                    spent: paperBudgetUsage(ledger.data, today(), paperId).spentCents,
                    halted: state?.halted !== undefined,
                  };
                }),
              detail: [
                { type: 'info', id: 'paper', data: ({ rowKey }) => paperInfo(knownPaper(rowKey)) },
                {
                  type: 'table',
                  id: 'paperTasks',
                  label: t('tasks'),
                  rowKey: 'id',
                  empty: t('noPaperTasks'),
                  columns: [
                    ...TASK_COLUMNS,
                    { key: 'room', label: t('room') },
                    { key: 'duration', label: t('duration') },
                    { key: 'cost', label: t('costCents') },
                    { key: 'publication', label: t('publication') },
                    { key: 'text', label: t('request'), kind: 'long-text' },
                    { key: 'id', label: 'ID', kind: 'code' },
                  ],
                  rowActions: [
                    { action: 'cancelTask', visibleWhen: 'cancellable' },
                    { action: 'abandonTask', visibleWhen: 'abandonable' },
                    { action: 'writeOffReserve', visibleWhen: 'writeOffable' },
                  ],
                  data: ({ rowKey }) => tasksOf(task => task.paperId === knownPaper(rowKey)).map(taskRow),
                },
                {
                  type: 'table',
                  id: 'paperArtifacts',
                  label: t('outputs'),
                  rowKey: 'key',
                  empty: t('noPaperOutputs'),
                  columns: [...ARTIFACT_COLUMNS, { key: 'rel', label: t('remotePath'), kind: 'long-text' }],
                  data: ({ rowKey }) => artifactRows(tasksOf(task => task.paperId === knownPaper(rowKey))),
                },
              ],
            },
            {
              type: 'table',
              id: 'spend',
              label: t('todaySpend'),
              rowKey: 'key',
              columns: [
                { key: 'scope', label: t('scope'), primary: true },
                { key: 'cents', label: t('costCents'), primary: true },
                { key: 'tasks', label: t('taskCount') },
                { key: 'reserved', label: t('reservedColumn') },
              ],
              data: spendRows,
            },
            {
              type: 'table',
              id: 'alerts',
              label: t('alerts'),
              rowKey: 'id',
              empty: t('noAlerts'),
              columns: [
                { key: 'message', label: t('message'), kind: 'long-text', primary: true },
                { key: 'status', label: t('status'), kind: 'status', primary: true },
                { key: 'kind', label: t('kind') },
                { key: 'at', label: t('time'), kind: 'time' },
              ],
              rowActions: [{ action: 'acknowledgeAlert', visibleWhen: 'unread' }],
              data: () =>
                [...ledger.data.alerts]
                  .sort((a, b) => b.at - a.at)
                  .map(alert => ({
                    id: alert.id,
                    message: alert.message,
                    status: alert.acknowledged
                      ? { text: t('read'), state: 'inactive' as const }
                      : { text: t('unread'), state: 'attention' as const },
                    kind: named(ALERT_KINDS, alert.kind),
                    at: alert.at,
                    unread: !alert.acknowledged,
                  })),
            },
          ],
        },
        {
          key: 'logs',
          title: t('logsTab'),
          content: [
            {
              type: 'table',
              id: 'logs',
              rowKey: 'taskId',
              empty: t('noLogs'),
              columns: [
                { key: 'name', label: t('taskName'), primary: true },
                { key: 'entries', label: t('entries'), primary: true },
                { key: 'taskId', label: t('taskId'), kind: 'code' },
              ],
              rowActions: [{ action: 'clearTaskLog', visibleWhen: 'clearable' }],
              data: async () =>
                (await driver.journal.list()).map(row => ({
                  taskId: row.taskId,
                  entries: row.entries,
                  name: ledger.data.tasks[row.taskId]?.name ?? t('taskArchived'),
                  clearable: logClearable(row.taskId),
                })),
              detail: [
                {
                  type: 'markdown',
                  id: 'logRecent',
                  label: t('recentRecords', { count: RECENT_LOG_RECORDS }),
                  async data({ rowKey }) {
                    const recent = await driver.journal.recent(logTaskId(rowKey), RECENT_LOG_RECORDS);
                    return recent ? markdownCode(recent, 'json') : t('noLogYet');
                  },
                },
                {
                  type: 'markdown',
                  id: 'logLocation',
                  data: ({ rowKey }) => t('fullLogAt', { uri: driver.journal.uri(logTaskId(rowKey)) }),
                },
              ],
            },
          ],
        },
      ],
    },
  });

  // 群会话里的白纸面板：只在开了白纸的房间出现，数据按会话 id 取
  const roomPage = webui.definePage({
    key: 'paper-room',
    title: t('paper'),
    icon: 'file',
    placement: 'session',
    applies: ({ sessionId, kind }) => kind === 'room' && deps.fields.get(sessionId).paperEnabled === true,
    actions: {
      cancelTask: {
        label: t('cancelTask'),
        effect: 'destructive',
        confirm: t('cancelConfirm'),
        row: true,
        handler({ rowKey, ctx }) {
          if (ledger.data.tasks[rowKey]?.room !== ctx.sessionId) throw new TextError(t('notInThisRoom'));
          return cancelTask(rowKey);
        },
      },
      resumeRoomPaper: {
        label: t('resumeRoomPaper'),
        effect: 'write',
        async handler({ ctx }) {
          writable();
          const paper = resolveRoomPaper(deps.sessionManager.use, deps.fields, cfg, ctx.sessionId, undefined);
          if ('unavailable' in paper) throw new TextError(paper.unavailable);
          if (!(await driver.resume(paper.paperId))) throw new TextError(t('notHalted'));
          return t('resumed');
        },
      },
    },
    content: [
      {
        type: 'info',
        id: 'room',
        async data({ ctx }) {
          const paper = resolveRoomPaper(deps.sessionManager.use, deps.fields, cfg, ctx.sessionId, undefined);
          if ('unavailable' in paper) return [{ label: t('paper'), value: paper.unavailable }];
          const day = today();
          const usage = paperBudgetUsage(ledger.data, day, paper.paperId);
          const limit = paper.room.remoteAgentRoomDailyCents;
          const roomReserved = Object.values(ledger.data.reserves)
            .filter(reserve => reserve.room === ctx.sessionId)
            .reduce((total, reserve) => total + reserve.cents, 0);
          return [
            { label: t('paper'), value: paperLabel(paper.paperId) },
            {
              label: t('status'),
              value: paperStatus(ledger.data.papers[paper.paperId]?.halted),
              kind: 'status' as const,
            },
            { label: t('roomSpentToday'), value: ledger.data.spend[day]?.rooms[ctx.sessionId] ?? 0 },
            { label: t('roomReserved'), value: roomReserved },
            {
              label: t('roomDailyLimit'),
              // 会话配置的原值：缺省不限，写坏了按 0，与受理时的判据一致
              value:
                limit === undefined || limit === null
                  ? t('roomUnlimited')
                  : typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
                    ? t('roomLimitCents', { cents: limit })
                    : t('roomLimitInvalid'),
            },
            { label: t('paperSpentToday'), value: usage.spentCents },
            { label: t('paperDailyLimit'), value: budgetLimit(paper.spec) },
          ];
        },
      },
      {
        type: 'table',
        id: 'tasks',
        label: t('roomTasks'),
        rowKey: 'id',
        empty: t('noRoomTasks'),
        columns: [...TASK_COLUMNS],
        rowActions: [{ action: 'cancelTask', visibleWhen: 'cancellable' }],
        data: ({ ctx }) =>
          tasksOf(task => task.room === ctx.sessionId && UNFINISHED_STATES.has(task.state)).map(taskRow),
      },
      {
        type: 'table',
        id: 'artifacts',
        label: t('recentOutputs'),
        rowKey: 'key',
        empty: t('noRoomOutputs'),
        columns: [...ARTIFACT_COLUMNS],
        data: ({ ctx }) => artifactRows(tasksOf(task => task.room === ctx.sessionId)).slice(0, RECENT_ARTIFACTS),
      },
      { type: 'actions', actions: ['resumeRoomPaper'] },
    ],
  });

  if (ledger.failure) {
    webui.notify({
      id: 'ledger',
      level: 'error',
      title: t('ledgerDownTitle'),
      detail: t('ledgerDownDetail', { failure: ledger.failure }),
      open: { page: PAGE_KEY },
    });
  }
  let unread: NoticeHandle | undefined;
  /** 账本落盘：两页重取，未读告警数（写进标题）发出或撤回提示 */
  const changed = () => {
    page.invalidate();
    roomPage.invalidate();
    const count = ledger.data.alerts.filter(alert => !alert.acknowledged).length;
    if (count === 0) {
      unread?.clear();
      unread = undefined;
      return;
    }
    unread = webui.notify({
      id: 'alerts',
      level: 'action',
      title: t('unreadAlerts', { count }),
      open: { page: PAGE_KEY },
    });
  };
  ledger.onChange(changed);
  changed();
}
