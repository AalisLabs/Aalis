import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteAgentError,
  type RemoteRunSummary,
  type RunActivity,
} from '../../packages/api-remote-agent/src/index.js';
import type { SessionConfig } from '../../packages/api-session-manager/src/index.js';
import type { PaperLedger } from '../../packages/plugin-paper/src/ledger.js';
import { LEDGER_URI } from '../fixtures/paper.js';
import {
  advance,
  DRIVER_CONFIG,
  DRIVER_ROOMS,
  type DriverHub,
  FAKE_TIMERS,
  MINUTE,
  PAPER_A,
  PAPER_A_ID,
  PAPER_B,
  RECONCILE_MS,
  REMOTE_A,
  REMOTE_B,
  ROOM_A,
  ROOM_B,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { once, PNG, ScriptedRemote } from '../fixtures/paper-remote.js';

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

/** 跑完首件、白纸绑定了代理的测试台 */
async function bound(config?: Record<string, unknown>) {
  const a = new ScriptedRemote();
  const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, config });
  const t1 = await hub.accept();
  await until(() => hub.task(t1).state === 'running', '首件开轮');
  const agentId = hub.task(t1).agentId ?? '';
  a.finish(hub.task(t1).runId ?? '');
  await until(() => hub.task(t1).state === 'done', '首件完成');
  return { a, hub, agentId };
}

describe('开轮', () => {
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
  it('安全：远端开轮后只发心跳，到 maxRunMinutes 仍取消；已有成品与费用照常取回', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const { agentId, runId } = hub.task(t1);
    a.outputs.set(t1, [{ rel: 'index.html', data: new TextEncoder().encode('<!doctype html><title>第一版</title>') }]);
    await advance(19 * MINUTE);
    expect(a.count('cancelRun')).toBe(0);
    await advance(MINUTE);
    await until(() => hub.task(t1).state === 'cancelled', '到点取消');
    expect(a.calls.filter(c => c.method === 'cancelRun').map(c => c.args)).toEqual([[agentId, runId]]);
    expect(hub.task(t1)).toMatchObject({ cancelledVia: 'timeout', costCents: 10 });
    expect(a.callsOn('collectArtifacts', agentId ?? '')[0]?.args[1]).toBe(t1);
    expect(hub.task(t1).artifacts.map(x => x.rel)).toEqual(['index.html']);
    expect(hub.store.data.runs[runId ?? ''].cost).toEqual({ state: 'booked', cents: 10 });
  });

  it('安全：新建代理的一轮从远端开跑时算：建代理的响应几十秒才回时，startedAt 与计时器不按响应时刻', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    let arrivedAt: number | undefined;
    a.intercept.createAgent = async ({ proceed }) => {
      // 远端收到 POST 就建出这一轮开跑，响应却要 40 秒才回
      arrivedAt = Date.now();
      const out = await proceed();
      await new Promise(resolve => setTimeout(resolve, 40_000));
      return out;
    };
    const t1 = await hub.accept();
    await advance(40_000);
    await until(() => hub.task(t1).state === 'running', '开轮');
    expect(arrivedAt).toBeDefined();
    expect(hub.task(t1).startedAt).toBe(arrivedAt);
    expect(Date.now() - (arrivedAt ?? 0)).toBeGreaterThanOrEqual(40_000);

    // 开跑起 20 分钟到点；按响应时刻算要再晚 40 秒
    await advance(20 * MINUTE - (Date.now() - (arrivedAt ?? 0)) - 5_000);
    expect(a.count('cancelRun')).toBe(0);
    await advance(10_000);
    await until(() => hub.task(t1).state === 'cancelled', '到点取消');
    expect(Date.now() - (arrivedAt ?? 0)).toBeLessThan(20 * MINUTE + 40_000);
  });

  it('安全：建代理先遇限流、退避 5 分钟后才建出：计时从远端开跑时算，退避的等待不占单轮时长', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    once(a, 'createAgent', async () => {
      throw new RemoteAgentError('rate-limited', '限流', { retryAfterMs: 5 * MINUTE });
    });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'starting', '开轮中');
    const requestedAt = hub.task(t1).start?.requestedAt ?? 0;
    await advance(5 * MINUTE);
    await until(() => hub.task(t1).state === 'running', '开轮');
    const created = a.runs.get(hub.task(t1).runId ?? '')?.createdAt ?? 0;
    expect(created - requestedAt).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(hub.task(t1).startedAt).toBe(created);

    // 开跑起 20 分钟到点；按请求时刻算会早 5 分钟
    await advance(20 * MINUTE - (Date.now() - created) - 5_000);
    expect(a.count('cancelRun')).toBe(0);
    await advance(10_000);
    await until(() => hub.task(t1).state === 'cancelled', '到点取消');
  });

  it('提供者给的开跑时刻超出请求时刻到现在的范围（两边时钟有偏差）时，限在这个范围里；没给时按请求时刻', async () => {
    for (const skew of [-10 * MINUTE, 10 * MINUTE, undefined]) {
      const a = new ScriptedRemote();
      const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
      let requestedAt = 0;
      let returnedAt = 0;
      a.intercept.createAgent = async ({ proceed }) => {
        requestedAt = Object.values(hub.store.data.tasks)[0]?.start?.requestedAt ?? 0;
        const out = (await proceed()) as { runId: string };
        await new Promise(resolve => setTimeout(resolve, 30_000));
        returnedAt = Date.now();
        return skew === undefined ? { runId: out.runId } : { runId: out.runId, startedAt: returnedAt + skew };
      };
      const t1 = await hub.accept();
      await advance(30_000);
      await until(() => hub.task(t1).state === 'running', '开轮');
      expect(returnedAt - requestedAt).toBe(30_000);
      const expected = skew !== undefined && skew > 0 ? returnedAt : requestedAt;
      expect(hub.task(t1).startedAt, `偏差 ${skew}`).toBe(expected);
      await hub.stop();
    }
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
  it('驱动从持久发布意图给远端使用可部署成品提示', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await hub.accept();
    await until(() => hub.task(first).state === 'running', '首件开轮');
    const second = await hub.accept();
    expect(hub.task(second).state).toBe('queued');
    await hub.store.exclusive(async () => {
      hub.task(second).publication = { target: 'works', title: '作品', summary: '', state: 'pending' };
      await hub.store.save();
    });
    a.finish(hub.task(first).runId ?? '');
    await until(() => hub.task(second).state === 'running', '发布任务开轮');
    const prompt = String(a.callsOn('startRun', hub.task(second).agentId ?? '')[0]?.args[1] ?? '');
    expect(prompt).toContain('最终可部署');
    expect(prompt).toContain('相对路径');
    expect(prompt).not.toContain('另附一份预览');
  });

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
    const prompt = a.agents.get(hub.task(t1).agentId ?? '')?.prompts[0] ?? '';
    expect(prompt).toContain('这一轮总时长上限为 5 分钟');
    expect(prompt).toContain(`尽早把第一版可用成品写入 /opt/out/${t1}/`);
    await advance(5 * MINUTE);
    await until(() => a.count('cancelRun') === 1, '5 分钟到点取消');
  });
});

