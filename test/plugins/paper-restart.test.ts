import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import type {} from '../../packages/api-memory/src/index.js'; // declaration merging：memory:clear 钩子类型
import type { PaperLedger, TaskRecord } from '../../packages/plugin-paper/src/ledger.js';
import {
  emptyLedger,
  human,
  LEDGER_URI,
  PAPER,
  PILOT_CONFIG,
  REMOTE,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';
import {
  advance,
  FAKE_TIMERS,
  MINUTE,
  PAPER_A_ID,
  REMOTE_A,
  ROOM_A,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { PNG, ScriptedRemote } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 重启接回（U10b）：开轮中的任务按 start.path 分两条（新建代理按同一 agentId 重试，已绑定代理先认领再
// 决定是否重发）；运行中的任务从 lastEventId 继续跟踪。另经真实 App 装载一次插件，核对 apply 的接线：
// 受理后开轮、停机后重启接着跑完、memory:clear 不动账本与白纸文件。
// ════════════════════════════════════════════════════════════

const AGENT = 'bc-00000099';

function seedTask(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: 't-000000aa',
    paperId: PAPER_A_ID,
    room: ROOM_A,
    platform: 'onebot',
    initiator: { platform: 'onebot', userId: '30001' },
    name: '种子任务',
    text: '种子任务原文',
    state: 'queued',
    createdAt: Date.now() - 120_000,
    artifacts: [],
    delivered: false,
    ...over,
  };
}

function seedLedger(mutate: (ledger: PaperLedger) => void): Map<string, string | Uint8Array> {
  const ledger = emptyLedger();
  ledger.papers[PAPER_A_ID] = { lastClearedAt: Date.now() };
  mutate(ledger);
  return new Map([[LEDGER_URI, JSON.stringify(ledger)]]);
}

const agentRecord = (state: 'creating' | 'active') => ({
  providerType: REMOTE_A,
  paperId: PAPER_A_ID,
  name: 'aalis-paper-0000abcd',
  state,
  createdAt: Date.now() - 120_000,
  costCents: 0,
});

describe('重启接回（假时钟）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now });
  });
  afterEach(async () => {
    await stopDriverHubs();
    vi.useRealTimers();
  });

  it('start.path 为 create 的任务以同一 agentId 再调 createAgent，不会建第二个代理；startedAt 取远端首轮开跑的时刻', async () => {
    const a = new ScriptedRemote();
    const requestedAt = Date.now() - 60_000;
    // 停机前建代理的请求已到达远端：首轮从那时起就在跑，不从接回时算
    const firstRun = a.seedAgent(AGENT, 'aalis-paper-0000abcd', requestedAt + 2_000);
    const files = seedLedger(ledger => {
      ledger.agents[AGENT] = agentRecord('creating');
      ledger.tasks['t-000000aa'] = seedTask({
        state: 'starting',
        agentId: AGENT,
        start: { path: 'create', requestedAt },
      });
    });
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    await until(() => hub.task('t-000000aa').state === 'running', '接回后开轮');
    expect(
      a.calls.filter(c => c.method === 'createAgent').map(c => (c.args[0] as { agentId: string }).agentId),
    ).toEqual([AGENT]);
    expect(a.agents.size).toBe(1);
    expect(hub.task('t-000000aa')).toMatchObject({ runId: firstRun, startedAt: requestedAt + 2_000 });
    expect(hub.store.data.agents[AGENT].state).toBe('active');
    expect(hub.store.data.papers[PAPER_A_ID].binding).toBe(AGENT);
  });

  it('安全：建代理的请求没到达远端就停机、停机超过单轮时长：接回后新建的一轮从远端开跑时计时，不立即取消', async () => {
    const a = new ScriptedRemote();
    const requestedAt = Date.now() - 30 * MINUTE;
    const files = seedLedger(ledger => {
      ledger.agents[AGENT] = agentRecord('creating');
      ledger.tasks['t-000000aa'] = seedTask({
        state: 'starting',
        agentId: AGENT,
        start: { path: 'create', requestedAt },
      });
    });
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    await until(() => hub.task('t-000000aa').state === 'running', '接回后开轮');
    const created = a.runs.get(hub.task('t-000000aa').runId ?? '')?.createdAt;
    expect(hub.task('t-000000aa').startedAt).toBe(created);
    expect(created).toBeGreaterThanOrEqual(requestedAt + 30 * MINUTE);
    await advance(MINUTE);
    expect(a.count('cancelRun')).toBe(0);
    expect(hub.task('t-000000aa').state).toBe('running');
  });

  describe('安全：start.path 为 run 的任务不调 createAgent，先认领', () => {
    function boundLedger(requestedAt: number, knownRun: string) {
      return seedLedger(ledger => {
        ledger.agents[AGENT] = agentRecord('active');
        ledger.papers[PAPER_A_ID].binding = AGENT;
        ledger.runs[knownRun] = { agentId: AGENT, cost: { state: 'booked', cents: 10 } };
        ledger.tasks['t-000000aa'] = seedTask({
          state: 'starting',
          agentId: AGENT,
          start: { path: 'run', requestedAt },
        });
      });
    }

    it('远端已有一轮账本外的轮次：认领它，startedAt 取 requestedAt', async () => {
      const a = new ScriptedRemote();
      const known = a.seedAgent(AGENT);
      a.finish(known);
      const opened = a.spawnRun(AGENT);
      const requestedAt = Date.now() - 30_000;
      const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files: boundLedger(requestedAt, known) });
      await until(() => hub.task('t-000000aa').state === 'running', '接回后认领');
      expect(hub.task('t-000000aa')).toMatchObject({ runId: opened, startedAt: requestedAt });
      expect(a.count('createAgent')).toBe(0);
      expect(a.count('startRun')).toBe(0);
      expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
    });

    it('远端没有账本外的轮次：重发 startRun 一次', async () => {
      const a = new ScriptedRemote();
      const known = a.seedAgent(AGENT);
      a.finish(known);
      const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files: boundLedger(Date.now() - 30_000, known) });
      await until(() => hub.task('t-000000aa').state === 'running', '接回后开轮');
      expect(a.count('createAgent')).toBe(0);
      expect(a.count('startRun')).toBe(1);
      expect(hub.task('t-000000aa').runId).toBe(a.runsOf(AGENT).at(-1)?.runId);
    });
  });

  it('运行中的任务从 lastEventId 继续跟踪并完成', async () => {
    const a = new ScriptedRemote();
    const runId = a.seedAgent(AGENT);
    const files = seedLedger(ledger => {
      ledger.agents[AGENT] = agentRecord('active');
      ledger.papers[PAPER_A_ID].binding = AGENT;
      ledger.runs[runId] = { agentId: AGENT, taskId: 't-000000aa', cost: { state: 'pending' } };
      ledger.tasks['t-000000aa'] = seedTask({
        state: 'running',
        agentId: AGENT,
        runId,
        startedAt: Date.now() - 60_000,
        lastEventId: 'ev-2-seeded',
      });
      ledger.reserves['t-000000aa'] = { cents: 50, day: '2026-09-27', room: ROOM_A, user: 'onebot:30001' };
    });
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    await until(() => a.count('followRun') === 1, '接着跟踪');
    expect(a.calls.find(c => c.method === 'followRun')?.args).toEqual([AGENT, runId, 'ev-2-seeded']);
    a.progress(runId);
    a.finish(runId, 'finished', '做好了');
    await until(() => hub.task('t-000000aa').state === 'done', '完成');
    expect(hub.task('t-000000aa')).toMatchObject({ resultText: '做好了', costCents: 10 });
    expect(hub.store.data.reserves['t-000000aa']).toBeUndefined();
  });
});

