import { afterEach, describe, expect, it } from 'vitest';
import { type PublishService, publish } from '../../packages/api-publish/src/index.js';
import { type EgressReport, RemoteAgentError } from '../../packages/api-remote-agent/src/index.js';
import { placePaperId } from '../../packages/api-session-manager/src/index.js';
import type { ComponentView, DeclarativePageView, InfoItem } from '../../packages/api-webui/src/index.js';
import { provide } from '../../packages/core/src/index.js';
import type { PaperLedger, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import { defineTexts, isTextRef, resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { replyOf } from '../fixtures/page-host.js';
import {
  emptyLedger,
  fakeRemote,
  human,
  LEDGER_URI,
  PAPER,
  type PaperFiles,
  type PaperHub,
  PILOT_CONFIG,
  PILOT_ROOM,
  REMOTE,
  ROOM,
  ROOM2,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';
import { PNG, ScriptedRemote, text } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// WebUI 白纸页与群会话的白纸面板：经 webui-server 的真实登记表登记（质量门槛）、取数与调动作（闸门）。
// 白纸页分「白纸」「创作日志」两个标签：白纸表选中一块看属性、任务与成品，同一标签里另有今天的花费与告警。
// owner 的管理动作（换新、归档代理、清空、恢复、取消任务、放弃跟踪、核销预留、告警已读）经页面动作调运行驱动。
// 成品交存储地址：宿主签发下载句柄（一律当附件下发），只有记录里记作位图的给预览（宿主经 /api/media 按文件头再核）。
// 记录落盘后两页都重取；未读告警数与记录读取失败发提示。真实 App 装载插件，远端用 ScriptedRemote，真实时钟。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const PAPER_ID = `n:${PAPER}`;
/** ROOM 所在窗口的白纸（不写名字） */
const WINDOW_PAPER = placePaperId('onebot:group:20001');
const DIR = `paper:/n-${PAPER}`;
const ROOMY_CONFIG = { ...PILOT_CONFIG, globalDailyCents: 100_000 };
const ROOMY_ROOM = { ...PILOT_ROOM, remoteAgentRoomDailyCents: 100_000 };

type Row = Record<string, unknown>;

async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`等不到：${label}`);
}

async function hubWith(remote: ScriptedRemote, extra: { files?: PaperFiles; config?: Record<string, unknown> } = {}) {
  return startPaperHub({
    remotes: { [REMOTE]: remote },
    config: extra.config ?? ROOMY_CONFIG,
    rooms: { [ROOM]: ROOMY_ROOM },
    files: extra.files,
  });
}

async function accept(hub: PaperHub, name: string): Promise<string> {
  const res = await hub.call('paper_task', { text: `${name}的原文`, name, publish: false }, human('30001'));
  if (res.ok !== true) throw new Error(`paper_task 未受理：${String(res.error)}`);
  return String(res.taskId);
}

async function running(hub: PaperHub, taskId: string): Promise<string> {
  await waitFor(() => hub.ledger().tasks[taskId]?.state === 'running', `${taskId} 开轮`);
  return hub.ledger().tasks[taskId].runId ?? '';
}

/** 白纸页一个组件的数据，文字对象按原文 */
const rows = async (hub: PaperHub, id: string, query: Record<string, unknown> = {}) =>
  toSource(await hub.pages.data<Row[]>('paper', id, query));
const papers = (hub: PaperHub) => rows(hub, 'papers');
const tasks = (hub: PaperHub, paperId = PAPER_ID) => rows(hub, 'paperTasks', { rowKey: paperId });
const artifacts = (hub: PaperHub, paperId = PAPER_ID) =>
  hub.pages.data<Row[]>('paper', 'paperArtifacts', { rowKey: paperId });
const spend = (hub: PaperHub) => rows(hub, 'spend');
const alerts = (hub: PaperHub) => rows(hub, 'alerts');
/** 白纸详情的键值：名称 → 值 */
async function info(hub: PaperHub, paperId = PAPER_ID): Promise<Map<string, unknown>> {
  const items = await hub.pages.data<InfoItem[]>('paper', 'paper', { rowKey: paperId });
  return new Map(toSource(items).map(item => [item.label, item.value]));
}
/** 调白纸页的动作，回执与报错按原文 */
const act = async (hub: PaperHub, action: string, rowKey: string) =>
  toSource(await hub.pages.act('paper', action, { rowKey }));
const ok = (message: string) => ({ status: 200, body: { message } });
const refused = (error: string | RegExp) => ({
  status: 500,
  body: { error: typeof error === 'string' ? error : expect.stringMatching(error) },
});

/** 页面声明里按 id 找组件（含标签里的与详情里的） */
function component(view: DeclarativePageView, id: string): ComponentView {
  const screens = Array.isArray(view.content) ? [view.content] : view.content.tabs.map(tab => tab.content);
  const all = screens.flat().flatMap(c => [c, ...(('detail' in c && c.detail) || [])]);
  const found = all.find(c => 'id' in c && c.id === id);
  if (!found) throw new Error(`页面 ${view.key} 没有组件 ${id}`);
  return found;
}
const rowActionsOf = (hub: PaperHub, id: string) => {
  const table = component(hub.pages.view('paper'), id);
  return table.type === 'table' ? (table.rowActions ?? []) : [];
};

function doneTask(id: string, taskArtifacts: TaskRecord['artifacts'], over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    paperId: PAPER_ID,
    room: ROOM,
    platform: 'onebot',
    initiator: { platform: 'onebot', userId: '30001' },
    name: `任务 ${id}`,
    text: `原文 ${id}`,
    state: 'done',
    createdAt: Date.now() - 60_000,
    startedAt: Date.now() - 50_000,
    endedAt: Date.now() - 10_000,
    costCents: 12,
    artifacts: taskArtifacts,
    delivered: false,
    ...over,
  };
}

/** 记录里一件已完成的任务，成品文件照宿主的命名放进白纸根 */
function seeded(
  seeds: Array<{ task: TaskRecord; bytes: Record<string, Uint8Array> }>,
  mutate?: (ledger: PaperLedger) => void,
): PaperFiles {
  const ledger = emptyLedger();
  const files: PaperFiles = new Map();
  for (const { task, bytes } of seeds) {
    ledger.tasks[task.id] = task;
    for (const a of task.artifacts) {
      const ext = {
        png: 'png',
        jpeg: 'jpg',
        gif: 'gif',
        webp: 'webp',
        mp4: 'mp4',
        mov: 'mov',
        html: 'html',
        other: 'bin',
      }[a.type];
      files.set(`${DIR}/tasks/${task.id}/out/${a.id}.${ext}`, bytes[a.id]);
    }
  }
  mutate?.(ledger);
  files.set(LEDGER_URI, JSON.stringify(ledger));
  return files;
}

const unreadAlert = (ledger: PaperLedger) => {
  ledger.alerts.push({
    id: 'al-00000001',
    at: Date.now(),
    kind: 'unknown-agent',
    subject: 'bc-foreign',
    providerType: REMOTE,
    message: '账号下有未登记的代理 FOREIGN-AGENT',
    acknowledged: false,
  });
};

const HTML = text('<!doctype html><html><body><script>alert(1)</script></body></html>');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
const media = (uri: string) => `/api/media?${new URLSearchParams({ uri })}`;

/** 白纸页一个组件的数据按 language 渲染 */
const rowsIn = async (hub: PaperHub, language: string, id: string, query: Record<string, unknown> = {}) =>
  renderIn(await hub.pages.data<Row[]>('paper', id, query), language);
/** 动作的回执或报错按 language 渲染 */
const saidIn = (reply: { body: object }, language: string) => renderIn(replyOf(reply), language);
/** 白纸详情按 language 渲染后的各项 */
const infoIn = async (hub: PaperHub, language: string, paperId = PAPER_ID) =>
  renderIn(await hub.pages.data<InfoItem[]>('paper', 'paper', { rowKey: paperId }), language);
/** 停开时间：按读者语言的短日期时间，时区按服务进程 */
const shortTime = (at: number, language: string) =>
  new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(at);
/** 作品站交来的不可用原因：文字对象 */
const surfaceTexts = defineTexts({
  ns: '@zz/paper-webui-surfaces',
  language: 'zh-CN',
  source: { paused: '暂停' } as const,
  locales: { en: { paused: 'Paused' } },
});