describe('出队复核', () => {
  type Ctx = { a: ScriptedRemote; rooms: Record<string, SessionConfig> };
  const CHANGES: Array<[string, (ctx: Ctx) => void]> = [
    [
      '房间关了 paperEnabled',
      ({ rooms }) => {
        rooms[ROOM_A].paperEnabled = false;
      },
    ],
    [
      '房间的 remoteAgentTypes 去掉了白纸的类型',
      ({ rooms }) => {
        rooms[ROOM_A].remoteAgentTypes = [REMOTE_B];
      },
    ],
    [
      '房间的 paperName 改指别的白纸',
      ({ rooms }) => {
        rooms[ROOM_A].paperName = PAPER_B;
      },
    ],
    [
      '提供者的出网方式超过白纸的上限',
      ({ a }) => {
        a.egressMode = 'open';
      },
    ],
  ];

  for (const [label, change] of CHANGES) {
    it(`安全：受理之后${label}，排队的任务出队时判为失败、释放预留，不开轮`, async () => {
      const a = new ScriptedRemote();
      const rooms = { ...DRIVER_ROOMS, [ROOM_A]: { ...DRIVER_ROOMS[ROOM_A] } };
      // 白纸 b 的提供者也在场：改指别的白纸时，那块白纸本身的条件都成立，只有白纸指向这一条核对挡得住
      const hub = await startDriverHub({ remotes: { [REMOTE_A]: a, [REMOTE_B]: new ScriptedRemote() }, rooms });
      const t1 = await hub.accept();
      await until(() => hub.task(t1).state === 'running', '首件开轮');
      const t2 = await hub.accept();
      change({ a, rooms });
      const opened = a.count('createAgent') + a.count('startRun');
      a.finish(hub.task(t1).runId ?? '');
      await until(() => hub.task(t2).state === 'failed', '第二件出队时判为失败');
      expect(a.count('createAgent') + a.count('startRun'), '不开轮').toBe(opened);
      expect(hub.store.data.reserves[t2]).toBeUndefined();
    });
  }

  it('安全：受理之后配置里多了一块同账号的具名白纸，重启后排队的任务出队时判为失败', async () => {
    const a = new ScriptedRemote({ isolation: 'shared', accountKey: 'acct-shared' });
    const files = new Map();
    const config = { ...DRIVER_CONFIG, papers: [{ name: PAPER_A, remoteAgentType: REMOTE_A }] };
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files, config });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '首件开轮');
    const t2 = await hub.accept();
    await hub.stop();

    const twoPapers = {
      ...DRIVER_CONFIG,
      papers: [
        { name: PAPER_A, remoteAgentType: REMOTE_A },
        { name: PAPER_B, remoteAgentType: REMOTE_A },
      ],
    };
    const restarted = await startDriverHub({ remotes: { [REMOTE_A]: a }, files, config: twoPapers });
    const opened = a.count('createAgent') + a.count('startRun');
    a.finish(restarted.task(t1).runId ?? '');
    await until(() => restarted.task(t2).state === 'failed', '第二件出队时判为失败');
    expect(restarted.task(t2).error).toMatch(/同一远端账号/);
    expect(a.count('createAgent') + a.count('startRun')).toBe(opened);
  });
});

