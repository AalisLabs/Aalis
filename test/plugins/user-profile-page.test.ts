import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandHandler, commands } from '../../packages/api-commands/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import type { DeclarativePageView } from '../../packages/api-webui/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 用户档案页：插件详情里一张带详情的表格，列出有事实的人；详情列出各条事实。只删不改：删一条事实、清空一个人，
// 都是 destructive，由宿主确认；档案的事实变了（页面动作、指令、提取、全局清理）就 invalidate。webui 不在时插件照常
// ════════════════════════════════════════════════════════════

const PAGE = 'profiles';
const NS = 'user:profile';

const apps: App[] = [];
const hosts: PageHost[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const host of hosts.splice(0)) host.dispose();
});

const fact = (id: string, text: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  id,
  text,
  temporality: 'permanent',
  observedAt: updatedAt,
  updatedAt,
  ...extra,
});

/** extract 是事实提取时模型回的 JSON；给了就每条消息都提取一次 */
async function setup(extract?: unknown) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  await app.plugin(memoryInMemory);
  const pages = pageHost();
  hosts.push(pages);
  const host = app.bind({ provide, services, hooks, events });
  const reply = JSON.stringify(extract ?? {});
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat: async () => ({ content: reply }) } as never);
  host.provide(webuiServer, pages.service);
  // 指令只收下处理函数，按名字直接调用；调用的人是 onebot 上的 admin
  const handlers = new Map<string, CommandHandler>();
  host.provide(commands, {
    command: (name: string) => ({ action: (handler: CommandHandler) => handlers.set(name.split(' ')[0], handler) }),
    unregister() {},
  } as never);
  const command = (name: string, ...args: unknown[]) =>
    handlers.get(name)?.(
      { session: { sessionId: 'onebot:g1', platform: 'onebot', userId: 'alice', raw: '' }, options: {} },
      ...args,
    );
  await app.plugins.idle();
  const mem = host.services.get(memory);
  if (!mem) throw new Error('memory 服务未就绪');
  await mem.saveMetadata(NS, 'onebot:alice', {
    facts: [fact('f1', '喜欢猫', 100, { category: '偏好' }), fact('f2', '在读研', 300, { temporality: 'temporary' })],
    relationScore: 12,
    updatedAt: 900,
  });
  await mem.saveMetadata(NS, 'onebot:bob', { facts: [fact('f9', '会弹琴', 500)], updatedAt: 500 });
  // 只有关系分、没有事实的不算有档案
  await mem.saveMetadata(NS, 'onebot:carol', { facts: [], relationScore: 3, updatedAt: 950 });
  await app.plugin(userProfile, extract === undefined ? {} : { extractEveryNMessages: 1 });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');
  const facts = async (key: string) =>
    ((await mem.getMetadata(NS, key))?.facts as Array<{ id: string }> | undefined)?.map(f => f.id);
  return { pages, mem, host, facts, command };
}

