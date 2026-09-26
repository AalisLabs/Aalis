import { describe, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import {
  defaultTriggerPolicyConfig,
  resolveTriggerPolicyConfig,
} from '../../packages/plugin-trigger-policy/src/config.js';
import {
  checkImmediateMention,
  checkImmediateTrigger,
  checkMuteKeyword,
  checkNameMention,
  getBotNames,
  type PersonaRef,
} from '../../packages/plugin-trigger-policy/src/detector.js';
import {
  applyScoreDecay,
  calculateScoreIncrement,
  createState,
  getCurrentThreshold,
  SESSION_TTL_MS,
  sweepStaleStates,
} from '../../packages/plugin-trigger-policy/src/state.js';

/** 名字检测只读 persona 的当前提供者：给出 current 即可，不必伪造整个绑定接口 */
const personaRef = (service?: PersonaService): PersonaRef => ({ current: service });

describe('trigger-policy config', () => {
  it('resolve 默认值', () => {
    const c = resolveTriggerPolicyConfig({});
    expect(c.intervalMode).toBe(defaultTriggerPolicyConfig.intervalMode);
    expect(c.triggerOnAt).toBe(true);
  });

  it('评分与闲置触发字段（自 flow-control 迁入）字段名与默认值不变', () => {
    const c = resolveTriggerPolicyConfig({});
    expect(c).toMatchObject({
      fixedInterval: 5,
      activityScoreLower: 0.3,
      activityScoreUpper: 0.85,
      activityDecayMinutes: 10,
      scoreDecayMinutes: 0,
      idleTriggerScope: 'off',
      idleTriggerStrategy: 'all-quiet',
      idleTriggerMinutes: 180,
      idleTriggerStyle: 'exponential',
      idleTriggerMaxMinutes: 1440,
      idleTriggerJitter: true,
      idleTriggerPrompt: '',
    });
    const set = resolveTriggerPolicyConfig({ fixedInterval: 100, scoreDecayMinutes: 10, idleTriggerScope: 'session' });
    expect(set).toMatchObject({ fixedInterval: 100, scoreDecayMinutes: 10, idleTriggerScope: 'session' });
  });

  it('resolve 逗号分隔 triggerNames', () => {
    const c = resolveTriggerPolicyConfig({ triggerNames: 'aalis, alice ,bob' });
    expect(c.triggerNames).toEqual(['aalis', 'alice', 'bob']);
  });

  it('resolve 逗号分隔 muteKeywords', () => {
    const c = resolveTriggerPolicyConfig({ muteKeywords: '闭嘴,别说话' });
    expect(c.muteKeywords).toEqual(['闭嘴', '别说话']);
  });

  it('intervalMode 非法值回退', () => {
    const c = resolveTriggerPolicyConfig({ intervalMode: 'bogus' as unknown });
    expect(c.intervalMode).toBe(defaultTriggerPolicyConfig.intervalMode);
  });

  it('判定截止与识别等待：默认 2000 / 8000 毫秒；非法值回退默认，识别等待允许 0', () => {
    expect(resolveTriggerPolicyConfig({})).toMatchObject({ decisionTimeoutMs: 2000, mediaWaitMs: 8000 });
    expect(resolveTriggerPolicyConfig({ decisionTimeoutMs: 0, mediaWaitMs: -1 })).toMatchObject({
      decisionTimeoutMs: 2000,
      mediaWaitMs: 8000,
    });
    expect(resolveTriggerPolicyConfig({ decisionTimeoutMs: 500, mediaWaitMs: 0 })).toMatchObject({
      decisionTimeoutMs: 500,
      mediaWaitMs: 0,
    });
  });

  it('idleTriggerScope 非法值回退默认', () => {
    const c = resolveTriggerPolicyConfig({ idleTriggerScope: 'bogus' as unknown });
    expect(c.idleTriggerScope).toBe(defaultTriggerPolicyConfig.idleTriggerScope);
  });
});

describe('trigger-policy state', () => {
  it('calculateScoreIncrement 默认权重 = 1/fixedInterval', () => {
    const s = createState('p');
    const inc = calculateScoreIncrement(s, defaultTriggerPolicyConfig);
    expect(inc).toBeCloseTo(1 / defaultTriggerPolicyConfig.fixedInterval, 5);
  });

  it('calculateScoreIncrement 用户高频时权重抬升', () => {
    const s = createState('p');
    s.userInteractions.set('u1', 20);
    const incHigh = calculateScoreIncrement(s, defaultTriggerPolicyConfig, 'u1');
    const incBase = calculateScoreIncrement(s, defaultTriggerPolicyConfig);
    expect(incHigh).toBeGreaterThan(incBase);
    // 上限 1.5×
    expect(incHigh).toBeLessThanOrEqual(incBase * 1.5 + 1e-6);
  });

  it('applyScoreDecay 在 scoreDecayMinutes=0 时不衰减', () => {
    const s = createState('p');
    s.activityScore = 0.8;
    s.lastMessageTime = Date.now() - 60_000;
    applyScoreDecay(s, defaultTriggerPolicyConfig);
    expect(s.activityScore).toBe(0.8);
  });

  it('applyScoreDecay 时间过去半周期 ≈ 半值', () => {
    const cfg = { ...defaultTriggerPolicyConfig, scoreDecayMinutes: 10 };
    const s = createState('p');
    s.activityScore = 1.0;
    s.lastMessageTime = Date.now() - 5 * 60 * 1000; // 半个衰减周期
    applyScoreDecay(s, cfg);
    expect(s.activityScore).toBeGreaterThan(0.4);
    expect(s.activityScore).toBeLessThan(0.6);
  });

  it('applyScoreDecay 超过周期清零', () => {
    const cfg = { ...defaultTriggerPolicyConfig, scoreDecayMinutes: 1 };
    const s = createState('p');
    s.activityScore = 1.0;
    s.lastMessageTime = Date.now() - 10 * 60 * 1000;
    applyScoreDecay(s, cfg);
    expect(s.activityScore).toBe(0);
  });

  it('getCurrentThreshold 首次触发前 = lower', () => {
    const s = createState('p');
    expect(getCurrentThreshold(s, defaultTriggerPolicyConfig)).toBe(defaultTriggerPolicyConfig.activityScoreLower);
  });

  it('getCurrentThreshold 刚触发后 ≈ upper；bot 开口不影响阈值', () => {
    const s = createState('p');
    s.lastBotActivityAt = Date.now();
    expect(getCurrentThreshold(s, defaultTriggerPolicyConfig)).toBe(defaultTriggerPolicyConfig.activityScoreLower);
    s.lastTriggerTime = Date.now();
    const t = getCurrentThreshold(s, defaultTriggerPolicyConfig);
    expect(t).toBeGreaterThan(defaultTriggerPolicyConfig.activityScoreUpper - 0.01);
  });
});

describe('trigger-policy TTL 清扫', () => {
  it('超过 TTL 无活动且无 idle 定时器的会话被删；bot 开口算活动；有定时器的保留', () => {
    const now = Date.now();
    const stale = createState('onebot');
    stale.lastMessageTime = now - SESSION_TTL_MS - 1;
    const botSpoke = createState('onebot');
    botSpoke.lastMessageTime = now - SESSION_TTL_MS - 1;
    botSpoke.lastBotActivityAt = now - 60_000;
    const scheduled = createState('onebot');
    scheduled.lastMessageTime = now - SESSION_TTL_MS - 1;
    scheduled.idleTimer = setTimeout(() => {}, 0);
    clearTimeout(scheduled.idleTimer);
    const states = new Map([
      ['stale', stale],
      ['botSpoke', botSpoke],
      ['scheduled', scheduled],
    ]);

    expect(sweepStaleStates(states, now)).toBe(1);
    expect([...states.keys()].sort()).toEqual(['botSpoke', 'scheduled']);
  });
});

describe('checkImmediateMention (@ 检测)', () => {
  it('OneBot 内联 <at> 命中', () => {
    expect(checkImmediateMention('<at self>123</at> hi')).toBe(true);
    expect(checkImmediateMention('<at self qq="1">x</at>')).toBe(true);
  });
  it('裸 CQ 码不再命中（adapter 入站已规范化成 <at self>，CQ 码到不了这里）', () => {
    expect(checkImmediateMention('[CQ:at,qq=12345] 你好')).toBe(false);
  });
  it('@别人（<at> 无 self）不命中', () => {
    expect(checkImmediateMention('<at id="999">路人</at> 你好')).toBe(false);
  });
  it('普通文本 @nickname 不再视作 @ 提及（避免 @他人 误触发）', () => {
    expect(checkImmediateMention('hi @aalis 帮我')).toBe(false);
  });
  it('无 @ 不命中', () => {
    expect(checkImmediateMention('hello world')).toBe(false);
  });
});

describe('checkNameMention', () => {
  it('包含名字 → 命中', () => {
    expect(checkNameMention('阿狸你好', ['阿狸'])).toBe(true);
  });
  it('未包含名字 → 不命中', () => {
    expect(checkNameMention('随便聊聊', ['阿狸'])).toBe(false);
  });
  it('空名字数组', () => {
    expect(checkNameMention('something', [])).toBe(false);
  });
  it('忽略空字符串名', () => {
    expect(checkNameMention('hello', ['', 'hello'])).toBe(true);
    expect(checkNameMention('hello', [''])).toBe(false);
  });
});

describe('getBotNames', () => {
  it('无 persona 服务时返回 cfg.triggerNames', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerNames: ['a', 'b'] };
    expect(getBotNames(personaRef(), cfg)).toEqual(['a', 'b']);
  });
  it('有 persona 服务时合并 + 去重', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerNames: ['a'] };
    const persona: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => 'aalis',
      getNickNames: () => ['a', 'amy'],
    };
    expect(getBotNames(personaRef(persona), cfg)).toEqual(['a', 'aalis', 'amy']);
  });
});

