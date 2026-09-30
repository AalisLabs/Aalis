import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteAgentError } from '../../packages/api-remote-agent/src/index.js';
import {
  advance,
  DRIVER_CONFIG,
  FAKE_TIMERS,
  MINUTE,
  PAPER_A_ID,
  REMOTE_A,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { ScriptedRemote, text } from '../fixtures/paper-remote.js';

beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now }));
afterEach(async () => {
  await stopDriverHubs();
  vi.useRealTimers();
});

describe('白纸未完成工程保留', () => {
  it.each(['missing', 'unavailable'] as const)('旧工程包 %s 时不从空工作区换新，也不删旧代理', async failure => {
    const remote = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: remote } });
    const first = await hub.accept();
    await until(() => hub.task(first).state === 'running', '首轮开跑');
    const oldAgent = hub.task(first).agentId ?? '';
    remote.finish(hub.task(first).runId ?? '', 'error');
    await until(() => hub.task(first).state === 'failed', '首轮失败');
    if (failure === 'unavailable') {
      remote.intercept.bundleLink = () => {
        throw new RemoteAgentError('unavailable', 'package unavailable');
      };
    }
    await hub.driver.rotate(PAPER_A_ID);
    const next = await hub.accept();
    await until(() => ['running', 'failed'].includes(hub.task(next).state), '换新决策落定');
    expect(hub.task(next).state).toBe('running');
    expect(hub.task(next).agentId).toBe(oldAgent);
    expect(remote.count('createAgent')).toBe(1);
    expect(remote.callsOn('deleteAgent', oldAgent)).toHaveLength(0);
    expect(hub.store.data.papers[PAPER_A_ID].binding).toBe(oldAgent);
    expect(hub.store.data.agents[oldAgent].state).toBe('active');

    // 旧工程仍在；补好工程包后，下一次正常换新能带上它。
    delete remote.intercept.bundleLink;
    remote.bundles.set(oldAgent, text('saved workspace'));
    remote.finish(hub.task(next).runId ?? '');
    await until(() => hub.task(next).state === 'done', '原工作区保存完成');
    const recovered = await hub.accept();
    await until(() => hub.task(recovered).state === 'running', '工程包恢复后开跑');
    expect(hub.task(recovered).agentId).not.toBe(oldAgent);
    const prompt = (remote.calls.filter(c => c.method === 'createAgent').at(-1)?.args[0] as { prompt: string }).prompt;
    expect(prompt).toContain(`https://bundle.invalid/${oldAgent}.tar.gz`);
    expect(remote.callsOn('deleteAgent', oldAgent)).toHaveLength(0);
  });

  it('超时回收已有成品，同一白纸的下一件任务继续使用原工作区', async () => {
    const remote = new ScriptedRemote();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: remote },
      config: { ...DRIVER_CONFIG, maxRunMinutes: 1 },
    });
    const first = await hub.accept();
    await until(() => hub.task(first).state === 'running', '开跑');
    const agent = hub.task(first).agentId ?? '';
    remote.outputs.set(first, [{ rel: 'index.html', data: text('<!doctype html><title>draft</title>') }]);
    await advance(MINUTE);
    await until(() => hub.task(first).state === 'cancelled', '超时收尾');
    expect(hub.task(first).artifacts).toHaveLength(1);
    expect(remote.callsOn('deleteAgent', agent)).toHaveLength(0);
    const next = await hub.accept(undefined, '继续上一轮的工程');
    await until(() => hub.task(next).state === 'running', '接着做');
    expect(hub.task(next).agentId).toBe(agent);
    expect(remote.count('createAgent')).toBe(1);
    expect(remote.count('startRun')).toBe(1);
  });

  it('重载时延长上限，接回同一轮且不在旧截止时间取消', async () => {
    const remote = new ScriptedRemote();
    const first = await startDriverHub({
      remotes: { [REMOTE_A]: remote },
      config: { ...DRIVER_CONFIG, maxRunMinutes: 1 },
    });
    const taskId = await first.accept();
    await until(() => first.task(taskId).state === 'running', '开跑');
    const runId = first.task(taskId).runId;
    await advance(30_000);
    await first.stop();
    const resumed = await startDriverHub({
      remotes: { [REMOTE_A]: remote },
      files: first.files,
      config: { ...DRIVER_CONFIG, maxRunMinutes: 3 },
    });
    await advance(45_000);
    expect(resumed.task(taskId).state).toBe('running');
    expect(resumed.task(taskId).runId).toBe(runId);
    expect(remote.count('cancelRun')).toBe(0);
    expect(remote.count('createAgent')).toBe(1);
    await advance(2 * MINUTE);
    await until(() => resumed.task(taskId).state === 'cancelled', '新截止时间取消');
    expect(remote.count('cancelRun')).toBe(1);
  });
});
