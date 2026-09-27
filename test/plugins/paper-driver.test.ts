import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteAgentError } from '../../packages/api-remote-agent/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import {
  advance,
  DRIVER_CONFIG,
  FAKE_TIMERS,
  MINUTE,
  PAPER_A_ID,
  RECONCILE_MS,
  REMOTE_A,
  REMOTE_B,
  ROOM_A,
  ROOM_B,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { once, ScriptedRemote } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 白纸运行驱动（U10b）：每块白纸一条队列依次执行，不同白纸并行；会改变远端状态的步骤之前先落盘；
// 开轮结果未知时先认领、不盲目重发；忙与临时故障的等待有上限；单轮时长由独立计时器执行；
// 前言的内容；费用暂缺时停开白纸、预留保留。
// ════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now });
});
afterEach(async () => {
  await stopDriverHubs();
  vi.useRealTimers();
});

describe('队列', () => {
  it('同一白纸两件任务依次执行：第二件在第一件终态后才开轮；不同白纸并行', async () => {
    const a = new ScriptedRemote();
    const b = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a, [REMOTE_B]: b } });
    const t1 = await hub.accept(ROOM_A);
    const t2 = await hub.accept(ROOM_A);
    const t3 = await hub.accept(ROOM_B);
    await until(() => hub.task(t1).state === 'running' && hub.task(t3).state === 'running', '两块白纸各开一轮');
    expect(hub.task(t2).state).toBe('queued');
    expect(a.count('createAgent') + a.count('startRun')).toBe(1);

    let firstWhenSecondStarts: string | undefined;
    a.intercept.startRun = ({ proceed }) => {
      firstWhenSecondStarts = hub.task(t1).state;
      return proceed();
    };
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    expect(firstWhenSecondStarts).toBe('done');
    expect(a.count('createAgent'), '第二件用已绑定的代理').toBe(1);
    expect(a.count('startRun')).toBe(1);
    expect(hub.task(t3).state).toBe('running');
  });
});

describe('先落盘再调远端', () => {
  it('安全：建代理时账本里已有这个 agentId；已绑定代理开轮时任务已是 starting、path 为 run', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    let atCreate: PaperLedger | undefined;
    let createdId = '';
    a.intercept.createAgent = ({ proceed, args }) => {
      createdId = (args[0] as { agentId: string }).agentId;
      atCreate = hub.disk();
      return proceed();
    };
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '首件开轮');
    expect(atCreate?.agents[createdId]).toMatchObject({
      state: 'creating',
      paperId: PAPER_A_ID,
      providerType: REMOTE_A,
    });
    expect(atCreate?.tasks[t1]).toMatchObject({ state: 'starting', agentId: createdId, start: { path: 'create' } });

    let atStart: PaperLedger | undefined;
    a.intercept.startRun = ({ proceed }) => {
      atStart = hub.disk();
      return proceed();
    };
    const t2 = await hub.accept();
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    expect(atStart?.tasks[t2]).toMatchObject({ state: 'starting', agentId: createdId, start: { path: 'run' } });
  });
});

describe('开轮', () => {
  async function bound() {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '首件开轮');
    const agentId = hub.task(t1).agentId ?? '';
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t1).state === 'done', '首件完成');
    return { a, hub, agentId };
  }

  it('安全：startRun 读超时但远端已开轮时，POST 只发一次，这一轮认领为本件任务', async () => {
    const { a, hub, agentId } = await bound();
    once(a, 'startRun', async ({ proceed }) => {
      await proceed();
      throw new RemoteAgentError('transient', '读超时');
    });
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'running', '第二件认领');
    expect(a.count('startRun')).toBe(1);
    const opened = a.runsOf(agentId).at(-1)?.runId;
    expect(hub.task(t2).runId).toBe(opened);
    expect(hub.store.data.runs[opened ?? '']).toMatchObject({ agentId, taskId: t2 });
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
  });

  it('绑定已归档时先 unarchiveAgent 再 startRun', async () => {
    const { a, hub, agentId } = await bound();
    hub.store.data.agents[agentId].state = 'archived';
    const remoteAgent = a.agents.get(agentId);
    if (remoteAgent) remoteAgent.archived = true;
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    const methods = a.calls.map(c => c.method);
    expect(methods.indexOf('unarchiveAgent')).toBeGreaterThan(-1);
    expect(methods.indexOf('unarchiveAgent')).toBeLessThan(methods.indexOf('startRun'));
    expect(hub.store.data.agents[agentId].state).toBe('active');
  });

  it('transient（远端没开出轮次）：先查一次没有账本外的轮次，退避后重发成功', async () => {
    const { a, hub } = await bound();
    once(a, 'startRun', () => {
      throw new RemoteAgentError('transient', '断线');
    });
    const t2 = await hub.accept();
    await advance(6000);
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    expect(a.count('startRun')).toBe(2);
    const methods = a.calls.map(c => c.method);
    const first = methods.indexOf('startRun');
    expect(methods.slice(first + 1, methods.lastIndexOf('startRun'))).toContain('listRuns');
  });

  it('busy 与 transient 合计等满 10 分钟后任务判为失败、预留释放，队列不被卡住', async () => {
    const { a, hub } = await bound();
    let n = 0;
    a.intercept.startRun = () => {
      n++;
      throw n % 2 ? new RemoteAgentError('busy', '忙') : new RemoteAgentError('transient', '断线');
    };
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'starting', '第二件开轮中');
    await advance(9 * MINUTE);
    expect(hub.task(t2).state).toBe('starting');
    await advance(2 * MINUTE);
    await until(() => hub.task(t2).state === 'failed', '第二件判为失败');
    expect(hub.task(t2).error).toMatch(/忙或不可用/);
    expect(hub.store.data.reserves[t2]).toBeUndefined();

    delete a.intercept.startRun;
    const t3 = await hub.accept();
    await until(() => hub.task(t3).state === 'running', '下一件照常开轮');
  });
});