describe('checkImmediateTrigger', () => {
  it('triggerOnAt 关闭时不响应 @', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: false, triggerNames: [] };
    expect(checkImmediateTrigger(personaRef(), cfg, '@aalis hi')).toBe(false);
  });
  it('triggerOnAt 开启但仅纯文本 @ 时不命中（由名字检测兜底）', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: true, triggerNames: [] };
    expect(checkImmediateTrigger(personaRef(), cfg, '@aalis hi')).toBe(false);
  });
  it('triggerOnAt 开启且为 <at self> 时命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: true, triggerNames: [] };
    expect(checkImmediateTrigger(personaRef(), cfg, '<at self id="1">bot</at> hi')).toBe(true);
  });
  it('名字匹配也命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: false, triggerNames: ['aalis'] };
    expect(checkImmediateTrigger(personaRef(), cfg, 'aalis 你好')).toBe(true);
  });
});

describe('checkMuteKeyword', () => {
  it('cfg 关键词命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, muteKeywords: ['闭嘴'] };
    expect(checkMuteKeyword(cfg, '你给我闭嘴')).toBe(true);
  });
  it('只认 cfg 下发的关键词：persona 等别处的词不命中（避免单例 PersonaService 跨平台泄漏）', () => {
    const cfg = { ...defaultTriggerPolicyConfig, muteKeywords: [] };
    expect(checkMuteKeyword(cfg, 'please stop')).toBe(false);
  });
  it('全部不命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, muteKeywords: ['x'] };
    expect(checkMuteKeyword(cfg, 'hello world')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// inbound:trigger 相位（走真实插件装配，不装 gateway 插件 / flow-control）
// ════════════════════════════════════════════════════════════

import { App, provide } from '@aalis/core';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

/** 每条消息都达到计数阈值：非直触发的群消息一律判 interval，用来观察是否走到了意愿评估 */
const EVERY_MESSAGE = { intervalMode: 'fixed', fixedInterval: 1 };

async function setupPolicy(config: Record<string, unknown> = {}, personaService?: PersonaService) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, hooks });
  host.provide(gateway, {} as never); // 满足 required 依赖；相位判定本身不经过 gateway
  if (personaService) host.provide(persona, personaService);
  await app.plugins.register(triggerPolicyPlugin, config);
  await app.plugins.idle();
  // 激活闸：required 依赖缺席时插件停在 pending 而不报错，不核状态会让整组用例伪装成绿
  const state = app.plugins.getPlugin(triggerPolicyPlugin.name)?.state;
  if (state !== 'active') throw new Error(`trigger-policy 插件未激活（state=${state}）`);
  return { app, host };
}

