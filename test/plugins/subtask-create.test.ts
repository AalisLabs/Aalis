import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../packages/core/src/index.js';
import subtask from '../../packages/plugin-subtask/src/index.js';
import { recordRoom } from '../fixtures/rooms.js';
import { startSubtaskHub } from '../fixtures/subtask.js';

// ════════════════════════════════════════════════════════════
// create_subtask 建子会话：建之前取会话设置管理面的 childMetadata 并进 metadata，子会话一出现就带着写下的父会话此刻的设置；
// 子会话的对话模型 = 工具参数 model（条目 id）› 父会话此刻生效的子任务模型（本插件的按会话字段）› 父会话此刻的对话模型（随
// childMetadata 写下），前两项有值时建好之后、派发首条消息之前调 agent 的 assignModel 压过写下的那个。会话设置不在、要指定
// 模型而 agent 不在时不建；assignModel 抛错时删掉刚建的子会话。任务名写在 title 上，metadata 不写 platform、title。
// ════════════════════════════════════════════════════════════

const ROOM = 'onebot:10000:group:20001';
const WINDOW = 'onebot:group:20001';
const CTX = { sessionId: ROOM, platform: 'onebot', userId: '30001' };

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

async function setup(opts: Parameters<typeof startSubtaskHub>[0] = {}) {
  const hub = await startSubtaskHub(opts);
  apps.push(hub.app);
  await recordRoom(hub.host.events.use, ROOM, '群');
  hub.order.splice(0);
  hub.dispatched.splice(0);
  return hub;
}

describe('create_subtask：子会话带着写下的设置出生', () => {
  it('派发首条消息时子会话已带着父会话此刻的设置；任务名写在 title 上，metadata 不写 platform、title', async () => {
    const hub = await setup();
    await hub.admin.update({ sessionId: ROOM }, { plugin: 'zz-agent', key: 'persona', value: '<父会话的人设>' });
    const created = await hub.call('create_subtask', { task: '<任务>', name: '<任务名>' }, CTX);

    const child = hub.sm.getSession(created.subtaskId);
    expect(child).toMatchObject({ parentId: ROOM, name: '<任务名>', title: '<任务名>', inputContext: '<任务>' });
    expect(Object.keys(child?.metadata ?? {})).toEqual(['session-settings']);
    expect(hub.dispatched).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ sessionId: created.subtaskId, source: 'subtask' }),
        settings: expect.objectContaining({ persona: '<父会话的人设>' }),
      }),
    ]);
    expect((await hub.admin.rows({ sessionId: created.subtaskId })).find(row => row.key === 'persona')).toMatchObject({
      source: 'session',
      value: '<父会话的人设>',
    });
  });

  it('会话设置不在：回错误、不建子会话', async () => {
    const hub = await setup({ withoutSettings: true });
    const reply = await hub.call('create_subtask', { task: '<任务>' }, CTX);
    expect(reply.error).toContain('会话设置');
    expect(hub.sm.getSession(ROOM)?.children).toEqual([]);
    expect(hub.dispatched).toEqual([]);
  });
});

