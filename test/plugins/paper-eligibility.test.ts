import { afterEach, describe, expect, it } from 'vitest';
import { selfInitiatedActor } from '../../packages/schema-message/src/index.js';
import {
  emptyLedger,
  fakeRemote,
  human,
  LEDGER_URI,
  PAPER,
  type PaperHub,
  PILOT_CONFIG,
  PILOT_ROOM,
  REMOTE,
  ROOM,
  ROOM2,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 白纸枢纽的资格判定（U10a）：paper_task 只受理真人在房间会话本身里当面发起的任务，房间要开了白纸、
// 允许白纸的远端类型，提供者要按名字精确在场、出网不超过白纸的上限、不违反同账号隔离、白纸没有停开、
// 提供者实例没有未读的账本外代理告警。每条拒绝各自一个用例，并各有一次变异验证。
// 被拒时不回显、不记账本。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const TASK = { text: '做一个会动的像素小猫 GIF', name: '像素小猫' };
const PAPER_ID = `n:${PAPER}`;

async function expectRefused(hub: PaperHub, reason: RegExp, ctx = human()) {
  const res = await hub.call('paper_task', TASK, ctx);
  expect(res.ok, `应被拒，实际：${JSON.stringify(res)}`).toBe(false);
  expect(String(res.error)).toMatch(reason);
  expect(hub.outbound, '被拒时不回显').toEqual([]);
  expect(hub.files.has(LEDGER_URI), '被拒时不记账本').toBe(false);
}

async function expectAccepted(hub: PaperHub, ctx = human()) {
  const res = await hub.call('paper_task', TASK, ctx);
  expect(res, `应受理，实际：${JSON.stringify(res)}`).toMatchObject({ ok: true });
}

describe('发起者：真人、房间会话本身、入站回合', () => {
  it('对照：真人在试点房间提交被受理', async () => {
    const hub = await startPaperHub();
    await expectAccepted(hub);
  });

  it('安全：子会话里调 paper_task 被拒', async () => {
    const child = `${ROOM}::zz-child`;
    const hub = await startPaperHub({ rooms: { [child]: PILOT_ROOM }, children: { [child]: ROOM } });
    await expectRefused(hub, /子会话/, human('30001', child));
  });

  it('安全：ctx.inbound 缺省（workflow 节点、mcp-server 自造的上下文）被拒', async () => {
    const hub = await startPaperHub();
    await expectRefused(hub, /消息驱动/, { sessionId: ROOM, platform: 'onebot', userId: '30001' });
  });

  it.each([
    'scheduler',
    'idle-trigger',
    'paper:n:zz-paper:t-00000000',
  ])('安全：inbound.source 为 %s 的回合被拒', async source => {
    const hub = await startPaperHub();
    await expectRefused(hub, /真人/, {
      sessionId: ROOM,
      platform: 'onebot',
      actor: { platform: 'onebot', userId: '30001' },
      inbound: { source },
    });
  });

  it('安全：actor 为 selfInitiatedActor（interval 回合）被拒', async () => {
    const hub = await startPaperHub();
    await expectRefused(hub, /发起人/, {
      sessionId: ROOM,
      platform: 'onebot',
      actor: selfInitiatedActor('onebot'),
      inbound: {},
    });
  });
});

describe('房间配置', () => {
  it('安全：房间没开 paperEnabled 被拒', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, paperEnabled: undefined } } });
    await expectRefused(hub, /没有开启白纸/);
  });

  it('安全：房间 remoteAgentTypes 不含白纸的远端类型被拒', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, remoteAgentTypes: ['zz-remote-other'] } } });
    await expectRefused(hub, /远端代理类型/);
  });

  it('房间写的白纸名在插件配置里不存在时被拒', async () => {
    const hub = await startPaperHub({ rooms: { [ROOM]: { ...PILOT_ROOM, paperName: 'zz-missing' } } });
    await expectRefused(hub, /不存在/);
  });
});

