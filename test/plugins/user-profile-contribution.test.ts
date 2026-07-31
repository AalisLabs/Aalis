import { describe, expect, it } from 'vitest';
import type { MemoryService } from '../../packages/api-memory/src/index.js';
import { App } from '../../packages/core/src/index.js';
import { assemblePromptContributions } from '../../packages/plugin-agent/src/prompt-assembly.js';
import * as memoryInMemoryModule from '../../packages/plugin-memory-inmemory/src/index.js';
import * as userProfileModule from '../../packages/plugin-user-profile/src/index.js';
import type { Message } from '../../packages/schema-message/src/index.js';

// ════════════════════════════════════════════════════════════
// plugin-user-profile 的 agent:prompt 贡献 build（anchor='identity'，多块返回）
//
// 档案落在 memory 的 metadata 上，本测试直接经 memory.saveMetadata 种入：
//   - user:profile / `${platform}:${userId}`  → 用户档案（facts / aalisFeelings / relationScore …）
//   - user:profile / `__self__:<persona>`     → Aalis 自档案（persona 服务缺席时 persona 名 = 'Aalis'）
//   - aalis:instructions / `<persona>`        → 第三方行为指令
// ════════════════════════════════════════════════════════════

const PROFILE_NS = 'user:profile';
const INSTRUCTIONS_NS = 'aalis:instructions';
/** persona 服务缺席时插件回退的默认 persona 名 */
const SELF_KEY = '__self__:Aalis';
/** 固定时间戳，避免渲染「记录于」等时间派生内容随运行时刻漂移 */
const TS = Date.UTC(2026, 0, 15, 8, 0, 0);

function makeFact(id: string, text: string, category?: string, updatedAt = TS) {
  return { id, text, category, temporality: 'permanent', observedAt: updatedAt, updatedAt };
}

async function setup(config: Record<string, unknown> = {}) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  // user-profile 的 inject.required 含 'llm'；build 路径不会触达它，
  // 这里只需一个占位 provider 让插件能激活（不联网、不调真模型）。
  app.ctx.provide('llm', { chat: async () => ({ content: '' }) });
  await app.ctx.useModule(memoryInMemoryModule);
  const memory = app.ctx.getService<MemoryService>('memory');
  if (!memory?.getMetadata || !memory.listMetadata) throw new Error('memory 服务未就绪');
  // 读取计数代理：透传原实现，只记 getMetadata/listMetadata 调用次数。
  // 插件每次经 getService 取到的都是同一实例，实例属性覆盖原型方法即全程生效。
  const reads = { count: 0 };
  const rawGetMetadata = memory.getMetadata.bind(memory);
  const rawListMetadata = memory.listMetadata.bind(memory);
  memory.getMetadata = (namespace, key) => {
    reads.count += 1;
    return rawGetMetadata(namespace, key);
  };
  memory.listMetadata = namespace => {
    reads.count += 1;
    return rawListMetadata(namespace);
  };
  await app.ctx.useModule(userProfileModule, config);
  await app.plugins.idle();
  return { app, memory, reads };
}

/**
 * 主发言者 u1 的默认对话消息（携带 userId / platform 元数据，供「其他参与者」扫描）。
 * 前置两条 system（persona + guard）用于钉死 identity 锚位：identity = 首条 system 之后，
 * 块应落在两条 system 之间；若锚位错成 knowledge/context（头部 system 区末尾）会落到 guard 之后。
 */
function baseMessages(extra: Message[] = []): Message[] {
  return [
    { role: 'system', content: 'persona' },
    { role: 'system', content: 'guard' },
    ...extra,
    { role: 'user', content: '在吗', metadata: { userId: 'u1', platform: 'onebot' } },
  ];
}

/** 取本插件注入的全部块（injector 全局键后缀为 /user-profile） */
function injectedBlocks(messages: Message[]): Message[] {
  return messages.filter(m => String(m.metadata?.injector ?? '').endsWith('/user-profile'));
}

async function seedPrimaryProfile(memory: MemoryService, extra: Record<string, unknown> = {}) {
  await memory.saveMetadata!(PROFILE_NS, 'onebot:u1', {
    facts: [makeFact('f001', '喜欢养猫', '兴趣爱好'), makeFact('f002', '是后端工程师', '职业身份')],
    relationScore: 12.5,
    interactionCount: 7,
    lastInteractionAt: TS,
    updatedAt: TS,
    ...extra,
  });
}

