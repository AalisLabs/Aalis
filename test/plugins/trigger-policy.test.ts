import { describe, expect, it } from 'vitest';
import type { Context } from '../../packages/core/src/index.js';
import {
  defaultTriggerPolicyConfig,
  isScopeEnabled,
  resolveTriggerPolicyConfig,
} from '../../packages/plugin-trigger-policy/src/config.js';
import {
  checkImmediateMention,
  checkImmediateTrigger,
  checkMuteKeyword,
  checkNameMention,
  getBotNames,
} from '../../packages/plugin-trigger-policy/src/detector.js';

const fakeCtx = (services: Record<string, unknown> = {}): Context =>
  ({
    getService(name: string) {
      return services[name];
    },
  }) as unknown as Context;

describe('trigger-policy config', () => {
  it('resolve 默认值', () => {
    const c = resolveTriggerPolicyConfig({});
    expect(c.intervalMode).toBe(defaultTriggerPolicyConfig.intervalMode);
    expect(c.triggerOnAt).toBe(true);
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
});

describe('isScopeEnabled (trigger-policy)', () => {
  const make = (scopes: string[]) => ({ ...defaultTriggerPolicyConfig, scopes });
  it('全通配', () => {
    expect(isScopeEnabled(make(['*']), 'p', 't')).toBe(true);
  });
  it('platform 单边通配', () => {
    expect(isScopeEnabled(make(['onebot:*']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(make(['onebot:*']), 'cli', 'group')).toBe(false);
  });
  it('空名单 = false', () => {
    expect(isScopeEnabled(make([]), 'p', 't')).toBe(false);
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
    expect(getBotNames(fakeCtx(), cfg)).toEqual(['a', 'b']);
  });
  it('有 persona 服务时合并 + 去重', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerNames: ['a'] };
    const persona = {
      getPersonaName: () => 'aalis',
      getNickNames: () => ['a', 'amy'],
    };
    expect(getBotNames(fakeCtx({ persona }), cfg)).toEqual(['a', 'aalis', 'amy']);
  });
});

describe('checkImmediateTrigger', () => {
  it('triggerOnAt 关闭时不响应 @', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: false, triggerNames: [] };
    expect(checkImmediateTrigger(fakeCtx(), cfg, '@aalis hi')).toBe(false);
  });
  it('triggerOnAt 开启但仅纯文本 @ 时不命中（由名字检测兜底）', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: true, triggerNames: [] };
    expect(checkImmediateTrigger(fakeCtx(), cfg, '@aalis hi')).toBe(false);
  });
  it('triggerOnAt 开启且为 <at self> 时命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: true, triggerNames: [] };
    expect(checkImmediateTrigger(fakeCtx(), cfg, '<at self id="1">bot</at> hi')).toBe(true);
  });
  it('名字匹配也命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: false, triggerNames: ['aalis'] };
    expect(checkImmediateTrigger(fakeCtx(), cfg, 'aalis 你好')).toBe(true);
  });
});

