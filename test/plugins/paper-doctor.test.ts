import { afterEach, describe, expect, it } from 'vitest';
import type { CheckResult } from '../../packages/api-doctor/src/index.js';
import {
  emptyLedger,
  fakeRemote,
  LEDGER_URI,
  PAPER,
  type PaperHubOptions,
  PILOT_CONFIG,
  PILOT_ROOM,
  REMOTE,
  ROOM,
  ROOM2,
  startPaperHub,
  stopPaperHubs,
} from '../fixtures/paper.js';

// ════════════════════════════════════════════════════════════
// 诊断项 paper.config（U10d）：让远端任务开不了、或让长期代理的可见范围超出预期的配置与账本问题。
// error：账本读取失败、同账号多块具名白纸、有停开的白纸、有未读的账本外代理告警；
// warn：平台档写了 remoteAgentTypes、具名白纸引用的提供者不在场、取不到账号标识（按冲突处理）、
// 一块具名白纸被多个房间共用、globalDailyCents 为 0；出网取自 owner 配置时在说明里标「未核实」。
// ════════════════════════════════════════════════════════════

afterEach(stopPaperHubs);

const PAPER_ID = `n:${PAPER}`;
/** 出网来自提供者接口的替身：说明里不该出现「未核实」 */
const VERIFIED = { [REMOTE]: fakeRemote({ egress: { mode: 'allowlist', source: 'provider-api' } }) };

async function check(opts: PaperHubOptions = {}): Promise<CheckResult> {
  const hub = await startPaperHub({ remotes: VERIFIED, ...opts });
  const results = await hub.doctor();
  expect(results).toHaveLength(1);
  expect(results[0].id).toBe('paper.config');
  return results[0];
}

function ledgerWith(mutate: (ledger: ReturnType<typeof emptyLedger>) => void) {
  const ledger = emptyLedger();
  mutate(ledger);
  return new Map([[LEDGER_URI, JSON.stringify(ledger)]]);
}