describe('plugin-user-profile: agent:prompt 贡献', () => {
  it('dryRun：不注入，且完全跳过档案 IO（零元数据读取）', async () => {
    const { app, memory, reads } = await setup();
    await seedPrimaryProfile(memory);

    const messages = baseMessages();
    reads.count = 0; // 只统计本次组装期间的读取
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
      dryRun: true,
    });
    expect(injectedBlocks(messages)).toHaveLength(0);
    expect(messages).toHaveLength(3);
    // dryRun 的存在理由是跳过昂贵的档案加载——不止「没注入」，读取本身必须为零
    expect(reads.count).toBe(0);
  });

  it.each([
    'direct',
    'immediate',
    undefined,
  ] as const)('triggerType=%s + 主发言者有档案：注入完整档案块（含事实与关系强度）', async triggerType => {
    const { app, memory } = await setup();
    await seedPrimaryProfile(memory);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType, // undefined 走插件内 `?? 'direct'` 默认分支
    });

    const blocks = injectedBlocks(messages);
    expect(blocks).toHaveLength(1);
    const content = String(blocks[0].content);
    expect(content).toContain('关于当前对话者（u1）的已知事实');
    expect(content).toContain('喜欢养猫');
    expect(content).toContain('是后端工程师');
    // 非 compact 渲染带分组标题
    expect(content).toContain('## 兴趣爱好');
    expect(content).toContain('## 职业身份');
    expect(content).toContain('关系强度：12.5/100');
    expect(content).toContain('累计互动：7 次');
    // identity 锚位：块应精确落在 persona 与 guard 两条 system 之间
    expect(messages[0].content).toBe('persona');
    expect(messages[1]).toBe(blocks[0]);
    expect(messages[2].content).toBe('guard');
  });

  it('多块返回：准则 → 自档案 → 主发言者档案 → 主观感受 → 其他参与者，块序稳定且共用同一 injector 键', async () => {
    const { app, memory } = await setup({
      enableInstructions: true,
      enableSelfProfile: true,
      enableAalisFeelings: true,
      maxOtherParticipants: 3,
    });

    await memory.saveMetadata!(INSTRUCTIONS_NS, 'Aalis', {
      instructions: [
        {
          id: 'i001',
          text: '不要单条禁言超过 24 小时',
          category: '审核与处罚',
          severity: 'must',
          sourceUserName: '管理员甲',
          observedAt: TS,
          updatedAt: TS,
        },
      ],
      updatedAt: TS,
    });
    await memory.saveMetadata!(PROFILE_NS, SELF_KEY, {
      facts: [makeFact('s001', '最近对长对话有点疲惫', '性格特征')],
      updatedAt: TS,
    });
    await seedPrimaryProfile(memory, {
      aalisFeelings: [makeFact('g001', '觉得他讲话很直接')],
    });
    await memory.saveMetadata!(PROFILE_NS, 'onebot:u2', {
      facts: [makeFact('f201', '常在深夜发言', '其他')],
      relationScore: 3,
      interactionCount: 2,
      lastInteractionAt: TS,
      updatedAt: TS,
    });

    const messages = baseMessages([
      { role: 'user', content: '我也在', metadata: { userId: 'u2', platform: 'onebot', nickname: '小二' } },
    ]);
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
    });

    const blocks = injectedBlocks(messages);
    expect(blocks).toHaveLength(5);
    const contents = blocks.map(b => String(b.content));
    expect(contents[0]).toContain('第三方行为准则（最高优先）');
    expect(contents[0]).toContain('不要单条禁言超过 24 小时');
    expect(contents[0]).toContain('【必须】');
    expect(contents[1]).toContain('关于你自己（Aalis）的近期内心状态');
    expect(contents[1]).toContain('最近对长对话有点疲惫');
    expect(contents[2]).toContain('关于当前对话者（u1）的已知事实');
    expect(contents[3]).toContain('你（Aalis）对该用户的主观感受');
    expect(contents[3]).toContain('觉得他讲话很直接');
    expect(contents[4]).toContain('群聊其他参与者背景摘要');
    expect(contents[4]).toContain('小二（u2）');
    expect(contents[4]).toContain('常在深夜发言');
    // 主发言者不出现在「其他参与者」里
    expect(contents[4]).not.toContain('喜欢养猫');

    // 多块共用同一全局键
    const keys = new Set(blocks.map(b => String(b.metadata?.injector)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toMatch(/\/user-profile$/);

    // 五块连续落在 persona 与 guard 之间（identity 锚位），中间不夹别的消息
    const first = messages.indexOf(blocks[0]);
    expect(first).toBe(1);
    expect(messages.slice(first, first + 5)).toEqual(blocks);
    expect(messages[first + 5].content).toBe('guard');
  });

  it('triggerType=interval：不注入主发言者完整档案，改为「在场参与者」compact 摘要', async () => {
    const { app, memory } = await setup({ maxOtherParticipants: 3 });
    await seedPrimaryProfile(memory);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'interval',
    });

    const blocks = injectedBlocks(messages);
    expect(blocks).toHaveLength(1);
    const content = String(blocks[0].content);
    expect(content).toContain('在场参与者背景摘要');
    expect(content).not.toContain('关于当前对话者');
    // compact 渲染：无分组标题，事实平铺
    expect(content).not.toContain('## 兴趣爱好');
    expect(content).toContain('### u1');
    expect(content).toContain('喜欢养猫');
  });

  it('triggerType=interval + maxOtherParticipants=0：完全不注入', async () => {
    const { app, memory } = await setup({ maxOtherParticipants: 0 });
    await seedPrimaryProfile(memory);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'interval',
    });
    expect(injectedBlocks(messages)).toHaveLength(0);
  });

  it('无任何档案：build 返回 null，不注入', async () => {
    const { app } = await setup();
    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
    });
    expect(injectedBlocks(messages)).toHaveLength(0);
    expect(messages).toHaveLength(3);
  });

  it('主发言者档案只剩过期 temporary 事实：不注入', async () => {
    const { app, memory } = await setup({ temporaryFactMaxAgeDays: 90, maxOtherParticipants: 0 });
    const stale = Date.now() - 200 * 86_400_000;
    await memory.saveMetadata!(PROFILE_NS, 'onebot:u1', {
      facts: [
        {
          id: 'f900',
          text: '这周在出差',
          category: '近期处境',
          temporality: 'temporary',
          observedAt: stale,
          updatedAt: stale,
        },
      ],
      relationScore: 5,
      interactionCount: 3,
      updatedAt: stale,
    });

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
    });
    expect(injectedBlocks(messages)).toHaveLength(0);
  });

  it('enableSelfProfile=false：已有自档案也不注入', async () => {
    const { app, memory } = await setup({ enableSelfProfile: false, maxOtherParticipants: 0 });
    await memory.saveMetadata!(PROFILE_NS, SELF_KEY, {
      facts: [makeFact('s001', '自我观察占位')],
      updatedAt: TS,
    });
    await seedPrimaryProfile(memory);

    const messages = baseMessages();
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct',
    });

    const blocks = injectedBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(String(blocks[0].content)).toContain('关于当前对话者（u1）的已知事实');
    expect(String(blocks[0].content)).not.toContain('自我观察占位');
  });

  it('allowGlobalBackfill 跨会话补齐：自档案不会被当作「在场参与者」泄漏', async () => {
    const { app, memory } = await setup({
      allowGlobalBackfill: true,
      maxOtherParticipants: 3,
      enableSelfProfile: false,
    });
    await memory.saveMetadata!(PROFILE_NS, SELF_KEY, {
      facts: [makeFact('s001', '自档案私密内容')],
      updatedAt: TS,
    });
    await memory.saveMetadata!(PROFILE_NS, 'onebot:u2', {
      facts: [makeFact('f201', '常在深夜发言', '其他')],
      relationScore: 3,
      interactionCount: 2,
      lastInteractionAt: TS,
      updatedAt: TS,
    });

    // 上下文里没有任何带 userId 的消息 → 只能靠 listMetadata 补齐
    const messages: Message[] = [
      { role: 'system', content: 'persona' },
      { role: 'user', content: '（群里有人闲聊）' },
    ];
    await assemblePromptContributions(app.ctx, {
      messages,
      sessionId: 's1',
      platform: 'onebot',
      triggerType: 'idle',
    });

    const blocks = injectedBlocks(messages);
    expect(blocks).toHaveLength(1);
    const content = String(blocks[0].content);
    expect(content).toContain('在场参与者背景摘要');
    expect(content).toContain('常在深夜发言');
    expect(content).not.toContain('自档案私密内容');
    expect(content).not.toContain('__self__');
  });

  it('幂等：同一 messages 重复组装不重复注入', async () => {
    const { app, memory } = await setup();
    await seedPrimaryProfile(memory);

    const messages = baseMessages();
    const view = {
      messages,
      sessionId: 's1',
      userId: 'u1',
      platform: 'onebot',
      triggerType: 'direct' as const,
    };
    await assemblePromptContributions(app.ctx, view);
    await assemblePromptContributions(app.ctx, view);
    expect(injectedBlocks(messages)).toHaveLength(1);
  });
});
