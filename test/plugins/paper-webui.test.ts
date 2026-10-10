import { afterEach, describe, expect, it } from 'vitest';
import { type PublishService, publish } from '../../packages/api-publish/src/index.js';
import { placePaperId } from '../../packages/api-session-manager/src/index.js';
import type { ComponentView, DeclarativePageView, InfoItem } from '../../packages/api-webui/src/index.js';
import { provide } from '../../packages/core/src/index.js';
import type { PaperLedger, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import {
  emptyLedger,
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
// 成品交存储地址：宿主签发下载句柄（一律当附件下发），只有账本记作位图的给预览（宿主经 /api/media 按文件头再核）。
// 账本落盘后两页都重取；未读告警数与账本读取失败发提示。真实 App 装载插件，远端用 ScriptedRemote，真实时钟。
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

const papers = (hub: PaperHub) => hub.pages.data<Row[]>('paper', 'papers');
const tasks = (hub: PaperHub, paperId = PAPER_ID) => hub.pages.data<Row[]>('paper', 'paperTasks', { rowKey: paperId });
const artifacts = (hub: PaperHub, paperId = PAPER_ID) =>
  hub.pages.data<Row[]>('paper', 'paperArtifacts', { rowKey: paperId });
const spend = (hub: PaperHub) => hub.pages.data<Row[]>('paper', 'spend');
const alerts = (hub: PaperHub) => hub.pages.data<Row[]>('paper', 'alerts');
/** 白纸详情的键值：名称 → 值 */
async function info(hub: PaperHub, paperId = PAPER_ID): Promise<Map<string, unknown>> {
  const items = await hub.pages.data<InfoItem[]>('paper', 'paper', { rowKey: paperId });
  return new Map(items.map(item => [item.label, item.value]));
}
const act = (hub: PaperHub, action: string, rowKey: string) => hub.pages.act('paper', action, { rowKey });
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

/** 账本里一件已完成的任务，成品文件照宿主的命名放进白纸根 */
function seeded(
  seeds: Array<{ task: TaskRecord; bytes: Record<string, Uint8Array> }>,
  mutate?: (ledger: PaperLedger) => void,
): PaperFiles {
  const ledger = emptyLedger();
  const files: PaperFiles = new Map();
  for (const { task, bytes } of seeds) {
    ledger.tasks[task.id] = task;
    for (const a of task.artifacts) {
      const ext = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', mp4: 'mp4', html: 'html', other: 'bin' }[a.type];
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
    message: '账号下有账本外的代理 FOREIGN-AGENT',
    acknowledged: false,
  });
};

const HTML = text('<!doctype html><html><body><script>alert(1)</script></body></html>');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
const media = (uri: string) => `/api/media?${new URLSearchParams({ uri })}`;

describe('页面登记', () => {
  it('白纸页与会话面板都过登记门槛；白纸页分「白纸」「创作日志」两个标签', async () => {
    const hub = await startPaperHub();
    expect(hub.pages.logs).toEqual([]);
    const view = hub.pages.view('paper');
    expect(view).toMatchObject({ title: '白纸', placement: 'plugin', icon: 'file' });
    expect('tabs' in view.content && view.content.tabs.map(tab => tab.title)).toEqual(['白纸', '创作日志']);
    expect(hub.pages.view('paper-room')).toMatchObject({ title: '白纸', placement: 'session' });
  });

  it('动作按语义分效果：会丢东西的弹确认；恢复、放弃跟踪、核销与已读按行状态显示', async () => {
    const hub = await startPaperHub();
    const actions = hub.pages.view('paper').actions ?? {};
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
      listed: { [ROOM]: {}, [ROOM2]: {} },
      placeProfiles: { 'onebot:group:20001': PILOT_ROOM, 'onebot:group:20002': PILOT_ROOM },
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

  it('白纸详情只显示获准发布目标的地址与状态，显式空显示禁发布', async () => {
    const hub = await startPaperHub({
      config: {
        ...PILOT_CONFIG,
        papers: [
          { name: PAPER, publishTargets: 'one, two', defaultPublishTarget: 'two' },
          { name: 'closed', publishTargets: '' },
        ],
      },
    });
    hub.app.bind({ provide }).provide.use(publish, {
      listSurfaces: () => [
        { name: 'one', label: '主站', baseUrl: 'https://aalis1.example.test', available: true },
        { name: 'two', label: '画板', baseUrl: 'https://aalis2.example.test/draw', available: false, reason: '暂停' },
        { name: 'secret', baseUrl: 'https://secret.example.test', available: true },
      ],
    } as unknown as PublishService);
    const open = await info(hub);
    const closed = await info(hub, 'n:closed');
    expect(String(open.get('可用发布目标'))).toContain('https://aalis2.example.test/draw');
    expect(String(open.get('可用发布目标'))).toContain('不可用：暂停');
    expect(String(open.get('可用发布目标'))).not.toContain('secret.example.test');
    expect(open.get('默认发布目标')).toBe('two');
    expect(closed.get('可用发布目标')).toBe('（禁止发布）');
    expect(closed.get('默认发布目标')).toBe('（禁止发布）');
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
    expect(String(paper.agent)).toContain('active');
    const detail = await info(hub);
    expect(String(detail.get('共用的房间'))).toContain(ROOM);
    expect(detail.get('远端类型')).toBe(REMOTE);
    expect(String(detail.get('出网'))).toContain('allowlist');
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
});

describe('白纸详情的「共用的房间」', () => {
  it('平台类型档写了 paperName：列出继承它的已登记房间与这一档的全部房间，标为共用', async () => {
    const hub = await startPaperHub({
      listed: { [ROOM]: {} },
      typeProfiles: { 'onebot/group': { paperName: PAPER } },
    });
    expect((await info(hub)).get('共用的房间')).toBe(`共用（2）：${ROOM}、平台类型档 onebot · group 的全部房间`);
  });

  it('对照：只有一个窗口的场所写了 paperName、没有平台档与平台类型档时不算共用', async () => {
    const hub = await startPaperHub({
      listed: { [ROOM]: {} },
      placeProfiles: { 'onebot:group:20001': { paperName: PAPER } },
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

  it('归档代理：调提供者的 archiveAgent，账本里代理转为 archived', async () => {
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

  it('换新：下一件任务建新代理（账本置 rotateNext），不动远端', async () => {
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
    await waitFor(() => !hub.ledger().agents[agentId], '代理移出账本');
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

  it('不认识的白纸一律回失败，账本里不多出白纸', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    for (const action of ['rotatePaper', 'archivePaper', 'clearPaper', 'resumePaper', 'freshStartPaper']) {
      expect(await act(hub, action, 'n:zz-no-such'), action).toEqual(refused('没有这块白纸'));
    }
    expect(hub.ledger()?.papers?.['n:zz-no-such']).toBeUndefined();
    expect(a.count('deleteAgent') + a.count('archiveAgent')).toBe(0);
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
  it('列出告警；账本外代理的告警标为已读后，用这个提供者的白纸解除停开', async () => {
    const hub = await hubWith(new ScriptedRemote(), { files: seeded([], unreadAlert) });
    const [alert] = await alerts(hub);
    expect(alert).toMatchObject({
      id: 'al-00000001',
      kind: 'unknown-agent',
      status: { text: '未读', state: 'attention' },
      unread: true,
    });
    expect(String(alert.message)).toContain('FOREIGN-AGENT');

    const refusedTask = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(String(refusedTask.error)).toMatch(/账本外的代理/);

    expect(await act(hub, 'acknowledgeAlert', 'al-00000001')).toEqual(ok('已标为已读'));
    expect(hub.ledger().alerts[0].acknowledged).toBe(true);
    expect((await alerts(hub))[0]).toMatchObject({ status: { text: '已读', state: 'inactive' }, unread: false });
    expect(await act(hub, 'acknowledgeAlert', 'al-00000001')).toEqual(refused('没有这条未读告警'));

    const accepted = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(accepted.ok).toBe(true);
  });

  it('未读告警发提示，数量写进标题、跳到白纸页；全部标为已读后撤回', async () => {
    const hub = await hubWith(new ScriptedRemote(), { files: seeded([], unreadAlert) });
    expect(hub.pages.notices()).toEqual([
      {
        instance: '@aalis/plugin-paper',
        id: 'alerts',
        level: 'action',
        title: '1 条白纸告警未读',
        open: { page: 'paper' },
      },
    ]);
    await act(hub, 'acknowledgeAlert', 'al-00000001');
    expect(hub.pages.notices()).toEqual([]);
  });

  it('账本每次落盘后白纸页与会话面板都重取', async () => {
    const hub = await hubWith(new ScriptedRemote());
    const before = hub.pages.invalidations.length;
    await accept(hub, '网页');
    const pushed = hub.pages.invalidations.slice(before);
    expect(pushed).toContainEqual({ instance: '@aalis/plugin-paper', pageKey: 'paper' });
    expect(pushed).toContainEqual({ instance: '@aalis/plugin-paper', pageKey: 'paper-room' });
  });

  it('账本读取失败：发「出错」提示跳到白纸页，管理动作一律回错误', async () => {
    const files: PaperFiles = new Map([[LEDGER_URI, '{ 坏了']]);
    const hub = await startPaperHub({ files });
    expect(hub.pages.notices()).toEqual([
      expect.objectContaining({ id: 'ledger', level: 'error', title: '白纸账本读取失败', open: { page: 'paper' } }),
    ]);
    expect(await act(hub, 'archivePaper', PAPER_ID)).toEqual(refused('白纸账本读取失败，等 owner 处理'));
    expect(await act(hub, 'cancelTask', 't-00000001')).toEqual(refused('白纸账本读取失败，等 owner 处理'));
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
    expect(await panel(ROOM, 'room')).toEqual(
      expect.arrayContaining([
        { label: '白纸', value: PAPER },
        { label: '状态', value: { text: '正常' }, kind: 'status' },
        { label: '本群每天上限', value: '100000 美分' },
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
    expect(await hub.pages.act('paper-room', 'cancelTask', { rowKey: 't-00000001', sessionId: ROOM2 })).toEqual(
      refused('本群没有这件任务'),
    );
    expect(await hub.pages.act('paper-room', 'cancelTask', { rowKey: 't-00000001', sessionId: ROOM })).toEqual(
      ok('已取消'),
    );
    expect(await hub.pages.act('paper-room', 'resumeRoomPaper', { sessionId: ROOM })).toEqual(ok('已恢复'));
    expect(hub.ledger().papers[PAPER_ID].halted).toBeUndefined();
    expect(await hub.pages.act('paper-room', 'resumeRoomPaper', { sessionId: ROOM })).toEqual(
      refused('这块白纸没有停开'),
    );
  });
});
