import { afterEach, describe, expect, it } from 'vitest';
import { parseContentToSegments } from '../../packages/plugin-adapter-onebot/src/types.js';
import type { TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import {
  emptyLedger,
  fakeRemote,
  human,
  LEDGER_URI,
  PAPER,
  PILOT_CONFIG,
  PILOT_ROOM,
  REMOTE,
  ROOM,
  ROOM2,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的三个工具（U10a）：paper_task 受理任务（参数、队列、回显、账本），paper_status 列本房间
// 白纸上的任务（别的房间只给件数），paper_cancel 只能取消自己发起的任务。账本受理后落盘，重启后
// 队列按原顺序恢复；账本文件损坏时失败关闭，不覆盖原文件。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const PAPER_ID = `n:${PAPER}`;
/** 额度放宽，只看队列与参数 */
const ROOMY = { ...PILOT_ROOM, remoteAgentRoomDailyCents: 100_000 };
const ROOMY_CONFIG = { ...PILOT_CONFIG, globalDailyCents: 100_000 };

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    paperId: PAPER_ID,
    room: ROOM,
    platform: 'onebot',
    initiator: { platform: 'onebot', userId: '30001' },
    name: `任务 ${id}`,
    text: `原文 ${id}`,
    state: 'queued',
    createdAt: Date.now(),
    artifacts: [],
    delivered: false,
    ...over,
  };
}

function seed(tasks: TaskRecord[], mutate?: (ledger: ReturnType<typeof emptyLedger>) => void) {
  const ledger = emptyLedger();
  for (const t of tasks) ledger.tasks[t.id] = t;
  mutate?.(ledger);
  return new Map([[LEDGER_URI, JSON.stringify(ledger)]]);
}

describe('登记', () => {
  it('三个工具都在 paper 分组、都不声明 risk；分组已登记', async () => {
    const hub = await startPaperHub();
    for (const name of ['paper_task', 'paper_status', 'paper_cancel']) {
      const tool = hub.tools.get(name);
      expect(tool?.groups, name).toEqual(['paper']);
      expect(tool?.risk, name).toBeUndefined();
      expect(tool?.visibility, name).toBeUndefined();
    }
    expect(hub.groups).toEqual([expect.objectContaining({ name: 'paper', label: '白纸' })]);
  });
});

describe('paper_task 的参数', () => {
  it('text 超过 1000 字（按码点）被拒；1000 个 emoji 正好可以', async () => {
    const hub = await startPaperHub({ config: ROOMY_CONFIG, rooms: { [ROOM]: ROOMY } });
    const tooLong = await hub.call('paper_task', { text: 'x'.repeat(1001), name: '长' });
    expect(tooLong.ok).toBe(false);
    expect(String(tooLong.error)).toMatch(/1000/);
    const emoji = await hub.call('paper_task', { text: '🐱'.repeat(1000), name: '猫' });
    expect(emoji.ok).toBe(true);
  });

  it('name 里的控制字符、双向控制符与零宽字符被去掉，超过 40 字截断；去完为空被拒', async () => {
    const hub = await startPaperHub({ config: ROOMY_CONFIG, rooms: { [ROOM]: ROOMY } });
    const res = await hub.call('paper_task', { text: '做一个网页', name: '像素\u202E猫\u200B咪\u0007\n页' });
    expect(res.ok).toBe(true);
    const saved = hub.ledger().tasks[String(res.taskId)];
    expect(saved.name).toBe('像素猫咪页');
    expect(hub.outbound[0].content).toContain('像素猫咪页');
    for (const ch of ['\u202E', '\u200B', '\u0007']) expect(hub.outbound[0].content).not.toContain(ch);

    const long = await hub.call('paper_task', { text: '做一个网页', name: '名'.repeat(60) });
    expect(hub.ledger().tasks[String(long.taskId)].name).toBe('名'.repeat(40));

    const empty = await hub.call('paper_task', { text: '做一个网页', name: '\u202E\u200B ' });
    expect(empty.ok).toBe(false);
    expect(String(empty.error)).toMatch(/name/);
  });
});