describe('远端条件：提供者按名字精确在场、出网不超过上限', () => {
  it('安全：白纸类型的提供者未登记时被拒', async () => {
    const hub = await startPaperHub({ remotes: {} });
    await expectRefused(hub, /不在场/);
  });

  it.each(['open', 'unknown'] as const)('安全：提供者出网为 %s、白纸上限为 allowlist 时被拒', async mode => {
    const hub = await startPaperHub({
      remotes: { [REMOTE]: fakeRemote({ egress: { mode, source: 'owner-config' } }) },
    });
    await expectRefused(hub, /出网/);
  });

  it('对照：白纸上限为 open 时，出网 unknown 的提供者可用', async () => {
    const hub = await startPaperHub({
      config: { ...PILOT_CONFIG, papers: [{ name: PAPER, remoteAgentType: REMOTE, remoteAgentEgress: 'open' }] },
      remotes: { [REMOTE]: fakeRemote({ egress: { mode: 'unknown', source: 'owner-config' } }) },
    });
    await expectAccepted(hub);
  });

  it('安全：偏好指向另一个提供者、白纸类型的提供者不在场时，不回落到偏好的那个', async () => {
    const other = fakeRemote({ accountKey: 'acct-other' });
    const hub = await startPaperHub({ remotes: { 'zz-remote-other': other }, prefer: 'zz-remote-other' });
    await expectRefused(hub, /不在场/);
    expect(other.readyCalls, '偏好的提供者一次都不该被调用').toBe(0);
  });
});

describe('同账号隔离：声明 shared 的提供者，同一账号下只给一块具名白纸', () => {
  const TWO_PAPERS = {
    ...PILOT_CONFIG,
    papers: [
      { name: PAPER, remoteAgentType: REMOTE, remoteAgentEgress: 'allowlist' },
      { name: 'zz-paper-b', remoteAgentType: 'zz-remote-b', remoteAgentEgress: 'allowlist' },
    ],
  };
  const TWO_ROOMS = {
    [ROOM]: PILOT_ROOM,
    [ROOM2]: { ...PILOT_ROOM, paperName: 'zz-paper-b', remoteAgentTypes: ['zz-remote-b'] },
  };

  it('安全：同一个 shared 提供者被两块具名白纸引用时两块都不开，诊断项报 error', async () => {
    const hub = await startPaperHub({
      config: { ...PILOT_CONFIG, papers: [...PILOT_CONFIG.papers, { name: 'zz-paper-b', remoteAgentType: REMOTE }] },
      rooms: { [ROOM]: PILOT_ROOM, [ROOM2]: { ...PILOT_ROOM, paperName: 'zz-paper-b' } },
    });
    await expectRefused(hub, /同一远端账号/);
    await expectRefused(hub, /同一远端账号/, human('30001', ROOM2));
    const [check] = await hub.doctor();
    expect(check.level).toBe('error');
    expect(check.message).toContain(PAPER);
    expect(check.message).toContain('zz-paper-b');
  });

  it('安全：同一 accountKey 的两个实例各被一块具名白纸引用时两块都不开', async () => {
    const hub = await startPaperHub({
      config: TWO_PAPERS,
      rooms: TWO_ROOMS,
      remotes: { [REMOTE]: fakeRemote({ accountKey: 'acct-1' }), 'zz-remote-b': fakeRemote({ accountKey: 'acct-1' }) },
    });
    await expectRefused(hub, /同一远端账号/);
    await expectRefused(hub, /同一远端账号/, human('30001', ROOM2));
  });

  it('对照：两个实例在不同账号下时两块都能用', async () => {
    const hub = await startPaperHub({
      config: TWO_PAPERS,
      rooms: TWO_ROOMS,
      remotes: { [REMOTE]: fakeRemote({ accountKey: 'acct-1' }), 'zz-remote-b': fakeRemote({ accountKey: 'acct-2' }) },
    });
    await expectAccepted(hub);
    await expectAccepted(hub, human('30001', ROOM2));
  });

  it('安全：ready() 失败、取不到 accountKey 时按冲突算：自己不开，同类的其他具名白纸也不开', async () => {
    const hub = await startPaperHub({
      config: TWO_PAPERS,
      rooms: TWO_ROOMS,
      remotes: {
        [REMOTE]: fakeRemote({ accountKey: new Error('鉴权失败') }),
        'zz-remote-b': fakeRemote({ accountKey: 'acct-2' }),
      },
    });
    await expectRefused(hub, /账号标识/);
    await expectRefused(hub, /账号标识/, human('30001', ROOM2));
  });

  it('安全：defaults.remoteAgentType 指向 shared 提供者时，不写名字的房间白纸不开', async () => {
    const hub = await startPaperHub({
      config: { globalDailyCents: 1000, defaults: { remoteAgentType: REMOTE } },
      rooms: { [ROOM]: { ...PILOT_ROOM, paperName: undefined } },
    });
    await expectRefused(hub, /具名白纸/);
  });

  it('对照：per-agent 的提供者不受这条限制（房间白纸与两块具名白纸都能用）', async () => {
    const perAgent = fakeRemote({ isolation: 'per-agent' });
    const room = await startPaperHub({
      config: { globalDailyCents: 1000, defaults: { remoteAgentType: REMOTE } },
      rooms: { [ROOM]: { ...PILOT_ROOM, paperName: undefined } },
      remotes: { [REMOTE]: perAgent },
    });
    await expectAccepted(room);
    const named = await startPaperHub({
      config: { ...PILOT_CONFIG, papers: [...PILOT_CONFIG.papers, { name: 'zz-paper-b', remoteAgentType: REMOTE }] },
      rooms: { [ROOM]: PILOT_ROOM, [ROOM2]: { ...PILOT_ROOM, paperName: 'zz-paper-b' } },
      remotes: { [REMOTE]: perAgent },
    });
    await expectAccepted(named);
    await expectAccepted(named, human('30001', ROOM2));
  });
});

