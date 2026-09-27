// ============================================================
// WebUI 白纸页：白纸、任务、成品、账本、告警五个表与 owner 的管理动作
//
// 页面动作只有 owner 调得到（宿主路由层的权限闸）。管理动作（换新、归档代理、清空、恢复、取消任务、放弃跟踪、
// 核销预留、告警已读）都交给运行驱动，与定期检查、工具走同一把锁；取消不看发起者。
//
// 成品经 readArtifact 以 { name, mime, base64 } 取回（页面动作只回 JSON，不会被浏览器当页面渲染）：mime 按
// 文件头判定，只有位图给对应类型，其余（含 HTML、SVG，也含账本记作位图、文件头却不是的）一律
// application/octet-stream；文件名用宿主生成的产物 id 加判定类型的扩展名，不用远端给的路径。WebUI 客户端只把
// 位图显示在页面里，其余只能下载。超过单文件上限的不读。工程包不经 WebUI 下载，白纸表里显示它在本机的位置。
// ============================================================

import { type EgressReport, type RemoteAgentProvider, resolveRemoteAgent } from '@aalis/api-remote-agent';
import type { SessionManagerService } from '@aalis/api-session-manager';
import type { StorageService } from '@aalis/api-storage';
import type { BoundWebui, WebuiFilePayload, WebuiPage } from '@aalis/api-webui';
import type { ServiceRef } from '@aalis/core';
import { artifactUri, bundleUri, EXTENSIONS, MIME_TYPES, paperDirUri, sniffType, usageOf } from './artifacts.js';
import { dayKey } from './budget.js';
import { type PaperConfig, specOf } from './config.js';
import type { PaperDriver } from './driver.js';
import type { LedgerStore, TaskRecord } from './ledger.js';
import { actorKey, paperLabel, sharingRooms } from './rooms.js';
import { describe, formatDuration, formatSize } from './util.js';

/** 能在页面里显示的位图；其余一律按下载处理 */
const BITMAPS: ReadonlySet<TaskRecord['artifacts'][number]['type']> = new Set(['png', 'jpeg', 'gif', 'webp']);
const OCTET_STREAM = 'application/octet-stream';

const PAPER_ICON =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/></svg>';

const PAGE: WebuiPage = {
  key: 'paper',
  label: '白纸',
  icon: PAPER_ICON,
  order: 54,
  content: [
    {
      type: 'tabs',
      items: [
        {
          key: 'papers',
          label: '白纸',
          content: [
            {
              type: 'table',
              source: 'listPapers',
              columns: [
                { key: 'name', label: '名字', nowrap: true },
                { key: 'rooms', label: '共用的房间', minWidth: 160 },
                { key: 'remoteAgentType', label: '远端类型', nowrap: true },
                { key: 'agent', label: '绑定代理', nowrap: true },
                { key: 'egress', label: '出网', minWidth: 140 },
                { key: 'usage', label: '目录占用 / 上限', nowrap: true },
                { key: 'bundle', label: '工程包（本机位置）', minWidth: 160 },
                { key: 'halted', label: '停开原因', minWidth: 160 },
              ],
              actions: [
                {
                  label: '换新',
                  method: 'rotatePaper',
                  confirm: '下一件任务建新代理。换新只重置对话，工程包照常带到新代理；要清掉工作区用「清空」。继续？',
                },
                { label: '归档代理', method: 'archivePaper' },
                {
                  label: '清空',
                  method: 'clearPaper',
                  confirm:
                    '清空这块白纸：取消排队的任务，删除远端代理（连同它的对话与工作区）与本机的白纸目录（成品与工程包）。任务记录保留。继续？',
                  danger: true,
                },
                { label: '恢复', method: 'resumePaper' },
              ],
              refresh: 30,
            },
          ],
        },
        {
          key: 'tasks',
          label: '任务',
          content: [
            {
              type: 'table',
              source: 'listTasks',
              searchable: true,
              columns: [
                { key: 'id', label: 'ID', nowrap: true },
                { key: 'room', label: '房间', nowrap: true },
                { key: 'initiator', label: '发起者', nowrap: true },
                { key: 'name', label: '任务名', minWidth: 120 },
                { key: 'state', label: '状态', minWidth: 100 },
                { key: 'duration', label: '用时', nowrap: true },
                { key: 'cost', label: '花费（美分）', nowrap: true },
                { key: 'text', label: '原文', minWidth: 200, maxWidth: 360, render: 'expandable-text' },
                { key: 'artifacts', label: '成品数', nowrap: true },
              ],
              actions: [
                {
                  label: '取消',
                  method: 'cancelTask',
                  confirm: '取消这件任务？运行中的会请远端取消这一轮，已发生的费用照常入账。',
                },
                {
                  label: '放弃跟踪',
                  method: 'abandonTask',
                  confirm:
                    '只在运行中的任务到点取消失败、白纸停开之后，或开轮中的任务认领失败之后可用：这件任务判为失败，' +
                    '远端这一轮可能仍在运行或已开出，费用等列得出、结束之后补记；下一件任务建新代理。继续？',
                  danger: true,
                },
                {
                  label: '核销预留',
                  method: 'writeOffReserve',
                  confirm:
                    '费用一直取不到时用：这件已结束任务还没入账的费用按它的预留额记进当天花费，预留释放，之后不再补取。继续？',
                },
              ],
              refresh: 30,
            },
          ],
        },
        {
          key: 'artifacts',
          label: '成品',
          content: [
            {
              type: 'table',
              source: 'listArtifacts',
              columns: [
                { key: 'taskId', label: '任务 ID', nowrap: true },
                { key: 'artifactId', label: '产物 ID', nowrap: true },
                { key: 'type', label: '类型', nowrap: true },
                { key: 'size', label: '大小', nowrap: true },
                { key: 'rel', label: '文件（远端给的路径）', minWidth: 200, render: 'file', method: 'readArtifact' },
              ],
              refresh: 30,
            },
          ],
        },
        {
          key: 'spend',
          label: '账本',
          content: [
            {
              type: 'table',
              source: 'listSpend',
              columns: [
                { key: 'scope', label: '范围', minWidth: 200 },
                { key: 'cents', label: '今天花费（美分）', nowrap: true },
                { key: 'tasks', label: '今天件数', nowrap: true },
                { key: 'reserved', label: '预留中（美分）', nowrap: true },
              ],
              refresh: 30,
            },
          ],
        },
        {
          key: 'alerts',
          label: '告警',
          content: [
            {
              type: 'table',
              source: 'listAlerts',
              columns: [
                { key: 'at', label: '时间', nowrap: true },
                { key: 'kind', label: '类别', nowrap: true },
                { key: 'message', label: '说明', minWidth: 240, render: 'expandable-text' },
                { key: 'status', label: '状态', nowrap: true },
              ],
              actions: [{ label: '已读', method: 'acknowledgeAlert' }],
              refresh: 30,
            },
          ],
        },
      ],
    },
  ],
};

