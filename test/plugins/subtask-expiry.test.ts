import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContextMap } from '../../packages/api-hooks/src/index.js';
import type { App } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import { type SubtaskHub, startSubtaskHub } from '../fixtures/subtask.js';

// ════════════════════════════════════════════════════════════
// 子会话的到期销毁：子会话的一轮结束（回复、出错、被停止都算）满 idleDeleteHours 就删掉，追问在下一轮结束时重新计时，从没跑过
// 一轮的不计时；在飞的一轮与发出还没开跑的追问由子任务插件自己记，不看会话状态。删除只在定时器里做，延时截到 24 小时、到点重判；
// 插件重载之后按会话记录上的 lastTurn.endedAt 补删或重排。销毁之前把回报（名字、状态、原因、结果、任务）写进父会话记录，
// check_subtask、wait_subtasks 读到即删，父会话提醒列出它的那一轮结束后删；父会话清空时一并清掉。已删的子会话收到还没开跑的
// 派发与追问不跑。时钟用假时钟。
// ════════════════════════════════════════════════════════════

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOT_FOUND = '子任务不存在';

const apps: App[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(idleDeleteHours: number) {
  const hub = await startSubtaskHub({ config: { idleDeleteHours } });
  apps.push(hub.app);
  const parent = await hub.sm.createSession({ name: '<父会话>' });
  const child = await hub.sm.createChildSession(parent.id, { name: '<子任务>', inputContext: '<任务>' });
  const ctx = { sessionId: parent.id, platform: 'webui', userId: 'console' };
  const call = (tool: string, args: Record<string, unknown>) => hub.call(tool, args, ctx);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return { hub, parent, child, call };
}

const exists = (hub: SubtaskHub, id: string) => hub.sm.getSession(id) !== undefined;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** 父会话记录上的回报 */
const reports = (hub: SubtaskHub, parentId: string) =>
  ((hub.sm.getSession(parentId)?.metadata?.subtask as { reports?: unknown[] } | undefined)?.reports ?? []) as Array<
    Record<string, unknown>
  >;

describe('到期销毁', () => {
  it('一轮结束后满 idleDeleteHours 才销毁', async () => {
    const { hub, child } = await setup(1);
    await hub.turn(child.id, 'replied');
    await advance(59 * MINUTE);
    expect(exists(hub, child.id)).toBe(true);
    await advance(2 * MINUTE);
    expect(exists(hub, child.id)).toBe(false);
  });

  it.each<HookContextMap['agent:turn:after']['outcome']>([
    'error',
    'aborted',
  ])('结局为 %s 的一轮同样起算', async outcome => {
    const { hub, child } = await setup(1);
    await hub.turn(child.id, outcome);
    await advance(61 * MINUTE);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('追问让它在下一轮结束时重新计时', async () => {
    const { hub, child, call } = await setup(1);
    await hub.turn(child.id, 'replied');
    await advance(50 * MINUTE);
    await call('send_to_subtask', { subtask_id: child.id, message: '<追问>' });
    await hub.turn(child.id, 'replied');
    await advance(30 * MINUTE);
    expect(exists(hub, child.id)).toBe(true);
    await advance(31 * MINUTE);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('0：交回结果即销毁，删除在定时器里做，回合收尾时子会话还在', async () => {
    const { hub, child } = await setup(0);
    await hub.turn(child.id, 'replied');
    expect(exists(hub, child.id)).toBe(true);
    await advance(0);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('被追问打断的一轮先收口、追问那一轮还没开始：不删；追问那一轮结束后照常销毁', async () => {
    const { hub, child, call } = await setup(0);
    await hub.turn(child.id, 'aborted', {
      during: () => call('send_to_subtask', { subtask_id: child.id, message: '<追问>' }),
    });
    await advance(HOUR);
    expect(exists(hub, child.id)).toBe(true);
    await hub.turn(child.id, 'replied');
    await advance(0);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('写回报的这一拍里发出的追问：子会话不删、回报撤回，这一拍里的父会话提醒不把它说成已销毁；追问那一轮结束后照常销毁', async () => {
    const { hub, parent, child, call } = await setup(0);
    let followed = false;
    let reminded: string | undefined;
    hub.host.events.use.on('session:updated', async session => {
      if (followed || session.id !== parent.id || reports(hub, parent.id).length === 0) return;
      followed = true;
      await call('send_to_subtask', { subtask_id: child.id, message: '<追问>' });
      reminded = await hub.reminder(parent.id);
    });
    await hub.turn(child.id, 'replied');
    await advance(0);
    expect(followed).toBe(true);
    expect(reminded).toContain('<子任务>');
    expect(reminded).not.toContain('已销毁');
    expect(exists(hub, child.id)).toBe(true);
    expect(reports(hub, parent.id)).toEqual([]);
    await hub.turn(child.id, 'replied');
    await advance(0);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('归档的子会话跑一轮时不在中途被删：到点时一轮在飞，收尾后重新计时', async () => {
    const { hub, child } = await setup(1);
    await hub.turn(child.id, 'replied');
    await hub.sm.updateSession(child.id, { status: 'archived' });
    await advance(30 * MINUTE);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => (finish = resolve));
    const running = hub.turn(child.id, 'replied', { during: () => gate });
    await advance(31 * MINUTE);
    expect(exists(hub, child.id)).toBe(true);
    await advance(9 * MINUTE);
    finish();
    await running;
    await advance(59 * MINUTE);
    expect(exists(hub, child.id)).toBe(true);
    await advance(2 * MINUTE);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('send_to_subtask 把出错与已完成翻回进行中，不翻归档', async () => {
    const { hub, child, call } = await setup(24);
    for (const status of ['error', 'completed'] as const) {
      await hub.sm.updateSession(child.id, { status });
      await call('send_to_subtask', { subtask_id: child.id, message: '<追问>' });
      expect(hub.sm.getSession(child.id)?.status, status).toBe('active');
    }
    await hub.sm.updateSession(child.id, { status: 'archived' });
    await call('send_to_subtask', { subtask_id: child.id, message: '<追问>' });
    expect(hub.sm.getSession(child.id)?.status).toBe('archived');
  });

  it('从没跑过一轮的子会话不计时', async () => {
    const { hub, child } = await setup(0);
    await advance(48 * HOUR);
    expect(exists(hub, child.id)).toBe(true);
  });

  it('时长很大时不立即销毁：定时器到 24 小时重判、再排', async () => {
    const { hub, child } = await setup(100_000);
    await hub.turn(child.id, 'replied');
    // 先让会话管理落盘之类的短定时器跑完，下一个定时器就是到期判定
    await advance(1000);
    for (const wait of [24 * HOUR - 1000, 24 * HOUR]) {
      const before = Date.now();
      await vi.advanceTimersToNextTimerAsync();
      expect(Date.now() - before).toBe(wait);
      expect(exists(hub, child.id)).toBe(true);
    }
  });

  it('插件重载之后按会话记录上的 lastTurn.endedAt 重排：各按自己的起点到期', async () => {
    const { hub, parent, child } = await setup(1);
    const later = await hub.sm.createChildSession(parent.id, { name: '<后一个>' });
    await hub.turn(child.id, 'replied');
    await advance(50 * MINUTE);
    await hub.turn(later.id, 'replied');
    await hub.app.plugins.bounce(subtask.name);
    await advance(11 * MINUTE);
    expect([exists(hub, child.id), exists(hub, later.id)]).toEqual([false, true]);
    await advance(50 * MINUTE);
    expect(exists(hub, later.id)).toBe(false);
  });

  it('插件停着的时段里到期的：重新启用时补删', async () => {
    const { hub, child } = await setup(1);
    await hub.turn(child.id, 'replied');
    await hub.app.plugins.disable(subtask.name);
    await advance(2 * HOUR);
    expect(exists(hub, child.id)).toBe(true);
    await hub.app.plugins.enable(subtask.name);
    await advance(0);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('已删的子会话收到还没开跑的派发或追问不跑；不是子任务派来的照常跑', async () => {
    const { hub, child } = await setup(24);
    await hub.sm.deleteSession(child.id);
    expect(await hub.turn(child.id, 'replied', { source: 'subtask' })).toBe(false);
    expect(await hub.turn('<没有建档的会话>', 'replied', { source: 'scheduler' })).toBe(true);
  });
});

describe('回报', () => {
  it('到期销毁之前写进父会话记录；check_subtask 读到即删', async () => {
    const { hub, parent, child, call } = await setup(0);
    await hub.turn(child.id, 'replied');
    await advance(0);
    expect(reports(hub, parent.id)).toEqual([
      { id: child.id, name: '<子任务>', status: 'completed', result: '<结果>', inputContext: '<任务>' },
    ]);

    const checked = await call('check_subtask', { subtask_ids: [child.id] });
    expect(checked.subtasks).toEqual([
      expect.objectContaining({ id: child.id, status: 'completed', result: '<结果>', destroyed: true }),
    ]);
    expect(checked.summary).toMatchObject({ total: 1, completed: 1 });
    expect(reports(hub, parent.id)).toEqual([]);
    expect((await call('check_subtask', { subtask_ids: [child.id] })).subtasks).toEqual([
      { id: child.id, error: NOT_FOUND },
    ]);
  });

  it('子会话还在时 check_subtask、wait_subtasks 取过的结果：到期销毁时不再写回报；之后的追问交回新结果的照常写', async () => {
    for (const tool of ['check_subtask', 'wait_subtasks']) {
      const { hub, parent, child, call } = await setup(1);
      await hub.turn(child.id, 'replied');
      const taken = await call(tool, { subtask_ids: [child.id] });
      expect(taken.subtasks, tool).toEqual([expect.objectContaining({ result: '<结果>' })]);
      expect(taken.subtasks[0], tool).not.toHaveProperty('destroyed');
      await advance(61 * MINUTE);
      expect(exists(hub, child.id), tool).toBe(false);
      expect(reports(hub, parent.id), tool).toEqual([]);
      expect(await hub.reminder(parent.id), tool).toBeUndefined();

      const again = await hub.sm.createChildSession(parent.id, { name: '<又一个>' });
      await hub.turn(again.id, 'replied');
      await call(tool, { subtask_ids: [again.id] });
      await call('send_to_subtask', { subtask_id: again.id, message: '<追问>' });
      await hub.turn(again.id, 'error', { error: '<原因>' });
      await advance(61 * MINUTE);
      expect(exists(hub, again.id), tool).toBe(false);
      expect(reports(hub, parent.id), tool).toEqual([expect.objectContaining({ id: again.id, status: 'error' })]);
      vi.useRealTimers();
    }
  });

  it('写回报的这一拍里 check_subtask 取走了结果：子会话照常销毁，回报不留在父会话记录上、提醒不再列出', async () => {
    const { hub, parent, child, call } = await setup(0);
    let checked: Record<string, unknown> | undefined;
    hub.host.events.use.on('session:updated', async session => {
      if (checked || session.id !== parent.id || reports(hub, parent.id).length === 0) return;
      checked = await call('check_subtask', { subtask_ids: [child.id] });
    });
    await hub.turn(child.id, 'replied');
    await advance(0);
    expect(checked?.subtasks).toEqual([expect.objectContaining({ id: child.id, result: '<结果>' })]);
    expect(exists(hub, child.id)).toBe(false);
    expect(reports(hub, parent.id)).toEqual([]);
    expect(await hub.reminder(parent.id)).toBeUndefined();
  });

  it('出错的子任务回报带原因', async () => {
    const { hub, parent, child } = await setup(0);
    await hub.turn(child.id, 'error', { error: '<原因>' });
    await advance(0);
    expect(reports(hub, parent.id)).toEqual([expect.objectContaining({ status: 'error', reason: '<原因>' })]);
    expect(reports(hub, parent.id)[0]).not.toHaveProperty('result');
  });

  it('wait_subtasks：销毁之后取回报一次', async () => {
    const { hub, child, call } = await setup(0);
    await hub.turn(child.id, 'replied');
    await advance(0);
    const waited = await call('wait_subtasks', { subtask_ids: [child.id] });
    expect(waited).toMatchObject({
      allCompleted: true,
      timedOut: false,
      subtasks: [{ id: child.id, status: 'completed', result: '<结果>', completed: true, destroyed: true }],
    });
    expect((await call('wait_subtasks', { subtask_ids: [child.id] })).subtasks).toEqual([
      { id: child.id, error: NOT_FOUND },
    ]);
  });

  it('wait_subtasks 等着时子会话交回结果、随即销毁（0）：等到的结果不丢', async () => {
    const { hub, child, call } = await setup(0);
    vi.useRealTimers();
    const waiting = call('wait_subtasks', { subtask_ids: [child.id] });
    await hub.turn(child.id, 'replied');
    expect(await waiting).toMatchObject({
      allCompleted: true,
      subtasks: [{ id: child.id, result: '<结果>', completed: true }],
    });
  });

  it('父会话提醒：列出它的那一轮里每次调用都列出，那一轮结束后删、下一轮不再出现；干跑不算列出', async () => {
    const { hub, parent, child } = await setup(0);
    await hub.turn(child.id, 'replied');
    await advance(0);
    expect(hub.sm.getSession(parent.id)?.children).toEqual([]);

    expect(await hub.reminder(parent.id, true)).toContain('<子任务>');
    await hub.turn(parent.id, 'replied', { source: 'webui-user' });
    expect(reports(hub, parent.id)).toHaveLength(1);

    const seen: Array<string | undefined> = [];
    await hub.turn(parent.id, 'replied', {
      source: 'webui-user',
      during: async () => {
        seen.push(await hub.reminder(parent.id), await hub.reminder(parent.id));
      },
    });
    for (const text of seen) {
      expect(text).toContain('<子任务>');
      expect(text).toContain('<结果>');
      expect(text).toContain('销毁');
    }
    expect(reports(hub, parent.id)).toEqual([]);
    expect(await hub.reminder(parent.id)).toBeUndefined();
  });

  it('delete_subtask 与父会话清空连带的删除不写回报', async () => {
    const { hub, parent, child, call } = await setup(24);
    const other = await hub.sm.createChildSession(parent.id, { name: '<另一个>' });
    await call('delete_subtask', { subtask_id: child.id });
    const data: HookContextMap['memory:clear'] = { scope: 'session', sessionId: parent.id, results: [] };
    await hub.hooks.use.run('memory:clear', data, async () => {
      data.results.push({ source: 'memory', type: 'context', success: true, message: '<已清空>' });
    });
    expect(exists(hub, other.id)).toBe(false);
    expect(reports(hub, parent.id)).toEqual([]);
  });

  it('父会话清空时回报一并清掉；消息历史没清成时不清；全部清空时清掉所有会话上的', async () => {
    const { hub, parent, child } = await setup(0);
    await hub.turn(child.id, 'replied');
    await advance(0);
    const clear = (scope: 'session' | 'all', success: boolean) => {
      const data: HookContextMap['memory:clear'] = {
        scope,
        ...(scope === 'session' ? { sessionId: parent.id } : {}),
        results: [],
      };
      return hub.hooks.use.run('memory:clear', data, async () => {
        data.results.push({ source: 'memory', type: 'context', success, message: '<结果>' });
      });
    };
    await clear('session', false);
    expect(reports(hub, parent.id)).toHaveLength(1);
    await clear('session', true);
    expect(reports(hub, parent.id)).toEqual([]);

    const another = await hub.sm.createChildSession(parent.id, { name: '<又一个>' });
    await hub.turn(another.id, 'replied');
    await advance(0);
    expect(reports(hub, parent.id)).toHaveLength(1);
    await clear('all', true);
    expect(reports(hub, parent.id)).toEqual([]);
  });
});