describe('页面登记', () => {
  it('白纸页与会话面板都过登记门槛；白纸页分「白纸」「创作日志」两个标签', async () => {
    const hub = await startPaperHub();
    expect(hub.pages.logs).toEqual([]);
    const view = toSource(hub.pages.view('paper'));
    expect(view).toMatchObject({ title: '白纸', placement: 'plugin', icon: 'file' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual(['白纸', '创作日志']);
    expect(toSource(hub.pages.view('paper-room'))).toMatchObject({ title: '白纸', placement: 'session' });
  });

  it('动作按语义分效果：会丢东西的弹确认；恢复、放弃跟踪、核销与已读按行状态显示', async () => {
    const hub = await startPaperHub();
    const actions = toSource(hub.pages.view('paper').actions ?? {});
    expect(rowActionsOf(hub, 'papers')).toEqual([
      { action: 'resumePaper', visibleWhen: 'halted' },
      { action: 'archivePaper' },
      { action: 'rotatePaper' },
      { action: 'freshStartPaper' },
      { action: 'clearPaper' },
    ]);
    expect(actions.rotatePaper).toMatchObject({ label: '换新', effect: 'destructive' });
    expect(actions.rotatePaper.confirm).toContain('只重置对话，工程包照常带到新代理');
    expect(actions.freshStartPaper.confirm).toContain('成品与任务记录保留');
    expect(actions.clearPaper).toMatchObject({ label: '清空', effect: 'destructive' });
    expect(actions.clearPaper.confirm).toMatch(/远端代理/);
    expect(actions.archivePaper).toMatchObject({ effect: 'write' });
    expect(rowActionsOf(hub, 'paperTasks')).toEqual([
      { action: 'cancelTask', visibleWhen: 'cancellable' },
      { action: 'abandonTask', visibleWhen: 'abandonable' },
      { action: 'writeOffReserve', visibleWhen: 'writeOffable' },
    ]);
    // 动作名写明取消什么：确认框里关掉框的按钮写「取消」，确认的按钮写动作名，两个不同名；会话面板里的同一个动作也是
    const cancelTask = { label: '取消任务', effect: 'destructive' };
    expect(actions.cancelTask).toMatchObject(cancelTask);
    expect(toSource(hub.pages.view('paper-room').actions?.cancelTask)).toMatchObject(cancelTask);
    expect(rowActionsOf(hub, 'alerts')).toEqual([{ action: 'acknowledgeAlert', visibleWhen: 'unread' }]);
  });

  it('白纸详情的每日额度：具名留空、显式额度与零值；无名房间纸才用 defaults 金额', async () => {
    const configured = await startPaperHub({
      config: {
        ...PILOT_CONFIG,
        budgetTimeZone: 'UTC',
        defaults: { dailyCents: 120 },
        papers: [
          { name: PAPER, remoteAgentType: REMOTE },
          { name: 'capped', dailyCents: 120 },
          { name: 'closed', dailyCents: 0 },
        ],
      },
    });
    expect(String((await info(configured, PAPER_ID)).get('每日额度'))).toContain('不单独限额');
    expect(String((await info(configured, 'n:capped')).get('每日额度'))).toContain('上限 120 美分');
    expect(String((await info(configured, 'n:closed')).get('每日额度'))).toContain('0 美分（禁任务）');

    const anonymous = await startPaperHub({
      config: { defaults: { dailyCents: 120 } },
      files: seeded([], ledger => {
        ledger.papers[WINDOW_PAPER] = { lastClearedAt: 0 };
      }),
    });
    expect(String((await info(anonymous, WINDOW_PAPER)).get('每日额度'))).toContain('上限 120 美分');
    await expect(info(anonymous, 'n:zz-no-such')).rejects.toThrow('没有这块白纸');
  });

  it.each([
    [
      'en',
      {
        limited: [
          'No separate limit (global and room limits still apply); booked 1 cent; reserved 1 cent',
          'Limit 1 cent; booked 0 cents; reserved 0 cents',
          'Limit 2 cents; booked 2 cents; reserved 1 cent',
          'Limit 0 cents (tasks blocked); booked 0 cents; reserved 0 cents',
        ],
        limitedScope: (day: string) => `Global (${day}, limit 1 cent)`,
        typeShared: 'Shared (1): all rooms under Platform-type profile “onebot · group”',
        roomLimits: ['1 cent', 'Unlimited'],
        unlimited:
          'Unlimited (neither this paper nor the global setting has a limit; room limits apply separately); booked 1 cent; reserved 0 cents; unattributed costs (including old entries) of 2 cents are counted conservatively against every paper’s budget',
        unlimitedScope: (day: string) => `Global (${day}, unlimited)`,
        globalShared: 'Shared (1): all rooms under Global (plugin config)',
      },
    ],
    [
      'zh-CN',
      {
        limited: [
          '不单独限额（仍受全局与房间限制）；已记 1 美分；预留 1 美分',
          '上限 1 美分；已记 0 美分；预留 0 美分',
          '上限 2 美分；已记 2 美分；预留 1 美分',
          '上限 0 美分（禁任务）；已记 0 美分；预留 0 美分',
        ],
        limitedScope: (day: string) => `全局（${day}，上限 1 美分）`,
        typeShared: '共用（1）：平台类型档「onebot · group」的全部房间',
        roomLimits: ['1 美分', '不限'],
        unlimited:
          '不限额（这块白纸与全局都没设上限；房间上限另算）；已记 1 美分；预留 0 美分；未归属费用（含旧账）2 美分，保守计入每块白纸额度',
        unlimitedScope: (day: string) => `全局（${day}，不限额）`,
        globalShared: '共用（1）：全局（插件配置）的全部房间',
      },
    ],
  ])('%s：每日额度、今天的花费、共用的房间与本群上限的各支按读者语言（金额 1 与 2 美分）', async (language, expected) => {
    const day = new Date().toISOString().slice(0, 10);
    const { remoteAgentRoomDailyCents: _, ...unlimitedRoom } = PILOT_ROOM;
    const limited = await startPaperHub({
      config: {
        ...PILOT_CONFIG,
        globalDailyCents: 1,
        budgetTimeZone: 'UTC',
        papers: [
          { name: PAPER, remoteAgentType: REMOTE },
          { name: 'zz-one', dailyCents: 1 },
          { name: 'zz-two', dailyCents: 2 },
          { name: 'zz-zero', dailyCents: 0 },
        ],
      },
      files: seeded([], ledger => {
        ledger.spend[day] = { global: 3, papers: { [PAPER_ID]: 1, 'n:zz-two': 2 }, rooms: {}, users: {} };
        ledger.reserves['t-0000e001'] = { cents: 1, day, paperId: PAPER_ID, room: ROOM, user: 'onebot:30001' };
        ledger.reserves['t-0000e002'] = { cents: 1, day, paperId: 'n:zz-two', room: ROOM2, user: 'onebot:30002' };
      }),
      rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentRoomDailyCents: 1 }, [ROOM2]: unlimitedRoom },
      platformTypes: { 'onebot/group': { paperName: PAPER } },
    });
    const budgets = [];
    for (const paperId of [PAPER_ID, 'n:zz-one', 'n:zz-two', 'n:zz-zero']) {
      budgets.push((await infoIn(limited, language, paperId))[5].value);
    }
    expect(budgets).toEqual(expected.limited);
    expect((await rowsIn(limited, language, 'spend'))[0].scope).toBe(expected.limitedScope(day));
    expect((await infoIn(limited, language))[0].value).toBe(expected.typeShared);
    const roomLimit = async (sessionId: string) =>
      renderIn(await limited.pages.data<InfoItem[]>('paper-room', 'room', { sessionId }), language)[4].value;
    expect([await roomLimit(ROOM), await roomLimit(ROOM2)]).toEqual(expected.roomLimits);

    const unlimited = await startPaperHub({
      config: { budgetTimeZone: 'UTC', papers: [{ name: PAPER, remoteAgentType: REMOTE }] },
      files: seeded([], ledger => {
        ledger.spend[day] = { global: 3, papers: { [PAPER_ID]: 1 }, rooms: {}, users: {} };
      }),
      global: { paperName: PAPER },
    });
    const detail = await infoIn(unlimited, language);
    expect([detail[0].value, detail[5].value]).toEqual([expected.globalShared, expected.unlimited]);
    expect((await rowsIn(unlimited, language, 'spend'))[0].scope).toBe(expected.unlimitedScope(day));
  });

  it('全局金额上限留空时，今天的花费与白纸详情写明不限额而不显示 undefined 美分', async () => {
    const hub = await startPaperHub({
      config: { papers: [{ name: PAPER, remoteAgentType: REMOTE }] },
    });
    const [global] = await spend(hub);
    expect(global.scope).toContain('全局');
    expect(global.scope).toContain('不限额');
    expect(global.scope).not.toContain('undefined');
    expect(String((await info(hub)).get('每日额度'))).toContain('不限额（这块白纸与全局都没设上限；房间上限另算）');
  });

  it('共用白纸合并两个房间的费用与预留，并明确计入未归属旧日账', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const files = seeded([], ledger => {
      ledger.spend[day] = {
        global: 120,
        rooms: { [ROOM]: 50, [ROOM2]: 70 },
        users: {},
        papers: { [PAPER_ID]: 20, 'n:other': 30 },
      };
      ledger.reserves['t-11111111'] = { cents: 15, day, room: ROOM, user: 'onebot:30001', paperId: PAPER_ID };
      ledger.reserves['t-22222222'] = { cents: 8, day, room: ROOM2, user: 'onebot:30002', paperId: 'n:other' };
      ledger.reserves['t-33333333'] = { cents: 5, day, room: ROOM2, user: 'onebot:30003' };
    });
    const hub = await startPaperHub({
      files,
      config: {
        ...PILOT_CONFIG,
        budgetTimeZone: 'UTC',
        papers: [{ name: PAPER, remoteAgentType: REMOTE, dailyCents: 200 }],
      },
      rooms: { [ROOM]: PILOT_ROOM, [ROOM2]: PILOT_ROOM },
      listed: [ROOM, ROOM2],
      places: { 'onebot:group:20001': PILOT_ROOM, 'onebot:group:20002': PILOT_ROOM },
    });
    const detail = await info(hub);
    expect(String(detail.get('共用的房间'))).toContain('共用（2）');
    expect(String(detail.get('共用的房间'))).toContain(ROOM);
    expect(String(detail.get('共用的房间'))).toContain(ROOM2);
    expect(String(detail.get('每日额度'))).toContain('上限 200 美分');
    expect(String(detail.get('每日额度'))).toContain('已记 20 美分');
    expect(String(detail.get('每日额度'))).toContain('预留 20 美分');
    expect(String(detail.get('每日额度'))).toContain('未归属费用（含旧账）70 美分，保守计入每块白纸额度');
    expect((await papers(hub)).find(row => row.paperId === PAPER_ID)).toMatchObject({ spent: 20 });
    expect((await spend(hub))[0]).toMatchObject({ key: 'global', cents: 120, reserved: 28 });
  });

  it.each([
    [
      'en',
      {
        absent:
          'one (publish service not present), two (publish service not present), three (publish service not present), four (publish service not present)',
        open: 'one / 主站: https://aalis1.example.test (available), two / 画板: https://aalis2.example.test/draw (unavailable: Paused), three (not registered), four (unavailable)',
        closed: '(publishing disabled)',
      },
    ],
    [
      'zh-CN',
      {
        absent: 'one（发布服务不在场）、two（发布服务不在场）、three（发布服务不在场）、four（发布服务不在场）',
        open: 'one／主站：https://aalis1.example.test（可用）、two／画板：https://aalis2.example.test/draw（不可用：暂停）、three（未登记）、four（不可用）',
        closed: '（禁止发布）',
      },
    ],
  ])('%s：白纸详情只显示获准发布目标的地址与状态，作品站给的不可用原因按读者语言，显式空显示禁发布', async (language, expected) => {
    const hub = await startPaperHub({
      config: {
        ...PILOT_CONFIG,
        papers: [
          { name: PAPER, publishTargets: 'one, two, three, four', defaultPublishTarget: 'two' },
          { name: 'closed', publishTargets: '' },
        ],
      },
    });
    const value = async (paperId: string, index: number) => (await infoIn(hub, language, paperId))[index].value;
    expect(await value(PAPER_ID, 3)).toBe(expected.absent);
    hub.app.bind({ provide }).provide.use(publish, {
      listSurfaces: () => [
        { name: 'one', label: '主站', baseUrl: 'https://aalis1.example.test', available: true },
        {
          name: 'two',
          label: '画板',
          baseUrl: 'https://aalis2.example.test/draw',
          available: false,
          reason: surfaceTexts('paused'),
        },
        { name: 'four', available: false },
        { name: 'secret', baseUrl: 'https://secret.example.test', available: true },
      ],
    } as unknown as PublishService);
    expect(await value(PAPER_ID, 3)).toBe(expected.open);
    expect(await value(PAPER_ID, 4)).toBe('two');
    expect(await value('n:closed', 3)).toBe(expected.closed);
    expect(await value('n:closed', 4)).toBe(expected.closed);
  });
});

