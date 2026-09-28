import { describe, expect, it } from 'vitest';
import { resolveEffectiveConfig } from '../../packages/api-gateway/src/index.js';
import { configSchema, normalizeScopes } from '../../packages/plugin-flow-control/src/config.js';
import { parseConfig } from '../../packages/schema-config/src/index.js';

/** 与插件 apply 同一条路径：parseConfig 之后做作用域核对 */
function readConfig(raw: Record<string, unknown>) {
  const warns: string[] = [];
  const logger = { warn: (message: string) => void warns.push(message) };
  return { cfg: normalizeScopes(parseConfig(configSchema, raw, logger), logger), warns };
}

describe('flow-control overrides（parseConfig + normalizeScopes）', () => {
  it('overrides 字段默认空数组', () => {
    expect(readConfig({}).cfg.overrides).toEqual([]);
  });

  it('overrides 解析有效项、scope 去首尾空白，无效项逐项告警后忽略', () => {
    const { cfg, warns } = readConfig({
      overrides: [
        { scope: '*:private', cooldownSeconds: 10 },
        { scope: '   ', cooldownSeconds: 1 }, // 只含空白的 scope
        null,
        { /* 无 scope */ cooldownSeconds: 2 },
        { scope: ' onebot:group:20002 ', rateLimitWindow: 60, rateLimitMaxReplies: 3 },
      ],
    });
    expect(cfg.overrides).toEqual([
      { scope: '*:private', cooldownSeconds: 10 },
      { scope: 'onebot:group:20002', rateLimitWindow: 60, rateLimitMaxReplies: 3 },
    ]);
    expect(warns).toEqual([
      expect.stringContaining('配置项 overrides[2] 已忽略'),
      expect.stringContaining('配置项 overrides[3] 已忽略：scope'),
      expect.stringContaining('scope 只含空白'),
    ]);
  });

  it('overrides 只保留已知字段（防注入；评分与闲置字段已不属于本插件）', () => {
    const { cfg } = readConfig({
      overrides: [{ scope: '*:private', cooldownSeconds: 10, fixedInterval: 3, malicious: 'x' }],
    });
    expect(cfg.overrides[0]).toEqual({ scope: '*:private', cooldownSeconds: 10 });
  });
});

describe('flow-control overrides 经 resolveEffectiveConfig 生效', () => {
  it('留空字段穿透：override 只填部分字段，未填字段沿用顶层默认（不被覆盖为 0/空）', () => {
    const { cfg } = readConfig({
      cooldownSeconds: 5,
      rateLimitWindow: 60,
      rateLimitMaxReplies: 3,
      overrides: [
        {
          scope: '*:private',
          cooldownSeconds: 10,
          // 其他字段留空 / null / undefined → 应沿用顶层
          rateLimitWindow: undefined,
          rateLimitMaxReplies: null,
        },
      ],
    });
    // 元素字段没有 default：留空的键不进解析结果，resolveEffectiveConfig 才不会拿它压过顶层
    expect(Object.keys(cfg.overrides[0]).sort()).toEqual(['cooldownSeconds', 'scope']);
    const eff = resolveEffectiveConfig(cfg, 'onebot', 'private');
    expect(eff.cooldownSeconds).toBe(10); // override 生效
    expect(eff.rateLimitWindow).toBe(60); // 穿透
    expect(eff.rateLimitMaxReplies).toBe(3); // 穿透
  });
});
