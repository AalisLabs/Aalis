import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayKey } from '../../packages/plugin-paper/src/budget.js';
import { human } from '../fixtures/paper.js';
import {
  DRIVER_CONFIG,
  DRIVER_ROOMS,
  FAKE_TIMERS,
  PAPER_A,
  PAPER_A_ID,
  PAPER_B,
  REMOTE_A,
  REMOTE_B,
  ROOM_A,
  ROOM_A2,
  ROOM_B,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { ScriptedRemote } from '../fixtures/paper-remote.js';

beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now }));
afterEach(async () => {
  await stopDriverHubs();
  vi.useRealTimers();
});

describe('白纸日额度：受理、出队、记账与重启', () => {
  it('共用白纸的两房间合计预留；另一白纸独立，但所有白纸仍受全局限制', async () => {
    const hub = await startDriverHub({
      config: {
        ...DRIVER_CONFIG,
        globalDailyCents: 150,
        papers: [
          { name: PAPER_A, remoteAgentType: REMOTE_A, dailyCents: 100 },
          { name: PAPER_B, remoteAgentType: REMOTE_B },
        ],
      },
      remotes: { [REMOTE_A]: new ScriptedRemote(), [REMOTE_B]: new ScriptedRemote() },
    });
    const first = await hub.accept(ROOM_A);
    const second = await hub.accept(ROOM_A2);
    await expect(hub.accept(ROOM_A2)).rejects.toThrow('白纸今天的额度不够');
    await hub.accept(ROOM_B);
    await expect(hub.accept(ROOM_B)).rejects.toThrow('全局');
    expect(hub.disk().reserves[first]).toMatchObject({ cents: 50, paperId: PAPER_A_ID, room: ROOM_A });
    expect(hub.disk().reserves[second]).toMatchObject({ cents: 50, paperId: PAPER_A_ID, room: ROOM_A2 });
    expect(Object.keys(hub.store.data.tasks)).toHaveLength(3);
  });

  it('首轮实际费用高于预留时挡住排队任务；重启并清理历史任务后仍保留当日支出', async () => {
    const remote = new ScriptedRemote();
    remote.costOf = () => ({ cents: 80 });
    const config = {
      ...DRIVER_CONFIG,
      papers: [{ name: PAPER_A, remoteAgentType: REMOTE_A, dailyCents: 100 }],
    };
    const hub = await startDriverHub({ config, remotes: { [REMOTE_A]: remote } });
    const first = await hub.accept(ROOM_A);
    await until(() => hub.task(first).state === 'running', '首件开轮');
    const second = await hub.accept(ROOM_A2);
    remote.finish(hub.task(first).runId ?? '');
    await until(() => hub.task(first).state === 'done' && hub.task(second).state === 'failed', '费用入账并拒绝第二件');
    expect(hub.task(second).error).toContain('白纸今天的额度不够');
    expect(remote.count('createAgent')).toBe(1);
    expect(remote.count('startRun')).toBe(0);
    const day = dayKey(Date.now());
    expect(hub.disk().spend[day].papers?.[PAPER_A_ID]).toBe(80);
    expect(hub.disk().reserves).toEqual({});
    await hub.stop();
    // 模拟历史任务已经按保留期限清理，预算不能依赖任务表重建。
    hub.store.data.tasks = {};
    await hub.store.save();
    const resumed = await startDriverHub({ config, remotes: { [REMOTE_A]: remote }, files: hub.files });
    await expect(resumed.accept(ROOM_A2)).rejects.toThrow('白纸今天的额度不够');
    expect(resumed.store.data.spend[day].papers?.[PAPER_A_ID]).toBe(80);
    expect(remote.count('startRun')).toBe(0);
  });

  it('各层金额留空能实际开轮，具名额度不继承默认的 0；显式 0 的纸不开轮也不发受理回显', async () => {
    const remote = new ScriptedRemote();
    const hub = await startDriverHub({
      config: {
        defaults: { dailyCents: 0 },
        papers: [
          { name: PAPER_A, remoteAgentType: REMOTE_A },
          { name: PAPER_B, remoteAgentType: REMOTE_B, dailyCents: 0 },
        ],
      },
      rooms: {
        ...DRIVER_ROOMS,
        [ROOM_A]: { ...DRIVER_ROOMS[ROOM_A], remoteAgentRoomDailyCents: undefined },
      },
      remotes: { [REMOTE_A]: remote, [REMOTE_B]: new ScriptedRemote() },
    });
    const id = await hub.accept(ROOM_A);
    await until(() => hub.task(id).state === 'running', '不设金额上限的任务开轮');
    const sent = hub.outbound.length;
    const refused = await hub.call('paper_task', { name: '测试', text: '测试' }, human('30001', ROOM_B));
    expect(refused).toMatchObject({ ok: false });
    expect(refused.error).toMatch(/白纸.*上限为 0/);
    expect(hub.outbound).toHaveLength(sent);
    expect(Object.keys(hub.store.data.tasks)).toHaveLength(1);
  });
});