describe('跑完一件任务后的几张表', () => {
  it('任务表显示运行中的最近动作与时间，结束后不再显示旧动作', async () => {
    const remote = new ScriptedRemote();
    const hub = await hubWith(remote);
    const taskId = await accept(hub, '进展');
    const runId = await running(hub, taskId);
    const run = remote.runs.get(runId);
    if (!run) throw new Error('没有轮次');
    run.queue.push({ kind: 'progress', eventId: 'progress-webui', activity: { action: 'tool', status: 'running' } });
    run.wake?.();
    let active: Row | undefined;
    for (let i = 0; i < 400; i++) {
      active = (await tasks(hub)).find(row => row.id === taskId);
      if (active?.progress === '使用工具（进行中）') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(active).toMatchObject({
      progress: '使用工具（进行中）',
      progressAt: expect.any(String),
      state: { text: '运行中', state: 'running' },
      cancellable: true,
    });
    remote.finish(runId);
    await waitFor(() => hub.ledger().tasks[taskId]?.state === 'done', '任务完成');
    const finished = (await tasks(hub)).find(row => row.id === taskId);
    expect(finished).toMatchObject({ progress: '', state: { text: '完成' }, cancellable: false });
    expect(finished?.progressAt).toBeUndefined();
  });

  it('白纸、任务、成品、账本各行对得上；成品给下载句柄，位图另给预览', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '像素猫');
    const runId = await running(hub, taskId);
    a.outputs.set(taskId, [
      { rel: 'cat.png', data: PNG },
      { rel: 'index.html', data: HTML },
    ]);
    a.finish(runId, 'finished', '做好了');
    await waitFor(() => hub.ledger().tasks[taskId]?.state === 'done', '任务完成');
    const ledger = hub.ledger();
    const agentId = ledger.tasks[taskId].agentId ?? '';
    const agentName = ledger.agents[agentId].name;

    const [paper] = await papers(hub);
    expect(paper).toMatchObject({ paperId: PAPER_ID, name: PAPER, status: { text: '正常' }, halted: false });
    expect(String(paper.agent)).toContain(agentName);
    expect(String(paper.agent)).toContain('在用');
    const detail = await info(hub);
    expect(String(detail.get('共用的房间'))).toContain(ROOM);
    expect(detail.get('远端类型')).toBe(REMOTE);
    expect(String(detail.get('出网'))).toContain('只到白名单');
    expect(String(detail.get('出网'))).toContain('未核实');
    expect(String(detail.get('目录占用 / 上限'))).toContain('2048');
    expect(detail.get('停开原因')).toBe('');

    const [task] = await tasks(hub);
    expect(task).toMatchObject({
      id: taskId,
      room: ROOM,
      initiator: 'onebot:30001',
      name: '像素猫',
      state: { text: '完成' },
      cost: 10,
      text: '像素猫的原文',
    });

    const [png, html] = ledger.tasks[taskId].artifacts;
    const pngUri = `${DIR}/tasks/${taskId}/out/${png.id}.png`;
    const htmlUri = `${DIR}/tasks/${taskId}/out/${html.id}.html`;
    expect(await artifacts(hub)).toEqual([
      {
        key: `${taskId}/${png.id}`,
        file: { name: `${png.id}.png`, handle: `signed:${pngUri}` },
        preview: media(pngUri),
        task: '像素猫',
        type: 'png',
        size: expect.any(String),
        rel: 'cat.png',
      },
      {
        key: `${taskId}/${html.id}`,
        file: { name: `${html.id}.html`, handle: `signed:${htmlUri}` },
        task: '像素猫',
        type: 'html',
        size: expect.any(String),
        rel: 'index.html',
      },
    ]);

    expect(await spend(hub)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: expect.stringContaining('全局'), cents: 10, tasks: 1, reserved: 0 }),
        expect.objectContaining({ key: `room:${ROOM}`, cents: 10, tasks: 1 }),
        expect.objectContaining({ key: 'user:onebot:30001', cents: 10, tasks: 1 }),
      ]),
    );
  });

  it('落盘的失败原因与发布原因是文字对象：重启读回仍在，任务表按读者语言显示', async () => {
    const quota = defineTexts({
      ns: '@zz/paper-webui-readback',
      language: 'zh-CN',
      source: { quota: '额度用完了' } as const,
      locales: { en: { quota: 'Out of quota' } },
    })('quota');
    const failed = doneTask('t-0000000e', [], {
      state: 'failed',
      error: quota,
      publication: { target: 'works', title: '猫', summary: '', state: 'failed', reason: quota },
    });
    const hub = await hubWith(new ScriptedRemote(), { files: seeded([{ task: failed, bytes: {} }]) });
    const [row] = await hub.pages.data<Row[]>('paper', 'paperTasks', { rowKey: PAPER_ID });
    const shown = [(row.state as { text: unknown }).text, row.publication];
    expect(shown.map(text => isTextRef(text) && [toSource(text), resolveText(text, ['en'])])).toEqual([
      ['失败：额度用完了', 'Failed: Out of quota'],
      ['works：未能上线（额度用完了）', 'works: Not published (Out of quota)'],
    ]);
  });

  it('今天的花费：预留中的金额按房间与发起者列出', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '网页');
    await running(hub, taskId);
    const reserve = hub.ledger().reserves[taskId].cents;
    expect(await spend(hub)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'global', cents: 0, reserved: reserve }),
        expect.objectContaining({ key: `room:${ROOM}`, reserved: reserve }),
        expect.objectContaining({ key: 'user:onebot:30001', reserved: reserve, tasks: 1 }),
      ]),
    );
  });
  it.each([
    [
      'en',
      {
        states: [
          'Running',
          'Starting',
          'Collecting outputs',
          'Queued',
          'Done',
          'Done',
          'Done',
          'Failed',
          'Cancelled (tool)',
          'Cancelled (WebUI)',
          'Cancelled (timed out)',
          'Cancelled (zz-via)',
          'zz-state',
          'Done',
          'Done',
        ],
        publications: [
          'works: Live',
          'works: Waiting to be submitted',
          'works: Being published',
          'works: zz-pub',
          'Not publishing',
        ],
        durations: ['40 s', '7 min 20 s'],
        progress: 'Running a command (failed) · bash · src/app.ts · npm test · exit code 1',
        egress: [
          'No egress (owner config, unverified); limit Allowlist only',
          'Allowlist only (owner config, unverified); limit Allowlist only',
          'Unrestricted; limit Allowlist only',
          'Unknown (owner config, unverified); limit Allowlist only',
          'zz-mode (owner config, unverified); limit Allowlist only',
          'Read failed: EGRESS-SENTINEL',
        ],
      },
    ],
    [
      'zh-CN',
      {
        states: [
          '运行中',
          '开轮中',
          '取回成品',
          '排队',
          '完成',
          '完成',
          '完成',
          '失败',
          '已取消（工具）',
          '已取消（WebUI）',
          '已取消（超时）',
          '已取消（zz-via）',
          'zz-state',
          '完成',
          '完成',
        ],
        publications: ['works：已上线', 'works：等待自动提交', 'works：发布处理中', 'works：zz-pub', '不发布'],
        durations: ['40 秒', '7 分 20 秒'],
        progress: '执行命令（失败） · bash · src/app.ts · npm test · 退出码 1',
        egress: [
          '不出网（owner 配置，未核实）；上限 只到白名单',
          '只到白名单（owner 配置，未核实）；上限 只到白名单',
          '不限；上限 只到白名单',
          '未知（owner 配置，未核实）；上限 只到白名单',
          'zz-mode（owner 配置，未核实）；上限 只到白名单',
          '读取失败：EGRESS-SENTINEL',
        ],
      },
    ],
  ])('%s：任务状态、取消来源、发布状态、用时、最近动作与出网方式显示名字（表外的值显示原值）；最近动作交给模型的是原文', async (language, expected) => {
    const now = Date.now();
    const publication = (state: string) =>
      ({ target: 'works', title: '猫', summary: '', state }) as NonNullable<TaskRecord['publication']>;
    // 运行中的那件最早：运行循环一直跟着它（替身提供者跟不了），排在后面的开轮中、取回成品中与排队的不被挪动
    const seeds: Array<[string, Partial<TaskRecord>]> = [
      [
        't-0000a001',
        {
          state: 'running',
          createdAt: now - 120_000,
          endedAt: undefined,
          agentId: 'bc-0000a001',
          runId: 'run-a001',
          progress: {
            activity: {
              action: 'command',
              status: 'failed',
              tool: 'bash',
              target: 'src/app.ts',
              summary: 'npm test',
              exitCode: 1,
            },
            at: now,
          },
        },
      ],
      [
        't-0000a002',
        { state: 'starting', endedAt: undefined, agentId: 'bc-0000a001', start: { path: 'run', requestedAt: now } },
      ],
      ['t-0000a003', { state: 'collecting', endedAt: undefined, agentId: 'bc-0000a001', runId: 'run-a003' }],
      ['t-0000a004', { state: 'queued', startedAt: undefined, endedAt: undefined }],
      ['t-0000a005', { publication: publication('live') }],
      ['t-0000a006', { publication: publication('pending') }],
      ['t-0000a007', { publication: { ...publication('submitted'), workId: 'zz-work' } }],
      ['t-0000a008', { state: 'failed' }],
      ['t-0000a009', { state: 'cancelled', cancelledVia: 'tool' }],
      ['t-0000a010', { state: 'cancelled', cancelledVia: 'webui' }],
      ['t-0000a011', { state: 'cancelled', cancelledVia: 'timeout' }],
      ['t-0000a012', { state: 'cancelled', cancelledVia: 'zz-via' as TaskRecord['cancelledVia'] }],
      ['t-0000a013', { state: 'zz-state' as TaskRecord['state'] }],
      ['t-0000a014', { publication: publication('zz-pub') }],
      ['t-0000a015', { startedAt: now - 500_000, endedAt: now - 60_000 }],
    ];
    const remote = fakeRemote();
    const hub = await startPaperHub({
      remotes: { [REMOTE]: remote },
      files: seeded(seeds.map(([id, over]) => ({ task: doneTask(id, [], over), bytes: {} }))),
    });
    const byId = new Map((await rowsIn(hub, language, 'paperTasks', { rowKey: PAPER_ID })).map(row => [row.id, row]));
    const row = (id: string) => byId.get(id) ?? {};
    expect(seeds.map(([id]) => (row(id).state as { text: unknown }).text)).toEqual(expected.states);
    expect(
      ['t-0000a005', 't-0000a006', 't-0000a007', 't-0000a014', 't-0000a015'].map(id => row(id).publication),
    ).toEqual(expected.publications);
    expect(['t-0000a005', 't-0000a015'].map(id => row(id).duration)).toEqual(expected.durations);
    expect(row('t-0000a001').progress).toBe(expected.progress);

    const egress: unknown[] = [];
    for (const report of [
      { mode: 'none', source: 'owner-config' },
      { mode: 'allowlist', source: 'owner-config' },
      { mode: 'open', source: 'provider-api' },
      { mode: 'unknown', source: 'owner-config' },
      { mode: 'zz-mode', source: 'owner-config' },
    ] as EgressReport[]) {
      remote.egress = async () => report;
      egress.push((await infoIn(hub, language))[2].value);
    }
    remote.egress = async () => {
      throw new Error('EGRESS-SENTINEL');
    };
    egress.push((await infoIn(hub, language))[2].value);
    expect(egress).toEqual(expected.egress);

    const status = await hub.call('paper_status', { task_id: 't-0000a001' });
    expect((status.tasks as Row[])[0].progress).toEqual({
      activity: '执行命令（失败）',
      at: new Date(now).toISOString(),
    });
  });

  it.each([
    [
      'en',
      'Failed: Today’s global budget for remote tasks is not enough (cents used plus reserved: 1200; reserved for this task: 1000; limit: 2000)',
    ],
    ['zh-CN', '失败：今天全局的远端任务额度不够（已用加预留 1200 美分，本件预留 1000，上限 2000）'],
  ])('%s：出队时额度不够：任务状态按读者语言，paper_task 与 paper_status 交给模型的是原文', async (language, state) => {
    const remote = new ScriptedRemote();
    remote.costOf = () => ({ cents: 1200 });
    // 早先一件记过账的 800 美分：出队时的预留取两件的均值 1000，与当天已用的 1200 分得开
    const earlier = doneTask('t-0000f001', [], { costCents: 800, endedAt: Date.now() - 120_000 });
    const hub = await hubWith(remote, {
      config: { ...PILOT_CONFIG, globalDailyCents: 2000 },
      files: seeded([{ task: earlier, bytes: {} }]),
    });
    const first = await accept(hub, '任务一');
    const runId = await running(hub, first);
    const second = await accept(hub, '任务二');
    remote.finish(runId);
    await waitFor(() => hub.ledger().tasks[second]?.state === 'failed', '第二件出队时判为失败');
    const row = (await rowsIn(hub, language, 'paperTasks', { rowKey: PAPER_ID })).find(task => task.id === second);
    expect(row?.state).toEqual({ text: state, state: 'error' });
    const reason = '今天全局的远端任务额度不够（已用加预留 1200 美分，本件预留 1000，上限 2000）';
    expect(await hub.call('paper_task', { text: '再来一件', name: '再来', publish: false })).toEqual({
      ok: false,
      error: reason,
    });
    const status = await hub.call('paper_status', { task_id: second });
    expect((status.tasks as Row[])[0].error).toBe(reason);
  });
});