describe('插件接线（真实 App，真实时钟）', () => {
  afterEach(stopPaperHubs);

  async function waitFor(pred: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (pred()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`等不到：${label}`);
  }

  it('受理后开轮；停机后重启接着跟踪并取回成品；memory:clear 不动账本与白纸文件', async () => {
    const a = new ScriptedRemote({ isolation: 'shared' });
    const files = new Map<string, string | Uint8Array>();
    const hub = await startPaperHub({ remotes: { [REMOTE]: a }, files, config: PILOT_CONFIG });
    const accepted = await hub.call('paper_task', { text: '做一张像素猫的图', name: '像素猫' }, human());
    expect(accepted.ok).toBe(true);
    const taskId = String(accepted.taskId);
    await waitFor(() => hub.ledger().tasks[taskId]?.state === 'running', '受理后开轮');
    const runId = hub.ledger().tasks[taskId].runId ?? '';
    a.outputs.set(taskId, [{ rel: 'cat.png', data: PNG }]);
    await hub.stop();

    const restarted = await startPaperHub({ remotes: { [REMOTE]: a }, files, config: PILOT_CONFIG });
    await waitFor(() => a.count('followRun') === 2, '重启后接着跟踪');
    a.finish(runId);
    await waitFor(() => restarted.ledger().tasks[taskId]?.state === 'done', '完成');
    const [artifact] = restarted.ledger().tasks[taskId].artifacts;
    expect(artifact).toMatchObject({ rel: 'cat.png', type: 'png' });
    const uri = `paper:/n-${PAPER}/tasks/${taskId}/out/${artifact.id}.png`;
    expect(files.get(uri)).toEqual(PNG);

    const before = new Map(files);
    const data: HookContextMap['memory:clear'] = { scope: 'all', results: [] };
    await restarted.app.bind({ hooks }).hooks.run('memory:clear', data, async () => {});
    expect(files).toEqual(before);
  });
});