describe('用户档案页', () => {
  it('位置为插件详情：带详情的表格列出有事实的人（键、事实条数、最近一条事实的时间），新的在前；详情是各条事实与清空', async () => {
    const { pages } = await setup();
    const view: DeclarativePageView = pages.view(PAGE);
    expect(view.placement).toBe('plugin');
    expect(pages.logs).toEqual([]);
    expect(await pages.data(PAGE, 'profiles')).toEqual([
      { key: 'onebot:bob', facts: 1, updatedAt: 500 },
      { key: 'onebot:alice', facts: 2, updatedAt: 300 },
    ]);
    expect(await pages.data(PAGE, 'facts', { rowKey: 'onebot:alice' })).toEqual([
      { ref: '["onebot:alice","f2"]', text: '在读研', category: '', temporality: '近期', updatedAt: 300 },
      { ref: '["onebot:alice","f1"]', text: '喜欢猫', category: '偏好', temporality: '长期', updatedAt: 100 },
    ]);
    expect(await pages.data(PAGE, 'facts', { rowKey: 'onebot:nobody' })).toEqual([]);
    expect(view.actions).toMatchObject({
      forgetFact: { effect: 'destructive', row: true },
      clearProfile: { effect: 'destructive', row: true },
    });
  });

  it('删一条事实：只删这一条，其余的与关系分照旧，页面 invalidate；已经不在的、认不出的行回错误，什么都不改', async () => {
    const { pages, mem, facts } = await setup();
    const reply = await pages.act(PAGE, 'forgetFact', { rowKey: '["onebot:alice","f1"]' });
    expect(reply.status).toBe(200);
    expect(await facts('onebot:alice')).toEqual(['f2']);
    expect((await mem.getMetadata(NS, 'onebot:alice'))?.relationScore).toBe(12);
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);

    const read = vi.spyOn(mem, 'getMetadata');
    for (const rowKey of ['["onebot:alice","f1"]', 'onebot:alice', '["onebot:alice"]', '[{"$ne":null},"f2"]']) {
      expect((await pages.act(PAGE, 'forgetFact', { rowKey })).status, rowKey).not.toBe(200);
    }
    // 认不出的行在查档案之前就拒掉：不是字符串的键不交给记忆后端
    expect(read.mock.calls.map(([, key]) => key)).toEqual(['onebot:alice']);
    expect(await facts('onebot:alice')).toEqual(['f2']);
    expect(pages.invalidations).toHaveLength(1);
  });

  it('清空一个人：删掉这个人的档案，别人的照旧，页面 invalidate；已经没有档案的回错误', async () => {
    const { pages, facts } = await setup();
    expect((await pages.act(PAGE, 'clearProfile', { rowKey: 'onebot:alice' })).status).toBe(200);
    expect(await facts('onebot:alice')).toBeUndefined();
    expect(await facts('onebot:bob')).toEqual(['f9']);
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);
    expect((await pages.act(PAGE, 'clearProfile', { rowKey: 'onebot:alice' })).status).not.toBe(200);
    expect(await pages.data(PAGE, 'profiles')).toEqual([{ key: 'onebot:bob', facts: 1, updatedAt: 500 }]);
  });

  it('全局清理（/clear all）清掉档案后页面 invalidate；会话级清理不动档案，也不 invalidate', async () => {
    const { pages, host } = await setup();
    const clear = (scope: 'session' | 'all') => {
      const data: HookContextMap['memory:clear'] = { scope, sessionId: 's1', results: [] };
      return host.hooks.run('memory:clear', data, async () => {});
    };
    await clear('session');
    expect(pages.invalidations).toEqual([]);
    await clear('all');
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);
    expect(await pages.data(PAGE, 'profiles')).toEqual([]);
  });

  it('指令改了事实也 invalidate：/profile.forget、/profile.clear、/profile.clear.nuke', async () => {
    const { pages, facts, command } = await setup();
    await command('profile.forget', 'onebot:bob', 'f9');
    expect(await facts('onebot:bob')).toEqual([]);
    await command('profile.clear');
    expect(await facts('onebot:alice')).toBeUndefined();
    await command('profile.clear.nuke');
    expect(await pages.data(PAGE, 'profiles')).toEqual([]);
    expect(pages.invalidations).toHaveLength(3);
  });

  it('提取写进新的事实后 invalidate', async () => {
    const { pages, mem, host, facts } = await setup({
      add: [{ text: '养了一只柴犬', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我家柴犬' }],
    });
    await mem.saveMessage('onebot:g1', {
      role: 'user',
      content: '我家柴犬今天又拆家了',
      metadata: { userId: 'bob', platform: 'onebot' },
    });
    await host.events.emit('inbound:message:archived', {
      sessionId: 'onebot:g1',
      incoming: { userId: 'bob', platform: 'onebot' },
    } as never);
    await vi.waitFor(async () => expect(await facts('onebot:bob')).toHaveLength(2));
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);
  });
});
