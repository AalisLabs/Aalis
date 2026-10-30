import { afterEach, describe, expect, it, vi } from 'vitest';
import { type CommandHandler, commands } from '../../packages/api-commands/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import type { DeclarativePageView, PageActionResponse } from '../../packages/api-webui/src/index.js';
import { webuiServer } from '../../packages/api-webui/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { isTextRef, resolveText, type TextRef, toSource } from '../../packages/schema-i18n/src/index.js';
import { renderIn } from '../fixtures/host-language.js';
import { registerHubs } from '../fixtures/hubs.js';
import { type PageHost, pageHost } from '../fixtures/page-host.js';

// ════════════════════════════════════════════════════════════
// 用户档案页：插件详情里一张带详情的表格，列出有事实的人；详情列出各条事实。只删不改：删一条事实、清空一个人，
// 都是 destructive，由宿主确认；档案的事实变了（页面动作、指令、提取、全局清理）就 invalidate。webui 不在时插件照常。
// 页面数据、动作回执与报错、指令回复与全局清理的结果行都是文字对象，按读者的语言显示
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
  host.provide.use(llm, { id: 'stub-model', capabilities: ['chat'], chat: async () => ({ content: reply }) } as never);
  host.provide.use(webuiServer, pages.service);
  // 指令只收下处理函数，按名字直接调用；调用的人是 onebot 上的 admin
  const handlers = new Map<string, CommandHandler>();
  host.provide.use(commands, {
    command: (name: string) => ({ action: (handler: CommandHandler) => handlers.set(name.split(' ')[0], handler) }),
    unregister() {},
  } as never);
  const command = (name: string, ...args: unknown[]) =>
    handlers.get(name)?.(
      { session: { sessionId: 'onebot:g1', platform: 'onebot', userId: 'alice', raw: '' }, options: {} },
      ...args,
    );
  await app.plugins.idle();
  const mem = host.services.use.get(memory);
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
    const { pages, mem } = await setup();
    const view: DeclarativePageView = pages.view(PAGE);
    expect(view.placement).toBe('plugin');
    expect(pages.logs).toEqual([]);
    expect(await pages.data(PAGE, 'profiles')).toEqual([
      { key: 'onebot:bob', facts: 1, updatedAt: 500 },
      { key: 'onebot:alice', facts: 2, updatedAt: 300 },
    ]);
    const facts = await pages.data<Array<{ category: string | TextRef; temporality: string | TextRef }>>(
      PAGE,
      'facts',
      {
        rowKey: 'onebot:alice',
      },
    );
    expect(toSource(facts)).toEqual([
      { ref: '["onebot:alice","f2"]', text: '在读研', category: '', temporality: '近期', updatedAt: 300 },
      { ref: '["onebot:alice","f1"]', text: '喜欢猫', category: '偏好', temporality: '长期', updatedAt: 100 },
    ]);
    // 分类与时效的显示名按读者语言；落盘的分类值照旧
    expect(facts.map(f => [renderIn(f.category, 'en'), renderIn(f.temporality, 'en')])).toEqual([
      ['', 'Short-term'],
      ['Preferences', 'Long-term'],
    ]);
    expect((await mem.getMetadata(NS, 'onebot:alice'))?.facts).toContainEqual(
      expect.objectContaining({ id: 'f1', category: '偏好' }),
    );
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
    const refused: Array<string | TextRef> = [];
    for (const rowKey of ['["onebot:alice","f1"]', 'onebot:alice', '["onebot:alice"]', '[{"$ne":null},"f2"]']) {
      const failed = await pages.act(PAGE, 'forgetFact', { rowKey });
      expect(failed.status, rowKey).not.toBe(200);
      refused.push((failed.body as { error: string | TextRef }).error);
    }
    const shown = (language: string) =>
      [(reply.body as PageActionResponse).message, ...refused.slice(0, 2)].map(text => renderIn(text, language));
    expect(shown('en')).toEqual([
      'Deleted: 喜欢猫',
      'This fact is no longer in the profile',
      'Unrecognized fact: onebot:alice',
    ]);
    expect(shown('zh-CN')).toEqual(['已删除：喜欢猫', '这条事实已经不在档案里了', '不认识的事实：onebot:alice']);
    // 认不出的行在查档案之前就拒掉：不是字符串的键不交给记忆后端
    expect(read.mock.calls.map(([, key]) => key)).toEqual(['onebot:alice']);
    expect(await facts('onebot:alice')).toEqual(['f2']);
    expect(pages.invalidations).toHaveLength(1);
  });

  it('清空一个人：删掉这个人的档案，别人的照旧，页面 invalidate；已经没有档案的回错误', async () => {
    const { pages, facts } = await setup();
    const cleared = await pages.act(PAGE, 'clearProfile', { rowKey: 'onebot:alice' });
    expect(cleared.status).toBe(200);
    expect(await facts('onebot:alice')).toBeUndefined();
    expect(await facts('onebot:bob')).toEqual(['f9']);
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);
    const again = await pages.act(PAGE, 'clearProfile', { rowKey: 'onebot:alice' });
    expect(again.status).not.toBe(200);
    const shown = (language: string) =>
      [(cleared.body as PageActionResponse).message, (again.body as { error: string | TextRef }).error].map(text =>
        renderIn(text, language),
      );
    expect(shown('en')).toEqual(['Cleared the profile of onebot:alice', 'onebot:alice no longer has a profile']);
    expect(shown('zh-CN')).toEqual(['已清空 onebot:alice 的档案', 'onebot:alice 已经没有档案了']);
    expect(await pages.data(PAGE, 'profiles')).toEqual([{ key: 'onebot:bob', facts: 1, updatedAt: 500 }]);
  });

  it('全局清理（/clear all）清掉档案后页面 invalidate；会话级清理不动档案，也不 invalidate', async () => {
    const { pages, host } = await setup();
    const clear = (scope: 'session' | 'all') => {
      const data: HookContextMap['memory:clear'] = { scope, sessionId: 's1', results: [] };
      return host.hooks.use.run('memory:clear', data, async () => {});
    };
    await clear('session');
    expect(pages.invalidations).toEqual([]);
    await clear('all');
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);
    expect(await pages.data(PAGE, 'profiles')).toEqual([]);
  });

  it('指令改了事实也 invalidate：/profile.forget、/profile.clear、/profile.clear.nuke；回复按读者的语言', async () => {
    const { pages, facts, command } = await setup();
    const replies = [
      await command('profile.forget', 'onebot:bob', 'zz'),
      await command('profile.forget', 'onebot:alice', 'zz'),
      await command('profile.forget', 'onebot:bob', 'f9'),
    ];
    expect(await facts('onebot:bob')).toEqual([]);
    replies.push(await command('profile.clear'));
    expect(await facts('onebot:alice')).toBeUndefined();
    replies.push(await command('profile.clear'), await command('profile'));
    await command('profile.clear.nuke');
    expect(await pages.data(PAGE, 'profiles')).toEqual([]);
    expect(pages.invalidations).toHaveLength(3);
    expect(replies.map(reply => renderIn(reply as string | TextRef, 'en'))).toEqual([
      'Fact [zz] not found. onebot:bob has 1 fact:\n  [f9] 会弹琴',
      'Fact [zz] not found. onebot:alice has 2 facts:\n  [f1] 喜欢猫\n  [f2] 在读研',
      'Deleted fact [f9] of onebot:bob: 会弹琴',
      'Cleared your profile (onebot:alice)',
      'You have no profile data (onebot:alice)',
      'No profile data yet (onebot:alice)',
    ]);
    expect(replies.map(reply => renderIn(reply as string | TextRef, 'zh-CN'))).toEqual([
      '未找到事实 [zz]。onebot:bob 现有 1 条：\n  [f9] 会弹琴',
      '未找到事实 [zz]。onebot:alice 现有 2 条：\n  [f1] 喜欢猫\n  [f2] 在读研',
      '已删除 onebot:bob 的事实 [f9]：会弹琴',
      '已清除你的档案 (onebot:alice)',
      '你当前没有档案数据 (onebot:alice)',
      '暂无档案数据 (onebot:alice)',
    ]);
  });

  it('清掉的条数按读者的语言：/profile.clear.nuke 与全局清理各清 1 条、2 条', async () => {
    const { mem, host, command } = await setup();
    const keep = async (...keys: string[]) => {
      for (const entry of await mem.listMetadata(NS)) await mem.deleteMetadata(NS, entry.key);
      for (const key of keys) await mem.saveMetadata(NS, key, { facts: [fact('f1', 'zz', 1)], updatedAt: 1 });
    };
    const clearAll = async () => {
      const data: HookContextMap['memory:clear'] = { scope: 'all', sessionId: 's1', results: [] };
      await host.hooks.use.run('memory:clear', data, async () => {});
      return data.results.find(result => result.source === 'user-profile')?.message;
    };
    const replies: unknown[] = [];
    for (const keys of [['onebot:a'], ['onebot:a', 'onebot:b']]) {
      await keep(...keys);
      replies.push(await command('profile.clear.nuke'));
      await keep(...keys);
      replies.push(await clearAll());
    }
    expect(replies.map(reply => renderIn(reply as string | TextRef, 'en'))).toEqual([
      'Cleared all user profiles (1 entry)',
      'Cleared user profiles (1 entry)',
      'Cleared all user profiles (2 entries)',
      'Cleared user profiles (2 entries)',
    ]);
    expect(replies.map(reply => renderIn(reply as string | TextRef, 'zh-CN'))).toEqual([
      '已清空全部用户档案（1 条）',
      '用户档案已清空（1 条）',
      '已清空全部用户档案（2 条）',
      '用户档案已清空（2 条）',
    ]);
  });

  it('/profile 交出文字对象：分类名与说明按读者语言，原文与给模型的档案块同一版式', async () => {
    const { mem, command } = await setup();
    await mem.saveMetadata(NS, 'onebot:alice', {
      facts: [
        fact('f1', '喜欢猫', 100, { category: '偏好' }),
        fact('f3', '考试周', Date.now(), {
          category: '近期处境',
          temporality: 'temporary',
          timeHint: '十月',
          observedAt: 100,
        }),
        fact('f4', 'zz', 100),
      ],
      relationScore: 12,
      interactionCount: 3,
      updatedAt: 900,
    });
    const reply = (await command('profile')) as TextRef;
    expect(toSource(reply)).toBe(
      [
        '你的档案 (onebot:alice)',
        '关系强度：12.0/100，互动次数：3',
        '',
        '## 近期处境',
        '- 考试周（时间线索：十月；记录于：1970/1/1；临时状态）',
        '',
        '## 偏好',
        '- 喜欢猫（记录于：1970/1/1）',
        '',
        '## 其他',
        '- zz（记录于：1970/1/1）',
      ].join('\n'),
    );
    expect(isTextRef(reply) && resolveText(reply, ['en'])).toBe(
      [
        'Your profile (onebot:alice)',
        'Relationship strength: 12.0/100, interactions: 3',
        '',
        '## Current situation',
        '- 考试周 (time hint: 十月; recorded 1/1/70; temporary)',
        '',
        '## Preferences',
        '- 喜欢猫 (recorded 1/1/70)',
        '',
        '## Other',
        '- zz (recorded 1/1/70)',
      ].join('\n'),
    );
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
    await host.events.use.emit('inbound:message:archived', {
      sessionId: 'onebot:g1',
      incoming: { userId: 'bob', platform: 'onebot' },
    } as never);
    await vi.waitFor(async () => expect(await facts('onebot:bob')).toHaveLength(2));
    expect(pages.invalidations).toEqual([{ instance: userProfile.name, pageKey: PAGE }]);
  });
});
