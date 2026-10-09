import { afterEach, describe, expect, it, vi } from 'vitest';
import { llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, type MetadataOp, memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 先读后改再写的路径必须严格读取：getMetadata 抛错时中止本次写入，只有返回空才算「不存在」。
// 读档案曾把任何读错都当成「不存在」，调用方拿默认值覆盖写回：一次瞬时读错（Mongo 超时、
// SQLITE_BUSY）就让该用户的事实、关系分、互动次数全部清零。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const PROFILE_KEY = 'user:profile/onebot:u1';

const SEED_PROFILE = {
  facts: [
    { id: 'f1', text: '事实一', temporality: 'permanent', observedAt: 100, updatedAt: 100 },
    { id: 'f2', text: '事实二', temporality: 'permanent', observedAt: 100, updatedAt: 100 },
  ],
  relationScore: 42,
  interactionCount: 7,
  lastInteractionAt: Date.now(),
  updatedAt: 1,
};

class FlakyMemory {
  readonly metadata = new Map<string, Record<string, unknown>>();
  /** 下一次 getMetadata 抛错 */
  failNextRead = false;
  /** 下一次 getHistory 之后的第一次 getMetadata 抛错（命中提取路径 LLM 之前的那次读） */
  failReadAfterHistory = false;

  constructor(readonly history: Message[] = []) {}

  async saveMessage(_sessionId: string, message: Message): Promise<void> {
    this.history.push(message);
  }
  async getHistory(): Promise<Message[]> {
    if (this.failReadAfterHistory) {
      this.failReadAfterHistory = false;
      this.failNextRead = true;
    }
    return [...this.history];
  }
  async clearSession(): Promise<void> {}
  async saveMetadata(ns: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.metadata.set(`${ns}/${key}`, data);
  }
  async getMetadata(ns: string, key: string): Promise<Record<string, unknown> | undefined> {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('MongoServerSelectionError（模拟）');
    }
    return this.metadata.get(`${ns}/${key}`);
  }
  async deleteMetadata(ns: string, key: string): Promise<void> {
    this.metadata.delete(`${ns}/${key}`);
  }
  async listMetadata(ns: string) {
    return [...this.metadata]
      .filter(([k]) => k.startsWith(`${ns}/`))
      .map(([k, data]) => ({ key: k.slice(ns.length + 1), data, updatedAt: 0 }));
  }
  async commitMetadata(ops: readonly MetadataOp[]): Promise<void> {
    for (const op of ops) {
      if (op.op === 'put') this.metadata.set(`${op.namespace}/${op.key}`, op.data);
      else this.metadata.delete(`${op.namespace}/${op.key}`);
    }
  }
}

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function setup(config: Record<string, unknown>, history: Message[] = []) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events });
  const chat = vi.fn(async () => ({
    content: JSON.stringify({
      add: [{ text: '喜欢猫', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢猫' }],
    }),
  }));
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
  const mem = new FlakyMemory(history);
  mem.metadata.set(PROFILE_KEY, structuredClone(SEED_PROFILE));
  host.provide(memory, mem as unknown as MemoryService);
  await app.plugins.register(userProfile, {
    extractEveryNMessages: 0,
    ...config,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');
  const inbound = async () => {
    await host.events.emit('inbound:message:archived', {
      sessionId: SESSION,
      incoming: { userId: 'u1', platform: 'onebot' },
    } as never);
    await new Promise<void>(r => setTimeout(r, 20));
  };
  return { mem, chat, inbound };
}

describe('plugin-user-profile: 读改写路径遇读错中止，不以默认值覆盖', () => {
  it('旁观计数：读错一次后档案原样保留，恢复后在原值上累加', async () => {
    const { mem, inbound } = await setup({ relationIncrementWitness: 0 });

    mem.failNextRead = true;
    await inbound();
    expect(mem.metadata.get(PROFILE_KEY), '读失败的那次不得写回').toEqual(SEED_PROFILE);

    await inbound();
    const doc = mem.metadata.get(PROFILE_KEY);
    expect((doc?.facts as Array<{ text: string }>).map(f => f.text)).toEqual(['事实一', '事实二']);
    expect(doc?.relationScore).toBe(42);
    expect(doc?.interactionCount, '在原有 7 次上累加，而不是从 0 重来').toBe(8);
  });

  it('事实提取：LLM 之前那次读失败即中止，不调 LLM、不覆盖已有事实', async () => {
    const { mem, chat, inbound } = await setup({ extractEveryNMessages: 1, relationIncrementWitness: 0 }, [
      { role: 'user', content: '我喜欢猫', metadata: { userId: 'u1', platform: 'onebot' } },
    ]);

    mem.failReadAfterHistory = true;
    await inbound();
    await new Promise<void>(r => setTimeout(r, 30));

    expect(chat, '读不出现有事实时不该拿空表去问 LLM').not.toHaveBeenCalled();
    const facts = mem.metadata.get(PROFILE_KEY)?.facts as Array<{ text: string }>;
    expect(facts.map(f => f.text)).toEqual(['事实一', '事实二']);
  });
});
