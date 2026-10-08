import { afterEach, describe, expect, it } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { sessionManager } from '../../packages/api-session-manager/src/index.js';
import { tools } from '../../packages/api-tools/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 子会话与根会话同一套收口：最后一轮出错收口为 error，被停止收口为 completed、从 lastTurn 看出。
// 父会话的 wait_subtasks 随即返回，不等到超时；check_subtask、wait_subtasks 与父会话的子任务提醒
// 把被停止的报成「已停止」（stopped），不算完成；出错的三处都带出 lastTurn 里的原因。
// ════════════════════════════════════════════════════════════

type Outcome = HookContextMap['agent:turn:after']['outcome'];
type Handler = (args: Record<string, unknown>, callCtx: Record<string, unknown>) => Promise<string>;

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, sessionManager });
  host.provide(memory, fakeMemory() as never);
  const handlers = new Map<string, Handler>();
  host.provide(tools, {
    register(tool: { definition: { function: { name: string } }; handler: Handler }) {
      handlers.set(tool.definition.function.name, tool.handler);
      return () => void handlers.delete(tool.definition.function.name);
    },
    registerGroup: () => () => {},
  } as never);
  await app.plugin(sessionManagerPlugin);
  await app.plugin(subtask, {});
  await app.plugins.idle();
  for (const name of [sessionManagerPlugin.name, subtask.name]) {
    const state = app.plugins.getPlugin(name)?.state;
    if (state !== 'active') throw new Error(`${name} 未激活（state=${state}）`);
  }
  const sm = host.sessionManager.require();
  const parent = await sm.createSession({ name: '<父会话>' });
  const ctx = { sessionId: parent.id, platform: 'webui', userId: 'console' };
  const call = async (tool: string, args: Record<string, unknown>) => JSON.parse(await handlers.get(tool)!(args, ctx));

  let turns = 0;
  /** 子会话跑一轮，按 agent 的顺序发回合结束；during 在这一轮结束前跑（同一会话并行的另一轮） */
  const turn = (sessionId: string, outcome: Outcome, error?: string, during?: () => Promise<unknown>) => {
    const message = { content: '<任务>', sessionId, platform: 'webui' };
    const turnId = `t${++turns}`;
    return host.hooks.run('agent:input:before', { message, turnId, metadata: {} }, async () => {
      await during?.();
      await host.hooks.run('agent:turn:after', {
        message,
        reply: outcome === 'replied' ? '<结果>' : '',
        outcome,
        ...(error === undefined ? {} : { error }),
        sessionId,
        turnId,
        metadata: {},
      });
    });
  };

  /** 父会话下一次请求模型时插入的子任务提醒 */
  const reminder = async () => {
    const messages: Message[] = [
      { role: 'system', content: '<人设>' },
      { role: 'user', content: '<提问>' },
    ];
    await host.hooks.run('agent:llm:before', { messages, tools: [], sessionId: parent.id });
    return messages.find(m => m.metadata?.injector === 'subtask/parent-status')?.content as string | undefined;
  };

  return { sm, parent, call, turn, reminder };
}

/** wait_subtasks 在 ms 毫秒内返回了没有：没返回为 'pending' */
const within = <T>(promise: Promise<T>, ms = 200) =>
  Promise.race([promise, new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), ms))]);