describe('开轮结果未知时的认领', () => {
  it('开轮结果未知之后重发得到 busy：账本外恰好一轮时认领为本件，不按自唤醒处理', async () => {
    const { a, hub, agentId } = await bound();
    let opened: string | undefined;
    once(a, 'startRun', async ({ proceed }) => {
      opened = ((await proceed()) as { runId: string }).runId;
      throw new RemoteAgentError('transient', '读超时');
    });
    // 第一次认领时远端的轮次列表还看不到刚开出的这一轮
    let hidden = false;
    a.intercept.listRuns = async ({ proceed }) => {
      const runs = (await proceed()) as RemoteRunSummary[];
      if (!opened || hidden) return runs;
      hidden = true;
      return runs.filter(r => r.runId !== opened);
    };
    const t2 = await hub.accept();
    await advance(6000);
    await until(() => hub.task(t2).state === 'running', '认领');
    expect(hub.task(t2).runId).toBe(opened);
    expect(a.callsOn('startRun', agentId)).toHaveLength(2);
    expect(a.count('deleteAgent')).toBe(0);
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
  });

  it('安全：开轮结果未知时认领了账本外的唯一一轮，记一条告警请 owner 核对', async () => {
    const { a, hub } = await bound();
    once(a, 'startRun', async ({ proceed }) => {
      await proceed();
      throw new RemoteAgentError('transient', '读超时');
    });
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'running', '认领');
    expect(hub.store.data.alerts).toContainEqual(
      expect.objectContaining({ kind: 'claim-unverified', subject: hub.task(t2).runId, acknowledged: false }),
    );
  });
});

describe('认领时列轮次失败', () => {
  it.each([
    ['提供者不可用', () => new RemoteAgentError('unavailable', 'GET /v1/agents/x/runs 返回 401')],
    ['临时故障等满上限', () => new RemoteAgentError('transient', '断线')],
  ])('安全：开轮结果未知、认领时列轮次失败（%s）：任务留在开轮中，不重发、不判失败、预留保留；列表恢复后下次认领', async (_, error) => {
    // 认领时按请求时刻计时：单轮时长放宽，免得认领后立即到点
    const { a, hub, agentId } = await bound({ ...DRIVER_CONFIG, maxRunMinutes: 120 });
    let opened: string | undefined;
    once(a, 'startRun', async ({ proceed }) => {
      opened = ((await proceed()) as { runId: string }).runId;
      throw new RemoteAgentError('transient', '读超时');
    });
    // 开轮前的核查照常列出；开轮之后的认领列不出来
    a.intercept.listRuns = ({ proceed }) => {
      if (opened === undefined) return proceed();
      throw error();
    };
    const t2 = await hub.accept();
    await until(() => opened !== undefined, 'POST 已到远端');
    await advance(25 * MINUTE);
    expect(hub.task(t2).state).toBe('starting');
    expect(hub.task(t2).error).toBeUndefined();
    expect(hub.store.data.reserves[t2], '预留保留').toBeDefined();
    expect(a.callsOn('startRun', agentId), '不重发').toHaveLength(1);
    expect(a.callsOn('listRuns', agentId).length, '之后的触发接着认领').toBeGreaterThan(1);

    delete a.intercept.listRuns;
    await advance(RECONCILE_MS);
    await until(() => hub.task(t2).state === 'running', '下次认领');
    expect(hub.task(t2).runId).toBe(opened);
    expect(a.callsOn('startRun', agentId)).toHaveLength(1);
    expect(a.runsOf(agentId)).toHaveLength(2);
  });

  it('对照：从没发出过结果未知的请求（开轮得到 busy）时列轮次失败，照旧判失败并释放预留', async () => {
    const { a, hub } = await bound();
    once(a, 'startRun', () => {
      throw new RemoteAgentError('busy', '代理上有一轮在跑');
    });
    a.intercept.listRuns = ({ proceed }) => {
      if (a.count('startRun') === 0) return proceed();
      throw new RemoteAgentError('unavailable', 'GET /v1/agents/x/runs 返回 401');
    };
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'failed', '判为失败');
    expect(hub.store.data.reserves[t2]).toBeUndefined();
    expect(a.count('startRun')).toBe(1);
  });
});

