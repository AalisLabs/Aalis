import { describe, expect, it } from 'vitest';
import {
  extractTargetId,
  inferSessionScope,
  isScopeEnabled,
  resolveEffectiveConfig,
} from '../../packages/api-gateway/src/index.js';

// api-gateway 的会话作用域纯函数：flow-control 与 trigger-policy 共用同一份匹配规则。

describe('isScopeEnabled', () => {
  const cfg = (scopes: string[], overrides: { scope: string }[] = []) => ({ scopes, overrides });

  it('精确匹配', () => {
    expect(isScopeEnabled(cfg(['onebot:group']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:group']), 'onebot', 'private')).toBe(false);
  });

  it('platform 通配', () => {
    expect(isScopeEnabled(cfg(['*:group']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['*:group']), 'cli', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['*:group']), 'cli', 'private')).toBe(false);
  });

  it('sessionType 通配', () => {
    expect(isScopeEnabled(cfg(['onebot:*']), 'onebot', 'group')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:*']), 'onebot', 'private')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:*']), 'cli', 'group')).toBe(false);
  });

  it('全通配', () => {
    expect(isScopeEnabled(cfg(['*']), 'anything', 'thing')).toBe(true);
  });

  it('targetId 段命中', () => {
    expect(isScopeEnabled(cfg(['onebot:group:1014']), 'onebot', 'group', '1014')).toBe(true);
    expect(isScopeEnabled(cfg(['onebot:group:1014']), 'onebot', 'group', '9999')).toBe(false);
  });

  it('未提供 targetId 时 targetId 限定的 scope 不命中', () => {
    expect(isScopeEnabled(cfg(['onebot:group:1014']), 'onebot', 'group')).toBe(false);
  });

  it('两段写法对任意 targetId 通配', () => {
    expect(isScopeEnabled(cfg(['*:group']), 'onebot', 'group', '1014')).toBe(true);
    expect(isScopeEnabled(cfg(['*:group']), 'onebot', 'private', '1014')).toBe(false);
  });

  it('只有 overrides 命中也视为启用', () => {
    const c = cfg([], [{ scope: '*:private' }]);
    expect(isScopeEnabled(c, 'onebot', 'private')).toBe(true);
    expect(isScopeEnabled(c, 'onebot', 'group')).toBe(false);
  });

  it('空 scopes + 空 overrides 不命中', () => {
    expect(isScopeEnabled(cfg([]), 'onebot', 'group')).toBe(false);
  });
});

describe('resolveEffectiveConfig', () => {
  interface Cfg {
    overrides: Array<{ scope: string; cooldownSeconds?: number; fixedInterval?: number }>;
    cooldownSeconds: number;
    fixedInterval: number;
  }
  const make = (overrides: Cfg['overrides']): Cfg => ({ overrides, cooldownSeconds: 10, fixedInterval: 5 });

  it('无 overrides 返回原对象引用', () => {
    const c = make([]);
    expect(resolveEffectiveConfig(c, 'onebot', 'group')).toBe(c);
  });

  it('单一匹配：只覆盖列出的字段，其他穿透', () => {
    const eff = resolveEffectiveConfig(make([{ scope: '*:private', cooldownSeconds: 30 }]), 'onebot', 'private');
    expect(eff.cooldownSeconds).toBe(30);
    expect(eff.fixedInterval).toBe(5);
  });

  it('最具体匹配优先：targetId > sessionType > platform > 通配', () => {
    const c = make([
      { scope: '*', cooldownSeconds: 20 },
      { scope: '*:private', cooldownSeconds: 30 },
      { scope: 'onebot:private', cooldownSeconds: 40 },
      { scope: 'onebot:private:42', cooldownSeconds: 50 },
    ]);
    expect(resolveEffectiveConfig(c, 'onebot', 'private', '42').cooldownSeconds).toBe(50);
    expect(resolveEffectiveConfig(c, 'onebot', 'private', '99').cooldownSeconds).toBe(40);
    expect(resolveEffectiveConfig(c, 'cli', 'private').cooldownSeconds).toBe(30);
    expect(resolveEffectiveConfig(c, 'cli', 'group').cooldownSeconds).toBe(20);
  });

  it('具体度相同时取先出现的一项', () => {
    const c = make([
      { scope: '*:private', cooldownSeconds: 30 },
      { scope: '*:private', cooldownSeconds: 40, fixedInterval: 1 },
    ]);
    const eff = resolveEffectiveConfig(c, 'onebot', 'private');
    expect(eff.cooldownSeconds).toBe(30);
    expect(eff.fixedInterval, '后一项整条不生效，不做按键合并').toBe(5);
  });

  it('未匹配的 override 不影响', () => {
    const c = make([{ scope: 'onebot:private', cooldownSeconds: 99 }]);
    expect(resolveEffectiveConfig(c, 'cli', 'group')).toBe(c);
  });

  it('值为 undefined 的键穿透，scope 键不写进结果', () => {
    const eff = resolveEffectiveConfig(
      make([{ scope: '*:private', cooldownSeconds: undefined, fixedInterval: 1 }]),
      'onebot',
      'private',
    );
    expect(eff.cooldownSeconds).toBe(10);
    expect(eff.fixedInterval).toBe(1);
    expect('scope' in eff).toBe(false);
  });
});

describe('extractTargetId', () => {
  it('群聊取 groupId，私聊取 userId，其他为空串', () => {
    expect(extractTargetId({ sessionType: 'group', groupId: 'g1', userId: 'u1' })).toBe('g1');
    expect(extractTargetId({ sessionType: 'private', groupId: 'g1', userId: 'u1' })).toBe('u1');
    expect(extractTargetId({ sessionType: 'channel', groupId: 'g1', userId: 'u1' })).toBe('');
    expect(extractTargetId({ userId: 'u1' })).toBe('');
  });
});

describe('inferSessionScope', () => {
  it('按 <platform>:<self>:<type>:<target> 约定推断：群取群号、私聊取对方 id，频道只给类型、目标为空', () => {
    expect(inferSessionScope('onebot', 'onebot:10000:group:20001')).toEqual({
      sessionType: 'group',
      targetId: '20001',
    });
    expect(inferSessionScope('onebot', 'onebot:10000:private:30001')).toEqual({
      sessionType: 'private',
      targetId: '30001',
    });
    expect(inferSessionScope('onebot', 'onebot:10000:channel:40001:50001')).toEqual({
      sessionType: 'channel',
      targetId: '',
    });
  });

  it('类型段只认 group / private / channel', () => {
    for (const t of ['guild', 'other', 'GROUP', '']) {
      expect(inferSessionScope('onebot', `onebot:10000:${t}:20001`), t).toBeUndefined();
    }
  });

  it('前缀与平台不符、段数不足、子任务会话、不符合约定的不推断', () => {
    expect(inferSessionScope('internal', 'onebot:10000:group:20001')).toBeUndefined();
    expect(inferSessionScope(undefined, 'onebot:10000:group:20001')).toBeUndefined();
    expect(inferSessionScope('onebot', 'onebot:10000:group')).toBeUndefined();
    expect(inferSessionScope('onebot', 'onebot:10000:group:20001::abcd1234')).toBeUndefined();
    expect(inferSessionScope('webui', 'webui-default')).toBeUndefined();
  });
});