describe('子会话收口后父会话的等待随即返回', () => {
  it('被停止：报 stopped（已停止），不算完成、也不算超时；check_subtask 与子任务提醒同样报已停止', async () => {
    const { sm, parent, call, turn, reminder } = await setup();
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });

    const waiting = call('wait_subtasks', { subtask_ids: [child.id] });
    await turn(child.id, 'aborted');
    const waited = await within(waiting);

    expect(waited).toMatchObject({
      allCompleted: false,
      timedOut: false,
      subtasks: [{ id: child.id, status: 'stopped', completed: false }],
    });
    const checked = await call('check_subtask', { subtask_ids: [child.id] });
    expect(checked.subtasks[0]).toMatchObject({ status: 'stopped', statusLabel: '已停止' });
    expect(checked.summary).toEqual({ total: 1, active: 0, completed: 0, errored: 0, stopped: 1 });
    expect(checked.subtasks[0]).not.toHaveProperty('reason');
    expect(waited.subtasks[0]).not.toHaveProperty('reason');
    const text = await reminder();
    expect(text).toContain('[已停止] <子任务>');
    expect(text).not.toContain('[已完成]');
  });

  it('出错：报 error，不算完成、也不算超时；wait_subtasks、check_subtask 与子任务提醒都带出原因', async () => {
    const { sm, parent, call, turn, reminder } = await setup();
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });

    const waiting = call('wait_subtasks', { subtask_ids: [child.id] });
    await turn(child.id, 'error', '<原因>');

    expect(await within(waiting)).toMatchObject({
      allCompleted: false,
      timedOut: false,
      subtasks: [{ id: child.id, status: 'error', completed: false, reason: '<原因>' }],
    });
    const checked = await call('check_subtask', { subtask_ids: [child.id] });
    expect(checked.subtasks[0]).toMatchObject({ status: 'error', statusLabel: '出错', reason: '<原因>' });
    expect(checked.summary).toEqual({ total: 1, active: 0, completed: 0, errored: 1, stopped: 0 });
    expect(await reminder()).toContain(`[出错] <子任务> (ID: ${child.id}): <原因>`);
  });

  it('出错但没有原因：不带 reason，提醒写无错误详情，不拿上一轮的结果充当错误详情', async () => {
    const { sm, parent, call, turn, reminder } = await setup();
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });
    await turn(child.id, 'replied');
    await turn(child.id, 'error');

    const waited = await call('wait_subtasks', { subtask_ids: [child.id] });
    expect(waited.subtasks[0]).toMatchObject({ status: 'error' });
    expect(waited.subtasks[0]).not.toHaveProperty('reason');
    const checked = await call('check_subtask', { subtask_ids: [child.id] });
    expect(checked.subtasks[0]).not.toHaveProperty('reason');
    expect(await reminder()).toContain(`[出错] <子任务> (ID: ${child.id}): (无错误详情)`);
  });

  it('正常回复：照旧由子任务以回复为结果收口为 completed', async () => {
    const { sm, parent, call, turn } = await setup();
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });

    const waiting = call('wait_subtasks', { subtask_ids: [child.id] });
    await turn(child.id, 'replied');

    expect(await within(waiting)).toMatchObject({
      allCompleted: true,
      timedOut: false,
      subtasks: [{ id: child.id, status: 'completed', completed: true, result: '<结果>' }],
    });
  });

  it('最后结束的一轮出错、会话已由并行的另一轮收口为完成：报 completed，不带 reason', async () => {
    const { sm, parent, call, turn } = await setup();
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });
    await turn(child.id, 'error', '<原因>', () => turn(child.id, 'replied'));
    expect(sm.getSession(child.id)).toMatchObject({ status: 'completed', lastTurn: { error: '<原因>' } });

    const waited = await call('wait_subtasks', { subtask_ids: [child.id] });
    expect(waited.subtasks[0]).toMatchObject({ status: 'completed' });
    expect(waited.subtasks[0]).not.toHaveProperty('reason');
    const checked = await call('check_subtask', { subtask_ids: [child.id] });
    expect(checked.subtasks[0]).toMatchObject({ status: 'completed' });
    expect(checked.subtasks[0]).not.toHaveProperty('reason');
  });

  it('等满时还在跑的报超时', async () => {
    const { sm, parent, call } = await setup();
    const child = await sm.createChildSession(parent.id, { name: '<子任务>' });

    expect(await call('wait_subtasks', { subtask_ids: [child.id], timeout_seconds: 0.05 })).toMatchObject({
      allCompleted: false,
      timedOut: true,
      subtasks: [{ id: child.id, status: 'active', completed: false }],
    });
  });
});
