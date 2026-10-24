import { afterEach, describe, expect, it } from 'vitest';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { isUnfiled, sessionManager } from '../../packages/api-session-manager/src/index.js';
import { App, definePlugin, events, provide } from '../../packages/core/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { toSource } from '../../packages/schema-i18n/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// ════════════════════════════════════════════════════════════
// 会话树：删除会话先从表里摘掉并发 session:deleted，再清它的数据（监听方在事件里还看得到数据没清）；开始删除的同一步换这个
// 会话的代号，删过的 id 之后再建档也不换回去。会话的消息历史被清空（memory:clear 没指定类型或类型含 context，且消息历史那一行
// 清成功）时它的子会话一并删除：范围为 session 删这个会话的，为 all 删全部子会话，结果里加一行「已删除 N 个子会话」；只清别的
// 类型、消息历史没清成、删除会话自己触发的清理都不删。场所记录带插件的 metadata，经 updatePlace 合并式改；listPlaces 默认工作区
// 在前。建会话时 metadata 里的 title、inputContext 不当成同名字段。
// ════════════════════════════════════════════════════════════

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

type Clear = HookContextMap['memory:clear'];

async function setup(places: Record<string, Record<string, unknown>> = {}) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const order: string[] = [];
  const mem = fakeMemory({}, places);
  mem.clearSession = async () => void order.push('clear');
  const host = app.bind({ provide, events, hooks, sessionManager });
  host.provide.use(memory, mem as never);
  await app.plugin(sessionManagerPlugin);
  await app.plugins.idle();
  const sm = host.sessionManager.use;
  /** 像 /clear 那样跑一次 memory:clear：默认动作写下消息历史那一行（type 为 context），成败由 ok 定 */
  const clear = async (data: Omit<Clear, 'results'>, ok = true) => {
    const run: Clear = { ...data, results: [] };
    await host.hooks.use.run('memory:clear', run, async () => {
      run.results.push({ source: 'memory', type: 'context', success: ok, message: '<消息历史>' });
    });
    return run.results;
  };
  return { app, host, sm, mem, order, clear };
}

describe('删除会话', () => {
  it('先发 session:deleted 再清数据：监听里会话已不在表里、数据还没清', async () => {
    const { host, sm, order } = await setup();
    const { id } = await sm.createSession({ name: '<会话>' });
    host.events.use.on('session:deleted', deleted => {
      order.push(`deleted:${deleted}`);
      expect(sm.getSession(deleted)).toBeUndefined();
    });
    await sm.deleteSession(id);
    expect(order).toEqual([`deleted:${id}`, 'clear']);
  });

  it('代号：开始删除的同一步换（带子会话的不等删完子会话），删完同一 id 再建档也不换回去；连带删掉的子会话各自换，别的会话不变', async () => {
    const { sm } = await setup();
    const parent = await sm.createSession({ name: '<父会话>' });
    const child = await sm.createSession({ parentId: parent.id });
    const other = await sm.createSession({ name: '<另一个会话>' });
    const before = new Map([parent, child, other].map(({ id }) => [id, sm.generationOf(id)]));
    const deleting = sm.deleteSession(parent.id);
    expect(sm.generationOf(parent.id), '开始删除的同一步就换了').not.toBe(before.get(parent.id));
    expect(sm.generationOf(child.id), '子会话在开始删它的同一步换').not.toBe(before.get(child.id));
    await deleting;
    expect(sm.generationOf(parent.id), '删完之后不换回去').not.toBe(before.get(parent.id));
    expect(sm.generationOf(other.id), '别的会话不变').toBe(before.get(other.id));
    const deleted = sm.generationOf(parent.id);
    await sm.ensureSession(parent.id);
    expect(sm.generationOf(parent.id), '同一 id 再建档不换').toBe(deleted);
  });
});

