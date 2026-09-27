import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteAgentError } from '../../packages/api-remote-agent/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import { LEDGER_URI } from '../fixtures/paper.js';
import {
  advance,
  DRIVER_CONFIG,
  type DriverHub,
  FAKE_TIMERS,
  MINUTE,
  PAPER_A,
  PAPER_A_DIR,
  PAPER_A_ID,
  RECONCILE_MS,
  REMOTE_A,
  ROOM_A,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { once, PNG, ScriptedRemote, text } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 对账与自唤醒（U10b）：定期检查账本里全部未删除的代理，出现账本外的轮次就按自唤醒事件处理
// （取消、删除代理、停开白纸、费用记进全局日账，恢复后新建代理且不带旧工程包）；开轮中的代理对账跳过；
// 账本外的代理只建一条告警、未读期间停开同一提供者实例的白纸；闲置归档前先核查；任务记录按保留天数清理，
// 轮次记录留到代理确认删除；清空取消排队任务、删除代理与白纸目录、保留任务记录。
// ════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now });
});
afterEach(async () => {
  await stopDriverHubs();
  vi.useRealTimers();
});

async function runOne(hub: DriverHub, a: ScriptedRemote, status: 'finished' | 'error' = 'finished') {
  const id = await hub.accept();
  await until(() => hub.task(id).state === 'running', `任务 ${id} 开轮`);
  const agentId = hub.task(id).agentId ?? '';
  a.bundles.set(agentId, text(`bundle of ${agentId}`));
  a.finish(hub.task(id).runId ?? '', status);
  await until(() => ['done', 'failed'].includes(hub.task(id).state), `任务 ${id} 到终态`);
  return { id, agentId };
}

const todaySpend = (ledger: PaperLedger) => Object.values(ledger.spend).reduce((sum, d) => sum + d.global, 0);

describe('自唤醒事件', () => {
  it('安全：对账发现账本外的轮次在跑：取消、删除代理、停开白纸、费用记进全局；恢复后新建代理且不带旧工程包', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await runOne(hub, a);
    const rogue = a.spawnRun(first.agentId);
    a.costOf = runId => ({
      chargedCents: runId === rogue ? 77 : 10,
      inputTokens: 1,
      cacheReadTokens: 0,
    });

    await advance(RECONCILE_MS);
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '删除自唤醒的代理');
    expect(a.callsOn('cancelRun', first.agentId).map(c => c.args[1])).toEqual([rogue]);
    expect(a.callsOn('archiveAgent', first.agentId)).toEqual([]);
    const ledger = hub.store.data;
    expect(ledger.papers[PAPER_A_ID]).toMatchObject({ halted: { reason: 'unknown-run' }, noBundleNext: true });
    expect(ledger.papers[PAPER_A_ID].binding).toBeUndefined();
    expect(ledger.agents[first.agentId]).toBeUndefined();
    expect(ledger.alerts).toContainEqual(
      expect.objectContaining({ kind: 'unknown-run', subject: first.agentId, acknowledged: false }),
    );
    expect(todaySpend(ledger), '账本外轮次的费用记进全局日账').toBe(10 + 77);

    const refused = await hub.call('paper_task', { text: '再来一件', name: '再来' });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/停开/);
    expect(a.count('unarchiveAgent')).toBe(0);

    await hub.driver.resume(PAPER_A_ID);
    const second = await runOne(hub, a);
    expect(second.agentId).not.toBe(first.agentId);
    const prompt = a.agents.get(second.agentId)?.prompts[0] ?? '';
    expect(prompt).not.toContain('bundle.invalid');
    expect(hub.store.data.papers[PAPER_A_ID].noBundleNext).toBeUndefined();
  });

  it('安全：第一次 POST 就得到 busy、账本里又没有这个代理在跑的轮次时，立即按自唤醒处理，不等重试', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await runOne(hub, a);
    once(a, 'startRun', ({ args }) => {
      a.spawnRun(String(args[0]));
      throw new RemoteAgentError('busy', '代理上有一轮在跑');
    });
    const t2 = await hub.accept();
    await until(() => hub.store.data.papers[PAPER_A_ID].halted !== undefined, '立即停开', 100);
    expect(hub.store.data.papers[PAPER_A_ID].halted?.reason).toBe('unknown-run');
    expect(a.count('startRun')).toBe(1);
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '删除代理');
    expect(hub.task(t2).state, '任务留在队列里').toBe('queued');
  });

  it('安全：每轮终态后的核查也能发现；本白纸的任务在这个代理上时，等它取回成品后再删', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const agentId = hub.task(t1).agentId ?? '';
    a.outputs.set(t1, [{ rel: 'shot.png', data: PNG }]);
    const rogue = a.spawnRun(agentId);
    let stateAtDelete: string | undefined;
    a.intercept.deleteAgent = ({ proceed }) => {
      stateAtDelete = hub.task(t1).state;
      return proceed();
    };
    a.finish(hub.task(t1).runId ?? '');
    await until(() => a.callsOn('deleteAgent', agentId).length === 1, '删除代理');
    expect(stateAtDelete).toBe('done');
    expect(hub.task(t1).artifacts).toHaveLength(1);
    expect(a.callsOn('cancelRun', agentId).map(c => c.args[1])).toEqual([rogue]);
    expect(hub.store.data.papers[PAPER_A_ID].halted?.reason).toBe('unknown-run');
  });

  it('安全：闲置归档前的核查也能发现，发现后不归档', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await runOne(hub, a);
    const doneAt = Date.now();
    let rogue: string | undefined;
    // 对账先逐个查代理的轮次、再列账号下的代理；在列代理时开出账本外的一轮，只有闲置归档前的核查看得到它
    a.intercept.listAgents = ({ proceed }) => {
      if (!rogue && Date.now() - doneAt >= 30 * MINUTE) rogue = a.spawnRun(first.agentId);
      return proceed();
    };
    await advance(45 * MINUTE);
    await until(() => hub.store.data.papers[PAPER_A_ID].halted !== undefined, '停开');
    expect(rogue).toBeDefined();
    expect(a.count('archiveAgent')).toBe(0);
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '删除代理');
  });
});

