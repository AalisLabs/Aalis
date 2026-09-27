import { afterEach, describe, expect, it } from 'vitest';
import type {
  WebuiComponent,
  WebuiFilePayload,
  WebuiTableComponent,
  WebuiTabsComponent,
} from '../../packages/api-webui/src/index.js';
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
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';
import { PNG, ScriptedRemote, text } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// WebUI 白纸页（U10d）：声明式页面 paper，白纸、任务、成品、账本、告警五个表；owner 的管理动作
// （换新、归档代理、清空、恢复、取消任务、告警已读）经页面动作调运行驱动；成品经 readArtifact 以
// { name, mime, base64 } 取回，mime 按文件头判定：只有位图给对应类型，其余（含 HTML、SVG）一律
// application/octet-stream，不在 WebUI 源里渲染。真实 App 装载插件，远端用 ScriptedRemote，真实时钟。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const PAPER_ID = `n:${PAPER}`;
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
  const res = await hub.call('paper_task', { text: `${name}的原文`, name }, human('30001'));
  if (res.ok !== true) throw new Error(`paper_task 未受理：${String(res.error)}`);
  return String(res.taskId);
}

async function running(hub: PaperHub, taskId: string): Promise<string> {
  await waitFor(() => hub.ledger().tasks[taskId]?.state === 'running', `${taskId} 开轮`);
  return hub.ledger().tasks[taskId].runId ?? '';
}

async function rows(hub: PaperHub, method: string): Promise<Row[]> {
  return (await hub.action(method)) as Row[];
}

function tabsOf(hub: PaperHub): WebuiTabsComponent {
  const page = hub.pages.find(p => p.key === 'paper');
  expect(page, '白纸页已登记').toBeDefined();
  const tabs = page?.content?.find((c: WebuiComponent) => c.type === 'tabs');
  expect(tabs, '白纸页是 tabs').toBeDefined();
  return tabs as WebuiTabsComponent;
}

function tableOf(hub: PaperHub, label: string): WebuiTableComponent {
  const item = tabsOf(hub).items.find(i => i.label === label);
  const table = item?.content.find(c => c.type === 'table');
  expect(table, `${label} 表`).toBeDefined();
  return table as WebuiTableComponent;
}

function doneTask(id: string, artifacts: TaskRecord['artifacts'], over: Partial<TaskRecord> = {}): TaskRecord {
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
    artifacts,
    delivered: false,
    ...over,
  };
}