describe('认领失败的告警、诊断与出口', () => {
  const CLAIM_RAW = 'CLAIM-RAW-invalid-key-0123';
  const spent = (hub: DriverHub) => Object.values(hub.store.data.spend).reduce((sum, day) => sum + day.global, 0);

  /** 开轮结果未知（POST 已到远端）、认领时列轮次一直失败：任务留在开轮中 */
  async function stuck() {
    // 认领时按请求时刻计时：单轮时长放宽，免得认领后立即到点；闲置归档推后，免得归档前的核查也去列轮次
    const { a, hub, agentId } = await bound({
      ...DRIVER_CONFIG,
      maxRunMinutes: 120,
      papers: [{ name: PAPER_A, remoteAgentType: REMOTE_A, idleArchiveMinutes: 24 * 60 }],
    });
    let opened: string | undefined;
    once(a, 'startRun', async ({ proceed }) => {
      opened = ((await proceed()) as { runId: string }).runId;
      throw new RemoteAgentError('transient', '读超时');
    });
    a.intercept.listRuns = ({ proceed }) => {
      if (opened === undefined) return proceed();
      throw new RemoteAgentError('unavailable', `GET /v1/agents/x/runs 返回 401：${CLAIM_RAW}`);
    };
    const t2 = await hub.accept();
    await until(() => hub.store.data.alerts.some(al => al.kind === 'claim-failed'), '认领失败');
    expect(hub.task(t2).state).toBe('starting');
    return { a, hub, agentId, t2, opened: opened ?? '' };
  }

  it('安全：第一次认领失败挂一条 claim-failed 告警（只写类别），之后再失败、标为已读后都不再挂；诊断项对认领失败后仍在开轮中的任务报 warn，标为已读后照报', async () => {
    const { hub, t2 } = await stuck();
    const claimAlerts = () => hub.store.data.alerts.filter(al => al.kind === 'claim-failed');
    expect(claimAlerts()).toEqual([
      expect.objectContaining({ subject: t2, providerType: REMOTE_A, acknowledged: false }),
    ]);
    expect(claimAlerts()[0].message).toContain('提供者不可用');
    expect(claimAlerts()[0].message).not.toContain(CLAIM_RAW);
    expect(
      hub.logs.some(l => l.level === 'warn' && l.message.includes(CLAIM_RAW)),
      '原文进 warn',
    ).toBe(true);
    // 与放弃跟踪同一判据：认领失败过就报，报出时点「放弃跟踪」不会被拒
    const first = await hub.doctor();
    expect(first.level).toBe('warn');
    expect(first.message).toContain(`白纸任务 ${t2} 认领失败后仍在开轮中`);
    expect(first.message).toContain('放弃跟踪');
    expect(first.message).not.toContain(CLAIM_RAW);

    expect(await hub.driver.acknowledge(claimAlerts()[0].id)).toBe(true);
    await advance(2 * RECONCILE_MS);
    expect(hub.task(t2).state).toBe('starting');
    expect(claimAlerts(), '只挂第一次').toHaveLength(1);
    const result = await hub.doctor();
    expect(result.level).toBe('warn');
    expect(result.message, '告警标为已读后照报').toContain(`白纸任务 ${t2} 认领失败后仍在开轮中`);
    expect(result.message).not.toContain(CLAIM_RAW);
  });

  it('安全：放弃跟踪开轮中的任务：判为失败、写明远端可能已开出一轮，预留保留、下一件建新代理；列表恢复后那一轮记到它名下并请远端取消，白纸不停开，费用只入账一次', async () => {
    const { a, hub, agentId, t2, opened } = await stuck();
    const before = spent(hub);
    expect(await hub.driver.abandon(t2)).toBeUndefined();
    expect(hub.task(t2)).toMatchObject({ state: 'failed', orphanRun: true, agentId });
    expect(hub.task(t2).error).toContain('远端可能已开出一轮');
    expect(hub.task(t2).start).toBeUndefined();
    expect(hub.store.data.reserves[t2], '预留保留到对账确认').toBeDefined();
    expect(hub.store.data.papers[PAPER_A_ID].rotateNext).toBe(true);

    delete a.intercept.listRuns;
    await advance(RECONCILE_MS);
    await until(() => hub.store.data.runs[opened]?.taskId === t2, '对账把那一轮记到它名下');
    // 没人再跟踪、取回成品，也没有单轮时长的到点取消：记到它名下的同时请远端取消，不让它跑到远端自己的上限
    await until(() => a.callsOn('cancelRun', agentId).some(c => c.args[1] === opened), '请远端取消那一轮');
    expect(hub.task(t2).runId).toBe(opened);
    expect(hub.task(t2).orphanRun).toBeUndefined();
    expect(hub.store.data.papers[PAPER_A_ID].halted, '不当成自唤醒').toBeUndefined();
    expect(hub.store.data.alerts.map(al => al.kind)).not.toContain('unknown-run');
    expect(hub.store.data.alerts).toContainEqual(
      expect.objectContaining({ kind: 'claim-unverified', subject: opened }),
    );
    expect(a.count('deleteAgent')).toBe(0);

    // 取消之后这一轮到终态，费用照常入账后释放预留
    await advance(RECONCILE_MS);
    await until(() => hub.store.data.runs[opened].cost.state === 'booked', '费用入账');
    await advance(2 * RECONCILE_MS);
    expect(spent(hub) - before, '只入账一次').toBe(10);
    expect(hub.task(t2)).toMatchObject({ state: 'failed', costCents: 10 });
    expect(hub.store.data.reserves[t2]).toBeUndefined();
    expect(a.callsOn('startRun', agentId), '不重发').toHaveLength(1);
  });

  it('安全：认领途中放弃跟踪：这次列出的那一轮记到它名下，任务不转运行中、不重发', async () => {
    const { a, hub, agentId, t2, opened } = await stuck();
    // 下一次认领时列轮次挂住，等放弃跟踪之后再放行
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    a.intercept.listRuns = async ({ proceed }) => {
      await gate;
      return proceed();
    };
    const listed = a.callsOn('listRuns', agentId).length;
    await advance(RECONCILE_MS);
    await until(() => a.callsOn('listRuns', agentId).length > listed, '下一次认领在列轮次');
    expect(await hub.driver.abandon(t2)).toBeUndefined();
    release();
    await until(() => hub.store.data.runs[opened]?.taskId === t2, '列出的那一轮记到它名下');
    await until(() => a.callsOn('cancelRun', agentId).some(c => c.args[1] === opened), '请远端取消那一轮');
    await advance(MINUTE);
    expect(hub.task(t2)).toMatchObject({ state: 'failed', runId: opened });
    expect(a.callsOn('startRun', agentId), '不重发').toHaveLength(1);
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
  });

  it.each([
    ['重发成功', false],
    ['重发被拒', true],
  ] as const)('安全：远端没有开出这一轮、重发途中放弃跟踪（%s）：任务不转运行中，放弃跟踪写下的失败原因不被改写', async (_, rejected) => {
    const { a, hub, agentId, t2, opened } = await stuck();
    // POST 其实没有开出轮次：下一次认领列出来是空的，于是重发；重发挂住，等放弃跟踪之后再放行
    a.runs.delete(opened);
    delete a.intercept.listRuns;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    a.intercept.startRun = async ({ proceed }) => {
      await gate;
      if (rejected) throw new RemoteAgentError('rejected', '重发被拒');
      return proceed();
    };
    await advance(RECONCILE_MS);
    await until(() => a.callsOn('startRun', agentId).length === 2, '重发');
    expect(await hub.driver.abandon(t2)).toBeUndefined();
    const error = hub.task(t2).error;
    release();
    await advance(MINUTE);
    expect(hub.task(t2)).toMatchObject({ state: 'failed', error });
    const resent = a.runsOf(agentId).at(-1)?.runId ?? '';
    if (rejected) {
      expect(hub.task(t2).orphanRun, '等列表确认').toBe(true);
      expect(hub.store.data.reserves[t2], '预留保留到对账确认').toBeDefined();
    } else {
      expect(hub.store.data.runs[resent], '重发开出的一轮记到它名下').toMatchObject({ taskId: t2 });
      expect(
        a.callsOn('cancelRun', agentId).map(c => c.args[1]),
        '放弃跟踪之后才开出的一轮请远端取消',
      ).toContain(resent);
      expect(hub.task(t2).runId).toBe(resent);
      expect(hub.task(t2).orphanRun).toBeUndefined();
      expect(hub.store.data.reserves[t2], '费用入账前预留保留').toBeDefined();
    }
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
  });

  it('放弃跟踪之后列表恢复、远端没有开出这一轮：释放预留，之后不再等', async () => {
    const { a, hub, t2, opened } = await stuck();
    // POST 其实没有开出轮次：远端的轮次表里删掉它
    a.runs.delete(opened);
    expect(await hub.driver.abandon(t2)).toBeUndefined();
    delete a.intercept.listRuns;
    await advance(RECONCILE_MS);
    await until(() => hub.task(t2).orphanRun === undefined, '对账确认');
    expect(hub.store.data.reserves[t2]).toBeUndefined();
    expect(hub.store.data.papers[PAPER_A_ID].halted).toBeUndefined();
  });

  it('放弃跟踪之后远端已找不到这个代理：从账本移除，放弃跟踪的任务释放预留', async () => {
    const { a, hub, agentId, t2 } = await stuck();
    expect(await hub.driver.abandon(t2)).toBeUndefined();
    a.intercept.listRuns = () => {
      throw new RemoteAgentError('not-found', '代理已删除');
    };
    await advance(RECONCILE_MS);
    await until(() => hub.store.data.agents[agentId] === undefined, '从账本移除');
    expect(hub.task(t2).orphanRun).toBeUndefined();
    expect(hub.store.data.reserves[t2]).toBeUndefined();
  });

  it('对照：没有认领失败过的开轮中任务、排队中与已结束的任务不能放弃跟踪', async () => {
    const { hub, t2 } = await stuck();
    const t3 = await hub.accept();
    expect(await hub.driver.abandon(t3)).toMatch(/运行中与开轮中/);
    expect(hub.task(t3).state).toBe('queued');
    // 认领失败的记录属于 t2：换一件开轮中、没有失败记录的任务
    hub.store.data.alerts = hub.store.data.alerts.filter(al => al.kind !== 'claim-failed');
    expect(await hub.driver.abandon(t2)).toMatch(/认领/);
    expect(hub.task(t2).state).toBe('starting');
  });
});