describe('白纸详情的「共用的房间」', () => {
  it('平台类型档写了 paperName：列出继承它的已登记房间与这一档的全部房间，标为共用', async () => {
    const hub = await startPaperHub({
      listed: [ROOM],
      platformTypes: { 'onebot/group': { paperName: PAPER } },
    });
    expect((await info(hub)).get('共用的房间')).toBe(`共用（2）：${ROOM}、平台类型档「onebot · group」的全部房间`);
  });

  /** 窗口的场所只开了白纸、没写白纸名：白纸名取覆盖一类房间的层 */
  const UNNAMED = { [ROOM]: { ...PILOT_ROOM, paperName: undefined } };

  it('全局层写了 paperName：列出继承它的已登记房间与全局（插件配置）的全部房间，标为共用', async () => {
    const hub = await startPaperHub({ listed: [ROOM], rooms: UNNAMED, global: { paperName: PAPER } });
    expect((await info(hub)).get('共用的房间')).toBe(`共用（2）：${ROOM}、全局（插件配置）的全部房间`);
  });

  it('对照：只有一个窗口的场所写了 paperName、没有平台档与平台类型档时不算共用', async () => {
    const hub = await startPaperHub({
      listed: [ROOM],
      places: { 'onebot:group:20001': { paperName: PAPER } },
    });
    expect((await info(hub)).get('共用的房间')).toBe(ROOM);
  });
});