describe('开轮与对账并发', () => {
  it('安全：对账落在 POST 返回之后、runId 落盘之前时，这一轮不被判为账本外、代理不被删', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await runOne(hub, a);
    let posted = false;
    let release = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    once(a, 'startRun', async ({ proceed }) => {
      const out = await proceed();
      posted = true;
      await gate;
      return out;
    });
    const t2 = await hub.accept();
    await until(() => posted, 'POST 已到远端');
    const listed = a.count('listAgents');
    await advance(RECONCILE_MS);
    await until(() => a.count('listAgents') > listed, '对账跑完');
    release();
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    expect(a.count('cancelRun')).toBe(0);
    expect(a.count('deleteAgent')).toBe(0);
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
    expect(hub.task(t2).agentId).toBe(first.agentId);
  });
});

describe('对账的范围', () => {
  it('安全：查的是账本里全部未删除的代理，不只当前绑定的那个', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      config: { ...DRIVER_CONFIG, papers: [{ name: PAPER_A, remoteAgentType: REMOTE_A, rotateAfterCents: 15 }] },
    });
    a.costOf = () => ({ chargedCents: 20, inputTokens: 1, cacheReadTokens: 0 });
    const first = await runOne(hub, a);
    a.costOf = () => ({ chargedCents: 1, inputTokens: 1, cacheReadTokens: 0 });
    const second = await runOne(hub, a, 'error');
    expect(hub.store.data.papers[PAPER_A_ID].binding).toBe(second.agentId);
    expect(hub.store.data.agents[first.agentId].state, '旧代理退役但还没删').toBe('retired');

    const rogue = a.spawnRun(first.agentId);
    await advance(RECONCILE_MS);
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '删除旧代理');
    expect(a.callsOn('cancelRun', first.agentId).map(c => c.args[1])).toEqual([rogue]);
    expect(hub.store.data.papers[PAPER_A_ID].halted?.reason).toBe('unknown-run');
    expect(hub.store.data.agents[second.agentId]?.replaces).toBeUndefined();
  });

  it('账本外的代理只建一条告警、未读期间每次对账都记 warn、停开同一提供者实例的白纸；标为已读后解除', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, config: { ...DRIVER_CONFIG, maxRunMinutes: 120 } });
    await runOne(hub, a);
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    const t3 = await hub.accept();
    a.addForeignAgent('bc-foreign-01', 'owner-own-agent');

    await advance(RECONCILE_MS);
    await until(() => hub.store.data.alerts.some(x => x.kind === 'unknown-agent'), '建告警');
    const warns = () => hub.logs.filter(l => l.level === 'warn' && l.message.includes('bc-foreign-01')).length;
    const firstWarns = warns();
    expect(firstWarns).toBeGreaterThan(0);
    await advance(RECONCILE_MS);
    await until(() => warns() > firstWarns, '未读期间再记 warn');
    const alerts = hub.store.data.alerts.filter(x => x.kind === 'unknown-agent');
    expect(alerts).toEqual([
      expect.objectContaining({ subject: 'bc-foreign-01', providerType: REMOTE_A, acknowledged: false }),
    ]);

    const refused = await hub.call('paper_task', { text: '再来一件', name: '再来' });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/账本外/);
    a.finish(hub.task(t2).runId ?? '');
    await until(() => hub.task(t2).state === 'done', '第二件完成');
    await advance(1000);
    expect(hub.task(t3).state, '未读期间不出队').toBe('queued');

    expect(await hub.driver.acknowledge(alerts[0].id)).toBe(true);
    await until(() => hub.task(t3).state === 'running', '标为已读后出队');
    expect((await hub.call('paper_task', { text: '再来一件', name: '再来' })).ok).toBe(true);
  });
});