describe('create_subtask：子会话的模型', () => {
  it('工具参数 model 写条目 id：模型 id 里的斜杠留在模型里，先 assignModel 再派发，压过写下的父会话模型', async () => {
    const hub = await setup();
    await hub.admin.update(
      { sessionId: ROOM },
      { plugin: 'zz-agent', key: 'llm', value: { provider: 'p-parent', model: 'm' } },
    );
    const created = await hub.call('create_subtask', { task: '<任务>', model: 'p-relay/vendor/m-1' }, CTX);

    expect(hub.order).toEqual([`assign ${created.subtaskId}`, `dispatch ${created.subtaskId}`]);
    expect(hub.dispatched[0].settings?.llm).toEqual({ provider: 'p-relay', model: 'vendor/m-1' });
    expect(hub.agentFields.reader().get(created.subtaskId).llm).toEqual({ provider: 'p-relay', model: 'vendor/m-1' });
  });

  it('npm 作用域的提供者实例 id 拆得对', async () => {
    const hub = await setup();
    const created = await hub.call('create_subtask', { task: '<任务>', model: '@scope/provider/m' }, CTX);
    expect(hub.agentFields.reader().get(created.subtaskId).llm).toEqual({ provider: '@scope/provider', model: 'm' });
  });

  it('model 拆不出：回错误、不建', async () => {
    const hub = await setup();
    const reply = await hub.call('create_subtask', { task: '<任务>', model: 'no-slash' }, CTX);
    expect(reply.error).toContain('model');
    expect(hub.sm.getSession(ROOM)?.children).toEqual([]);
  });

  it('子任务模型按父会话解析：群的场所单独设了就用它；工具参数压过它', async () => {
    const hub = await setup();
    await hub.admin.update(
      { layer: { scope: 'place', key: WINDOW } },
      { plugin: subtask.name, key: 'model', value: { provider: 'p-cheap', model: 'm' } },
    );
    const byField = await hub.call('create_subtask', { task: '<任务>' }, CTX);
    expect(hub.agentFields.reader().get(byField.subtaskId).llm).toEqual({ provider: 'p-cheap', model: 'm' });

    const byArg = await hub.call('create_subtask', { task: '<任务>', model: 'p-arg/m' }, CTX);
    expect(hub.agentFields.reader().get(byArg.subtaskId).llm).toEqual({ provider: 'p-arg', model: 'm' });
  });

  it('都没指定：不调 assignModel，子会话用随设置写下的父会话模型', async () => {
    const hub = await setup();
    await hub.admin.update(
      { sessionId: ROOM },
      { plugin: 'zz-agent', key: 'llm', value: { provider: 'p-parent', model: 'm' } },
    );
    const created = await hub.call('create_subtask', { task: '<任务>' }, CTX);
    expect(hub.order).toEqual([`dispatch ${created.subtaskId}`]);
    expect(hub.agentFields.reader().get(created.subtaskId).llm).toEqual({ provider: 'p-parent', model: 'm' });
  });

  it('要指定模型而 agent 不在：回错误、不建；不指定时照常建', async () => {
    const hub = await setup({ withoutAgent: true });
    const reply = await hub.call('create_subtask', { task: '<任务>', model: 'p/m' }, CTX);
    expect(reply.error).toContain('agent');
    expect(hub.sm.getSession(ROOM)?.children).toEqual([]);
    expect((await hub.call('create_subtask', { task: '<任务>' }, CTX)).subtaskId).toBeTruthy();
  });

  it('assignModel 抛错：删掉刚建的子会话、回错误，不派发', async () => {
    const hub = await setup({ assignFails: true });
    const reply = await hub.call('create_subtask', { task: '<任务>', model: 'p/m' }, CTX);
    expect(reply.error).toContain('<写不进>');
    expect(hub.sm.getSession(ROOM)?.children).toEqual([]);
    expect(hub.sm.listSessions().filter(s => s.parentId !== undefined)).toEqual([]);
    expect(hub.dispatched).toEqual([]);
  });
});

describe('子任务插件的配置', () => {
  it('子任务模型是按会话字段（全部房间与 owner 会话，1 级可改），交回后闲置销毁是普通配置，默认 24 小时', () => {
    const schema = subtask.configSchema as unknown as Record<string, Record<string, unknown>>;
    expect(schema.model).toMatchObject({
      type: 'llm-ref',
      session: { appliesTo: ['owner', 'room'], prominence: 'advanced', minLevel: 1 },
    });
    expect(schema.model).not.toHaveProperty('default');
    expect(schema.idleDeleteHours).toMatchObject({ type: 'number', min: 0, default: 24 });
    expect(schema.idleDeleteHours).not.toHaveProperty('session');
    expect(schema.idleDeleteHours).not.toHaveProperty('max');
    expect(schema).not.toHaveProperty('defaultProvider');
    expect(schema).not.toHaveProperty('defaultModel');
  });
});