/** 账本里一件已完成的任务，成品文件照宿主的命名放进白纸根 */
function seeded(
  tasks: Array<{ task: TaskRecord; bytes: Record<string, Uint8Array> }>,
  mutate?: (ledger: PaperLedger) => void,
): PaperFiles {
  const ledger = emptyLedger();
  const files: PaperFiles = new Map();
  for (const { task, bytes } of tasks) {
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

const HTML = text('<!doctype html><html><body><script>alert(1)</script></body></html>');
const SVG = text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');

describe('页面登记', () => {
  it('白纸页含白纸、任务、成品、账本、告警五个表；数据源、行动作与文件列都指向已登记的页面动作', async () => {
    const hub = await startPaperHub();
    const tabs = tabsOf(hub);
    expect(tabs.items.map(i => i.label)).toEqual(['白纸', '任务', '成品', '账本', '告警']);

    const tables = tabs.items.map(i => tableOf(hub, i.label));
    for (const table of tables) {
      await expect(hub.action(table.source), table.source).resolves.toEqual(expect.any(Array));
      for (const act of table.actions ?? []) {
        // 未登记的动作会抛「未登记」；登记了的对空参数回业务失败
        await expect(hub.action(act.method, {}), act.method).resolves.toMatchObject({ ok: false });
      }
    }

    const papers = tableOf(hub, '白纸');
    expect(papers.actions?.map(a => a.label)).toEqual(['换新', '归档代理', '清空', '恢复']);
    const rotate = papers.actions?.find(a => a.label === '换新');
    expect(rotate?.confirm).toContain('只重置对话，工程包照常带到新代理');
    const clear = papers.actions?.find(a => a.label === '清空');
    expect(clear).toMatchObject({ danger: true });
    expect(clear?.confirm).toMatch(/远端代理/);

    const tasks = tableOf(hub, '任务');
    expect(tasks.actions?.map(a => a.label)).toEqual(['取消', '放弃跟踪', '核销预留']);
    expect(tasks.columns.find(c => c.key === 'text')?.render).toBe('expandable-text');

    const artifacts = tableOf(hub, '成品');
    const fileColumn = artifacts.columns.find(c => c.render === 'file');
    expect(fileColumn?.method).toBe('readArtifact');
    await expect(hub.action('readArtifact', {})).resolves.toMatchObject({ ok: false });

    expect(tableOf(hub, '告警').actions?.map(a => a.label)).toEqual(['已读']);
  });
});

describe('跑完一件任务后的五个表', () => {
  it('白纸、任务、成品、账本各行对得上；位图成品按 image/png 取回', async () => {
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

    const [paper] = await rows(hub, 'listPapers');
    expect(paper).toMatchObject({ paperId: PAPER_ID, name: PAPER, remoteAgentType: REMOTE, halted: '' });
    expect(String(paper.rooms)).toContain(ROOM);
    expect(String(paper.agent)).toContain(agentName);
    expect(String(paper.agent)).toContain('active');
    expect(String(paper.egress)).toContain('allowlist');
    expect(String(paper.egress)).toContain('未核实');
    expect(String(paper.usage)).toContain('2048');

    const [task] = await rows(hub, 'listTasks');
    expect(task).toMatchObject({
      id: taskId,
      room: ROOM,
      initiator: 'onebot:30001',
      name: '像素猫',
      state: 'done',
      cost: 10,
      text: '像素猫的原文',
      artifacts: 2,
    });

    const artifacts = await rows(hub, 'listArtifacts');
    expect(artifacts.map(r => [r.taskId, r.type, r.rel])).toEqual([
      [taskId, 'png', 'cat.png'],
      [taskId, 'html', 'index.html'],
    ]);

    const spend = await rows(hub, 'listSpend');
    expect(spend).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: expect.stringContaining('全局'), cents: 10, tasks: 1, reserved: 0 }),
        expect.objectContaining({ scope: expect.stringContaining(ROOM), cents: 10, tasks: 1 }),
        expect.objectContaining({ scope: expect.stringContaining('onebot:30001'), cents: 10, tasks: 1 }),
      ]),
    );

    const png = (await hub.action('readArtifact', artifacts[0])) as WebuiFilePayload;
    expect(png.mime).toBe('image/png');
    expect(Buffer.from(png.base64, 'base64')).toEqual(Buffer.from(PNG));
    expect(png.name).toBe(`${artifacts[0].artifactId}.png`);
  });

  it('账本行：预留中的金额按房间与发起者列出', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '网页');
    await running(hub, taskId);
    const reserve = hub.ledger().reserves[taskId].cents;
    const spend = await rows(hub, 'listSpend');
    expect(spend).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: expect.stringContaining('全局'), cents: 0, reserved: reserve }),
        expect.objectContaining({ scope: expect.stringContaining(ROOM), reserved: reserve }),
        expect.objectContaining({ scope: expect.stringContaining('onebot:30001'), reserved: reserve, tasks: 1 }),
      ]),
    );
  });
});

describe('白纸表的「共用的房间」', () => {
  it('受众条目写了 paperName：列出继承它的已登记房间与这个受众的全部房间，标为共用', async () => {
    const hub = await startPaperHub({
      listed: { [ROOM]: {} },
      audienceProfiles: { 'onebot/group': { paperName: PAPER } },
    });
    const paper = (await rows(hub, 'listPapers')).find(r => r.paperId === PAPER_ID);
    expect(paper?.rooms).toBe(`共用（2）：${ROOM}、平台档 onebot 的全部群房间`);
  });

  it('对照：只有房间自己的配置写了 paperName、没有平台档时不算共用', async () => {
    const hub = await startPaperHub({ listed: { [ROOM]: { paperName: PAPER } } });
    const paper = (await rows(hub, 'listPapers')).find(r => r.paperId === PAPER_ID);
    expect(paper?.rooms).toBe(ROOM);
  });
});