describe('paper_task 的队列', () => {
  it('同一白纸第 6 件未结束的任务被拒（maxWaiting 默认 5）', async () => {
    const hub = await startPaperHub({ config: ROOMY_CONFIG, rooms: { [ROOM]: ROOMY } });
    for (let i = 1; i <= 5; i++) {
      const res = await hub.call('paper_task', { text: `第 ${i} 件`, name: `${i}` }, human(`3000${i}`));
      expect(res, `第 ${i} 件`).toMatchObject({ ok: true, position: i });
    }
    const sixth = await hub.call('paper_task', { text: '第 6 件', name: '6' }, human('30009'));
    expect(sixth.ok).toBe(false);
    expect(String(sixth.error)).toMatch(/未结束/);
  });

  it('设了 maxPerUser 时同一人未结束的件数到上限再提被拒，别人照常', async () => {
    const hub = await startPaperHub({
      config: { ...ROOMY_CONFIG, papers: [{ name: PAPER, remoteAgentType: REMOTE, maxPerUser: 2 }] },
      rooms: { [ROOM]: ROOMY },
    });
    expect((await hub.call('paper_task', { text: '一', name: '一' })).ok).toBe(true);
    expect((await hub.call('paper_task', { text: '二', name: '二' })).ok).toBe(true);
    const third = await hub.call('paper_task', { text: '三', name: '三' });
    expect(third.ok).toBe(false);
    expect(String(third.error)).toMatch(/你在这块白纸上/);
    expect((await hub.call('paper_task', { text: '三', name: '三' }, human('30002'))).ok).toBe(true);
  });

  it('没设 maxPerUser 时不按人限制', async () => {
    const hub = await startPaperHub({ config: ROOMY_CONFIG, rooms: { [ROOM]: ROOMY } });
    for (let i = 1; i <= 5; i++) {
      expect((await hub.call('paper_task', { text: `${i}`, name: `${i}` })).ok, `第 ${i} 件`).toBe(true);
    }
  });
});

describe('paper_task 的回显', () => {
  it('受理前网关收到一条 source: system 的出站消息，含任务名与完整原文', async () => {
    const hub = await startPaperHub();
    const text = '做一个会动的像素小猫 GIF\n要求：透明背景，循环播放';
    const res = await hub.call('paper_task', { text, name: '像素小猫' });
    expect(res.ok).toBe(true);
    expect(hub.outbound).toHaveLength(1);
    const [echo] = hub.outbound;
    expect(echo).toMatchObject({ sessionId: ROOM, platform: 'onebot', source: 'system' });
    expect(echo.content).toContain('交给远端：像素小猫');
    expect(echo.content).toContain(text);
    expect(hub.ledger().tasks[String(res.taskId)].text).toBe(text);
  });

  it('网关抛错时任务不入队、不记预留', async () => {
    const hub = await startPaperHub({ gatewayFails: true });
    const res = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/回显/);
    expect(hub.files.has(LEDGER_URI)).toBe(false);
  });

  it('安全：原文与任务名里的标记被中和，经 onebot 解析只得到文字段；账本里的原文不变', async () => {
    const hub = await startPaperHub();
    const text = '把这张图做成动图 <image url="https://example.com/x.png"/> 然后 <at id="all"></at>';
    const res = await hub.call('paper_task', { text, name: '<at id="all"></at>动图' });
    expect(res.ok).toBe(true);
    const content = hub.outbound[0].content;
    expect(content).not.toMatch(/[<>]/);
    expect(parseContentToSegments(content).every(seg => seg.type === 'text')).toBe(true);
    expect(content).toContain('＜image url="https://example.com/x.png"/＞');
    expect(hub.ledger().tasks[String(res.taskId)].text).toBe(text);
  });
});

