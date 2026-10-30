import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookContextMap } from '../../packages/api-hooks/src/index.js';
import { type BackgroundTask, type BackgroundTaskStatus, backgroundTasks } from '../../packages/api-tools/src/index.js';
import { type App, definePlugin, type PluginDefinition, provide } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import { type SubtaskHub, startSubtaskHub } from '../fixtures/subtask.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 子会话的到期销毁：子会话的一轮结束（回复、出错、被停止都算）满 idleDeleteHours 就删掉，追问在下一轮结束时重新计时，从没跑过
// 一轮的不计时；在飞的一轮与发出还没落定的追问由子任务插件自己记，不看会话状态。追问经网关送达、不等，在它落定时（所在的一轮
// 结束、被放掉、在网关相位被挡下）去掉记下的；子任务那一轮结束时还有没落定的追问，这一轮的回复不交回、不完成，等追问那一轮。
// 子会话有在跑的后台任务时同样不删：正常结束的由结束通知开的那一轮收尾时重新计时，被停止、中断的（不发结束通知）结束时按最近
// 一轮重判。删除只在定时器里做，延时截到 24 小时、到点重判；
// 插件重载之后按会话记录上的 lastTurn.endedAt 补删或重排。销毁之前把回报（名字、状态、原因、结果、任务）写进父会话记录，
// check_subtask、wait_subtasks 读到即删，父会话提醒列出它的那一轮回复或静默收尾后删（出错、被停止的一轮留着，下一轮照常
// 列出）；父会话清空时一并清掉。已删的子会话收到还没开跑的
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

async function setup(idleDeleteHours: number, plugins: PluginDefinition[] = []) {
  const hub = await startSubtaskHub({ config: { idleDeleteHours }, plugins });
  apps.push(hub.app);
  const parent = await hub.sm.createSession({ name: '<父会话>' });
  const child = await hub.sm.createChildSession(parent.id, { name: '<子任务>', inputContext: '<任务>' });
  const ctx = { sessionId: parent.id, platform: 'webui', userId: 'console' };
  const call = (tool: string, args: Record<string, unknown>) => hub.call(tool, args, ctx);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return { hub, parent, child, call };
}

const exists = (hub: SubtaskHub, id: string) => hub.sm.getSession(id) !== undefined;

/** 后台任务登记的替身：列出用例摆上的任务 */
const backgroundPlugin = (tasks: BackgroundTask[]) =>
  definePlugin({
    name: 'zz-background',
    provides: [backgroundTasks],
    uses: { provide },
    apply: ({ provide }) => {
      provide.use(backgroundTasks, {
        list: ({ sessionId } = {}) => tasks.filter(task => sessionId === undefined || task.sessionId === sessionId),
        output: () => undefined,
        stop: async () => undefined,
      });
    },
  });

