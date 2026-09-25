import { App, events, provide } from '@aalis/core';
import { describe, expect, it } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { type SessionManagerService, sessionManager } from '../../packages/api-session-manager/src/index.js';
import sessionManagerPlugin from '../../packages/plugin-session-manager/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { fakeMemory } from '../fixtures/session-memory.js';

// 背景（C11）：自动标题监听在「会话不存在」时只打一条 warn 就返回，而平台派生会话
// （cli-default、OneBot 会话 id）从不经 createSession 预建 —— 于是 CLI 会话永远没有标题，
// 且每条消息告警一次。契约：缺档时先 ensureSession 兜底建档再生成标题（与 createChildSession 同路）。

async function setup() {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, events, sessionManager });
  host.provide(memory, fakeMemory() as never);
  const llmCalls = { chats: 0 };
  host.provide(llm, {
    id: 'mock',
    capabilities: ['chat'],
    chat: async () => {
      llmCalls.chats++;
      return { content: '装修预算' };
    },
  } as never);
  await app.plugin(sessionManagerPlugin, {});
  await app.plugins.idle();
  // required 依赖缺席时插件停在 pending 且不报错——核激活状态，别让「压根没跑起来」冒充绿
  const state = app.plugins.getPlugin(sessionManagerPlugin.name)?.state;
  if (state !== 'active') throw new Error(`session-manager 未激活（state=${state}）`);
  const sm = host.sessionManager.require();
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

describe('自动标题：平台派生会话缺档时先兜底建档', () => {
  it('cli-default 首条消息后有标题（会话也被建出来）', async () => {
    const { app, host, sm } = await setup();

    await host.events.emit('inbound:message', {
      content: '帮我算下装修预算',
      sessionId: 'cli-default',
      platform: 'cli',
    });
    const title = await waitTitle(sm, 'cli-default');
    const session = sm.getSession('cli-default');
    await app.stop();

    expect(session, 'cli-default 应被兜底建档').toBeDefined();
    expect(title, '平台派生会话的首条消息也该拿到标题').toBe('装修预算');
  });

  it('缺 platform 的消息不建档也不生成标题：白名单是正向门，不兜底来路不明的会话', async () => {
    const { app, host, sm, llmCalls } = await setup();

    await host.events.emit('inbound:message', { content: '帮我算下装修预算', sessionId: 'no-platform' } as never);
    await new Promise(r => setTimeout(r, 30));
    const session = sm.getSession('no-platform');
    await app.stop();

    expect(session, '缺 platform 不该被兜底建档').toBeUndefined();
    expect(llmCalls.chats, '缺 platform 不该烧一次 LLM 生成标题').toBe(0);
  });

  it('已建档且已有标题的会话不重复生成', async () => {
    const { app, host, sm, llmCalls } = await setup();
    await sm.ensureSession('cli-default', { name: 'CLI' });
    await sm.updateSessionTitle('cli-default', '旧标题');

    await host.events.emit('inbound:message', { content: '换个话题', sessionId: 'cli-default', platform: 'cli' });
    await new Promise(r => setTimeout(r, 30));
    const title = sm.getSession('cli-default')?.title;
    await app.stop();

    expect(title).toBe('旧标题');
    // 标题没变还可能是「生成了但写不回」；真正的契约是**压根没调 LLM**（有成本），破闸即红
    expect(llmCalls.chats, '已有标题不该再发一次 LLM chat').toBe(0);
  });
});