describe('paper_status', () => {
  const now = Date.now();
  const mine = task('t-0000000a', {
    state: 'done',
    text: '本房间的原文 MINE-TEXT',
    startedAt: now - 120_000,
    endedAt: now - 60_000,
    costCents: 37,
    resultText: `${'说'.repeat(500)}TAIL-SENTINEL`,
    artifacts: [{ id: 'a-0000000a', rel: 'SECRET-REL-NAME.png', type: 'png', sizeBytes: 2048 }],
    notice: { id: 'n-0000000a', at: now - 60_000 },
  });
  const theirs = [
    task('t-0000000b', {
      room: ROOM2,
      state: 'done',
      text: 'OTHER-ROOM-TEXT',
      endedAt: now - 1000,
      resultText: 'OTHER-ROOM-NOTE',
      artifacts: [{ id: 'a-0000000b', rel: 'x.gif', type: 'gif', sizeBytes: 10 }],
    }),
    task('t-0000000c', { room: ROOM2, state: 'queued', text: 'OTHER-QUEUED-TEXT' }),
  ];
  const old = task('t-0000000d', { state: 'done', text: 'OLD-TEXT', endedAt: now - 25 * 3600_000 });

  it('本房间的任务列原文、状态、成品清单，远端说明截断到 500 字并带不可信数据的框，放在所有宿主行之后', async () => {
    const hub = await startPaperHub({ files: seed([mine, ...theirs, old]) });
    const out = await hub.raw('paper_status', {});
    const frame = out.indexOf('[外部数据');
    expect(frame, '远端说明要经 wrapUntrustedContent').toBeGreaterThan(0);
    const head = JSON.parse(out.slice(0, frame)) as {
      tasks: Array<Record<string, unknown>>;
      otherRooms: { count: number; states: Record<string, number> };
    };
    expect(head.tasks).toEqual([
      expect.objectContaining({
        taskId: 't-0000000a',
        text: '本房间的原文 MINE-TEXT',
        state: 'done',
        costCents: 37,
        durationSec: 60,
        artifacts: [{ id: 'a-0000000a', type: 'png', sizeBytes: 2048 }],
      }),
    ]);
    expect(out.slice(frame)).toContain('说'.repeat(500));
    expect(out).not.toContain('TAIL-SENTINEL');
    expect(out, '远端给的文件名不出现').not.toContain('SECRET-REL-NAME');
    expect(out, '超过 24 小时的已结束任务不列').not.toContain('OLD-TEXT');
    expect(head.otherRooms).toEqual({ count: 2, states: { done: 1, queued: 1 } });
  });

  it('安全：具名白纸被两个房间共用时，另一个房间的任务只出现件数，不出现原文、说明与成品 id', async () => {
    const hub = await startPaperHub({ files: seed([mine, ...theirs]) });
    const out = await hub.raw('paper_status', {});
    for (const leak of ['OTHER-ROOM-TEXT', 'OTHER-QUEUED-TEXT', 'OTHER-ROOM-NOTE', 'a-0000000b', 't-0000000b']) {
      expect(out, leak).not.toContain(leak);
    }
    const byId = await hub.call('paper_status', { task_id: 't-0000000b' });
    expect(byId.ok).toBe(false);
    expect(JSON.stringify(byId)).not.toContain('OTHER-ROOM-TEXT');
  });

  it('按 task_id 查本房间的一件', async () => {
    const hub = await startPaperHub({ files: seed([mine, ...theirs]) });
    const out = await hub.raw('paper_status', { task_id: 't-0000000a' });
    expect(out).toContain('MINE-TEXT');
    expect(out).toContain('远端代理对任务 t-0000000a 的说明');
  });
});