/** 直接驱动 inbound:trigger 钩子链 */
async function runTriggerPhase(
  chain: Hooks,
  message: IncomingMessage,
): Promise<{ reached: boolean; message: IncomingMessage }> {
  let reached = false;
  await chain.run('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
  });
  return { reached, message };
}

const pokeMsg = (platform = 'onebot'): IncomingMessage =>
  ({
    platform,
    sessionType: 'group',
    sessionId: `${platform}:bot:group:g1`,
    groupId: 'g1',
    userId: 'u1',
    role: 'notice',
    content: '',
    noticeType: 'poke',
  }) as unknown as IncomingMessage;

describe('trigger-policy inbound:trigger（poke）', () => {
  it('默认：poke 直触发（immediate）', async () => {
    const { app, host } = await setupPolicy();
    const { reached, message } = await runTriggerPhase(host.hooks, pokeMsg());
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('immediate');
  });

  it('triggerOnPoke=false：不直触发，落回正常意愿评估', async () => {
    const { app, host } = await setupPolicy({ triggerOnPoke: false, ...EVERY_MESSAGE });
    const { reached, message } = await runTriggerPhase(host.hooks, pokeMsg());
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType, '走到了计数判定而不是直触发').toBe('interval');
  });

  it('triggerOnPoke=false 且未到阈值：poke 被吞', async () => {
    const { app, host } = await setupPolicy({ triggerOnPoke: false });
    const { reached } = await runTriggerPhase(host.hooks, pokeMsg());
    await app.stop();
    expect(reached).toBe(false);
  });

  it('分作用域覆盖：仅指定 scope 关闭 poke 直触发，其余平台不受影响', async () => {
    const { app, host } = await setupPolicy({
      ...EVERY_MESSAGE,
      overrides: [{ scope: 'onebot:group', triggerOnPoke: false }],
    });
    const onebot = await runTriggerPhase(host.hooks, pokeMsg('onebot'));
    const telegram = await runTriggerPhase(host.hooks, pokeMsg('telegram'));
    await app.stop();
    expect(onebot.message.triggerType).toBe('interval');
    expect(telegram.message.triggerType).toBe('immediate');
  });

  it('非 poke 的 noticeType 不享受直触发（谓词只认词汇表里的 poke）', async () => {
    const { app, host } = await setupPolicy(EVERY_MESSAGE);
    const msg = { ...pokeMsg(), noticeType: 'group_increase' } as IncomingMessage;
    const { message } = await runTriggerPhase(host.hooks, msg);
    await app.stop();
    expect(message.triggerType).toBe('interval');
  });

  it('关闭后戳者昵称含 bot 名也不得经名字检测绕回直触发（合成文案是元数据非发言）', async () => {
    const { app, host } = await setupPolicy({ triggerOnPoke: false, triggerNames: 'Aalis', ...EVERY_MESSAGE });
    // adapter 真实合成格式：昵称内嵌在 content 里，用户可控
    const msg = { ...pokeMsg(), content: '[戳一戳: Aalis的小跟班(12345) 戳了你]' } as IncomingMessage;
    const poke = await runTriggerPhase(host.hooks, msg);
    // 对照：同样内容的普通消息（非 poke）该命中名字检测
    const normal = await runTriggerPhase(host.hooks, { ...msg, noticeType: undefined } as IncomingMessage);
    await app.stop();
    expect(poke.message.triggerType, '昵称含 bot 名的用户不得让开关对自己失效').toBe('interval');
    expect(normal.message.triggerType).toBe('immediate');
  });
});