describe('停开与账本外代理告警', () => {
  const seeded = (mutate: (ledger: ReturnType<typeof emptyLedger>) => void) => {
    const ledger = emptyLedger();
    mutate(ledger);
    return new Map([[LEDGER_URI, JSON.stringify(ledger)]]);
  };

  it('安全：白纸停开时被拒', async () => {
    const files = seeded(l => {
      l.papers[PAPER_ID] = { lastClearedAt: 0, halted: { reason: 'unknown-run', detail: '账本外的轮次', at: 1 } };
    });
    const hub = await startPaperHub({ files });
    const res = await hub.call('paper_task', TASK);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/停开/);
    expect(hub.outbound).toEqual([]);
  });

  it('安全：提供者实例有未读的 unknown-agent 告警时被拒；已读或别的实例的告警不挡', async () => {
    const alert = {
      id: 'al-1',
      at: 1,
      kind: 'unknown-agent' as const,
      subject: 'bc-00000000',
      providerType: REMOTE,
      message: '账本外的代理',
      acknowledged: false,
    };
    const blocked = await startPaperHub({ files: seeded(l => void l.alerts.push(alert)) });
    const res = await blocked.call('paper_task', TASK);
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/账本外的代理/);
    expect(blocked.outbound).toEqual([]);

    const read = await startPaperHub({ files: seeded(l => void l.alerts.push({ ...alert, acknowledged: true })) });
    await expectAccepted(read);
    const other = await startPaperHub({
      files: seeded(l => void l.alerts.push({ ...alert, providerType: 'zz-remote-other' })),
    });
    await expectAccepted(other);
  });
});

describe('paper_cancel 的资格同 paper_task', () => {
  it('安全：scheduler 回合（actor 为创建者）取消创建者的任务被拒；创建者本人当面取消可以', async () => {
    const hub = await startPaperHub({ config: { ...PILOT_CONFIG } });
    const accepted = await hub.call('paper_task', TASK, human('30001'));
    expect(accepted.ok).toBe(true);
    const taskId = String(accepted.taskId);

    const viaScheduler = await hub.call(
      'paper_cancel',
      { task_id: taskId },
      {
        sessionId: ROOM,
        platform: 'onebot',
        actor: { platform: 'onebot', userId: '30001' },
        inbound: { source: 'scheduler' },
      },
    );
    expect(viaScheduler.ok).toBe(false);
    expect(String(viaScheduler.error)).toMatch(/真人/);
    expect(hub.ledger().tasks[taskId].state).toBe('queued');

    const byHand = await hub.call('paper_cancel', { task_id: taskId }, human('30001'));
    expect(byHand.ok).toBe(true);
    expect(hub.ledger().tasks[taskId].state).toBe('cancelled');
  });
});