describe('成品的文件与预览', () => {
  const html = { id: 'a-0000000a', rel: 'index.html', type: 'html' as const, sizeBytes: HTML.byteLength };
  const svg = { id: 'a-0000000b', rel: 'pic.svg', type: 'other' as const, sizeBytes: SVG.byteLength };
  const fakePng = { id: 'a-0000000c', rel: 'fake.png', type: 'png' as const, sizeBytes: HTML.byteLength };
  const realPng = { id: 'a-0000000d', rel: 'real.png', type: 'png' as const, sizeBytes: PNG.byteLength };

  it('安全：HTML 与 SVG 成品只给下载、不给预览；记作位图的给预览，文件头由 /api/media 再核', async () => {
    const hub = await startPaperHub({
      files: seeded([
        {
          task: doneTask('t-00000001', [html, svg, fakePng, realPng]),
          bytes: { [html.id]: HTML, [svg.id]: SVG, [fakePng.id]: HTML, [realPng.id]: PNG },
        },
      ]),
    });
    const rows = new Map((await artifacts(hub)).map(row => [row.rel, row]));
    expect(rows.get('index.html')?.preview).toBeUndefined();
    expect(rows.get('pic.svg')?.preview).toBeUndefined();
    expect(rows.get('fake.png')?.preview).toBe(media(`${DIR}/tasks/t-00000001/out/${fakePng.id}.png`));
    // 类型列：other 取显示名，其余是文件格式名、原样
    expect(
      ['index.html', 'pic.svg'].map(rel => [toSource(rows.get(rel)?.type), renderIn(rows.get(rel)?.type, 'en')]),
    ).toEqual([
      ['html', 'html'],
      ['其他', 'other'],
    ]);
    for (const row of rows.values())
      expect(row.file).toMatchObject({ handle: expect.stringMatching(/^signed:paper:/) });
  });

  it('文件名由宿主给（产物 id 加判定类型的扩展名），不用远端给的路径', async () => {
    const hub = await startPaperHub({
      files: seeded([{ task: doneTask('t-00000001', [svg]), bytes: { [svg.id]: SVG } }]),
    });
    expect((await artifacts(hub))[0].file).toMatchObject({ name: `${svg.id}.bin` });
  });

  it('已随清空删除的成品不列', async () => {
    const hub = await startPaperHub({
      files: seeded([
        { task: doneTask('t-00000001', [realPng]), bytes: { [realPng.id]: PNG } },
        { task: doneTask('t-00000002', [realPng], { artifactsCleared: true }), bytes: { [realPng.id]: PNG } },
      ]),
    });
    expect((await artifacts(hub)).map(row => row.key)).toEqual([`t-00000001/${realPng.id}`]);
  });
});