describe('readArtifact', () => {
  const html = { id: 'a-0000000a', rel: 'index.html', type: 'html' as const, sizeBytes: HTML.byteLength };
  const svg = { id: 'a-0000000b', rel: 'pic.svg', type: 'other' as const, sizeBytes: SVG.byteLength };
  const fakePng = { id: 'a-0000000c', rel: 'fake.png', type: 'png' as const, sizeBytes: HTML.byteLength };
  const realPng = { id: 'a-0000000d', rel: 'real.png', type: 'png' as const, sizeBytes: PNG.byteLength };

  function files() {
    return seeded([
      {
        task: doneTask('t-00000001', [html, svg, fakePng, realPng]),
        bytes: { [html.id]: HTML, [svg.id]: SVG, [fakePng.id]: HTML, [realPng.id]: PNG },
      },
    ]);
  }

  it('安全：HTML 与 SVG 成品回 application/octet-stream；账本记作位图、文件头却不是的也一样', async () => {
    const hub = await startPaperHub({ files: files() });
    for (const artifact of [html, svg, fakePng]) {
      const out = (await hub.action('readArtifact', {
        taskId: 't-00000001',
        artifactId: artifact.id,
      })) as WebuiFilePayload;
      expect(out.mime, artifact.rel).toBe('application/octet-stream');
      expect(out.base64.length, artifact.rel).toBeGreaterThan(0);
    }
    const png = (await hub.action('readArtifact', {
      taskId: 't-00000001',
      artifactId: realPng.id,
    })) as WebuiFilePayload;
    expect(png.mime).toBe('image/png');
  });

  it('文件名由宿主给（产物 id 加判定类型的扩展名），不用远端给的路径', async () => {
    const hub = await startPaperHub({ files: files() });
    const out = (await hub.action('readArtifact', { taskId: 't-00000001', artifactId: svg.id })) as WebuiFilePayload;
    expect(out.name).toBe(`${svg.id}.bin`);
  });

  it('找不到的任务或成品、已随清空删除的、超过单文件上限的都拒绝', async () => {
    const big = { id: 'a-0000000e', rel: 'big.png', type: 'png' as const, sizeBytes: 64 };
    const cleared = doneTask('t-00000002', [realPng], { artifactsCleared: true });
    const hub = await startPaperHub({
      config: { ...PILOT_CONFIG, artifacts: { maxFileMB: 32 / (1024 * 1024) } },
      files: seeded([
        { task: doneTask('t-00000001', [realPng, big]), bytes: { [realPng.id]: PNG, [big.id]: new Uint8Array(64) } },
        { task: cleared, bytes: { [realPng.id]: PNG } },
      ]),
    });
    const refused = [
      { taskId: 't-0000000f', artifactId: realPng.id },
      { taskId: 't-00000001', artifactId: 'a-ffffffff' },
      { taskId: 't-00000002', artifactId: realPng.id },
      { taskId: 't-00000001', artifactId: big.id },
      { taskId: 42, artifactId: realPng.id },
    ];
    for (const args of refused) {
      expect(await hub.action('readArtifact', args), JSON.stringify(args)).toMatchObject({ ok: false });
    }
    const ok = (await hub.action('readArtifact', { taskId: 't-00000001', artifactId: realPng.id })) as WebuiFilePayload;
    expect(ok.mime).toBe('image/png');
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
    expect(await hub.action('archivePaper', { paperId: PAPER_ID })).toMatchObject({ ok: true });
    expect(a.callsOn('archiveAgent', agentId)).toHaveLength(1);
    expect(hub.ledger().agents[agentId].state).toBe('archived');
    // 已归档的再归档：没有在用的代理
    expect(await hub.action('archivePaper', { paperId: PAPER_ID })).toMatchObject({ ok: false });
    expect(a.count('archiveAgent')).toBe(1);
  });

  it('归档代理：白纸上有未结束的任务时拒绝，不调提供者', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '网页');
    await running(hub, taskId);
    const res = await hub.action('archivePaper', { paperId: PAPER_ID });
    expect(res).toMatchObject({ ok: false });
    expect(a.count('archiveAgent')).toBe(0);
  });

  it('换新：下一件任务建新代理（账本置 rotateNext），不动远端', async () => {
    const { a, hub } = await finishedHub();
    const before = a.calls.length;
    expect(await hub.action('rotatePaper', { paperId: PAPER_ID })).toMatchObject({ ok: true });
    expect(hub.ledger().papers[PAPER_ID].rotateNext).toBe(true);
    expect(a.calls.length).toBe(before);
  });

  it('清空：删除远端代理与白纸目录，任务记录保留、成品标为已清空，成品表随之为空', async () => {
    const { a, hub, taskId, agentId } = await finishedHub();
    expect([...hub.files.keys()].some(k => k.startsWith(`${DIR}/`))).toBe(true);
    expect(await hub.action('clearPaper', { paperId: PAPER_ID })).toMatchObject({ ok: true });
    await waitFor(() => !hub.ledger().agents[agentId], '代理移出账本');
    expect(a.callsOn('deleteAgent', agentId)).toHaveLength(1);
    const ledger = hub.ledger();
    expect(ledger.papers[PAPER_ID].binding).toBeUndefined();
    expect(ledger.tasks[taskId]).toMatchObject({ state: 'done', artifactsCleared: true });
    expect([...hub.files.keys()].some(k => k.startsWith(`${DIR}/`))).toBe(false);
    expect(await rows(hub, 'listArtifacts')).toEqual([]);
  });

  it('清空：有任务在跑时拒绝并给出原因', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '网页');
    await running(hub, taskId);
    const res = (await hub.action('clearPaper', { paperId: PAPER_ID })) as Row;
    expect(res).toMatchObject({ ok: false });
    expect(String(res.error)).toMatch(/在跑/);
    expect(a.count('deleteAgent')).toBe(0);
  });

  it('恢复：清除停开；没停开的回失败', async () => {
    const files = seeded([], ledger => {
      ledger.papers[PAPER_ID] = {
        lastClearedAt: Date.now(),
        halted: { reason: 'cost-missing', detail: 'HALT-DETAIL-轮次费用取不到', at: 1 },
      };
    });
    const hub = await hubWith(new ScriptedRemote(), { files });
    const [paper] = await rows(hub, 'listPapers');
    expect(String(paper.halted)).toContain('HALT-DETAIL');
    expect(await hub.action('resumePaper', { paperId: PAPER_ID })).toMatchObject({ ok: true });
    expect(hub.ledger().papers[PAPER_ID].halted).toBeUndefined();
    expect(await hub.action('resumePaper', { paperId: PAPER_ID })).toMatchObject({ ok: false });
  });

  it('不认识的白纸一律回失败，账本里不多出白纸', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    for (const method of ['rotatePaper', 'archivePaper', 'clearPaper', 'resumePaper']) {
      expect(await hub.action(method, { paperId: 'n:zz-no-such' }), method).toMatchObject({ ok: false });
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

    expect(await hub.action('cancelTask', { id: taskId })).toMatchObject({ ok: true });
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
    expect(await hub.action('cancelTask', { id: taskId })).toMatchObject({ ok: true });
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
    expect(await hub.action('cancelTask', { id: 't-00000001' })).toMatchObject({ ok: false });
    expect(await hub.action('cancelTask', { id: 't-0000000f' })).toMatchObject({ ok: false });
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
    const [row] = await rows(hub, 'listTasks');
    expect(row.cost).toBe('预留 70');

    expect(await hub.action('writeOffReserve', { id: 't-00000001' })).toMatchObject({ ok: true });
    const ledger = hub.ledger();
    expect(ledger.reserves['t-00000001']).toBeUndefined();
    expect(ledger.runs['run-1'].cost).toEqual({ state: 'booked', cents: 70, estimated: true });
    expect(Object.values(ledger.spend)[0]).toMatchObject({ global: 70, rooms: { [ROOM]: 70 } });
    expect(ledger.tasks['t-00000001'].costCents).toBe(70);
    expect(await hub.action('writeOffReserve', { id: 't-00000001' }), '没有预留了').toMatchObject({ ok: false });
  });

  it('还没结束的任务不能核销', async () => {
    const files = seeded([{ task: doneTask('t-00000001', [], { state: 'queued' }), bytes: {} }], ledger => {
      ledger.reserves['t-00000001'] = { cents: 70, day: '2026-09-27', room: ROOM, user: 'onebot:30001' };
    });
    const hub = await startPaperHub({ files });
    expect(await hub.action('writeOffReserve', { id: 't-00000001' })).toMatchObject({ ok: false });
    expect(hub.ledger().reserves['t-00000001']).toBeDefined();
  });
});