describe('trigger-policy inbound:trigger（判定异常）', () => {
  it('名字检测调 persona 抛错时放行而不是吞掉', async () => {
    const broken: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => {
        throw new Error('persona 故障');
      },
    };
    const { app, host } = await setupPolicy({}, broken);
    const { reached, message } = await runTriggerPhase(host.hooks, {
      platform: 'onebot',
      sessionType: 'group',
      sessionId: 'onebot:bot:group:g1',
      groupId: 'g1',
      userId: 'u1',
      content: '随便聊聊',
    } as IncomingMessage);
    await app.stop();
    expect(reached, '判定失败应放行').toBe(true);
    expect(message.triggerType, '未完成判定，不写 triggerType').toBeUndefined();
  });
});

describe('trigger-policy config (triggerOnPoke)', () => {
  it('默认 true；显式 false 可关；override 解析布尔', () => {
    expect(resolveTriggerPolicyConfig({}).triggerOnPoke).toBe(true);
    expect(resolveTriggerPolicyConfig({ triggerOnPoke: false }).triggerOnPoke).toBe(false);
    const c = resolveTriggerPolicyConfig({ overrides: [{ scope: '*:group', triggerOnPoke: false }] });
    expect(c.overrides[0]?.triggerOnPoke).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// inbound:trigger 中间件写进 message 的身份：interval 回合无主体
// ════════════════════════════════════════════════════════════

const groupMsg = (content: string, userId = 'owner-1'): IncomingMessage =>
  ({
    platform: 'onebot',
    sessionType: 'group',
    sessionId: 'onebot:bot:group:g1',
    groupId: 'g1',
    userId,
    nickname: '群主',
    content,
  }) as unknown as IncomingMessage;

describe('trigger-policy inbound:trigger 授权身份', () => {
  it('interval 触发：回填无主体 actor（空 userId），不继承撞阈值那条消息的发言者身份', async () => {
    // 事故形态（2026-09 日志实测 1415 次 interval 触发）：authority 经 actor ?? {platform,userId}
    // 回退到最后发言者——99.4% 回合按陌生人 0 级判权，owner 恰好最后发言时整轮按 owner 执行。
    const { app, host } = await setupPolicy(EVERY_MESSAGE);
    const { reached, message } = await runTriggerPhase(host.hooks, groupMsg('随便聊聊'));
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toEqual({ platform: 'onebot', userId: '' });
    // 物理发言者保持会话语义（归档/档案/记忆平台域都靠它）
    expect(message.userId).toBe('owner-1');
  });

  it('immediate（被 @）：点名者就是主体，actor 维持缺省', async () => {
    const { app, host } = await setupPolicy();
    const { reached, message } = await runTriggerPhase(host.hooks, groupMsg('<at self id="bot">Aalis</at> 在吗'));
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('immediate');
    expect(message.actor).toBeUndefined();
  });

  it('私聊纳入 scope 时的 interval：发言者就是唯一主体，不回填无主体 actor', async () => {
    // scope 可配成 `*` / `onebot:*` / `*:private`（WebUI 下拉一等公民值），私聊里没人 @ 就是 interval；
    // 若也回填无主体，owner 在私聊里调任何 sensitive 工具都会变成「权限不足」。
    const { app, host } = await setupPolicy({ scopes: ['onebot:*'], ...EVERY_MESSAGE });
    const msg = {
      platform: 'onebot',
      sessionType: 'private',
      sessionId: 'onebot:bot:private:owner-1',
      userId: 'owner-1',
      content: '帮我看下日志',
    } as unknown as IncomingMessage;
    const { reached, message } = await runTriggerPhase(host.hooks, msg);
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toBeUndefined();
  });

  it('interval 但消息已带 actor（委派等系统投递）：不覆盖既有授权身份', async () => {
    const { app, host } = await setupPolicy(EVERY_MESSAGE);
    const msg = groupMsg('派发任务');
    msg.actor = { platform: 'webui', userId: 'console' };
    const { message } = await runTriggerPhase(host.hooks, msg);
    await app.stop();
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toEqual({ platform: 'webui', userId: 'console' });
  });
});