describe('白纸的管理动作', () => {
  async function finishedHub() {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '像素猫');
    const runId = await running(hub, taskId);
    a.outputs.set(taskId, [{ rel: 'cat.png', data: PNG }]);
    a.finish(runId, 'finished');
    await waitFor(() => hub.ledger().tasks[taskId]?.state === 'done', '任务完成');
    const agentId = hub.ledger().tasks[taskId].agentId ?? '';
    return { a, hub, taskId, agentId };
  }

  it('归档代理：调提供者的 archiveAgent，记录里代理转为 archived', async () => {
    const { a, hub, agentId } = await finishedHub();
    expect(await act(hub, 'archivePaper', PAPER_ID)).toEqual(ok('已归档'));
    expect(a.callsOn('archiveAgent', agentId)).toHaveLength(1);
    expect(hub.ledger().agents[agentId].state).toBe('archived');
    // 已归档的再归档：没有在用的代理
    expect(await act(hub, 'archivePaper', PAPER_ID)).toMatchObject({ status: 500 });
    expect(a.count('archiveAgent')).toBe(1);
  });

  it('归档代理：白纸上有未结束的任务时拒绝，不调提供者', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '网页');
    await running(hub, taskId);
    expect(await act(hub, 'archivePaper', PAPER_ID)).toMatchObject({ status: 500 });
    expect(a.count('archiveAgent')).toBe(0);
  });

  it('换新：下一件任务建新代理（记录置 rotateNext），不动远端', async () => {
    const { a, hub } = await finishedHub();
    const before = a.calls.length;
    expect(await act(hub, 'rotatePaper', PAPER_ID)).toEqual(ok('下一件任务建新代理'));
    expect(hub.ledger().papers[PAPER_ID].rotateNext).toBe(true);
    expect(a.calls.length).toBe(before);
  });

  it('清空：删除远端代理与白纸目录，任务记录保留、成品标为已清空，成品表随之为空', async () => {
    const { a, hub, taskId, agentId } = await finishedHub();
    expect([...hub.files.keys()].some(k => k.startsWith(`${DIR}/`))).toBe(true);
    expect(await act(hub, 'clearPaper', PAPER_ID)).toEqual(ok('已清空'));
    await waitFor(() => !hub.ledger().agents[agentId], '代理移出记录');
    expect(a.callsOn('deleteAgent', agentId)).toHaveLength(1);
    const ledger = hub.ledger();
    expect(ledger.papers[PAPER_ID].binding).toBeUndefined();
    expect(ledger.tasks[taskId]).toMatchObject({ state: 'done', artifactsCleared: true });
    expect([...hub.files.keys()].some(k => k.startsWith(`${DIR}/`))).toBe(false);
    expect(await artifacts(hub)).toEqual([]);
  });

  it('清空：有任务在跑时拒绝并给出原因', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '网页');
    await running(hub, taskId);
    expect(await act(hub, 'clearPaper', PAPER_ID)).toEqual(refused(/在跑/));
    expect(a.count('deleteAgent')).toBe(0);
  });

  it('恢复：只对停开的白纸显示；清除停开，没停开的回失败', async () => {
    const files = seeded([], ledger => {
      ledger.papers[PAPER_ID] = {
        lastClearedAt: Date.now(),
        halted: { reason: 'cost-missing', detail: 'HALT-DETAIL-轮次费用取不到', at: 1 },
      };
    });
    const hub = await hubWith(new ScriptedRemote(), { files });
    expect((await papers(hub))[0]).toMatchObject({
      status: { text: '停开：HALT-DETAIL-轮次费用取不到', state: 'error' },
      halted: true,
    });
    expect(String((await info(hub)).get('停开原因'))).toContain('HALT-DETAIL');
    expect(await act(hub, 'resumePaper', PAPER_ID)).toEqual(ok('已恢复'));
    expect(hub.ledger().papers[PAPER_ID].halted).toBeUndefined();
    expect((await papers(hub))[0]).toMatchObject({ halted: false });
    expect(await act(hub, 'resumePaper', PAPER_ID)).toEqual(refused('这块白纸没有停开'));
  });

  it('不认识的白纸一律回失败，记录里不多出白纸', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    for (const action of ['rotatePaper', 'archivePaper', 'clearPaper', 'resumePaper', 'freshStartPaper']) {
      expect(await act(hub, action, 'n:zz-no-such'), action).toEqual(refused('没有这块白纸'));
    }
    expect(hub.ledger()?.papers?.['n:zz-no-such']).toBeUndefined();
    expect(a.count('deleteAgent') + a.count('archiveAgent')).toBe(0);
  });
  it.each([
    [
      'en',
      [
        'This paper is not waiting for an old project bundle',
        'The ledger has no such paper',
        'This paper has no agent in use',
        'Only running and starting tasks can stop being tracked',
        'No task t-0000b0ff',
        'This task holds no reserve',
        'This task has already ended (done)',
        'No task t-0000b0ff',
      ],
    ],
    [
      'zh-CN',
      [
        '这块白纸没有在等旧工程包',
        '记录里没有这块白纸',
        '这块白纸没有在用的代理',
        '只有运行中与开轮中的任务能放弃跟踪',
        '没有任务 t-0000b0ff',
        '这件任务没有占着预留',
        '这件任务已经结束（done）',
        '没有任务 t-0000b0ff',
      ],
    ],
  ])('%s：不带旧工程继续、归档、放弃跟踪、核销、取消被拒的报错按读者语言；paper_cancel 被拒交给模型的是原文', async (language, expected) => {
    const files = seeded([{ task: doneTask('t-0000b001', []), bytes: {} }], ledger => {
      ledger.papers[PAPER_ID] = { lastClearedAt: 0 };
    });
    const hub = await startPaperHub({
      files,
      config: { ...PILOT_CONFIG, papers: [...PILOT_CONFIG.papers, { name: 'zz-other' }] },
    });
    const onPage = (action: string, rowKey: string) => hub.pages.act('paper', action, { rowKey });
    const replies = [
      await onPage('freshStartPaper', PAPER_ID),
      await onPage('freshStartPaper', 'n:zz-other'),
      await onPage('archivePaper', PAPER_ID),
      await onPage('abandonTask', 't-0000b001'),
      await onPage('abandonTask', 't-0000b0ff'),
      await onPage('writeOffReserve', 't-0000b001'),
      await onPage('cancelTask', 't-0000b001'),
      await onPage('cancelTask', 't-0000b0ff'),
    ];
    expect(replies.map(reply => saidIn(reply, language))).toEqual(expected);
    expect(await hub.call('paper_cancel', { task_id: 't-0000b001' })).toEqual({
      ok: false,
      error: '这件任务已经结束（done）',
    });
  });
});

describe('取消任务（owner，任何任务）', () => {
  it('排队中的：移出队列、释放预留，记 cancelledVia=webui，完成通知写明被 owner 取消', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const t1 = await accept(hub, '任务一');
    await running(hub, t1);
    const t2 = await hub.call('paper_task', { text: '别人的任务', name: '任务二' }, human('30002'));
    const taskId = String(t2.taskId);
    expect(hub.ledger().reserves[taskId]).toBeDefined();

    expect(await act(hub, 'cancelTask', taskId)).toEqual(ok('已取消'));
    const ledger = hub.ledger();
    expect(ledger.tasks[taskId]).toMatchObject({ state: 'cancelled', cancelledVia: 'webui' });
    expect(ledger.reserves[taskId]).toBeUndefined();
    await waitFor(() => hub.injected.length === 1, '取消通知');
    expect(hub.injected[0].source).toBe(`paper:${PAPER_ID}:${taskId}`);
    expect(hub.injected[0].content).toContain('已被 owner 取消');
  });

  it('运行中的：请远端取消这一轮，到终态后记 cancelledVia=webui 并通知', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '任务一');
    const runId = await running(hub, taskId);
    const agentId = hub.ledger().tasks[taskId].agentId;
    expect(await act(hub, 'cancelTask', taskId)).toEqual(ok('已请远端取消这一轮；费用按实际发生的入账'));
    expect(a.calls.filter(c => c.method === 'cancelRun').map(c => c.args)).toEqual([[agentId, runId]]);
    await waitFor(() => hub.ledger().tasks[taskId]?.state === 'cancelled', '到终态');
    expect(hub.ledger().tasks[taskId].cancelledVia).toBe('webui');
    await waitFor(() => hub.injected.length === 1, '取消通知');
    expect(hub.injected[0].content).toContain('已被 owner 取消');
  });

  it('已结束的与找不到的回失败', async () => {
    const hub = await startPaperHub({
      files: seeded([{ task: doneTask('t-00000001', []), bytes: {} }]),
    });
    expect(await act(hub, 'cancelTask', 't-00000001')).toMatchObject({ status: 500 });
    expect(await act(hub, 'cancelTask', 't-0000000f')).toMatchObject({ status: 500 });
    expect(hub.ledger().tasks['t-00000001'].state).toBe('done');
  });
});

describe('核销预留', () => {
  it('费用取不到、预留一直占着的已结束任务：按预留额估计入账并释放预留，之后不再补取', async () => {
    const files = seeded(
      [
        {
          task: doneTask('t-00000001', [], { costCents: undefined, agentId: 'bc-00000001', runId: 'run-1' }),
          bytes: {},
        },
      ],
      ledger => {
        ledger.reserves['t-00000001'] = { cents: 70, day: '2026-09-27', room: ROOM, user: 'onebot:30001' };
        ledger.runs['run-1'] = { agentId: 'bc-00000001', taskId: 't-00000001', cost: { state: 'missing' } };
      },
    );
    const hub = await startPaperHub({ files });
    expect((await tasks(hub))[0]).toMatchObject({ cost: '预留 70', writeOffable: true, abandonable: false });

    expect(await act(hub, 'writeOffReserve', 't-00000001')).toEqual(ok('已核销'));
    const ledger = hub.ledger();
    expect(ledger.reserves['t-00000001']).toBeUndefined();
    expect(ledger.runs['run-1'].cost).toEqual({ state: 'booked', cents: 70, estimated: true });
    expect(Object.values(ledger.spend)[0]).toMatchObject({ global: 70, rooms: { [ROOM]: 70 } });
    expect(ledger.tasks['t-00000001'].costCents).toBe(70);
    expect((await tasks(hub))[0]).toMatchObject({ writeOffable: false });
    expect(await act(hub, 'writeOffReserve', 't-00000001'), '没有预留了').toEqual(refused('这件任务没有占着预留'));
  });

  it('还没结束的任务不能核销', async () => {
    const files = seeded([{ task: doneTask('t-00000001', [], { state: 'queued' }), bytes: {} }], ledger => {
      ledger.reserves['t-00000001'] = { cents: 70, day: '2026-09-27', room: ROOM, user: 'onebot:30001' };
    });
    const hub = await startPaperHub({ files });
    expect((await tasks(hub))[0]).toMatchObject({ writeOffable: false });
    expect(await act(hub, 'writeOffReserve', 't-00000001')).toMatchObject({ status: 500 });
    expect(hub.ledger().reserves['t-00000001']).toBeDefined();
  });
});