describe('放弃跟踪', () => {
  it('没有到点取消失败的运行中任务不能放弃跟踪', async () => {
    const a = new ScriptedRemote();
    const hub = await hubWith(a);
    const taskId = await accept(hub, '任务一');
    await running(hub, taskId);
    const res = await hub.action('abandonTask', { id: taskId });
    expect(res).toMatchObject({ ok: false });
    expect(hub.ledger().tasks[taskId].state).toBe('running');
  });
});

describe('告警', () => {
  it('列出告警；账本外代理的告警标为已读后，用这个提供者的白纸解除停开', async () => {
    const files = seeded([], ledger => {
      ledger.alerts.push({
        id: 'al-00000001',
        at: Date.now(),
        kind: 'unknown-agent',
        subject: 'bc-foreign',
        providerType: REMOTE,
        message: '账号下有账本外的代理 FOREIGN-AGENT',
        acknowledged: false,
      });
    });
    const hub = await hubWith(new ScriptedRemote(), { files });
    const [alert] = await rows(hub, 'listAlerts');
    expect(alert).toMatchObject({ id: 'al-00000001', kind: 'unknown-agent', status: '未读' });
    expect(String(alert.message)).toContain('FOREIGN-AGENT');

    const refused = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(String(refused.error)).toMatch(/账本外的代理/);

    expect(await hub.action('acknowledgeAlert', { id: 'al-00000001' })).toMatchObject({ ok: true });
    expect(hub.ledger().alerts[0].acknowledged).toBe(true);
    expect((await rows(hub, 'listAlerts'))[0].status).toBe('已读');
    expect(await hub.action('acknowledgeAlert', { id: 'al-00000001' })).toMatchObject({ ok: false });

    const accepted = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(accepted.ok).toBe(true);
  });
});