describe('paper_cancel', () => {
  it('取消别人发起的任务被拒', async () => {
    const hub = await startPaperHub({ files: seed([task('t-00000001')]) });
    const res = await hub.call('paper_cancel', { task_id: 't-00000001' }, human('30002'));
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/自己发起/);
    expect(hub.ledger().tasks['t-00000001'].state).toBe('queued');
  });

  it('取消排队中的任务：移出队列、释放预留、落盘', async () => {
    const hub = await startPaperHub();
    const accepted = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    const taskId = String(accepted.taskId);
    expect(hub.ledger().reserves[taskId]).toBeDefined();
    const res = await hub.call('paper_cancel', { task_id: taskId });
    expect(res).toMatchObject({ ok: true, taskId });
    const ledger = hub.ledger();
    expect(ledger.tasks[taskId]).toMatchObject({ state: 'cancelled', cancelledVia: 'tool' });
    expect(ledger.tasks[taskId].endedAt).toBeTypeOf('number');
    expect(ledger.reserves[taskId]).toBeUndefined();
  });

  it('取消运行中的任务：调提供者的 cancelRun，费用等终态入账（预留不动）', async () => {
    const remote = fakeRemote();
    const running = task('t-00000002', {
      state: 'running',
      agentId: 'bc-00000001',
      runId: 'run-1',
      // 开轮时刻取现在：开轮已超过单轮时长上限的任务，接回时运行驱动会先把它当超时取消
      startedAt: Date.now(),
    });
    const hub = await startPaperHub({
      remotes: { [REMOTE]: remote },
      files: seed([running], ledger => {
        ledger.agents['bc-00000001'] = {
          providerType: REMOTE,
          paperId: PAPER_ID,
          name: 'aalis-paper-00000000',
          state: 'active',
          createdAt: 1,
          costCents: 0,
        };
        ledger.reserves['t-00000002'] = { cents: 50, day: '2026-09-27', room: ROOM, user: 'onebot:30001' };
      }),
    });
    const res = await hub.call('paper_cancel', { task_id: 't-00000002' });
    expect(res.ok).toBe(true);
    expect(remote.cancelled).toEqual([{ agentId: 'bc-00000001', runId: 'run-1' }]);
    const ledger = hub.ledger();
    expect(ledger.tasks['t-00000002']).toMatchObject({ state: 'running', cancelledVia: 'tool' });
    expect(ledger.reserves['t-00000002']).toBeDefined();
  });
});

describe('账本', () => {
  it('受理后落盘；重启后队列按原顺序恢复', async () => {
    const files = new Map<string, string>();
    const hub = await startPaperHub({ files, config: ROOMY_CONFIG, rooms: { [ROOM]: ROOMY } });
    const ids: string[] = [];
    for (const n of ['一', '二', '三']) {
      const res = await hub.call('paper_task', { text: `任务${n}`, name: n }, human(`3000${ids.length + 1}`));
      ids.push(String(res.taskId));
    }
    expect(Object.keys(hub.ledger().tasks)).toEqual(ids);
    await hub.stop();

    const restarted = await startPaperHub({ files, config: ROOMY_CONFIG, rooms: { [ROOM]: ROOMY } });
    const head = JSON.parse(await restarted.raw('paper_status', {})) as {
      tasks: Array<{ taskId: string; position: number }>;
    };
    expect(head.tasks.map(t => [t.taskId, t.position])).toEqual(ids.map((id, i) => [id, i + 1]));
    const next = await restarted.call('paper_task', { text: '任务四', name: '四' }, human('30009'));
    expect(next).toMatchObject({ ok: true, position: 4 });
  });

  it.each([
    ['截断的 JSON', '{"version":1,"papers":{'],
    ['版本不对', JSON.stringify({ ...emptyLedger(), version: 2 })],
    ['缺表', JSON.stringify({ version: 1, papers: {} })],
  ])('安全：账本文件存在但损坏（%s）时 paper_task 被拒、原文件不变、诊断项报 error', async (_label, broken) => {
    const files = new Map([[LEDGER_URI, broken]]);
    const hub = await startPaperHub({ files });
    const res = await hub.call('paper_task', { text: '做个网页', name: '网页' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/账本/);
    expect(hub.outbound).toEqual([]);
    expect(files.get(LEDGER_URI)).toBe(broken);
    const [check] = await hub.doctor();
    expect(check.level).toBe('error');
    expect(check.message).toMatch(/账本/);
  });

  it('账本文件不存在时从空账本起步，诊断项不报账本问题', async () => {
    const hub = await startPaperHub();
    expect((await hub.call('paper_task', { text: '做个网页', name: '网页' })).ok).toBe(true);
    const [check] = await hub.doctor();
    expect(check.level).toBe('ok');
  });
});