describe('放弃跟踪', () => {
  it('没有到点取消失败的运行中任务不显示放弃跟踪，调用也回失败', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '任务一');
    await running(hub, taskId);
    expect((await tasks(hub)).find(row => row.id === taskId)).toMatchObject({ abandonable: false });
    expect(await act(hub, 'abandonTask', taskId)).toEqual(refused(/先试「取消」/));
    expect(hub.ledger().tasks[taskId].state).toBe('running');
  });

  it('白纸停开、到点取消失败的运行中任务显示放弃跟踪，判为失败', async () => {
    const files = seeded(
      [{ task: doneTask('t-00000001', [], { state: 'running', agentId: 'bc-00000001', runId: 'run-1' }), bytes: {} }],
      ledger => {
        ledger.papers[PAPER_ID] = { lastClearedAt: 0, halted: { reason: 'cancel-failed', detail: '取消失败', at: 1 } };
        ledger.alerts.push({
          id: 'al-00000002',
          at: 1,
          kind: 'cancel-failed',
          subject: 'bc-00000001',
          message: '到点取消失败',
          acknowledged: false,
        });
      },
    );
    const hub = await startPaperHub({ files });
    expect((await tasks(hub))[0]).toMatchObject({ abandonable: true });
    expect(await act(hub, 'abandonTask', 't-00000001')).toEqual(ok('已放弃跟踪'));
    expect(hub.ledger().tasks['t-00000001'].state).toBe('failed');
  });
});

describe('告警与提示', () => {
  it.each([
    [
      'en',
      {
        status: 'Halted: Remote agent “zz-remote-a” is unavailable (request rejected remotely)',
        haltLabel: 'Halt reason',
        haltReason: (time: string) => `Remote agent “zz-remote-a” is unavailable (request rejected remotely) (${time})`,
        statusLabel: 'Status',
        agent: (name: string, state: string) => `${name} (${state})`,
        active: 'active',
        doctor:
          'Paper zz-paper is halted (Remote agent “zz-remote-a” is unavailable (request rejected remotely)); waiting for the owner to resume it in the WebUI; The egress of remote agent “zz-remote-a” (Allowlist only) comes from the owner’s config and is unverified',
      },
    ],
    [
      'zh-CN',
      {
        status: '停开：远端代理「zz-remote-a」不可用（远端拒绝了请求）',
        haltLabel: '停开原因',
        haltReason: (time: string) => `远端代理「zz-remote-a」不可用（远端拒绝了请求）（${time}）`,
        statusLabel: '状态',
        agent: (name: string, state: string) => `${name}（${state}）`,
        active: '在用',
        doctor:
          '白纸 zz-paper 已停开（远端代理「zz-remote-a」不可用（远端拒绝了请求）），等 owner 在 WebUI 恢复；远端代理「zz-remote-a」的出网方式（只到白名单）取自 owner 配置，未核实',
      },
    ],
  ])('%s：提供者拒绝时停开：停开说明落盘为文字对象、只带类别，重启读回后状态栏、停开原因、会话面板与诊断项按读者语言；白纸表的绑定代理写代理状态（不在表里的显示原值）；paper_task 的拒绝是原文', async (language, expected) => {
    const remote = new ScriptedRemote();
    const hub = await hubWith(remote);
    const first = await accept(hub, '任务一');
    const runId = await running(hub, first);
    await accept(hub, '任务二');
    remote.intercept.ready = () => {
      throw new RemoteAgentError('rejected', 'READY-SENTINEL 401');
    };
    remote.finish(runId);
    await waitFor(() => hub.ledger().papers[PAPER_ID]?.halted !== undefined, '停开');
    const detail = hub.ledger().papers[PAPER_ID].halted?.detail as TextRef;
    expect(detail).toMatchObject({
      key: 'providerUnavailable',
      params: { type: REMOTE, category: { key: 'categoryRejected' } },
    });
    const binding = hub.ledger().papers[PAPER_ID].binding ?? '';
    const name = hub.ledger().agents[binding].name;
    expect((await rowsIn(hub, language, 'papers'))[0].agent).toBe(expected.agent(name, expected.active));
    await hub.stop();
    // 代理状态是落盘的值，读回不核：别的版本写的状态照原值显示
    const stored = hub.ledger();
    stored.agents[binding].state = 'zz-state' as 'active';
    // 停开时刻改成远离此刻的一个时间：停开原因写的是记录里的停开时刻，不是读的时候
    const at = new Date(2026, 0, 2, 3, 4).getTime();
    const halted = stored.papers[PAPER_ID].halted;
    if (!halted) throw new Error('应当已停开');
    halted.at = at;
    hub.files.set(LEDGER_URI, JSON.stringify(stored));

    const again = await hubWith(new ScriptedRemote(), { files: hub.files });
    expect((await rowsIn(again, language, 'papers'))[0]).toMatchObject({
      status: { text: expected.status, state: 'error' },
      agent: expected.agent(name, 'zz-state'),
    });
    expect((await infoIn(again, language)).at(-1)).toEqual({
      label: expected.haltLabel,
      value: expected.haltReason(shortTime(at, language)),
    });
    const room = renderIn(await again.pages.data<InfoItem[]>('paper-room', 'room', { sessionId: ROOM }), language);
    expect(room).toContainEqual({
      label: expected.statusLabel,
      value: { text: expected.status, state: 'error' },
      kind: 'status',
    });
    expect(renderIn((await again.doctor())[0].message, language)).toBe(expected.doctor);
    expect(await again.call('paper_task', { text: '再来一件', name: '再来' })).toEqual({
      ok: false,
      error: '这块白纸已停开（远端代理「zz-remote-a」不可用（远端拒绝了请求）），等 owner 在 WebUI 恢复',
    });
  });

  it.each([
    [
      'en',
      {
        selfWake: (name: string, agent: string, run: string) =>
          `Runs not in the ledger appeared on agent ${name} (${agent}): ${run}; handled as a self-wake: the agent is cancelled and deleted, and the next new agent starts without the old project bundle`,
        deleteFailed: (name: string, agent: string) =>
          `Deleting remote agent ${name} (${agent}) failed; retrying at the next reconciliation: DELETE-SENTINEL：远端说删不了`,
        unread: 'Unread',
        kinds: ['Untracked run', 'Agent deletion failed'],
      },
    ],
    [
      'zh-CN',
      {
        selfWake: (name: string, agent: string, run: string) =>
          `代理 ${name}（${agent}）上出现未登记的轮次 ${run}，按自唤醒处理：取消并删除代理，下一次新建代理不带旧工程包`,
        deleteFailed: (name: string, agent: string) =>
          `删除远端代理 ${name}（${agent}）失败，下次核对重试：DELETE-SENTINEL：远端说删不了`,
        unread: '未读',
        kinds: ['未登记的轮次', '删除代理失败'],
      },
    ],
  ])('%s：未登记轮次与删除远端代理失败的告警：告警表按读者语言（类别不在表里的显示原值），远端报错原样在里面，重启读回仍在；同一代理删除失败只告警一次', async (language, expected) => {
    const remote = new ScriptedRemote();
    const hub = await hubWith(remote);
    const taskId = await accept(hub, '任务一');
    const runId = await running(hub, taskId);
    const agentId = hub.ledger().tasks[taskId].agentId ?? '';
    const name = hub.ledger().agents[agentId].name;
    const stray = remote.spawnRun(agentId);
    remote.finish(stray);
    remote.intercept.deleteAgent = () => {
      throw new Error('DELETE-SENTINEL：远端说删不了');
    };
    remote.finish(runId);
    await waitFor(() => hub.ledger().alerts.some(alert => alert.kind === 'delete-failed'), '删除失败的告警');
    expect(await act(hub, 'clearPaper', PAPER_ID)).toMatchObject({ status: 200 });
    expect(remote.count('deleteAgent')).toBe(2);
    await hub.stop();
    // 告警的类别是落盘的值，读回不核：别的版本写的类别照原值显示
    const stored = hub.ledger();
    stored.alerts.push({ id: 'al-0000zz01', at: 0, kind: 'zz-kind' as 'provider', message: 'zz', acknowledged: false });
    hub.files.set(LEDGER_URI, JSON.stringify(stored));

    const again = await hubWith(new ScriptedRemote(), { files: hub.files });
    expect(again.ledger().alerts.map(alert => [alert.kind, isTextRef(alert.message)])).toEqual([
      ['unknown-run', true],
      ['delete-failed', true],
      ['zz-kind', false],
    ]);
    const shown = await rowsIn(again, language, 'alerts');
    expect(
      Object.fromEntries(shown.map(row => [row.kind, [row.message, (row.status as { text: unknown }).text]])),
    ).toEqual({
      [expected.kinds[0]]: [expected.selfWake(name, agentId, stray), expected.unread],
      [expected.kinds[1]]: [expected.deleteFailed(name, agentId), expected.unread],
      'zz-kind': ['zz', expected.unread],
    });
  });

  it('列出告警；未登记代理的告警标为已读后，用这个提供者的白纸解除停开', async () => {
    const hub = await hubWith(new ScriptedRemote(), { files: seeded([], unreadAlert) });
    const [alert] = await alerts(hub);
    expect(alert).toMatchObject({
      id: 'al-00000001',
      kind: '未登记的代理',
      status: { text: '未读', state: 'attention' },
      unread: true,
    });
    expect(String(alert.message)).toContain('FOREIGN-AGENT');

    const refusedTask = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(String(refusedTask.error)).toMatch(/未登记的代理/);

    expect(await act(hub, 'acknowledgeAlert', 'al-00000001')).toEqual(ok('已标为已读'));
    expect(hub.ledger().alerts[0].acknowledged).toBe(true);
    expect((await alerts(hub))[0]).toMatchObject({ status: { text: '已读', state: 'inactive' }, unread: false });
    expect(await act(hub, 'acknowledgeAlert', 'al-00000001')).toEqual(refused('没有这条未读告警'));

    const accepted = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(accepted.ok).toBe(true);
  });

  it('未读告警发提示，数量写进标题（按读者语言）、跳到白纸页；全部标为已读后撤回', async () => {
    const files = seeded([], ledger => {
      unreadAlert(ledger);
      unreadAlert(ledger);
      ledger.alerts[1].id = 'al-00000002';
    });
    const hub = await hubWith(new ScriptedRemote(), { files });
    const titles = () => hub.pages.notices().map(notice => [toSource(notice.title), renderIn(notice.title, 'en')]);
    expect(toSource(hub.pages.notices())).toEqual([
      {
        instance: '@aalis/plugin-paper',
        id: 'alerts',
        level: 'action',
        title: '2 条白纸告警未读',
        open: { page: 'paper' },
      },
    ]);
    expect(renderIn(hub.pages.notices()[0].title, 'en')).toBe('2 unread paper alerts');
    await act(hub, 'acknowledgeAlert', 'al-00000001');
    expect(titles()).toEqual([['1 条白纸告警未读', '1 unread paper alert']]);
    await act(hub, 'acknowledgeAlert', 'al-00000002');
    expect(hub.pages.notices()).toEqual([]);
  });

  it('记录每次落盘后白纸页与会话面板都重取', async () => {
    const hub = await hubWith(new ScriptedRemote());
    const before = hub.pages.invalidations.length;
    await accept(hub, '网页');
    const pushed = hub.pages.invalidations.slice(before);
    expect(pushed).toContainEqual({ instance: '@aalis/plugin-paper', pageKey: 'paper' });
    expect(pushed).toContainEqual({ instance: '@aalis/plugin-paper', pageKey: 'paper-room' });
  });

  it.each([
    [
      'en',
      {
        title: 'The paper ledger could not be read',
        detail: new RegExp(
          `^Paper ledger ${LEDGER_URI}: parsing failed: .+; no remote tasks will start and the original file is not overwritten\\. Fix or move it, then restart$`,
        ),
        refused: 'The paper ledger could not be read; waiting for the owner',
      },
    ],
    [
      'zh-CN',
      {
        title: '白纸记录读取失败',
        detail: new RegExp(`^白纸记录 ${LEDGER_URI} 解析失败：.+；远端任务一律不开，原文件不覆盖，修复或移走后重启$`),
        refused: '白纸记录读取失败，等 owner 处理',
      },
    ],
  ])('%s：记录读取失败：发「出错」提示跳到白纸页，管理动作一律回错误', async (language, expected) => {
    const files: PaperFiles = new Map([[LEDGER_URI, '{ 坏了']]);
    const hub = await startPaperHub({ files });
    expect(renderIn(hub.pages.notices(), language)).toEqual([
      {
        instance: '@aalis/plugin-paper',
        id: 'ledger',
        level: 'error',
        title: expected.title,
        detail: expect.stringMatching(expected.detail),
        open: { page: 'paper' },
      },
    ]);
    for (const [action, rowKey] of [
      ['archivePaper', PAPER_ID],
      ['cancelTask', 't-00000001'],
    ]) {
      const reply = await hub.pages.act('paper', action, { rowKey });
      expect([reply.status, saidIn(reply, language)]).toEqual([500, expected.refused]);
    }
  });
});

