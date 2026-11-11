import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ChatModelRequest, type ChatResponse, llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide, services } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';
import { deferred } from '../helpers/deferred.js';

// ════════════════════════════════════════════════════════════
// 用户档案停用时，收尾段等本插件自己发起的后台写（旁观关系更新、事实提取）落定再撤回：已经开始的写入写完，停用落定之后
// 不再有写入。提取的模型替身在信号断开时才回（恰在这时回来，照常往下写）；记忆后端的写入按条件卡在一道闸上，用例放行；
// order 记下写入开始、写完与停用落定的先后。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const LIKES_CATS = JSON.stringify({
  add: [{ text: '喜欢猫', category: '偏好', temporality: 'permanent', sourceQuote: '我喜欢猫' }],
  update: [],
  remove: [],
});

const apps: App[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const app of apps.splice(0)) await app.stop();
});

async function boot(config: Record<string, unknown>, gateWhen: (doc: Record<string, unknown>) => boolean) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, memory });
  const chat = (request: ChatModelRequest) =>
    new Promise<ChatResponse>(resolve =>
      request.signal?.addEventListener('abort', () => resolve({ content: LIKES_CATS }), { once: true }),
    );
  host.provide.use(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
  await app.plugin(memoryInMemory);
  await app.plugins.idle();
  // 记忆后端的写入：第一条合条件的卡在闸上
  const order: string[] = [];
  const gate = deferred<void>();
  let gated = false;
  const provider = app.bind({ services }).services.use.get(memory) as MemoryService;
  const save = provider.saveMetadata.bind(provider);
  vi.spyOn(provider, 'saveMetadata').mockImplementation(async (namespace, key, doc) => {
    order.push('写入开始');
    if (!gated && gateWhen(doc)) {
      gated = true;
      await gate.promise;
    }
    await save(namespace, key, doc);
    order.push('写完');
  });
  await app.plugin(userProfile, config);
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
  /** 停用：写入到了闸上再放行，停用落定时记下 */
  const disableWhileGated = async () => {
    const disabled = app.plugins.disable(userProfile.name).then(() => {
      order.push('停用落定');
    });
    await vi.waitFor(() => expect(gated).toBe(true));
    await new Promise(resolve => setImmediate(resolve));
    gate.resolve();
    await disabled;
    await new Promise(resolve => setTimeout(resolve, 20));
  };
  return { order, disableWhileGated };
}

describe('用户档案停用时等在途的后台写', () => {
  it('旁观关系更新的写入途中停用：停用等写完才落定，之后不再有写入', async () => {
    const t = await boot({ extractEveryNMessages: 0, relationIncrementWitness: 0.1 }, () => true);
    await t.disableWhileGated();
    expect(t.order).toContain('写完');
    expect(t.order.at(-1)).toBe('停用落定');
  });

  it('事实提取的模型调用途中停用：模型这时回来、开始写事实，停用等写完才落定，之后不再有写入', async () => {
    const t = await boot(
      { extractEveryNMessages: 1, relationIncrementWitness: 0 },
      doc => Array.isArray(doc.facts) && doc.facts.length > 0,
    );
    await t.disableWhileGated();
    expect(t.order).toContain('写完');
    expect(t.order.at(-1)).toBe('停用落定');
  });
});
