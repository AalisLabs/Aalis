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
  it('CQ 码 [CQ:at,qq=...]', () => {
    expect(checkImmediateMention('[CQ:at,qq=12345] 你好')).toBe(true);
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
  it('triggerOnAt 开启且为 CQ:at 时命中', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: true, triggerNames: [] };
    expect(checkImmediateTrigger(fakeCtx(), cfg, '[CQ:at,qq=123] hi')).toBe(true);
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