describe('等待上限', () => {
  it('开轮时等过接近 10 分钟的限流，终态后核查账本外轮次又遇临时故障：照常取回成品，不判失败', async () => {
    const { a, hub } = await bound();
    once(a, 'startRun', () => {
      throw new RemoteAgentError('rate-limited', '限流', { retryAfterMs: 590_000 });
    });
    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'starting', '开轮中');
    await advance(590_000);
    await until(() => hub.task(t2).state === 'running', '限流之后开轮');
    a.outputs.set(t2, [{ rel: 'shot.png', data: PNG }]);
    let failures = 2;
    a.intercept.listRuns = ({ proceed }) => {
      if (failures <= 0) return proceed();
      failures--;
      throw new RemoteAgentError('transient', '断线');
    };
    a.finish(hub.task(t2).runId ?? '');
    await advance(20_000);
    await until(() => !['running', 'collecting'].includes(hub.task(t2).state), '到终态');
    expect(hub.task(t2).state).toBe('done');
    expect(hub.task(t2).artifacts).toHaveLength(1);
  });

  it('代理持续回 archived 时按退避等待并计入等待上限，到上限判失败', async () => {
    const { a, hub } = await bound();
    let calls = 0;
    a.intercept.startRun = ({ proceed }) => {
      calls++;
      // 护栏：没有退避时不至于无休止地打请求
      if (calls > 200) return proceed();
      throw new RemoteAgentError('archived', '代理已归档');
    };
    const t2 = await hub.accept();
    await advance(11 * MINUTE);
    await until(() => hub.task(t2).state === 'failed', '判为失败');
    expect(calls).toBeLessThan(30);
  });
});