const fail = (error: string) => ({ ok: false as const, error });

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function registerPaperPage(deps: {
  webui: BoundWebui;
  driver: PaperDriver;
  ledger: LedgerStore;
  storage: StorageService & Required<Pick<StorageService, 'resolveLocalPath'>>;
  remote: ServiceRef<RemoteAgentProvider>;
  sessionManager: ServiceRef<SessionManagerService>;
  cfg: PaperConfig;
  signal: AbortSignal;
  now: () => number;
}): void {
  const { webui, driver, ledger, storage, cfg } = deps;

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

  /** 行动作带来的白纸 id：只认页面上列得出的，免得给不存在的白纸建出账本条目 */
  const knownPaper = (value: unknown): string | undefined =>
    typeof value === 'string' && paperIds().includes(value) ? value : undefined;

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

  async function paperRow(paperId: string): Promise<Record<string, unknown>> {
    const state = ledger.data.papers[paperId];
    const spec = specOf(cfg, paperId);
    const { labels, shared } = sharingRooms(deps.sessionManager.require(), ledger.data, paperId);
    const agent = state?.binding ? ledger.data.agents[state.binding] : undefined;
    return {
      paperId,
      name: paperLabel(paperId),
      rooms: shared ? `共用（${labels.length}）：${labels.join('、')}` : labels.join(''),
      remoteAgentType: spec ? spec.remoteAgentType || '（未配置）' : '（配置里已没有这块白纸）',
      agent: agent ? `${agent.name}（${agent.state}）` : '',
      egress: await egressText(paperId),
      usage: await usageText(paperId),
      bundle: await bundleText(paperId),
      halted: state?.halted ? `${state.halted.detail}（${formatTime(state.halted.at)}）` : '',
    };
  }

  const byNewest = (a: TaskRecord, b: TaskRecord) => b.createdAt - a.createdAt;

  webui.registerPage(PAGE);

  webui.registerAction('listPapers', async () => Promise.all(paperIds().map(paperRow)));

  webui.registerAction('listTasks', async () => {
    const now = deps.now();
    return Object.values(ledger.data.tasks)
      .sort(byNewest)
      .map(t => ({
        id: t.id,
        room: t.room,
        initiator: actorKey(t.initiator),
        name: t.name,
        state: t.error ? `${t.state}：${t.error}` : t.cancelledVia ? `${t.state}（${t.cancelledVia}）` : t.state,
        duration: t.startedAt !== undefined ? formatDuration((t.endedAt ?? now) - t.startedAt) : '',
        cost: t.costCents ?? (ledger.data.reserves[t.id] ? `预留 ${ledger.data.reserves[t.id].cents}` : ''),
        text: t.text,
        artifacts: t.artifacts.length,
      }));
  });

  webui.registerAction('listArtifacts', async () =>
    Object.values(ledger.data.tasks)
      .filter(t => !t.artifactsCleared)
      .sort(byNewest)
      .flatMap(t =>
        t.artifacts.map(a => ({
          taskId: t.id,
          artifactId: a.id,
          type: a.type,
          size: formatSize(a.sizeBytes),
          rel: a.rel,
        })),
      ),
  );

  webui.registerAction('listSpend', async () => {
    const day = dayKey(deps.now(), cfg.budgetTimeZone);
    const spend = ledger.data.spend[day] ?? { global: 0, rooms: {}, users: {} };
    const reserves = Object.values(ledger.data.reserves);
    const today = Object.values(ledger.data.tasks).filter(t => dayKey(t.createdAt, cfg.budgetTimeZone) === day);
    const sum = (list: Array<{ cents: number }>) => list.reduce((total, r) => total + r.cents, 0);
    const rooms = new Set([...Object.keys(spend.rooms), ...reserves.map(r => r.room), ...today.map(t => t.room)]);
    const users = new Set([
      ...Object.keys(spend.users),
      ...reserves.map(r => r.user),
      ...today.map(t => actorKey(t.initiator)),
    ]);
    return [
      {
        scope: `全局（${day}，上限 ${cfg.globalDailyCents} 美分）`,
        cents: spend.global,
        tasks: today.length,
        reserved: sum(reserves),
      },
      ...[...rooms].map(room => ({
        scope: `房间 ${room}`,
        cents: spend.rooms[room] ?? 0,
        tasks: today.filter(t => t.room === room).length,
        reserved: sum(reserves.filter(r => r.room === room)),
      })),
      ...[...users].map(user => ({
        scope: `发起者 ${user}`,
        cents: spend.users[user]?.cents ?? 0,
        tasks: today.filter(t => actorKey(t.initiator) === user).length,
        reserved: sum(reserves.filter(r => r.user === user)),
      })),
    ];
  });

  webui.registerAction('listAlerts', async () =>
    [...ledger.data.alerts]
      .sort((a, b) => b.at - a.at)
      .map(a => ({
        id: a.id,
        at: formatTime(a.at),
        kind: a.kind,
        message: a.message,
        status: a.acknowledged ? '已读' : '未读',
      })),
  );

  webui.registerAction('readArtifact', async args => {
    const taskId = text(args.taskId);
    const task = Object.hasOwn(ledger.data.tasks, taskId) ? ledger.data.tasks[taskId] : undefined;
    const artifact = task?.artifacts.find(a => a.id === text(args.artifactId));
    if (!task || !artifact) return fail('账本里没有这件成品');
    if (task.artifactsCleared) return fail('这件成品已随白纸清空删除');
    const uri = artifactUri(task.paperId, task.id, artifact);
    const max = cfg.artifacts.maxFileBytes;
    let data: Buffer;
    try {
      const size = (await storage.stat(uri)).size;
      if (size > max) return fail(`文件 ${formatSize(size)}，超过单文件上限 ${formatSize(max)}`);
      data = (await storage.readFile(uri)) as Buffer;
    } catch (err) {
      return fail(`读取失败：${describe(err)}`);
    }
    const sniffed = sniffType('', data);
    const payload: WebuiFilePayload = {
      name: `${artifact.id}.${EXTENSIONS[artifact.type]}`,
      mime: sniffed !== 'other' && BITMAPS.has(sniffed) ? MIME_TYPES[sniffed] : OCTET_STREAM,
      base64: data.toString('base64'),
    };
    return payload;
  });

  /** 改账本的动作：账本读取失败时一律不做 */
  const mutating = (
    method: string,
    run: (args: Record<string, unknown>) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>,
  ) =>
    webui.registerAction(method, async args => (ledger.failure ? fail('白纸账本读取失败，等 owner 处理') : run(args)));

  const onPaper =
    (run: (paperId: string) => Promise<string | undefined>, message: string) =>
    async (args: Record<string, unknown>) => {
      const paperId = knownPaper(args.paperId);
      if (!paperId) return fail('没有这块白纸');
      const refused = await run(paperId);
      return refused ? fail(refused) : { ok: true as const, message };
    };

  mutating(
    'rotatePaper',
    onPaper(async paperId => {
      await driver.rotate(paperId);
      return undefined;
    }, '下一件任务建新代理'),
  );
  mutating(
    'archivePaper',
    onPaper(paperId => driver.archive(paperId), '已归档'),
  );
  mutating(
    'clearPaper',
    onPaper(paperId => driver.clear(paperId), '已清空'),
  );
  mutating(
    'resumePaper',
    onPaper(async paperId => ((await driver.resume(paperId)) ? undefined : '这块白纸没有停开'), '已恢复'),
  );
  mutating('cancelTask', args => driver.cancel(text(args.id), 'webui'));
  const onTask =
    (run: (taskId: string) => Promise<string | undefined>, message: string) =>
    async (args: Record<string, unknown>) => {
      const refused = await run(text(args.id));
      return refused ? fail(refused) : { ok: true as const, message };
    };
  mutating(
    'abandonTask',
    onTask(taskId => driver.abandon(taskId), '已放弃跟踪'),
  );
  mutating(
    'writeOffReserve',
    onTask(taskId => driver.writeOff(taskId), '已核销'),
  );
  mutating('acknowledgeAlert', async args =>
    (await driver.acknowledge(text(args.id))) ? { ok: true } : fail('没有这条未读告警'),
  );
}
