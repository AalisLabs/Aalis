import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatModelRequest, type ChatResponse, llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 事实提取被输出上限截断（模型插件报 finishReason 'length'）时不收下：JSON 看着完整也当解析失败，走已有的重试；正文为空
// 的同样按解析失败重试（提示词要求总回 JSON，没有事实也回三个空数组）；重试的提示写明是截断（不是合法 JSON 时写明不合法，
// 不猜原因）；重试仍被截断就跳过这一批。提取模型用替身，按次序回给定的回复
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const PROFILE_NS = 'user:profile';
const LIKES_CATS = JSON.stringify({
  add: [{ text: '喜欢猫', category: '偏好', temporality: 'permanent', sourceQuote: '我喜欢猫' }],
  update: [],
  remove: [],
});
const EMPTY = '{"add":[],"update":[],"remove":[]}';

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
});

/** 跑一轮提取：替身按次序回 replies（用完了回最后一条），返回它收到的请求与写下的事实 */
async function extract(replies: ChatResponse[]) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, memory });
  const requests: ChatModelRequest[] = [];
  const chat = vi.fn(async (request: ChatModelRequest) => {
    requests.push(request);
    return replies[Math.min(requests.length, replies.length) - 1];
  });
  host.provide.use(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  await app.plugin(userProfile, { extractEveryNMessages: 1, relationIncrementWitness: 0 });
  await app.plugins.idle();
  await host.memory.use.saveMessage(SESSION, {
    role: 'user',
    content: '我喜欢猫',
    metadata: { userId: 'u1', platform: 'onebot' },
  });
  await host.events.use.emit('inbound:message:archived', {
    sessionId: SESSION,
    incoming: { userId: 'u1', platform: 'onebot' },
  } as never);
  return {
    requests,
    chat,
    facts: async () => {
      const profile = await host.memory.use.getMetadata(PROFILE_NS, 'onebot:u1');
      return ((profile?.facts as Array<{ text: string }> | undefined) ?? []).map(f => f.text);
    },
  };
}

/** 等这一轮提取跑完：调够次数之后再让写入落完 */
async function settle(chat: ReturnType<typeof vi.fn>, calls: number): Promise<void> {
  await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(calls));
  await new Promise(resolve => setTimeout(resolve, 50));
}

describe('plugin-user-profile: 截断的提取不收', () => {
  it('对照：结束原因是 stop 时照收，只调一次', async () => {
    const run = await extract([{ content: LIKES_CATS, finishReason: 'stop' }]);
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['喜欢猫']));
    expect(run.chat).toHaveBeenCalledTimes(1);
  });

  it('报了 length：JSON 完整也不收，重试一次、提示写明被截断', async () => {
    const run = await extract([
      { content: LIKES_CATS, finishReason: 'length' },
      { content: EMPTY, finishReason: 'stop' },
    ]);
    await settle(run.chat, 2);
    expect(await run.facts()).toEqual([]);
    expect(String(run.requests[1].messages.at(-1)?.content)).toContain('在长度上限处被截断');
  });

  it('正文为空、报了 length：重试一次，提示按截断写', async () => {
    const run = await extract([
      { content: '', finishReason: 'length' },
      { content: LIKES_CATS, finishReason: 'stop' },
    ]);
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['喜欢猫']));
    expect(run.chat).toHaveBeenCalledTimes(2);
    expect(String(run.requests[1].messages.at(-1)?.content)).toContain('在长度上限处被截断');
  });

  it('正文为空、报 stop：提示词要求总回 JSON，空回复按解析失败重试一次、提示写明不是合法的 JSON 对象', async () => {
    const run = await extract([
      { content: '', finishReason: 'stop' },
      { content: LIKES_CATS, finishReason: 'stop' },
    ]);
    await vi.waitFor(async () => expect(await run.facts()).toEqual(['喜欢猫']));
    expect(run.chat).toHaveBeenCalledTimes(2);
    expect(String(run.requests[1].messages.at(-1)?.content)).toContain('不是合法的 JSON 对象');
  });

  it('回的不是合法 JSON（报 stop）：重试提示写明不是合法的 JSON 对象，不猜原因', async () => {
    const run = await extract([
      { content: '我不会输出 JSON', finishReason: 'stop' },
      { content: EMPTY, finishReason: 'stop' },
    ]);
    await settle(run.chat, 2);
    const retry = String(run.requests[1].messages.at(-1)?.content);
    expect(retry).toContain('不是合法的 JSON 对象');
    expect(retry).not.toContain('很可能');
  });

  it('重试仍报 length：跳过这一批，重试给的事实也不收', async () => {
    const run = await extract([
      { content: LIKES_CATS, finishReason: 'length' },
      { content: LIKES_CATS, finishReason: 'length' },
    ]);
    await settle(run.chat, 2);
    expect(await run.facts()).toEqual([]);
  });
});
