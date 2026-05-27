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
  it('普通 @nickname 已不再命中（须由 checkNameMention 兜底）', () => {
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
  it('triggerOnAt 开启时响应 OneBot <at self>', () => {
    const cfg = { ...defaultTriggerPolicyConfig, triggerOnAt: true, triggerNames: [] };
    expect(checkImmediateTrigger(fakeCtx(), cfg, '<at self>1</at> hi')).toBe(true);
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
