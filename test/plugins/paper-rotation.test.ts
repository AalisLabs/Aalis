import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRIVER_CONFIG,
  type DriverHub,
  FAKE_TIMERS,
  PAPER_A,
  PAPER_A_ID,
  REMOTE_A,
  startDriverHub,
  stopDriverHubs,
  until,
} from '../fixtures/paper-driver.js';
import { ScriptedRemote, text } from '../fixtures/paper-remote.js';

// ════════════════════════════════════════════════════════════
// 白纸的换新（U10b）：代理累计花费超过 rotateAfterCents、上一轮上下文超过 rotateAfterInputTokens，
// 或 owner 点了换新，下一件任务建新代理；旧代理的工程包链接写进新代理的前言；新代理这一轮成功取回之后
// 删除旧代理（不只归档），首轮失败时不删，下一轮仍带旧工程包。
// ════════════════════════════════════════════════════════════

beforeEach(() => {
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS.toFake], now: FAKE_TIMERS.now });
});
afterEach(async () => {
  await stopDriverHubs();
  vi.useRealTimers();
});

const bundleUrl = (agentId: string) => `https://bundle.invalid/${agentId}.tar.gz?sig=BUNDLE-SIG`;

/** 跑完一件任务（按给定终态），返回它用的代理 */
async function runOne(hub: DriverHub, a: ScriptedRemote, status: 'finished' | 'error' = 'finished') {
  const id = await hub.accept();
  await until(() => hub.task(id).state === 'running', `任务 ${id} 开轮`);
  const agentId = hub.task(id).agentId ?? '';
  a.bundles.set(agentId, text(`bundle of ${agentId}`));
  a.finish(hub.task(id).runId ?? '', status);
  await until(() => ['done', 'failed'].includes(hub.task(id).state), `任务 ${id} 到终态`);
  return { id, agentId };
}

function withPaper(fields: Record<string, unknown>) {
  return { ...DRIVER_CONFIG, papers: [{ name: PAPER_A, remoteAgentType: REMOTE_A, ...fields }] };
}

describe('换新', () => {
  it('安全：累计花费超过 rotateAfterCents 后建新代理，首轮前言带旧工程包链接；首轮成功后旧代理被删除', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, config: withPaper({ rotateAfterCents: 300 }) });
    a.costOf = () => ({ cents: 400, inputTokens: 10, cacheReadTokens: 0 });
    const first = await runOne(hub, a);
    expect(hub.store.data.agents[first.agentId].costCents).toBe(400);

    const second = await runOne(hub, a);
    expect(second.agentId).not.toBe(first.agentId);
    expect(a.agents.get(second.agentId)?.prompts[0]).toContain(bundleUrl(first.agentId));
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '旧代理被删除');
    expect(a.callsOn('archiveAgent', first.agentId)).toEqual([]);
    expect(hub.store.data.agents[first.agentId], '确认删除后从账本移除').toBeUndefined();
    expect(Object.values(hub.store.data.runs).filter(r => r.agentId === first.agentId)).toEqual([]);
    expect(hub.store.data.papers[PAPER_A_ID].binding).toBe(second.agentId);
  });

  it('新代理首轮失败时不删旧代理；下一轮仍带旧工程包，成功后才删', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a }, config: withPaper({ rotateAfterCents: 15 }) });
    a.costOf = () => ({ cents: 20, inputTokens: 10, cacheReadTokens: 0 });
    const first = await runOne(hub, a);
    a.costOf = () => ({ cents: 1, inputTokens: 10, cacheReadTokens: 0 });
    const second = await runOne(hub, a, 'error');
    expect(hub.task(second.id).state).toBe('failed');
    expect(second.agentId).not.toBe(first.agentId);
    expect(a.callsOn('deleteAgent', first.agentId)).toEqual([]);
    expect(hub.store.data.agents[first.agentId]?.state).toBe('retired');

    const third = await runOne(hub, a);
    expect(third.agentId, '仍在新代理上').toBe(second.agentId);
    expect(a.callsOn('startRun', second.agentId)[0]?.args[1]).toContain(bundleUrl(first.agentId));
    await until(() => a.callsOn('deleteAgent', first.agentId).length === 1, '成功后删旧代理');
  });

  it('上一轮的上下文（input 加 cacheRead）超过 rotateAfterInputTokens 时建新代理', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({
      remotes: { [REMOTE_A]: a },
      config: withPaper({ rotateAfterInputTokens: 1200 }),
    });
    const first = await runOne(hub, a);
    expect(hub.store.data.agents[first.agentId].lastContextTokens).toBe(1500);
    const second = await runOne(hub, a);
    expect(second.agentId).not.toBe(first.agentId);
  });

  it('owner 点了换新，下一件任务建新代理', async () => {
    const a = new ScriptedRemote();
    const hub = await startDriverHub({ remotes: { [REMOTE_A]: a } });
    const first = await runOne(hub, a);
    const kept = await runOne(hub, a);
    expect(kept.agentId).toBe(first.agentId);
    await hub.driver.rotate(PAPER_A_ID);
    const second = await runOne(hub, a);
    expect(second.agentId).not.toBe(first.agentId);
    expect(a.agents.get(second.agentId)?.prompts[0]).toContain(bundleUrl(first.agentId));
    expect(hub.store.data.papers[PAPER_A_ID].rotateNext).toBeUndefined();
  });
});