/** 子会话里转到后台、在跑的一个任务 */
const runningTask = (sessionId: string): BackgroundTask => ({
  id: 'bg_1',
  sessionId,
  kind: 'tool-call',
  label: '<命令>',
  call: { tool: '<命令>', args: {}, turnId: '<回合>', callId: '<调用>' },
  status: 'running',
  startedAt: Date.now(),
});
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
    await hub.followUp('replied');
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

  it('追问排在在跑的一轮之后：那一轮先收口、追问还没落定时不删；追问那一轮结束后照常销毁', async () => {
    const { hub, child, call } = await setup(0);
    await hub.turn(child.id, 'replied', {
      during: () => call('send_to_subtask', { subtask_id: child.id, message: '<追问>' }),
    });
    await advance(HOUR);
    expect(exists(hub, child.id)).toBe(true);
    await hub.followUp('replied');
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
    await hub.followUp('replied');
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

  it('有在跑的后台任务时不删：交回「已转后台」之后闲置到期也留着；结束通知那一轮收尾后重新计时', async () => {
    const tasks: BackgroundTask[] = [];
    const { hub, child } = await setup(1, [backgroundPlugin(tasks)]);
    await hub.turn(child.id, 'replied', {
      reply: '<已在后台跑>',
      during: async () => void tasks.push(runningTask(child.id)),
    });
    await advance(2 * HOUR);
    expect(exists(hub, child.id)).toBe(true);
    tasks[0] = { ...tasks[0], status: 'completed' };
    await hub.turn(child.id, 'replied', { source: 'bg:bg_1' });
    await advance(59 * MINUTE);
    expect(exists(hub, child.id)).toBe(true);
    await advance(2 * MINUTE);
    expect(exists(hub, child.id)).toBe(false);
  });

  it.each<BackgroundTaskStatus>([
    'stopped',
    'aborted',
  ])('后台任务结束为 %s（不发结束通知）：结束时按最近一轮重判到期', async status => {
    const tasks: BackgroundTask[] = [];
    const { hub, child } = await setup(1, [backgroundPlugin(tasks)]);
    await hub.turn(child.id, 'replied', { during: async () => void tasks.push(runningTask(child.id)) });
    await advance(2 * HOUR);
    expect(exists(hub, child.id)).toBe(true);
    tasks[0] = { ...tasks[0], status };
    await hub.host.events.use.emit('background:changed', { task: tasks[0] });
    await advance(0);
    expect(exists(hub, child.id)).toBe(false);
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

describe('追问经网关送达', () => {
  it('子任务那一轮结束时还有没落定的追问：这一轮的回复不交回、不完成，等着它的 wait_subtasks 不返回；追问那一轮的回复交回', async () => {
    const { hub, child, call } = await setup(24);
    vi.useRealTimers();
    let waited: { subtasks: Array<{ status: string; result: string | null }> } | undefined;
    await hub.turn(child.id, 'replied', {
      during: async () => {
        await call('send_to_subtask', { subtask_id: child.id, message: '<追问>' });
        void call('wait_subtasks', { subtask_ids: [child.id], timeout_seconds: 30 }).then(r => (waited = r));
      },
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(hub.sm.getSession(child.id)?.result, '旧的一轮的回复不交回').toBeUndefined();
    expect(waited, '追问还没落定，wait_subtasks 不返回').toBeUndefined();
    expect(await call('check_subtask', { subtask_ids: [child.id] })).toMatchObject({
      subtasks: [{ status: 'active' }],
    });
    await hub.followUp('replied');
    await vi.waitFor(() => expect(waited).toBeDefined());
    expect(waited?.subtasks[0]).toMatchObject({ status: 'completed', result: '<结果>' });
  });

  it('追问那一轮里起的异步工作之后开的一轮不算追问开的：那时还有没落定的追问，它的回复不交回、不完成', async () => {
    const { hub, child, call } = await setup(24);
    await hub.turn(child.id, 'replied');
    await call('send_to_subtask', { subtask_id: child.id, message: '<追问一>' });
    const later = deferred();
    let notice: Promise<boolean> | undefined;
    await hub.followUp('replied', {
      // 追问一那一轮里排下的工作（如转后台的工具）继承它的异步上下文，追问一落定之后才开一轮（结束通知），这一轮里又来了追问二
      during: async () => {
        notice = later.promise.then(() =>
          hub.turn(child.id, 'replied', {
            source: 'bg:1',
            reply: '<通知那一轮的回复>',
            during: () => call('send_to_subtask', { subtask_id: child.id, message: '<追问二>' }),
          }),
        );
      },
    });
    later.resolve();
    await notice;
    expect(hub.sm.getSession(child.id)?.result, '追问二还没落定，通知那一轮的回复不交回').toBe('<结果>');
    expect(await call('check_subtask', { subtask_ids: [child.id] })).toMatchObject({
      subtasks: [{ status: 'active' }],
    });
  });

  it('追问在网关相位被挡下（没开轮就落定）同样去掉记下的：到期照常销毁', async () => {
    const { hub, child, call } = await setup(0);
    await hub.turn(child.id, 'replied');
    await call('send_to_subtask', { subtask_id: child.id, message: '<追问>' });
    await advance(HOUR);
    expect(exists(hub, child.id), '追问还没落定').toBe(true);
    await hub.dropFollowUp();
    await advance(0);
    expect(exists(hub, child.id)).toBe(false);
  });

  it('那一轮结束、追问还没落定时，父会话提醒与 check_subtask 一样按进行中列出（会话管理已把它收口成已完成）', async () => {
    const { hub, parent, child, call } = await setup(24);
    await hub.turn(child.id, 'replied', {
      during: () => call('send_to_subtask', { subtask_id: child.id, message: '<追问>' }),
    });
    expect(hub.sm.getSession(child.id)?.status).toBe('completed');
    const reminded = await hub.reminder(parent.id);
    expect(reminded).toContain('[进行中] <子任务>');
    expect(reminded).not.toContain('[已完成]');
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
      await hub.followUp('error', { error: '<原因>' });
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

  /** 子任务交回结果后随即销毁（0），父会话跑一轮、其间的提醒列出它；返回那次提醒 */
  async function listedIn(outcome: HookContextMap['agent:turn:after']['outcome']) {
    const { hub, parent, child, call } = await setup(0);
    await hub.turn(child.id, 'replied');
    await advance(0);
    let seen: string | undefined;
    await hub.turn(parent.id, outcome, {
      source: 'webui-user',
      during: async () => {
        seen = await hub.reminder(parent.id);
      },
    });
    expect(seen).toContain('<结果>');
    return { hub, parent, child, call };
  }

  it.each<HookContextMap['agent:turn:after']['outcome']>([
    'error',
    'aborted',
  ])('列出它的那一轮以 %s 收尾：回报留着，下一轮照常列出，check_subtask 取得到', async outcome => {
    const { hub, parent, child, call } = await listedIn(outcome);
    expect(await hub.reminder(parent.id)).toContain('<结果>');
    expect((await call('check_subtask', { subtask_ids: [child.id] })).subtasks).toEqual([
      expect.objectContaining({ id: child.id, result: '<结果>', destroyed: true }),
    ]);
  });

  it('列出它的那一轮静默收尾：与回复了一样，那一轮结束后删', async () => {
    const { hub, parent } = await listedIn('silent');
    expect(reports(hub, parent.id)).toEqual([]);
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