describe('清空连带删除子会话', () => {
  async function tree() {
    const ctx = await setup();
    const parent = await ctx.sm.createSession({ name: '<父会话>' });
    const other = await ctx.sm.createSession({ name: '<另一个会话>' });
    const childA = await ctx.sm.createSession({ parentId: parent.id });
    const grandchild = await ctx.sm.createSession({ parentId: childA.id });
    const childB = await ctx.sm.createSession({ parentId: other.id });
    return { ...ctx, parent, other, childA, grandchild, childB };
  }

  it('清这个会话的消息历史：删掉它的子会话（连同孙会话），结果里加一行；别的会话的子会话不动', async () => {
    const { sm, clear, parent, childA, grandchild, childB } = await tree();
    const results = await clear({ scope: 'session', sessionId: parent.id });
    expect(sm.getSession(childA.id)).toBeUndefined();
    expect(sm.getSession(grandchild.id)).toBeUndefined();
    expect(sm.getSession(childB.id)).toBeDefined();
    expect(sm.getSession(parent.id)?.children).toEqual([]);
    const row = results.find(r => r.source !== 'memory');
    expect(row).toMatchObject({ type: 'context', success: true });
    expect(toSource(row!.message)).toContain('2');
  });

  it('「已删除 N 个子会话」按实际删掉的会话算：删除途中别处建了会话，N 照样对', async () => {
    const { host, sm, clear, parent } = await tree();
    host.events.use.on('session:deleted', async () => {
      await sm.createSession({ name: '<途中建的会话>' });
    });
    const results = await clear({ scope: 'session', sessionId: parent.id });
    const row = results.find(r => r.source !== 'memory');
    expect(row && toSource(row.message)).toContain('2');
  });

  it('/clear all：删掉全部子会话', async () => {
    const { sm, clear, parent, other, childA, childB } = await tree();
    await clear({ scope: 'all' });
    expect(sm.getSession(childA.id)).toBeUndefined();
    expect(sm.getSession(childB.id)).toBeUndefined();
    expect(sm.getSession(parent.id)).toBeDefined();
    expect(sm.getSession(other.id)).toBeDefined();
  });

  it('没有子会话时不加那一行；只清别的类型、消息历史没清成时不删', async () => {
    const { sm, clear, other, parent, childA } = await tree();
    const lone = await sm.createSession({ name: '<没有子会话>' });
    expect((await clear({ scope: 'session', sessionId: lone.id })).map(r => r.source)).toEqual(['memory']);
    await clear({ scope: 'session', sessionId: parent.id, types: ['image'] });
    expect(sm.getSession(childA.id)).toBeDefined();
    await clear({ scope: 'session', sessionId: parent.id }, false);
    expect(sm.getSession(childA.id)).toBeDefined();
    expect(sm.getSession(other.id)?.children).toHaveLength(1);
  });

  it('删除会话自己触发的那次清理不删别的会话：删掉一个子会话，它的兄弟留着', async () => {
    const { sm, parent, childA } = await tree();
    const sibling = await sm.createSession({ parentId: parent.id });
    await sm.deleteSession(childA.id);
    expect(sm.getSession(sibling.id)).toBeDefined();
    expect(sm.getSession(parent.id)?.children).toEqual([sibling.id]);
  });
});

describe('场所记录', () => {
  const place = (key: string, fields: Record<string, unknown> = {}) => ({
    key,
    kind: key.startsWith('workspace:') ? 'workspace' : 'window',
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  });

  it('updatePlace 合并式改 metadata（顶层键整键替换）并落盘；没有这个键的记录抛错', async () => {
    const { sm, mem } = await setup({ 'onebot:group:1': place('onebot:group:1', { metadata: { a: 1, b: { x: 1 } } }) });
    await sm.updatePlace('onebot:group:1', { metadata: { b: { y: 2 } } });
    expect(sm.getPlace('onebot:group:1')?.metadata).toEqual({ a: 1, b: { y: 2 } });
    await expect.poll(() => mem.places.get('onebot:group:1')?.metadata).toEqual({ a: 1, b: { y: 2 } });
    await expect(sm.updatePlace('workspace:<没有>', { metadata: {} })).rejects.toThrow();
  });

  it('listPlaces：默认工作区在前，其余按键排；没有 config 字段的记录照常载入，metadata 不是对象的去掉', async () => {
    const { sm } = await setup({
      'onebot:group:2': place('onebot:group:2'),
      'onebot:group:1': place('onebot:group:1', { metadata: '<不是对象>' }),
    });
    expect(sm.listPlaces().map(p => p.key)).toEqual(['workspace:default', 'onebot:group:1', 'onebot:group:2']);
    expect(sm.getPlace('onebot:group:1')?.metadata).toBeUndefined();
  });
});

describe('会话字段', () => {
  it('建会话时 metadata 里的 title、inputContext 不当成同名字段读', async () => {
    const { sm } = await setup();
    const child = await sm.createSession({ metadata: { title: '<元数据标题>', inputContext: '<元数据指令>' } });
    expect(child.title).toBeUndefined();
    expect(child.inputContext).toBeUndefined();
    const ensured = await sm.ensureSession('zz-ensured', { metadata: { title: '<元数据标题>' } });
    expect(ensured.title).toBeUndefined();
    const named = await sm.createSession({ title: '<标题>', inputContext: '<指令>' });
    expect([named.title, named.inputContext]).toEqual(['<标题>', '<指令>']);
  });

  it('isUnfiled 与 ensureSession 补写创建来源的判法一致', async () => {
    const { sm } = await setup();
    const unfiled = await sm.ensureSession('zz-unfiled');
    expect(isUnfiled(unfiled)).toBe(true);
    await sm.ensureSession('zz-unfiled', {}, { createdFrom: 'cli' });
    expect(isUnfiled(sm.getSession('zz-unfiled')!)).toBe(false);
    expect(isUnfiled({ originPlatform: 'onebot' })).toBe(false);
    expect(isUnfiled({ work: { root: '/zz', extraRoots: [], worktrees: [] } })).toBe(false);
  });
});

// 删除会话时别的插件在 session:deleted 里收拾：定义一个只听事件的插件，核它跑在清数据之前（同一套顺序对插件也成立）
it('插件在 session:deleted 里看得到会话的数据还没清', async () => {
  const { app, sm, order } = await setup();
  await app.plugin(
    definePlugin({
      name: 'zz-listener',
      uses: { events },
      apply: ({ events }) => {
        events.use.on('session:deleted', () => void order.push('plugin'));
      },
    }),
  );
  await app.plugins.idle();
  const { id } = await sm.createSession({});
  await sm.deleteSession(id);
  expect(order).toEqual(['plugin', 'clear']);
});