describe('任务记录保留与轮次记录', () => {
  it('安全：任务记录按保留天数清理后，对账不把这个代理的旧轮次当成账本外；代理确认删除后它的轮次才移除', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      config: { ...DRIVER_CONFIG, taskRetentionDays: 1 },
    });
    const first = await runOne(hub, a);
    const runId = a.runsOf(first.agentId)[0].runId;
    await advance(24 * 60 * MINUTE + RECONCILE_MS);
    await until(() => hub.store.data.tasks[first.id] === undefined, '任务记录被清理');
    await advance(RECONCILE_MS);
    expect(hub.store.data.runs[runId], '轮次记录保留').toMatchObject({ agentId: first.agentId });
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
    expect(a.count('deleteAgent')).toBe(0);

    expect(await hub.driver.clear(PAPER_A_ID)).toBeUndefined();
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '清空时删除代理');
    expect(hub.store.data.runs[runId]).toBeUndefined();
  });
});

describe('闲置归档', () => {
  it('最后一轮结束 idleArchiveMinutes 后先核查再归档', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await runOne(hub, a);
    await advance(20 * MINUTE);
    expect(a.count('archiveAgent')).toBe(0);
    await advance(20 * MINUTE);
    await until(() => a.count('archiveAgent') === 1, '归档');
    const at = a.calls.findIndex(c => c.method === 'archiveAgent');
    expect(a.calls[at - 1]).toMatchObject({ method: 'listRuns', args: [first.agentId] });
    expect(hub.store.data.agents[first.agentId].state).toBe('archived');
    expect(a.agents.get(first.agentId)?.archived).toBe(true);
  });
});

describe('清空', () => {
  it('owner 清空：取消排队任务、删除代理与白纸目录，账本任务记录保留并标为已清空', async () => {
    const a = new ScriptedRemote();
    const files = new Map();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const agentId = hub.task(t1).agentId ?? '';
    a.outputs.set(t1, [{ rel: 'shot.png', data: PNG }]);
    a.bundles.set(agentId, text('bundle'));
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t1).state === 'done', '完成');
    const inPaper = () => [...files.keys()].filter(k => k.startsWith(`${PAPER_A_DIR}/`));
    expect(inPaper()).toHaveLength(2);
    const clearedBefore = hub.store.data.papers[PAPER_A_ID].lastClearedAt;
    await hub.stop();

    // 停开的白纸上留一件排队任务：白纸空闲，但队列不空
    const ledger = JSON.parse(String(files.get(LEDGER_URI))) as PaperLedger;
    ledger.papers[PAPER_A_ID].halted = { reason: 'provider', detail: '测试', at: Date.now() };
    const { agentId: _a, runId: _r, startedAt: _s, endedAt: _e, costCents: _c, ...base } = ledger.tasks[t1];
    ledger.tasks['t-0000000f'] = { ...base, id: 't-0000000f', state: 'queued', artifacts: [] };
    ledger.reserves['t-0000000f'] = { cents: 50, day: '2026-09-27', room: ROOM_A, user: 'onebot:30001' };
    files.set(LEDGER_URI, JSON.stringify(ledger));
    const restarted = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    await advance(1000);
    expect(restarted.task('t-0000000f').state).toBe('queued');

    expect(await restarted.driver.clear(PAPER_A_ID)).toBeUndefined();
    expect(restarted.task('t-0000000f')).toMatchObject({ state: 'cancelled', cancelledVia: 'webui' });
    expect(restarted.store.data.reserves['t-0000000f']).toBeUndefined();
    await until(() => a.callsOn('deleteAgent', agentId).length === 1, '删除代理');
    expect(inPaper()).toEqual([]);
    const paper = restarted.store.data.papers[PAPER_A_ID];
    expect(paper.binding).toBeUndefined();
    expect(paper.lastClearedAt).toBeGreaterThan(clearedBefore);
    expect(restarted.task(t1)).toMatchObject({ state: 'done', artifactsCleared: true });
    expect(restarted.task(t1).artifacts).toHaveLength(1);
  });

  it('有任务在跑时清空被拒', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    expect(await hub.driver.clear(PAPER_A_ID)).toMatch(/在跑/);
    expect(a.count('deleteAgent')).toBe(0);
  });

  it('定期清空：lastClearedAt 加 clearAfterDays 已过、且白纸空闲时清空', async () => {
    const a = new ScriptedRemote();
    const files = new Map();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      files,
      config: { ...DRIVER_CONFIG, papers: [{ name: PAPER_A, remoteAgentType: REMOTE_A, clearAfterDays: 1 }] },
    });
    const first = await runOne(hub, a);
    expect([...files.keys()].some(k => k.startsWith(`${PAPER_A_DIR}/`))).toBe(true);
    await advance(24 * 60 * MINUTE + RECONCILE_MS);
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '定期清空删除代理');
    expect([...files.keys()].filter(k => k.startsWith(`${PAPER_A_DIR}/`))).toEqual([]);
    expect(hub.task(first.id).state).toBe('done');
  });
});