describe('诊断项 paper.config', () => {
  it('对照：试点形态（一块具名白纸、一个房间、出网来自提供者接口）为 ok', async () => {
    const result = await check({ listed: { [ROOM]: PILOT_ROOM } });
    expect(result.level).toBe('ok');
    expect(result.message).not.toMatch(/未核实/);
  });

  it('出网取自 owner 配置时说明里标「未核实」，级别不变', async () => {
    const result = await check({ remotes: { [REMOTE]: fakeRemote() } });
    expect(result.level).toBe('ok');
    expect(result.message).toContain(REMOTE);
    expect(result.message).toContain('未核实');
  });

  it('globalDailyCents 为 0 时 warn（远端任务不会开）', async () => {
    const result = await check({ config: { ...PILOT_CONFIG, globalDailyCents: 0 } });
    expect(result.level).toBe('warn');
    expect(result.message).toContain('globalDailyCents');
  });

  it('平台档写了 remoteAgentTypes 时 warn，写明平台', async () => {
    const result = await check({ profiles: { onebot: { remoteAgentTypes: [REMOTE] } } });
    expect(result.level).toBe('warn');
    expect(result.message).toContain('onebot');
    expect(result.message).toContain('remoteAgentTypes');
  });

  it('对照：平台档的 remoteAgentTypes 为空数组时不报', async () => {
    const result = await check({ profiles: { onebot: { remoteAgentTypes: [] } } });
    expect(result.level).toBe('ok');
  });

  it('具名白纸引用的提供者不在场时 warn', async () => {
    const result = await check({
      config: {
        ...PILOT_CONFIG,
        papers: [...PILOT_CONFIG.papers, { name: 'zz-paper-gone', remoteAgentType: 'zz-remote-gone' }],
      },
    });
    expect(result.level).toBe('warn');
    expect(result.message).toContain('zz-paper-gone');
    expect(result.message).toContain('zz-remote-gone');
  });

  it('取不到账号标识时 warn，说明按冲突处理', async () => {
    const result = await check({ remotes: { [REMOTE]: fakeRemote({ accountKey: new Error('ready 失败') }) } });
    expect(result.level).toBe('warn');
    expect(result.message).toContain('按冲突处理');
  });

  it('同一账号下多于一块具名白纸时 error', async () => {
    const result = await check({
      remotes: { [REMOTE]: fakeRemote() },
      config: { ...PILOT_CONFIG, papers: [...PILOT_CONFIG.papers, { name: 'zz-paper-b', remoteAgentType: REMOTE }] },
    });
    expect(result.level).toBe('error');
    expect(result.message).toContain('zz-paper-b');
  });

  it('一块具名白纸被两个房间共用时 warn，写明长期代理对这些房间都可见', async () => {
    const result = await check({ listed: { [ROOM]: PILOT_ROOM, [ROOM2]: PILOT_ROOM } });
    expect(result.level).toBe('warn');
    expect(result.message).toContain(ROOM);
    expect(result.message).toContain(ROOM2);
    expect(result.message).toContain('可见');
  });

  it('平台档写了 paperName 时同样按多个房间共用 warn', async () => {
    const result = await check({ profiles: { onebot: { paperName: PAPER } } });
    expect(result.level).toBe('warn');
    expect(result.message).toContain('onebot');
    expect(result.message).toContain('可见');
  });

  it('账本里上次清空之后结束的任务所在的房间也算：另一个房间的任务让它成为共用', async () => {
    const files = ledgerWith(ledger => {
      ledger.papers[PAPER_ID] = { lastClearedAt: 1 };
      ledger.tasks['t-00000001'] = {
        id: 't-00000001',
        paperId: PAPER_ID,
        room: ROOM2,
        platform: 'onebot',
        initiator: { platform: 'onebot', userId: '30001' },
        name: '旧任务',
        text: '旧任务原文',
        state: 'done',
        createdAt: 2,
        endedAt: 3,
        artifacts: [],
        delivered: false,
      };
    });
    const result = await check({ files, listed: { [ROOM]: PILOT_ROOM } });
    expect(result.level).toBe('warn');
    expect(result.message).toContain(ROOM2);

    // 清空之前结束的任务不算：那时的对话与工作区已随代理删除
    const cleared = ledgerWith(ledger => {
      ledger.papers[PAPER_ID] = { lastClearedAt: 10 };
      ledger.tasks['t-00000001'] = {
        id: 't-00000001',
        paperId: PAPER_ID,
        room: ROOM2,
        platform: 'onebot',
        initiator: { platform: 'onebot', userId: '30001' },
        name: '旧任务',
        text: '旧任务原文',
        state: 'done',
        createdAt: 2,
        endedAt: 3,
        artifacts: [],
        delivered: false,
      };
    });
    expect((await check({ files: cleared, listed: { [ROOM]: PILOT_ROOM } })).level).toBe('ok');
  });

  it('有停开的白纸时 error，写明原因', async () => {
    const files = ledgerWith(ledger => {
      ledger.papers[PAPER_ID] = {
        lastClearedAt: Date.now(),
        halted: { reason: 'unknown-run', detail: 'HALT-DETAIL-自唤醒', at: 1 },
      };
    });
    const result = await check({ files });
    expect(result.level).toBe('error');
    expect(result.message).toContain(PAPER);
    expect(result.message).toContain('HALT-DETAIL-自唤醒');
  });

  it('有未读的账本外代理告警时 error；标为已读后不再报', async () => {
    const alert = {
      id: 'al-00000001',
      at: 1,
      kind: 'unknown-agent' as const,
      subject: 'bc-foreign',
      providerType: REMOTE,
      message: '账号下有账本外的代理 FOREIGN-AGENT',
    };
    const unread = await check({ files: ledgerWith(l => void l.alerts.push({ ...alert, acknowledged: false })) });
    expect(unread.level).toBe('error');
    expect(unread.message).toContain(REMOTE);
    expect(unread.message).toContain('bc-foreign');

    const read = await check({ files: ledgerWith(l => void l.alerts.push({ ...alert, acknowledged: true })) });
    expect(read.level).toBe('ok');
  });

  it('账本读取失败时 error', async () => {
    const result = await check({ files: new Map([[LEDGER_URI, '{"version":1']]) });
    expect(result.level).toBe('error');
    expect(result.message).toMatch(/账本/);
  });
});
