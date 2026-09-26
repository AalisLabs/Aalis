import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AuthorityService, authority } from '../../packages/api-authority/src/index.js';
import {
  type CommandBuilder,
  type CommandHandler,
  type CommandService,
  commands,
} from '../../packages/api-commands/src/index.js';
import { type HookContextMap, hooks } from '../../packages/api-hooks/src/index.js';
import { llm } from '../../packages/api-llm/src/index.js';
import { memory } from '../../packages/api-memory/src/index.js';
import { App, events, provide } from '../../packages/core/src/index.js';
import memoryInMemory from '../../packages/plugin-memory-inmemory/src/index.js';
import userProfile from '../../packages/plugin-user-profile/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

// ════════════════════════════════════════════════════════════
// 事实提取、自反思、指令提取都是「读快照 → 调 LLM（几秒到几十秒）→ 合并写回」。
// 合并曾以调用前的快照为基底：LLM 调用期间执行的 /clear、/profile.forget、
// /profile.self.clear、/instruct.clear 回执报成功，LLM 返回后清掉的内容整份写回。
// 合并基底须是 LLM 返回后重读的结果，快照里有、重读后已不在的事实不得借 update 复活。
// ════════════════════════════════════════════════════════════

const SESSION = 'onebot:g1';
const PROFILE_NS = 'user:profile';
const INSTRUCTIONS_NS = 'aalis:instructions';

/** 桩 commands 服务：只收集 action，按指令名直接调用 */
function captureCommands() {
  const handlers = new Map<string, CommandHandler>();
  const service = {
    command(name: string): CommandBuilder {
      const builder: CommandBuilder = {
        alias: () => builder,
        option: () => builder,
        usage: () => builder,
        example: () => builder,
        action(handler) {
          handlers.set(name.trim().split(/\s+/)[0], handler);
          return builder;
        },
      };
      return builder;
    },
    unregister() {},
  } as unknown as CommandService;
  return {
    service,
    async run(name: string, ...args: unknown[]): Promise<unknown> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`指令未注册：${name}`);
      return handler(
        { session: { sessionId: SESSION, platform: 'onebot', userId: 'admin-1', raw: '' }, options: {} },
        ...args,
      );
    },
  };
}

/** LLM 桩：进入后挂起，直到 release()；返回固定的 JSON 输出 */
function gatedChat(reply: unknown) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const enteredP = new Promise<void>(r => (entered = r));
  const chat = vi.fn(async () => {
    entered();
    await gate;
    return { content: JSON.stringify(reply) };
  });
  return { chat, entered: enteredP, release: () => release() };
}

