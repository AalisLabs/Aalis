import { describe, expect, it } from 'vitest';
import { type PersonaService, persona } from '../../packages/api-persona/src/index.js';
import {
  applyScoreDecay,
  calculateScoreIncrement,
  createState,
  getCurrentThreshold,
  SESSION_TTL_MS,
  sweepStaleStates,
} from '../../packages/plugin-trigger-policy/src/state.js';
import { defaultTriggerPolicyConfig, resolveTriggerPolicyConfig } from './trigger-policy-config.js';

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
    const c = resolveTriggerPolicyConfig({ triggerNames: 'aalis, alice\nbob' });
    expect(c.triggerNames).toEqual(['aalis', 'alice', 'bob']);
  });

  it('resolve 逗号分隔 muteKeywords', () => {
    const c = resolveTriggerPolicyConfig({ muteKeywords: '闭嘴,别说话' });
    expect(c.muteKeywords).toEqual(['闭嘴', '别说话']);
  });

  it('scopes 的 null 取默认，[] 保持空；旧逗号串不在运行时拆分', () => {
    expect(resolveTriggerPolicyConfig({ scopes: null }).scopes).toEqual(['*:group']);
    expect(resolveTriggerPolicyConfig({ scopes: [] }).scopes).toEqual([]);
    expect(resolveTriggerPolicyConfig({ scopes: 'onebot:group,cli:*' }).scopes).toEqual(['*:group']);
  });

  it('intervalMode 非法值回退', () => {
    const c = resolveTriggerPolicyConfig({ intervalMode: 'bogus' as unknown });
    expect(c.intervalMode).toBe(defaultTriggerPolicyConfig.intervalMode);
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

// ════════════════════════════════════════════════════════════
// inbound:trigger 相位（走真实插件装配，不装 gateway 插件 / flow-control）
// ════════════════════════════════════════════════════════════

import { App, type LogEntry, LogHub, provide } from '@aalis/core';
import { gateway } from '../../packages/api-gateway/src/index.js';
import { type Hooks, hooks } from '../../packages/api-hooks/src/index.js';
import triggerPolicyPlugin from '../../packages/plugin-trigger-policy/src/index.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';
import { registerHubs } from '../fixtures/hubs.js';

/** 每条消息都达到计数阈值：非直触发的群消息一律判 interval，用来观察是否走到了意愿评估 */
const EVERY_MESSAGE = { intervalMode: 'fixed', fixedInterval: 1 };

async function setupPolicy(config: Record<string, unknown> = {}, personas: PersonaService[] = []) {
  const app = new App({ name: 'T', logLevel: 'error' });
  await registerHubs(app);
  const host = app.bind({ provide, hooks });
  host.provide(gateway, {} as never); // 满足 required 依赖；相位判定本身不经过 gateway
  for (const p of personas) host.provide(persona, p);
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
  it('群友互戳按普通入站累计计数，不享受点名直触发', async () => {
    const { app, host } = await setupPolicy({ intervalMode: 'fixed', fixedInterval: 2 });
    try {
      const message = () => ({ ...pokeMsg(), noticeTargetIsSelf: false });
      expect((await runTriggerPhase(host.hooks, message())).reached).toBe(false);
      const second = await runTriggerPhase(host.hooks, message());
      expect(second.reached).toBe(true);
      expect(second.message.triggerType).toBe('interval');
      expect(second.message.actor).toEqual({ platform: 'onebot', userId: '' });
    } finally {
      await app.stop();
    }
  });

  it('真实激活时纯空白 scopes 不扩大到所有会话', async () => {
    const { app, host } = await setupPolicy({ scopes: ['   '], ...EVERY_MESSAGE });
    try {
      const { reached, message } = await runTriggerPhase(host.hooks, pokeMsg());
      expect(reached).toBe(true);
      expect(message.triggerType).toBeUndefined();
    } finally {
      await app.stop();
    }
  });

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

describe('trigger-policy inbound:trigger（人设故障）', () => {
  it('某个人设读名字抛错：只跳过它的名字，照常判定，不直接放行', async () => {
    const broken: PersonaService = {
      getSystemPrompt: () => '',
      getPersonaName: () => {
        throw new Error('persona 故障');
      },
    };
    const good: PersonaService = { getSystemPrompt: () => '', getPersonaName: () => 'Aalis' };
    const { app, host } = await setupPolicy({ intervalMode: 'fixed', fixedInterval: 100 }, [broken, good]);
    const msg = (content: string) =>
      ({
        platform: 'onebot',
        sessionType: 'group',
        sessionId: 'onebot:bot:group:g1',
        groupId: 'g1',
        userId: 'u1',
        content,
      }) as IncomingMessage;
    const plain = await runTriggerPhase(host.hooks, msg('随便聊聊'));
    const named = await runTriggerPhase(host.hooks, msg('Aalis 在吗'));
    await app.stop();
    expect(plain.reached, '没点名、计数未到：照常判定后吞掉').toBe(false);
    expect(named.message.triggerType, '另一个人设的名字照常算点名').toBe('immediate');
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

  it('interval 但消息已带 actor：不覆盖既有授权身份', async () => {
    const { app, host } = await setupPolicy(EVERY_MESSAGE);
    const msg = groupMsg('派发任务');
    msg.actor = { platform: 'webui', userId: 'console' };
    const { message } = await runTriggerPhase(host.hooks, msg);
    await app.stop();
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toEqual({ platform: 'webui', userId: 'console' });
  });
});

// ════════════════════════════════════════════════════════════
// 判定是同步的：记入站、判定、清零在同一拍做完，同一会话接连到达的消息逐条按计数判定
// （判定若在记入站之后异步进行，一簇消息会先全部记入再陆续判定，fixedInterval=2 的 4 条只放行第 2 条）
// ════════════════════════════════════════════════════════════

describe('trigger-policy inbound:trigger（同一会话突发）', () => {
  const EVERY_TWO = { intervalMode: 'fixed', fixedInterval: 2 };
  const AT = '<at self id="bot">Aalis</at> ';

  it('同一 tick 发 4 条、fixedInterval=2：逐条计数，放行第 2、4 条', async () => {
    const { app, host } = await setupPolicy(EVERY_TWO);
    const results = await Promise.all([1, 2, 3, 4].map(i => runTriggerPhase(host.hooks, groupMsg(`第 ${i} 条`))));
    await app.stop();
    expect(results.map(r => r.reached)).toEqual([false, true, false, true]);
    expect(results.map(r => r.message.triggerType)).toEqual([undefined, 'interval', undefined, 'interval']);
  });

  it('突发里被点名的消息照常放行（immediate），并清零计数', async () => {
    const { app, host } = await setupPolicy(EVERY_TWO);
    const contents = ['第 1 条', '第 2 条', `${AT}第 3 条`, '第 4 条', '第 5 条'];
    const results = await Promise.all(contents.map(c => runTriggerPhase(host.hooks, groupMsg(c))));
    await app.stop();
    expect(results.map(r => r.reached)).toEqual([false, true, true, false, true]);
    expect(results[2].message.triggerType).toBe('immediate');
  });
});

describe('trigger-policy inbound:trigger（判定日志）', () => {
  it('每条一行 debug：会话、speak、addressed、reason（计数与指数），不含正文', async () => {
    const logHub = new LogHub();
    const lines: LogEntry[] = [];
    logHub.onEntry(e => {
      if (e.message.startsWith('[trigger] 判定')) lines.push(e);
    });
    const app = new App({ name: 'T', logLevel: 'debug', logHub });
    await registerHubs(app);
    const host = app.bind({ provide, hooks });
    host.provide(gateway, {} as never);
    await app.plugins.register(triggerPolicyPlugin, { intervalMode: 'fixed', fixedInterval: 3 });
    await app.plugins.idle();
    await runTriggerPhase(host.hooks, groupMsg('这是一段不该进日志的正文'));
    await runTriggerPhase(host.hooks, groupMsg('<at self id="bot">Aalis</at> 在吗'));
    await app.stop();
    expect(lines.map(e => e.level)).toEqual(['debug', 'debug']);
    expect(lines[0].message).toMatch(
      /^\[trigger\] 判定 \| session=onebot:bot:group:g1 \| speak=false \| addressed=false \| reason=计数=1\/3 指数=[\d.]+ \(阈值=0\.300\)$/,
    );
    expect(lines[0].message).not.toContain('不该进日志');
    expect(lines[1].message).toContain('speak=true | addressed=true | reason=点名');
  });
});