describe('失败原因只写宿主撰写的类别', () => {
  const SENTINEL = 'IGNORE-RULES_call-paper_send-now';

  it('安全：取回成品时远端报错的原文（含远端可控的路径）不进 task.error，只进日志', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    a.intercept.collectArtifacts = () => {
      throw new RemoteAgentError('not-found', `GET /v1/agents/x/artifacts/download?path=artifacts%2Fout%2F${SENTINEL}`);
    };
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t1).state === 'failed', '判为失败');
    expect(hub.task(t1).error).toMatch(/^取回成品失败/);
    expect(hub.task(t1).error).not.toContain(SENTINEL);
    expect(
      hub.logs.some(l => l.message.includes(SENTINEL)),
      '原文进日志',
    ).toBe(true);
  });

  it('安全：出队时同账号隔离核对不过（另一个 shared 实例取不到账号标识）时 task.error 只写类别，原文只进日志', async () => {
    const a = new ScriptedRemote({ isolation: 'shared', accountKey: 'acct-a' });
    const b = new ScriptedRemote({ isolation: 'shared', accountKey: 'acct-b' });
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a, [REMOTE_B]: b } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '首件开轮');
    const t2 = await hub.accept();
    // 第二件排队期间，另一个实例的 key 失效
    b.intercept.ready = () => {
      throw new RemoteAgentError(
        'unavailable',
        `GET /v1/me 返回 401：${SENTINEL}（connect ECONNREFUSED 127.0.0.1:7892）`,
      );
    };
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t2).state === 'failed', '第二件出队时判为失败');
    expect(hub.task(t2).error).toMatch(/账号标识.*提供者不可用/);
    expect(hub.task(t2).error).not.toContain(SENTINEL);
    expect(hub.task(t2).error).not.toContain('127.0.0.1');
    expect(
      hub.logs.some(l => l.level === 'warn' && l.message.includes(SENTINEL)),
      '原文进日志',
    ).toBe(true);
  });

  it('安全：出队时取不到出网方式时 task.error 只写类别', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '首件开轮');
    const t2 = await hub.accept();
    a.egress = async () => {
      throw new RemoteAgentError('transient', `GET /egress 失败：${SENTINEL}`);
    };
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.task(t2).state === 'failed', '第二件出队时判为失败');
    expect(hub.task(t2).error).toMatch(/出网方式.*远端临时故障/);
    expect(hub.task(t2).error).not.toContain(SENTINEL);
  });

  it('安全：出队时提供者不可用而停开：停开说明、告警与 paper_task 的拒绝理由只写类别，原文只进日志', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '首件开轮');
    const t2 = await hub.accept();
    a.intercept.ready = () => {
      throw new RemoteAgentError(
        'unavailable',
        `GET /v1/me 返回 401：${SENTINEL}（connect ECONNREFUSED 127.0.0.1:7892）`,
      );
    };
    a.finish(hub.task(t1).runId ?? '');
    await until(() => hub.store.data.papers[PAPER_A_ID].halted !== undefined, '停开');
    const halted = hub.store.data.papers[PAPER_A_ID].halted;
    expect(halted?.reason).toBe('provider');
    expect(halted?.detail).toMatch(/提供者不可用/);
    expect(hub.task(t2).state, '任务留在队列里').toBe('queued');
    const alert = hub.store.data.alerts.find(x => x.kind === 'provider');
    for (const shown of [halted?.detail, alert?.message]) {
      expect(shown).not.toContain(SENTINEL);
      expect(shown).not.toContain('127.0.0.1');
    }

    delete a.intercept.ready;
    const refused = await hub.call('paper_task', { text: '再来一件', name: '再来' });
    expect(refused.ok).toBe(false);
    expect(String(refused.error)).toMatch(/停开.*提供者不可用/);
    expect(String(refused.error)).not.toContain(SENTINEL);
    expect(String(refused.error)).not.toContain('127.0.0.1');
    expect(
      hub.logs.some(l => l.level === 'warn' && l.message.includes(SENTINEL)),
      '原文进日志',
    ).toBe(true);
  });

  it('安全：建代理被拒、开轮被拒时同样只写类别', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    once(a, 'createAgent', () => {
      throw new RemoteAgentError('rejected', `bad name ${SENTINEL}`);
    });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'failed', '建代理被拒');
    expect(hub.task(t1).error).toMatch(/^建远端代理失败/);
    expect(hub.task(t1).error).not.toContain(SENTINEL);

    const t2 = await hub.accept();
    await until(() => hub.task(t2).state === 'running', '第二件开轮');
    a.finish(hub.task(t2).runId ?? '');
    await until(() => hub.task(t2).state === 'done', '第二件完成');
    once(a, 'startRun', () => {
      throw new RemoteAgentError('rejected', `bad prompt ${SENTINEL}`);
    });
    const t3 = await hub.accept();
    await until(() => hub.task(t3).state === 'failed', '开轮被拒');
    expect(hub.task(t3).error).toMatch(/^远端拒绝开轮/);
    expect(hub.task(t3).error).not.toContain(SENTINEL);
  });
});