const apps: App[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function setup(config: Record<string, unknown>, reply: unknown) {
  const app = new App({ name: 'T', logLevel: 'error' });
  apps.push(app);
  await registerHubs(app);
  const host = app.bind({ provide, events, hooks, memory });
  const llmStub = gatedChat(reply);
  host.provide(llm, { id: 'stub-model', capabilities: ['chat'], chat: llmStub.chat } as never);
  const cmd = captureCommands();
  host.provide(commands, cmd.service);
  host.provide(authority, {
    isOwner: (platform: string, userId?: string) => platform === 'onebot' && userId === 'admin-1',
    listUsers: () => [],
  } as unknown as AuthorityService);
  await app.plugins.register(memoryInMemory, {});
  await app.plugins.idle();
  const mem = host.memory.current;
  if (!mem) throw new Error('memory 服务未就绪');
  await app.plugins.register(userProfile, {
    extractEveryNMessages: 0,
    enableSelfProfile: false,
    enableInstructions: false,
    relationIncrementWitness: 0,
    ...config,
  });
  await app.plugins.idle();
  if (app.plugins.getPlugin(userProfile.name)?.state !== 'active') throw new Error('user-profile 未激活');
  const inbound = (userId: string) =>
    host.events.emit('inbound:message:archived', {
      sessionId: SESSION,
      incoming: { userId, platform: 'onebot' },
    } as never);
  const clearAll = async () => {
    const data: HookContextMap['memory:clear'] = {
      scope: 'all',
      types: ['user-profile'],
      sessionId: SESSION,
      results: [],
    };
    await host.hooks.run('memory:clear', data, async () => {});
    return data.results;
  };
  return { mem, cmd, llm: llmStub, inbound, clearAll };
}

const factTexts = (doc: Record<string, unknown> | undefined) =>
  ((doc?.facts as Array<{ text: string }> | undefined) ?? []).map(f => f.text);

describe('plugin-user-profile: LLM 调用期间的清除不被合并写回撤销', () => {
  it('事实提取挂起期间 /clear all：旧事实、关系分、互动次数不回来', async () => {
    const { mem, llm, inbound, clearAll } = await setup(
      { extractEveryNMessages: 1 },
      { add: [{ text: '喜欢猫', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢猫' }] },
    );
    await mem.saveMessage(SESSION, {
      role: 'user',
      content: '我喜欢猫',
      metadata: { userId: 'u1', platform: 'onebot' },
    });
    await mem.saveMetadata(PROFILE_NS, 'onebot:u1', {
      facts: [{ id: 'fold', text: '旧事实', temporality: 'permanent', observedAt: 1, updatedAt: 1 }],
      relationScore: 88,
      interactionCount: 50,
      updatedAt: 1,
    });

    await inbound('u1');
    await llm.entered;
    // 同一事件里的旁观计数先落定，再清
    await vi.waitFor(async () => expect((await mem.getMetadata(PROFILE_NS, 'onebot:u1'))?.interactionCount).toBe(51));
    const results = await clearAll();
    expect(results[0]).toMatchObject({ source: 'user-profile', success: true });
    expect(await mem.getMetadata(PROFILE_NS, 'onebot:u1')).toBeUndefined();

    llm.release();
    await vi.waitFor(async () => expect(factTexts(await mem.getMetadata(PROFILE_NS, 'onebot:u1'))).toContain('喜欢猫'));
    const doc = await mem.getMetadata(PROFILE_NS, 'onebot:u1');
    expect(factTexts(doc), '清空前的事实不得写回').toEqual(['喜欢猫']);
    expect(doc?.relationScore).toBe(0);
    expect(doc?.interactionCount).toBe(0);
  });

  it('事实提取挂起期间 /profile.forget：被删的事实不因 LLM 对它的 update 复活，其余事实保留', async () => {
    const { mem, cmd, llm, inbound } = await setup(
      { extractEveryNMessages: 1 },
      {
        update: [{ id: 'f1', text: '喜欢猫', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢猫' }],
        add: [{ text: '喜欢狗', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢狗' }],
      },
    );
    await mem.saveMessage(SESSION, {
      role: 'user',
      content: '我喜欢猫，我喜欢狗',
      metadata: { userId: 'u1', platform: 'onebot' },
    });
    await mem.saveMetadata(PROFILE_NS, 'onebot:u1', {
      facts: [
        { id: 'f1', text: '投毒事实', temporality: 'permanent', observedAt: 1, updatedAt: 1 },
        { id: 'f2', text: '事实二', temporality: 'permanent', observedAt: 2, updatedAt: 2 },
      ],
      updatedAt: 1,
    });

    await inbound('u1');
    await llm.entered;
    await vi.waitFor(async () => expect((await mem.getMetadata(PROFILE_NS, 'onebot:u1'))?.interactionCount).toBe(1));
    expect(String(await cmd.run('profile.forget', 'onebot:u1', 'f1'))).toContain('已删除');

    llm.release();
    await vi.waitFor(async () => expect(factTexts(await mem.getMetadata(PROFILE_NS, 'onebot:u1'))).toContain('喜欢狗'));
    expect(factTexts(await mem.getMetadata(PROFILE_NS, 'onebot:u1'))).toEqual(['事实二', '喜欢狗']);
  });

  it('对照：update 引用快照里本就没有的 id（LLM 编造）仍按新增写入', async () => {
    const { mem, llm, inbound } = await setup(
      { extractEveryNMessages: 1 },
      {
        update: [
          { id: 'zz-made-up', text: '喜欢鸟', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢鸟' },
        ],
        add: [{ text: '喜欢鱼', category: '兴趣爱好', temporality: 'permanent', sourceQuote: '我喜欢鱼' }],
      },
    );
    await mem.saveMessage(SESSION, {
      role: 'user',
      content: '我喜欢鸟，我喜欢鱼',
      metadata: { userId: 'u1', platform: 'onebot' },
    });
    await mem.saveMetadata(PROFILE_NS, 'onebot:u1', {
      facts: [{ id: 'f1', text: '事实一', temporality: 'permanent', observedAt: 1, updatedAt: 1 }],
      updatedAt: 1,
    });

    await inbound('u1');
    await llm.entered;
    llm.release();
    await vi.waitFor(async () => expect(factTexts(await mem.getMetadata(PROFILE_NS, 'onebot:u1'))).toContain('喜欢鱼'));
    expect(factTexts(await mem.getMetadata(PROFILE_NS, 'onebot:u1'))).toEqual(['事实一', '喜欢鸟', '喜欢鱼']);
  });

  it('自反思挂起期间 /profile.self.clear：旧自档案不回来', async () => {
    const { mem, cmd, llm, inbound } = await setup(
      { enableSelfProfile: true, selfReflectEveryNMessages: 1 },
      { add: [{ text: '最近想多聊天', category: '性格特征', temporality: 'temporary' }] },
    );
    await mem.saveMessage(SESSION, { role: 'assistant', content: '今天也来聊聊吧' });
    await mem.saveMetadata(PROFILE_NS, '__self__:Aalis', {
      facts: [{ id: 's1', text: '旧心境', temporality: 'permanent', observedAt: 1, updatedAt: 1 }],
      updatedAt: 1,
    });

    await inbound('u1');
    await llm.entered;
    expect(String(await cmd.run('profile.self.clear'))).toContain('已清空');

    llm.release();
    await vi.waitFor(async () =>
      expect(factTexts(await mem.getMetadata(PROFILE_NS, '__self__:Aalis'))).toEqual(['最近想多聊天']),
    );
  });

  it('指令提取挂起期间 /instruct.clear：旧指令不回来', async () => {
    const { mem, cmd, llm, inbound } = await setup(
      { enableInstructions: true, instructionExtractEveryNMessages: 1 },
      {
        add: [
          {
            text: '禁言不超过一天',
            category: '审核与处罚',
            severity: 'must',
            sourceUserKey: 'onebot:admin-1',
            sourceUserName: '管理员',
          },
        ],
      },
    );
    await mem.saveMessage(SESSION, {
      role: 'user',
      content: '以后禁言不超过一天',
      metadata: { userId: 'admin-1', platform: 'onebot' },
    });
    await mem.saveMetadata(INSTRUCTIONS_NS, 'Aalis', {
      instructions: [{ id: 'i1', text: '旧指令', updatedAt: 1, observedAt: 1 }],
      updatedAt: 1,
    });

    await inbound('admin-1');
    await llm.entered;
    expect(String(await cmd.run('instruct.clear'))).toContain('已清空');

    llm.release();
    const texts = async () =>
      ((await mem.getMetadata(INSTRUCTIONS_NS, 'Aalis'))?.instructions as Array<{ text: string }> | undefined)?.map(
        i => i.text,
      );
    await vi.waitFor(async () => expect(await texts()).toEqual(['禁言不超过一天']));
  });
});