describe('单轮时长上限', () => {
  it('安全：远端开轮后只发心跳，到 maxRunMinutes 仍调用 cancelRun；终态后费用照常入账', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const { agentId, runId } = hub.task(t1);
    await advance(19 * MINUTE);
    expect(a.count('cancelRun')).toBe(0);
    await advance(MINUTE);
    await until(() => hub.task(t1).state === 'cancelled', '到点取消');
    expect(a.calls.filter(c => c.method === 'cancelRun').map(c => c.args)).toEqual([[agentId, runId]]);
    expect(hub.task(t1)).toMatchObject({ cancelledVia: 'timeout', costCents: 10 });
    expect(hub.store.data.runs[runId ?? ''].cost).toEqual({ state: 'booked', cents: 10 });
  });

  it('安全：重启时已超时的任务立即被取消', async () => {
    const a = new ScriptedRemote();
    const files = new Map();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    await hub.stop();
    await advance(25 * MINUTE);
    expect(a.count('cancelRun')).toBe(0);

    const restarted = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    await until(() => a.count('cancelRun') === 1, '重启后立即取消');
    await until(() => restarted.task(t1).state === 'cancelled', '取消到终态');
    expect(restarted.task(t1).cancelledVia).toBe('timeout');
  });

  it('cancelRun 按 10、30、60 秒退避仍失败时白纸停开并告警；这一轮之后自己结束，费用照常入账', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    a.intercept.cancelRun = () => {
      throw new RemoteAgentError('transient', '断线');
    };
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    await advance(20 * MINUTE);
    await advance(99_000);
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
    await advance(2000);
    await until(() => hub.store.data.papers[PAPER_A_ID].halted !== undefined, '停开');
    expect(a.count('cancelRun')).toBe(4);
    expect(hub.store.data.papers[PAPER_A_ID].halted?.reason).toBe('cancel-failed');
    expect(hub.store.data.alerts).toContainEqual(expect.objectContaining({ kind: 'cancel-failed' }));

    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t1).state === 'done', '这一轮自己结束');
    expect(hub.task(t1).costCents).toBe(10);
  });
});

describe('前言', () => {
  it('含工作目录、本件交付目录、工程包路径、全部 policyNotes 与原文；不含凭据', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept(ROOM_A, '做一个像素风格的时钟网页 TEXT-SENTINEL');
    await until(() => hub.task(t1).state === 'running', '开轮');
    const prompt = a.agents.get(hub.task(t1).agentId ?? '')?.prompts[0] ?? '';
    for (const part of [
      '/agent',
      `/opt/out/${t1}/`,
      '/opt/workspace.tar.gz',
      'NOTE-RULE-FILES',
      'NOTE-NO-TIMERS',
      '做一个像素风格的时钟网页 TEXT-SENTINEL',
    ]) {
      expect(prompt, part).toContain(part);
    }
    expect(prompt).not.toContain(a.secret);
    expect(prompt, '首个代理没有旧工程包').not.toContain('bundle.invalid');
  });
});

describe('费用', () => {
  it('费用暂缺三次后白纸停开并告警、预留按临时花费保留；owner 恢复后可继续，对账时补上费用', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const booked = a.costOf;
    a.costOf = () => undefined;
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const runId = hub.task(t1).runId ?? '';
    a.finish(runId);
    await advance(45_000);
    await until(() => hub.task(t1).state === 'done', '任务完成');
    expect(a.count('runCost')).toBe(3);
    expect(hub.task(t1).costCents).toBeUndefined();
    const ledger = hub.store.data;
    expect(ledger.papers[PAPER_A_ID].halted?.reason).toBe('cost-missing');
    expect(ledger.alerts).toContainEqual(expect.objectContaining({ kind: 'cost-missing' }));
    expect(ledger.reserves[t1], '预留按临时花费保留').toBeDefined();
    expect(ledger.runs[runId].cost.state).toBe('missing');

    const refused = await hub.call('paper_task', { text: '再来一件', name: '再来' });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/停开/);

    a.costOf = booked;
    await hub.driver.resume(PAPER_A_ID);
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'running', 'owner 恢复后开轮');

    await advance(RECONCILE_MS);
    await until(() => ledger.runs[runId].cost.state === 'booked', '对账补上费用');
    expect(hub.task(t1).costCents).toBe(10);
    expect(ledger.reserves[t1]).toBeUndefined();
  });
});

describe('配置', () => {
  it('单轮时长上限取插件配置', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, config: { ...DRIVER_CONFIG, maxRunMinutes: 5 } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    await advance(5 * MINUTE);
    await until(() => a.count('cancelRun') === 1, '5 分钟到点取消');
  });
});