describe('放弃跟踪', () => {
  it('到点取消失败、白纸停开后，owner 放弃跟踪：任务判为失败，白纸能清空与恢复，费用等这一轮结束后补记', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    a.intercept.cancelRun = () => {
      throw new RemoteAgentError('unavailable', 'key 已吊销');
    };
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const t2 = await hub.accept();
    const { agentId, runId } = hub.task(t1);
    expect(await hub.driver.abandon(t1), '取消还没判失败时不能放弃').toMatch(/取消失败/);
    a.bundles.set(agentId ?? '', new TextEncoder().encode('saved workspace'));

    await advance(20 * MINUTE + 101_000);
    await until(() => hub.store.data.papers[PAPER_A_ID].halted?.reason === 'cancel-failed', '停开');
    expect(await hub.driver.clear(PAPER_A_ID)).toMatch(/在跑/);

    expect(await hub.driver.abandon(t1)).toBeUndefined();
    expect(hub.task(t1)).toMatchObject({ state: 'failed' });
    expect(hub.task(t1).error).toMatch(/可能仍在运行/);
    expect(hub.store.data.reserves[t1], '预留按临时花费保留').toBeDefined();
    expect(hub.store.data.runs[runId ?? ''].cost.state).toBe('pending');

    await hub.driver.resume(PAPER_A_ID);
    await until(() => hub.task(t2).state === 'running', '恢复后下一件开轮');
    expect(hub.task(t2).agentId, '下一件建新代理').not.toBe(agentId);

    delete a.intercept.cancelRun;
    a.finish(runId ?? '');
    await advance(RECONCILE_MS);
    await until(() => hub.store.data.runs[runId ?? '']?.cost.state === 'booked', '补记费用');
    expect(hub.store.data.reserves[t1]).toBeUndefined();
  });
});

