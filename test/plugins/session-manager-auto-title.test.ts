import { events, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import i18nPlugin from '../../packages/plugin-i18n/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { hostedApp } from '../fixtures/app.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 自动标题只给带创建来源的根会话（WebUI 新建的、终端建的）生成，按会话字段判，不按入口平台：
// IM 房间、按 id 建档的会话与子会话不生成，owner 从 WebUI 往房间插话也不拿来给房间起名。

type Chat = (req: { messages: { role: string; content: string }[] }) => Promise<{ content: string }>;

/** language 给出时装上 i18n，全局默认层的语言设成它 */
async function setup(chat: Chat = async () => ({ content: '装修预算' }), language?: string[]) {
  const { app } = hostedApp(language ? { sessionConfig: { defaults: { language } } } : {});
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide.use(memory, fakeMemory() as never);
  const llmCalls = { chats: 0 };
  host.provide.use(llm, {
    id: 'mock',
    capabilities: ['chat'],
    chat: (req: Parameters<Chat>[0]) => {
      llmCalls.chats++;
      return chat(req);
    },
  } as never);
  await app.plugin(sessionManagerPlugin, {});
  if (language) await app.plugin(i18nPlugin);
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.use;
  return { app, host, sm, llmCalls };
}

/** 标题生成是脱离事件链的异步任务，轮询等它落地（失败路径下会等满超时） */
async function waitTitle(sm: SessionManagerService, id: string): Promise<string | undefined> {
  for (let i = 0; i < 100; i++) {
    const t = sm.getSession(id)?.title;
    if (t) return t;
    await new Promise(r => setTimeout(r, 5));
  }
  return sm.getSession(id)?.title;
}

describe('自动标题按创建来源', () => {
  it('WebUI 新建与终端建的会话：首条消息后有标题', async () => {
    const { app, host, sm } = await setup();
    const webui = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
    await sm.ensureSession('cli-default', {}, { createdFrom: 'cli' });

    await host.events.use.emit('inbound:message', {
      content: '帮我算下装修预算',
      sessionId: webui.id,
      platform: 'webui',
    });
    await host.events.use.emit('inbound:message', {
      content: '帮我算下装修预算',
      sessionId: 'cli-default',
      platform: 'cli',
    });
    const titles = [await waitTitle(sm, webui.id), await waitTitle(sm, 'cli-default')];
    await app.stop();

    expect(titles).toEqual(['装修预算', '装修预算']);
  });

  it('IM 房间、按 id 建档的会话与子会话不生成标题，owner 从 WebUI 往房间插话也一样', async () => {
    const { app, host, sm, llmCalls } = await setup();
    const group = 'onebot:10000:group:20001';
    const owner = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
    await sm.updateSessionTitle(owner.id, '<已有标题>');
    const child = await sm.createChildSession(owner.id, { name: '<子任务>' });
    await sm.ensureSession('<按 id 建档>', {});
    const emit = (sessionId: string, platform: string) =>
      host.events.use.emit('inbound:message', { content: '帮我算下装修预算', sessionId, platform });

    await emit(group, 'onebot');
    await emit(group, 'webui');
    await emit(child.id, 'webui');
    await emit('<按 id 建档>', 'webui');
    await new Promise(r => setTimeout(r, 30));
    const titles = [group, child.id, '<按 id 建档>'].map(id => sm.getSession(id)?.title);
    await app.stop();

    expect(titles).toEqual([undefined, undefined, undefined]);
    expect(llmCalls.chats, '不该为起标题烧一次 LLM').toBe(0);
  });

  it('已有标题的会话不重复生成', async () => {
    const { app, host, sm, llmCalls } = await setup();
    await sm.ensureSession('cli-default', { name: 'CLI' }, { createdFrom: 'cli' });
    await sm.updateSessionTitle('cli-default', '旧标题');

    await host.events.use.emit('inbound:message', { content: '换个话题', sessionId: 'cli-default', platform: 'cli' });
    await new Promise(r => setTimeout(r, 30));
    const title = sm.getSession('cli-default')?.title;
    await app.stop();

    expect(title).toBe('旧标题');
    // 标题没变还可能是「生成了但写不回」；真正的契约是**压根没调 LLM**（有成本），破闸即红
    expect(llmCalls.chats, '已有标题不该再发一次 LLM chat').toBe(0);
  });
});

describe('标题的语言与截断', () => {
  async function titleOf(chat: Chat, content: string) {
    const { app, host, sm } = await setup(chat);
    const session = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
    await host.events.use.emit('inbound:message', { content, sessionId: session.id, platform: 'webui' });
    const title = await waitTitle(sm, session.id);
    await app.stop();
    return title;
  }

  it('标题的语言取自全局默认层的语言列表（会话自己设的不算）：提示词里写 English（en），不写死中文、不让模型跟对话的语言', async () => {
    const systems: string[] = [];
    const { app, host, sm } = await setup(
      async req => {
        systems.push(req.messages.find(m => m.role === 'system')?.content ?? '');
        return { content: 'Kitchen budget' };
      },
      ['en', 'zh-CN'],
    );
    const session = await sm.createSession({ name: '<新会话>' }, { createdFrom: 'webui' });
    await sm.updateSession(session.id, { config: { language: ['ja'] } });
    await host.events.use.emit('inbound:message', {
      content: '帮我算下厨房装修预算',
      sessionId: session.id,
      platform: 'webui',
    });
    const title = await waitTitle(sm, session.id);
    await app.stop();

    expect(title).toBe('Kitchen budget');
    expect(systems[0]).toContain('生成一个简短的标题，用 English（en）。');
    expect(systems[0]).not.toContain('中文标题');
    expect(systems[0]).not.toContain('对话片段所用的语言');
  });

  it('模型给的标题与兜底标题截断时不切坏 emoji', async () => {
    const fromModel = await titleOf(async () => ({ content: `${'y'.repeat(49)}😀` }), '随便聊聊');
    const fallback = await titleOf(async () => ({ content: '' }), `${'x'.repeat(19)}😀尾巴`);

    expect(fromModel).toBe('y'.repeat(49));
    expect(fallback).toBe('x'.repeat(19));
  });
});