describe('checkMuteKeyword', () => {
  it('cfg 关键词命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, muteKeywords: ['闭嘴'] };
    expect(checkMuteKeyword(fakeCtx(), cfg, '你给我闭嘴')).toBe(true);
  });
  it('persona 提供的 mute 关键词不再生效（统一收回 trigger-policy 配置，避免单例 PersonaService 跨平台泄漏）', () => {
    const cfg = { ...defaultTriggerPolicyConfig, muteKeywords: [] };
    const persona = { getMuteKeywords: () => ['stop'] };
    expect(checkMuteKeyword(fakeCtx({ persona }), cfg, 'please stop')).toBe(false);
  });
  it('全部不命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, muteKeywords: ['x'] };
    expect(checkMuteKeyword(fakeCtx(), cfg, 'hello world')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════
// decide()：poke 直触发与 triggerOnPoke 开关（走真实插件装配）
// ════════════════════════════════════════════════════════════

import { App } from '@aalis/core';
import * as triggerPolicyModule from '../../packages/plugin-trigger-policy/src/index.js';
import type { TriggerPolicyService } from '../../packages/plugin-trigger-policy/src/types.js';
import type { IncomingMessage } from '../../packages/schema-message/src/index.js';

async function setupPolicy(config: Record<string, unknown> = {}) {
  const app = new App({ config: { name: 'T', logLevel: 'error', plugins: {} } });
  app.ctx.provide('gateway', {}); // 满足 required 依赖；decide 本身不经过 gateway
  await app.ctx.useModule(triggerPolicyModule, config);
  await app.plugins.idle();
  const svc = app.ctx.getService<TriggerPolicyService>('trigger-policy');
  if (!svc) throw new Error('trigger-policy 服务未注册');
  return { app, svc };
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

describe('trigger-policy decide (poke)', () => {
  it('默认：poke 直触发（immediate）', async () => {
    const { app, svc } = await setupPolicy();
    const d = svc.decide(pokeMsg());
    expect(d.kind).toBe('immediate');
    expect(d.reason).toBe('poke notice');
    await app.stop();
  });

  it('triggerOnPoke=false：不直触发，落回正常意愿评估', async () => {
    const { app, svc } = await setupPolicy({ triggerOnPoke: false });
    const d = svc.decide(pokeMsg());
    // 无 flow-control 服务时正常评估的缺省放行路径——证明确实走到了 poke 分支之后
    expect(d.kind).toBe('interval');
    expect(d.reason).toBe('no flow state, default-pass');
    await app.stop();
  });

  it('分作用域覆盖：仅指定 scope 关闭 poke 直触发，其余平台不受影响', async () => {
    const { app, svc } = await setupPolicy({
      overrides: [{ scope: 'onebot:group', triggerOnPoke: false }],
    });
    expect(svc.decide(pokeMsg('onebot')).kind).toBe('interval');
    expect(svc.decide(pokeMsg('telegram')).kind).toBe('immediate');
    await app.stop();
  });

  it('非 poke 的 noticeType 不享受直触发（谓词只认词汇表里的 poke）', async () => {
    const { app, svc } = await setupPolicy();
    const msg = { ...pokeMsg(), noticeType: 'group_increase' } as IncomingMessage;
    const d = svc.decide(msg);
    expect(d.kind).toBe('interval');
    expect(d.reason).toBe('no flow state, default-pass');
    await app.stop();
  });

  it('关闭后戳者昵称含 bot 名也不得经名字检测绕回直触发（合成文案是元数据非发言）', async () => {
    const { app, svc } = await setupPolicy({ triggerOnPoke: false, triggerNames: 'Aalis' });
    // adapter 真实合成格式：昵称内嵌在 content 里，用户可控
    const msg = { ...pokeMsg(), content: '[戳一戳: Aalis的小跟班(12345) 戳了你]' } as IncomingMessage;
    const d = svc.decide(msg);
    expect(d.kind, '昵称含 bot 名的用户不得让开关对自己失效').toBe('interval');
    expect(d.reason).toBe('no flow state, default-pass');
    // 对照：同样内容的普通消息（非 poke）该命中名字检测
    const normal = { ...msg, noticeType: undefined } as IncomingMessage;
    expect(svc.decide(normal).kind).toBe('immediate');
    await app.stop();
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

/** 直接驱动相位钩子链（不装 gateway/flow-control）：无 flow 状态时非 @ 群消息即 interval（default-pass） */
async function runTriggerPhase(
  app: App,
  message: IncomingMessage,
): Promise<{ reached: boolean; message: IncomingMessage }> {
  let reached = false;
  const runHookLoose = app.ctx.runHook.bind(app.ctx) as (
    event: string,
    data: unknown,
    next: () => Promise<void>,
  ) => Promise<unknown>;
  await runHookLoose('inbound:trigger', { message, metadata: {}, agent: undefined }, async () => {
    reached = true;
  });
  return { reached, message };
}

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
    const { app } = await setupPolicy();
    const { reached, message } = await runTriggerPhase(app, groupMsg('随便聊聊'));
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toEqual({ platform: 'onebot', userId: '' });
    // 物理发言者保持会话语义（归档/档案/记忆平台域都靠它）
    expect(message.userId).toBe('owner-1');
  });

  it('immediate（被 @）：点名者就是主体，actor 维持缺省', async () => {
    const { app } = await setupPolicy();
    const { reached, message } = await runTriggerPhase(app, groupMsg('<at self id="bot">Aalis</at> 在吗'));
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('immediate');
    expect(message.actor).toBeUndefined();
  });

  it('私聊纳入 scope 时的 interval：发言者就是唯一主体，不回填无主体 actor', async () => {
    // scope 可配成 `*` / `onebot:*` / `*:private`（WebUI 下拉一等公民值），私聊里没人 @ 就是 interval；
    // 若也回填无主体，owner 在私聊里调任何 sensitive 工具都会变成「权限不足」。
    const { app } = await setupPolicy({ scopes: ['onebot:*'] });
    const msg = {
      platform: 'onebot',
      sessionType: 'private',
      sessionId: 'onebot:bot:private:owner-1',
      userId: 'owner-1',
      content: '帮我看下日志',
    } as unknown as IncomingMessage;
    const { reached, message } = await runTriggerPhase(app, msg);
    await app.stop();
    expect(reached).toBe(true);
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toBeUndefined();
  });

  it('interval 但消息已带 actor（委派等系统投递）：不覆盖既有授权身份', async () => {
    const { app } = await setupPolicy();
    const msg = groupMsg('派发任务');
    msg.actor = { platform: 'webui', userId: 'console' };
    const { message } = await runTriggerPhase(app, msg);
    await app.stop();
    expect(message.triggerType).toBe('interval');
    expect(message.actor).toEqual({ platform: 'webui', userId: 'console' });
  });
});