describe('账本落盘', () => {
  it('只在动作或状态变化时记录安全进展；旧提供者的无 activity 事件仍续传', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const taskId = await hub.accept();
    await until(() => hub.task(taskId).state === 'running', '开轮');
    const runId = hub.task(taskId).runId ?? '';
    let eventNumber = 0;
    const send = (activity?: RunActivity) => {
      const run = a.runs.get(runId);
      if (!run) throw new Error('没有轮次');
      const eventId = `ev-${++eventNumber}`;
      run.queue.push({ kind: 'progress', eventId, ...(activity ? { activity } : {}) });
      run.wake?.();
      return eventId;
    };
    const logs = () => hub.logs.filter(l => l.level === 'info' && l.message.includes(`白纸任务 ${taskId} 进展：`));
    const planning: RunActivity = { action: 'planning', status: 'running' };
    send(planning);
    await until(() => hub.task(taskId).progress?.activity.action === 'planning', '规划活动');
    const firstAt = hub.task(taskId).progress?.at;
    expect(logs().map(l => l.message)).toEqual([`白纸任务 ${taskId} 进展：规划（进行中）`]);
    await advance(1000);
    send(planning);
    const legacyId = send();
    await until(() => hub.task(taskId).lastEventId === legacyId, '旧进展事件');
    expect(hub.task(taskId).progress?.at).toBe(firstAt);
    expect(logs()).toHaveLength(1);
    send({ action: 'writing', status: 'running' });
    await until(() => hub.task(taskId).progress?.activity.action === 'writing', '写入活动');
    send({ action: 'writing', status: 'completed' });
    await until(() => hub.task(taskId).progress?.activity.status === 'completed', '写入完成');
    expect(logs().map(l => l.message)).toEqual([
      `白纸任务 ${taskId} 进展：规划（进行中）`,
      `白纸任务 ${taskId} 进展：写入（进行中）`,
      `白纸任务 ${taskId} 进展：写入（已完成）`,
    ]);
    a.finish(runId);
    await until(() => hub.task(taskId).state === 'done', '任务完成');
    expect(hub.task(taskId).progress?.activity.status).toBe('completed');
  });

  it('跟踪进展的落盘经账本锁：锁被占着时不写，放开后才写', async () => {
    const a = new ScriptedRemote();
    const files = new Map<string, string | Uint8Array>();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, files });
    const t1 = await hub.accept();
    await until(() => hub.task(t1).state === 'running', '开轮');
    const runId = hub.task(t1).runId ?? '';
    let release = () => {};
    const held = hub.store.exclusive(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    const before = files.get(LEDGER_URI);
    await advance(31_000);
    const eventId = a.progress(runId);
    await advance(10);
    expect(files.get(LEDGER_URI), '锁被占着时进展不落盘').toBe(before);
    release();
    await held;
    await until(() => hub.disk().tasks[t1].lastEventId === eventId, '锁放开后落盘');
  });
});