describe('会话面板', () => {
  it('只在开了白纸的群出现：没开白纸的群与 owner 的会话都不出现', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: PILOT_ROOM, [ROOM2]: { paperEnabled: false } } });
    expect(await hub.pages.panels(ROOM)).toEqual(['paper-room']);
    expect(await hub.pages.panels(ROOM2)).toEqual([]);
    expect(await hub.pages.panels('webui:zz-owner')).toEqual([]);
  });

  it('按当前会话取：本群的白纸、进行中的任务与最近的成品，别的群看不到', async () => {
    const a = new ScriptedRemote();
    const hub = await startPaperHub({
      remotes: { [REMOTE]: a },
      config: ROOMY_CONFIG,
      rooms: { [ROOM]: ROOMY_ROOM, [ROOM2]: ROOMY_ROOM },
    });
    const taskId = await accept(hub, '像素猫');
    await running(hub, taskId);
    const panel = (sessionId: string, id: string) => hub.pages.data<Row[]>('paper-room', id, { sessionId });
    expect(toSource(await panel(ROOM, 'room'))).toEqual(
      expect.arrayContaining([
        { label: '白纸', value: PAPER },
        { label: '状态', value: { text: '正常' }, kind: 'status' },
        { label: '本群每天上限', value: '100,000 美分' },
      ]),
    );
    expect(await panel(ROOM, 'tasks')).toMatchObject([{ id: taskId, name: '像素猫', cancellable: true }]);
    expect(await panel(ROOM2, 'tasks')).toEqual([]);

    a.outputs.set(taskId, [{ rel: 'cat.png', data: PNG }]);
    a.finish(hub.ledger().tasks[taskId].runId ?? '', 'finished');
    await waitFor(() => hub.ledger().tasks[taskId]?.state === 'done', '任务完成');
    expect(await panel(ROOM, 'tasks')).toEqual([]);
    expect(await panel(ROOM, 'artifacts')).toMatchObject([{ task: '像素猫', type: 'png' }]);
    expect(await panel(ROOM2, 'artifacts')).toEqual([]);
  });

  it('取消只认本群的任务；恢复本群的白纸，没停开的回失败', async () => {
    const files = seeded([], ledger => {
      ledger.papers[PAPER_ID] = { lastClearedAt: 0, halted: { reason: 'provider', detail: '提供者故障', at: 1 } };
      ledger.tasks['t-00000001'] = doneTask('t-00000001', [], { state: 'queued' });
    });
    const hub = await startPaperHub({ files });
    const inRoom = async (action: string, body: Record<string, unknown>) =>
      toSource(await hub.pages.act('paper-room', action, body));
    expect(await inRoom('cancelTask', { rowKey: 't-00000001', sessionId: ROOM2 })).toEqual(refused('本群没有这件任务'));
    expect(await inRoom('cancelTask', { rowKey: 't-00000001', sessionId: ROOM })).toEqual(ok('已取消'));
    expect(await inRoom('resumeRoomPaper', { sessionId: ROOM })).toEqual(ok('已恢复'));
    expect(hub.ledger().papers[PAPER_ID].halted).toBeUndefined();
    expect(await inRoom('resumeRoomPaper', { sessionId: ROOM })).toEqual(refused('这块白纸没有停开'));
  });
});
