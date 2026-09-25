import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { type MemoryService, type MetadataOp, memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 一次提取只认开头取到的 memory 实例。
//
// 事实提取、自反思、指令提取都是「读 A → 调 LLM → 重读最新档案 → 覆盖写」。LLM 调用期间
// memory 胜者可能换人而本插件不重启；若重读与写回现取胜者，就会拿 A 上合并出的整张表覆盖 B，
// B 原有的条目被删（读改写跨了两个后端）。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const PROFILE_NS = 'user:profile';
const INSTRUCTIONS_NS = 'aalis:instructions';

class StubMemory {
  readonly metadata = new Map<string, Record<string, unknown>>();
  constructor(readonly history: Message[] = []) {}

  async saveMessage(_sessionId: string, message: Message): Promise<void> {
    this.history.push(message);
  }
  async getHistory(): Promise<Message[]> {
    return [...this.history];
  }
  async clearSession(): Promise<void> {}
  async saveMetadata(ns: string, key: string, data: Record<string, unknown>): Promise<void> {
    this.metadata.set(`${ns}/${key}`, data);
  }
  async getMetadata(ns: string, key: string): Promise<Record<string, unknown> | undefined> {
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

  texts(ns: string, key: string, field: 'facts' | 'instructions'): string[] {
    const list = (this.metadata.get(`${ns}/${key}`)?.[field] ?? []) as Array<{ text: string }>;
    return list.map(item => item.text);
  }
}

/** 桩 authority：admin-1 等级 2，够得上指令提取的默认门槛 */
const stubAuthority = {
  isOwner: () => false,
  listUsers: () => [{ platform: 'onebot', userId: 'admin-1', isOwner: false, level: 2 }],
} as unknown as AuthorityService;

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

/**
 * 装好 user-profile（胜者 A 在场），发一条入站事件触发提取；LLM 被调用时挂起，
 * 此刻让更高优先级的 B 上线成为胜者，再放行 LLM。
 */
async function runWithWinnerSwitch(opts: {
  config: Record<string, unknown>;
  history: Message[];
  /** 两个后端各自原有的一份档案：key 为 `<namespace>/<key>` */
  seed: (label: 'A' | 'B') => [key: string, data: Record<string, unknown>];
  reply: unknown;
  speaker: string;
}): Promise<{ first: StubMemory; second: StubMemory }> {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events });

  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  let called!: () => void;
  const calledOnce = new Promise<void>(r => {
    called = r;
  });
  const chat = async () => {
    called();
    await gate;
    return { content: JSON.stringify(opts.reply) };
  };
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat } as never);
  host.provide(authority, stubAuthority);

  const first = new StubMemory(opts.history);
  const second = new StubMemory();
  first.metadata.set(...opts.seed('A'));
  second.metadata.set(...opts.seed('B'));
  host.provide(memory, first as unknown as MemoryService);
  await app.plugins.register(userProfile, { relationIncrementWitness: 0, ...opts.config });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');

  await host.events.emit('inbound:message:archived', {
    sessionId: SESSION,
    incoming: { userId: opts.speaker, platform: 'onebot' },
  } as never);
  await calledOnce;
  host.provide(memory, second as unknown as MemoryService, { priority: 10 });
  await app.plugins.idle();
  release();
  return { first, second };
}

describe('plugin-user-profile: 一次提取只认开头取到的 memory 实例', () => {
  it('事实提取：LLM 挂起期间换胜者，新事实落在 A，B 的事实不变', async () => {
    const { first, second } = await runWithWinnerSwitch({
      config: { extractEveryNMessages: 1, enableInstructions: false },
      history: [{ role: 'user', content: '我喜欢猫', metadata: { userId: 'u1', platform: 'onebot' } }],
      seed: label => [
        `${PROFILE_NS}/onebot:u1`,
        {
          facts: [{ id: 'f1', text: `${label}上的事实`, temporality: 'permanent', observedAt: 1, updatedAt: 1 }],
          relationScore: label === 'A' ? 10 : 90,
        },
      ],
      reply: { add: [{ text: '喜欢猫', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢猫' }] },
      speaker: 'u1',
    });

    await vi.waitFor(() => expect(first.texts(PROFILE_NS, 'onebot:u1', 'facts')).toContain('喜欢猫'));
    expect(first.texts(PROFILE_NS, 'onebot:u1', 'facts')).toEqual(['A上的事实', '喜欢猫']);
    expect(second.texts(PROFILE_NS, 'onebot:u1', 'facts'), 'B 上原有事实不得被 A 的整张表覆盖').toEqual(['B上的事实']);
    // LLM 之后的重读同样只认 A：从 B 重读会把 B 的关系分带进 A
    expect(first.metadata.get(`${PROFILE_NS}/onebot:u1`)?.relationScore).toBe(10);
  });

  it('自反思：LLM 挂起期间换胜者，自档案新事实落在 A，B 的自档案不变', async () => {
    const { first, second } = await runWithWinnerSwitch({
      config: {
        extractEveryNMessages: 0,
        enableInstructions: false,
        enableSelfProfile: true,
        selfReflectEveryNMessages: 1,
      },
      history: [
        { role: 'user', content: '你好', metadata: { userId: 'u1', platform: 'onebot' } },
        { role: 'assistant', content: '你好呀，我最近很喜欢猫' },
      ],
      seed: label => [
        `${PROFILE_NS}/__self__:Aalis`,
        {
          facts: [{ id: 'f1', text: `${label}上的事实`, temporality: 'permanent', observedAt: 1, updatedAt: 1 }],
          relationScore: label === 'A' ? 10 : 90,
        },
      ],
      reply: { add: [{ text: '喜欢猫', category: '兴趣爱好', temporality: 'permanent' }] },
      speaker: 'u1',
    });

    await vi.waitFor(() => expect(first.texts(PROFILE_NS, '__self__:Aalis', 'facts')).toContain('喜欢猫'));
    expect(first.texts(PROFILE_NS, '__self__:Aalis', 'facts')).toEqual(['A上的事实', '喜欢猫']);
    expect(second.texts(PROFILE_NS, '__self__:Aalis', 'facts')).toEqual(['B上的事实']);
    expect(first.metadata.get(`${PROFILE_NS}/__self__:Aalis`)?.relationScore).toBe(10);
  });

  it('指令提取：LLM 挂起期间换胜者，新指令落在 A，B 的指令不变', async () => {
    const { first, second } = await runWithWinnerSwitch({
      config: { extractEveryNMessages: 0, enableInstructions: true, instructionExtractEveryNMessages: 1 },
      history: [{ role: 'user', content: '禁言不超过一天', metadata: { userId: 'admin-1', platform: 'onebot' } }],
      seed: label => [
        `${INSTRUCTIONS_NS}/Aalis`,
        { instructions: [{ id: 'i1', text: `${label}上的指令`, updatedAt: 1 }] },
      ],
      reply: { add: [{ text: '禁言不超过一天', severity: 'must', sourceUserKey: 'onebot:admin-1' }] },
      speaker: 'admin-1',
    });

    await vi.waitFor(() => expect(first.texts(INSTRUCTIONS_NS, 'Aalis', 'instructions')).toContain('禁言不超过一天'));
    expect(first.texts(INSTRUCTIONS_NS, 'Aalis', 'instructions')).toEqual(['A上的指令', '禁言不超过一天']);
    expect(second.texts(INSTRUCTIONS_NS, 'Aalis', 'instructions')).toEqual(['B上的指令']);
  });
});
