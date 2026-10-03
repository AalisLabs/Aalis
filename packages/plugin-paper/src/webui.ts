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
// 最近的记录与它的位置。工程包不经 WebUI 下载，白纸详情里显示它在本机的位置。
// 账本每次落盘后两页都重取；未读告警数与账本读取失败发提示。
// ============================================================

import type { PublishService } from '@aalis/api-publish';
import { type EgressReport, type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { StorageService } from '@aalis/api-storage';
import { type BoundWebui, type InfoItem, markdownCode, type NoticeHandle, type StatusValue } from '@aalis/api-webui';
import type { ServiceRef } from '@aalis/core';
import { artifactUri, bundleUri, paperDirUri, usageOf } from './artifacts.js';
import { dayKey, paperBudgetUsage } from './budget.js';
import { type PaperConfig, type PaperSpec, specOf } from './config.js';
import type { PaperDriver } from './driver.js';
import { type LedgerStore, type TaskRecord, UNFINISHED_STATES } from './ledger.js';
import { currentProgress } from './progress.js';
import { actorKey, paperLabel, resolveRoomPaper, sharingRooms } from './rooms.js';
import { describe, formatDuration, formatSize } from './util.js';

const PAGE_KEY = 'paper';
/** 能在页面里预览的位图；宿主经 /api/media 按文件头再核一次 */
const BITMAPS: ReadonlySet<TaskRecord['artifacts'][number]['type']> = new Set(['png', 'jpeg', 'gif', 'webp']);
/** 会话面板里「最近的成品」最多几件 */
const RECENT_ARTIFACTS = 10;
/** 创作日志的详情显示最近几条记录 */
const RECENT_LOG_RECORDS = 20;

const STATE_TEXT: Record<TaskRecord['state'], string> = {
  queued: '排队',
  starting: '开轮中',
  running: '运行中',
  collecting: '取回成品',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

function taskStatus(task: TaskRecord): StatusValue {
  const base = STATE_TEXT[task.state];
  const text = task.error ? `${base}：${task.error}` : task.cancelledVia ? `${base}（${task.cancelledVia}）` : base;
  if (task.state === 'failed') return { text, state: 'error' };
  if (task.state === 'cancelled') return { text, state: 'inactive' };
  return UNFINISHED_STATES.has(task.state) ? { text, state: 'running' } : { text };
}

/** 白纸的状态：停开写明原因 */
const paperStatus = (halted: { detail: string } | undefined): StatusValue =>
  halted ? { text: `停开：${halted.detail}`, state: 'error' } : { text: '正常' };

const TASK_COLUMNS = [
  { key: 'name', label: '任务名', primary: true },
  { key: 'state', label: '状态', kind: 'status', primary: true },
  { key: 'progress', label: '最近动作' },
  { key: 'progressAt', label: '动作时间', kind: 'time' },
  { key: 'initiator', label: '发起者' },
] as const;

const ARTIFACT_COLUMNS = [
  { key: 'file', label: '文件', kind: 'file', primary: true },
  { key: 'preview', label: '预览', kind: 'image' },
  { key: 'task', label: '任务' },
  { key: 'type', label: '类型' },
  { key: 'size', label: '大小' },
] as const;

export function registerPaperPage(deps: {
  webui: BoundWebui;
  driver: PaperDriver;
  ledger: LedgerStore;
  storage: StorageService & Required<Pick<StorageService, 'resolveLocalPath'>>;
  remote: ServiceRef<RemoteAgentProvider>;
  publish: ServiceRef<PublishService>;
  sessionManager: ServiceRef<SessionManagerService>;
  cfg: PaperConfig;
  signal: AbortSignal;
  now: () => number;
}): void {
  const { webui, driver, ledger, storage, cfg } = deps;
  const today = () => dayKey(deps.now(), cfg.budgetTimeZone);
  const byNewest = (a: TaskRecord, b: TaskRecord) => b.createdAt - a.createdAt;

  const formatTime = (ts: number) =>
    new Intl.DateTimeFormat('sv-SE', {
      timeZone: cfg.budgetTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(ts);

  /** 页面上列出的白纸：配置里的具名白纸，加上账本里出现过的 */
  const paperIds = (): string[] => {
    const ids = new Set([...cfg.papers.keys()].map(name => `n:${name}`));
    for (const id of Object.keys(ledger.data.papers)) ids.add(id);
    for (const task of Object.values(ledger.data.tasks)) ids.add(task.paperId);
    return [...ids];
  };
  /** 行动作与详情带来的白纸 id：只认页面上列得出的，免得给不存在的白纸建出账本条目 */
  const knownPaper = (paperId: string): string => {
    if (!paperIds().includes(paperId)) throw new Error('没有这块白纸');
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
      duration: task.startedAt !== undefined ? formatDuration((task.endedAt ?? deps.now()) - task.startedAt) : '',
      cost: task.costCents ?? (ledger.data.reserves[task.id] ? `预留 ${ledger.data.reserves[task.id].cents}` : ''),
      text: task.text,
      publication: publication
        ? `${publication.target}：${{ pending: '等待自动提交', submitted: '发布处理中', live: '已上线', failed: '未能上线' }[publication.state]}${publication.reason ? `（${publication.reason}）` : ''}`
        : '不发布',
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
            type: artifact.type,
            size: formatSize(artifact.sizeBytes),
            rel: artifact.rel,
          };
        }),
      );

  async function egressText(paperId: string): Promise<string> {
    const spec = specOf(cfg, paperId);
    if (!spec?.remoteAgentType) return '';
    const provider = resolveRemoteAgent(deps.remote, spec.remoteAgentType);
    if (!provider) return '提供者不在场';
    let egress: EgressReport;
    try {
      egress = await provider.instance.egress(deps.signal);
    } catch (err) {
      return `读取失败：${describe(err)}`;
    }
    const source = egress.source === 'owner-config' ? '（owner 配置，未核实）' : '';
    return `${egress.mode}${source}；上限 ${spec.remoteAgentEgress}`;
  }

  async function usageText(paperId: string): Promise<string> {
    try {
      const used = await usageOf(storage, paperDirUri(paperId));
      return `${formatSize(used)} / ${formatSize(cfg.artifacts.maxPaperBytes)}`;
    } catch (err) {
      return `读取失败：${describe(err)}`;
    }
  }

  async function bundleText(paperId: string): Promise<string> {
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
    return `${where}（${formatSize(size)}）`;
  }

  /** 这块白纸的每日额度一句话 */
  const budgetLimit = (spec: PaperSpec | undefined) =>
    !spec
      ? '配置里已没有这块白纸'
      : spec.dailyCents === undefined
        ? cfg.globalDailyCents === undefined
          ? '不限额（这块白纸与全局都没设上限；房间上限另算）'
          : '不单独限额（仍受全局与房间限制）'
        : spec.dailyCents === 0
          ? '上限 0 美分（禁任务）'
          : `上限 ${spec.dailyCents} 美分`;

  function publishTargetsText(spec: PaperSpec | undefined): string {
    if (!spec) return '（配置里已没有这块白纸）';
    if (spec.publishTargets.length === 0) return '（禁止发布）';
    const service = deps.publish.current;
    if (!service) return spec.publishTargets.map(name => `${name}（发布服务不在场）`).join('、');
    try {
      const allowed = new Set(spec.publishTargets);
      const byName = new Map(
        service
          .listSurfaces()
          .filter(surface => allowed.has(surface.name))
          .map(surface => [surface.name, surface]),
      );
      return spec.publishTargets
        .map(name => {
          const surface = byName.get(name);
          if (!surface) return `${name}（未登记）`;
          const title = surface.label && surface.label !== name ? `${name}／${surface.label}` : name;
          return `${title}${surface.baseUrl ? `：${surface.baseUrl}` : ''}（${surface.available ? '可用' : `不可用${surface.reason ? `：${surface.reason}` : ''}`}）`;
        })
        .join('、');
    } catch {
      return '（发布目标读取失败）';
    }
  }

  async function paperInfo(paperId: string): Promise<InfoItem[]> {
    const state = ledger.data.papers[paperId];
    const spec = specOf(cfg, paperId);
    const { spentCents, unattributedCents, reservedCents } = paperBudgetUsage(ledger.data, today(), paperId);
    const { labels, shared } = sharingRooms(deps.sessionManager.require(), ledger.data, paperId);
    return [
      { label: '共用的房间', value: shared ? `共用（${labels.length}）：${labels.join('、')}` : labels.join('') },
      { label: '远端类型', value: spec ? spec.remoteAgentType || '（未配置）' : '（配置里已没有这块白纸）' },
      { label: '出网', value: await egressText(paperId) },
      { label: '可用发布目标', value: publishTargetsText(spec) },
      {
        label: '默认发布目标',
        value: !spec?.publishTargets.length
          ? '（禁止发布）'
          : (spec.defaultPublishTarget ?? (spec.publishTargets.length === 1 ? spec.publishTargets[0] : '（每次选择）')),
      },
      {
        label: '每日额度',
        value:
          `${budgetLimit(spec)}；已记 ${spentCents} 美分；预留 ${reservedCents} 美分` +
          (unattributedCents > 0 ? `；未归属费用（含旧账）${unattributedCents} 美分，保守计入每块白纸额度` : ''),
      },
      { label: '目录占用 / 上限', value: await usageText(paperId) },
      { label: '工程包（本机位置）', value: await bundleText(paperId) },
      { label: '停开原因', value: state?.halted ? `${state.halted.detail}（${formatTime(state.halted.at)}）` : '' },
    ];
  }

  function spendRows() {
    const day = today();
    const spend = ledger.data.spend[day] ?? { global: 0, rooms: {}, users: {} };
    const reserves = Object.values(ledger.data.reserves);
    const todays = Object.values(ledger.data.tasks).filter(t => dayKey(t.createdAt, cfg.budgetTimeZone) === day);
    const sum = (list: Array<{ cents: number }>) => list.reduce((total, r) => total + r.cents, 0);
    const rooms = new Set([...Object.keys(spend.rooms), ...reserves.map(r => r.room), ...todays.map(t => t.room)]);
    const users = new Set([
      ...Object.keys(spend.users),
      ...reserves.map(r => r.user),
      ...todays.map(t => actorKey(t.initiator)),
    ]);
    return [
      {
        key: 'global',
        scope: `全局（${day}，${cfg.globalDailyCents === undefined ? '不限额' : `上限 ${cfg.globalDailyCents} 美分`}）`,
        cents: spend.global,
        tasks: todays.length,
        reserved: sum(reserves),
      },
      ...[...rooms].map(room => ({
        key: `room:${room}`,
        scope: `房间 ${room}`,
        cents: spend.rooms[room] ?? 0,
        tasks: todays.filter(t => t.room === room).length,
        reserved: sum(reserves.filter(r => r.room === room)),
      })),
      ...[...users].map(user => ({
        key: `user:${user}`,
        scope: `发起者 ${user}`,
        cents: spend.users[user]?.cents ?? 0,
        tasks: todays.filter(t => actorKey(t.initiator) === user).length,
        reserved: sum(reserves.filter(r => r.user === user)),
      })),
    ];
  }

  // ----- 动作 -----

  const writable = () => {
    if (ledger.failure) throw new Error('白纸账本读取失败，等 owner 处理');
  };
  /** 白纸上的动作：驱动回原因即拒绝 */
  const onPaper =
    (run: (paperId: string) => Promise<string | undefined>, message: string) =>
    async ({ rowKey }: { rowKey: string }) => {
      writable();
      const refused = await run(knownPaper(rowKey));
      if (refused) throw new Error(refused);
      return message;
    };
  const onTask =
    (run: (taskId: string) => Promise<string | undefined>, message: string) =>
    async ({ rowKey }: { rowKey: string }) => {
      writable();
      const refused = await run(rowKey);
      if (refused) throw new Error(refused);
      return message;
    };
  async function cancelTask(taskId: string): Promise<string> {
    writable();
    const result = await driver.cancel(taskId, 'webui');
    if (!result.ok) throw new Error(result.error);
    return result.message ?? '已取消';
  }
  const CANCEL_CONFIRM = '取消这件任务？运行中的会请远端取消这一轮，已发生的费用照常入账。';
  /** 创作日志的任务 id：只认宿主生成的形状，免得拼进存储路径 */
  const logTaskId = (id: string) => {
    if (!/^t-[a-f0-9]{8}$/.test(id)) throw new Error('任务 ID 无效');
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
    title: '白纸',
    icon: 'file',
    actions: {
      rotatePaper: {
        label: '换新',
        effect: 'destructive',
        confirm: '下一件任务建新代理。换新只重置对话，工程包照常带到新代理；要清掉工作区用「清空」。继续？',
        row: true,
        handler: onPaper(async paperId => {
          await driver.rotate(paperId);
          return undefined;
        }, '下一件任务建新代理'),
      },
      archivePaper: {
        label: '归档代理',
        effect: 'write',
        row: true,
        handler: onPaper(paperId => driver.archive(paperId), '已归档'),
      },
      clearPaper: {
        label: '清空',
        effect: 'destructive',
        confirm:
          '清空这块白纸：取消排队的任务，删除远端代理（连同它的对话与工作区）与本机的白纸目录（成品与工程包）。任务记录保留。继续？',
        row: true,
        handler: onPaper(paperId => driver.clear(paperId), '已清空'),
      },
      resumePaper: {
        label: '恢复',
        effect: 'write',
        row: true,
        handler: onPaper(async paperId => ((await driver.resume(paperId)) ? undefined : '这块白纸没有停开'), '已恢复'),
      },
      freshStartPaper: {
        label: '不带旧工程继续',
        effect: 'destructive',
        confirm:
          '旧工程包永久取不到时用：新代理不再等旧工程包，从它自己的工作区（或空工程）继续。白纸上的成品与任务记录保留，旧工程里没交接过来的进度丢失。继续？',
        row: true,
        handler: onPaper(paperId => driver.freshStart(paperId), '下一件任务不再等旧工程包'),
      },
      cancelTask: {
        label: '取消',
        effect: 'destructive',
        confirm: CANCEL_CONFIRM,
        row: true,
        handler: ({ rowKey }) => cancelTask(rowKey),
      },
      abandonTask: {
        label: '放弃跟踪',
        effect: 'destructive',
        confirm:
          '这件任务判为失败，远端这一轮可能仍在运行或已开出，费用等列得出、结束之后补记；下一件任务建新代理。继续？',
        row: true,
        handler: onTask(taskId => driver.abandon(taskId), '已放弃跟踪'),
      },
      writeOffReserve: {
        label: '核销预留',
        effect: 'destructive',
        confirm:
          '费用一直取不到时用：这件已结束任务还没入账的费用按它的预留额记进当天花费，预留释放，之后不再补取。继续？',
        row: true,
        handler: onTask(taskId => driver.writeOff(taskId), '已核销'),
      },
      acknowledgeAlert: {
        label: '已读',
        effect: 'write',
        row: true,
        async handler({ rowKey }) {
          writable();
          if (!(await driver.acknowledge(rowKey))) throw new Error('没有这条未读告警');
          return '已标为已读';
        },
      },
      clearTaskLog: {
        label: '删除日志',
        effect: 'destructive',
        confirm: '只删除这件任务的创作日志，不删除工程或作品。继续？',
        row: true,
        async handler({ rowKey }) {
          const id = logTaskId(rowKey);
          if (!logClearable(id)) throw new Error('任务仍在创作或发布中，不能删除日志');
          try {
            await driver.journal.remove(id);
          } catch (err) {
            throw new Error(`删除创作日志失败：${describe(err)}`);
          }
          page.invalidate('logs');
          return '已删除创作日志';
        },
      },
    },
    content: {
      tabs: [
        {
          key: 'papers',
          title: '白纸',
          content: [
            {
              type: 'table',
              id: 'papers',
              rowKey: 'paperId',
              empty: '还没有白纸',
              columns: [
                { key: 'name', label: '名字', primary: true },
                { key: 'status', label: '状态', kind: 'status', primary: true },
                { key: 'agent', label: '绑定代理' },
                { key: 'spent', label: '今天花费（美分）' },
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
                    agent: agent ? `${agent.name}（${agent.state}）` : '',
                    spent: paperBudgetUsage(ledger.data, today(), paperId).spentCents,
                    halted: state?.halted !== undefined,
                  };
                }),
              detail: [
                { type: 'info', id: 'paper', data: ({ rowKey }) => paperInfo(knownPaper(rowKey)) },
                {
                  type: 'table',
                  id: 'paperTasks',
                  label: '任务',
                  rowKey: 'id',
                  empty: '这块白纸还没有任务',
                  columns: [
                    ...TASK_COLUMNS,
                    { key: 'room', label: '房间' },
                    { key: 'duration', label: '用时' },
                    { key: 'cost', label: '花费（美分）' },
                    { key: 'publication', label: '上线进度' },
                    { key: 'text', label: '原文', kind: 'long-text' },
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
                  label: '成品',
                  rowKey: 'key',
                  empty: '这块白纸上没有成品',
                  columns: [...ARTIFACT_COLUMNS, { key: 'rel', label: '远端给的路径', kind: 'long-text' }],
                  data: ({ rowKey }) => artifactRows(tasksOf(task => task.paperId === knownPaper(rowKey))),
                },
              ],
            },
            {
              type: 'table',
              id: 'spend',
              label: '今天的花费',
              rowKey: 'key',
              columns: [
                { key: 'scope', label: '范围', primary: true },
                { key: 'cents', label: '花费（美分）', primary: true },
                { key: 'tasks', label: '件数' },
                { key: 'reserved', label: '预留中（美分）' },
              ],
              data: spendRows,
            },
            {
              type: 'table',
              id: 'alerts',
              label: '告警',
              rowKey: 'id',
              empty: '没有告警',
              columns: [
                { key: 'message', label: '说明', kind: 'long-text', primary: true },
                { key: 'status', label: '状态', kind: 'status', primary: true },
                { key: 'kind', label: '类别' },
                { key: 'at', label: '时间', kind: 'time' },
              ],
              rowActions: [{ action: 'acknowledgeAlert', visibleWhen: 'unread' }],
              data: () =>
                [...ledger.data.alerts]
                  .sort((a, b) => b.at - a.at)
                  .map(alert => ({
                    id: alert.id,
                    message: alert.message,
                    status: alert.acknowledged
                      ? { text: '已读', state: 'inactive' as const }
                      : { text: '未读', state: 'attention' as const },
                    kind: alert.kind,
                    at: alert.at,
                    unread: !alert.acknowledged,
                  })),
            },
          ],
        },
        {
          key: 'logs',
          title: '创作日志',
          content: [
            {
              type: 'table',
              id: 'logs',
              rowKey: 'taskId',
              empty: '还没有创作日志',
              columns: [
                { key: 'name', label: '任务名', primary: true },
                { key: 'entries', label: '记录数', primary: true },
                { key: 'taskId', label: '任务 ID', kind: 'code' },
              ],
              rowActions: [{ action: 'clearTaskLog', visibleWhen: 'clearable' }],
              data: async () =>
                (await driver.journal.list()).map(row => ({
                  taskId: row.taskId,
                  entries: row.entries,
                  name: ledger.data.tasks[row.taskId]?.name ?? '（任务记录已归档）',
                  clearable: logClearable(row.taskId),
                })),
              detail: [
                {
                  type: 'markdown',
                  id: 'logRecent',
                  label: `最近 ${RECENT_LOG_RECORDS} 条记录`,
                  async data({ rowKey }) {
                    const id = logTaskId(rowKey);
                    const recent = await driver.journal.recent(id, RECENT_LOG_RECORDS);
                    const records = recent ? markdownCode(recent, 'json') : '尚未记录创作日志；旧任务不会补录。';
                    return `${records}\n\n完整记录在 \`${driver.journal.uri(id)}\`。`;
                  },
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
    title: '白纸',
    icon: 'file',
    placement: 'session',
    applies: ({ sessionId, kind }) =>
      kind === 'room' && deps.sessionManager.require().resolveConfig(sessionId).paperEnabled === true,
    actions: {
      cancelTask: {
        label: '取消',
        effect: 'destructive',
        confirm: CANCEL_CONFIRM,
        row: true,
        handler({ rowKey, ctx }) {
          if (ledger.data.tasks[rowKey]?.room !== ctx.sessionId) throw new Error('本群没有这件任务');
          return cancelTask(rowKey);
        },
      },
      resumeRoomPaper: {
        label: '恢复白纸',
        effect: 'write',
        async handler({ ctx }) {
          writable();
          const paper = await resolveRoomPaper(deps.sessionManager.require(), cfg, ctx.sessionId, undefined);
          if ('unavailable' in paper) throw new Error(paper.unavailable);
          if (!(await driver.resume(paper.paperId))) throw new Error('这块白纸没有停开');
          return '已恢复';
        },
      },
    },
    content: [
      {
        type: 'info',
        id: 'room',
        async data({ ctx }) {
          const paper = await resolveRoomPaper(deps.sessionManager.require(), cfg, ctx.sessionId, undefined);
          if ('unavailable' in paper) return [{ label: '白纸', value: paper.unavailable }];
          const day = today();
          const usage = paperBudgetUsage(ledger.data, day, paper.paperId);
          const limit = paper.room.remoteAgentRoomDailyCents;
          const roomReserved = Object.values(ledger.data.reserves)
            .filter(reserve => reserve.room === ctx.sessionId)
            .reduce((total, reserve) => total + reserve.cents, 0);
          return [
            { label: '白纸', value: paperLabel(paper.paperId) },
            { label: '状态', value: paperStatus(ledger.data.papers[paper.paperId]?.halted), kind: 'status' as const },
            { label: '本群今天花费（美分）', value: ledger.data.spend[day]?.rooms[ctx.sessionId] ?? 0 },
            { label: '本群预留中（美分）', value: roomReserved },
            {
              label: '本群每天上限',
              // 会话配置的原值：缺省不限，写坏了按 0，与受理时的判据一致
              value:
                limit === undefined || limit === null
                  ? '不限'
                  : typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
                    ? `${limit} 美分`
                    : '写坏了，按 0 处理',
            },
            { label: '白纸今天花费（美分）', value: usage.spentCents },
            { label: '白纸每天上限', value: budgetLimit(paper.spec) },
          ];
        },
      },
      {
        type: 'table',
        id: 'tasks',
        label: '进行中的任务',
        rowKey: 'id',
        empty: '本群没有进行中的任务',
        columns: [...TASK_COLUMNS],
        rowActions: [{ action: 'cancelTask', visibleWhen: 'cancellable' }],
        data: ({ ctx }) =>
          tasksOf(task => task.room === ctx.sessionId && UNFINISHED_STATES.has(task.state)).map(taskRow),
      },
      {
        type: 'table',
        id: 'artifacts',
        label: '最近的成品',
        rowKey: 'key',
        empty: '本群还没有成品',
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
      title: '白纸账本读取失败',
      detail: `${ledger.failure}；远端任务一律不开，原文件不覆盖，修复或移走后重启`,
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
      title: `${count} 条白纸告警未读`,
      open: { page: PAGE_KEY },
    });
  };
  ledger.onChange(changed);
  changed();
}
