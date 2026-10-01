import { describe, expect, it } from 'vitest';
import {
  type ConfigSchema,
  defaultsFrom,
  isSecretRef,
  mapSecretFields,
  parseConfig,
  validateConfig,
} from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// schema-config 的密钥词汇：`secret: true` 的字段在配置文档里写引用 `{ $secret: '<键>' }`，值在宿主的密钥存储里。
// validateConfig 校验文档，引用合法；parseConfig 给插件用，引用还在说明键不在密钥存储里，一律拒绝激活、点名键名
// （不回落 default：默认值可能悄悄连上别的东西）。defaultsFrom 的结果会写进文档，不收密钥字段。
// ════════════════════════════════════════════════════════════

const SCHEMA = {
  apiKey: { type: 'string', label: 'Key', secret: true, required: true },
  uri: { type: 'string', label: 'URI', secret: true, default: 'mongodb://localhost:27017' },
  env: { type: 'map', label: 'Env', secret: true, default: { A: '1' } },
  plain: { type: 'map', label: 'Plain' },
  group: {
    label: 'G',
    fields: { token: { type: 'string', label: 'T', secret: true }, user: { type: 'string', label: 'U' } },
  },
  list: {
    type: 'array',
    label: 'L',
    items: { url: { type: 'string', label: 'U' }, accessToken: { type: 'string', label: 'A', secret: true } },
  },
} satisfies ConfigSchema;

describe('isSecretRef', () => {
  it.each([
    [{ $secret: 'k' }, true],
    [{ $secret: '' }, false],
    [{ $secret: 'k', $value: 'v' }, false],
    [{ $secret: 1 }, false],
    [['k'], false],
    ['k', false],
    [null, false],
  ])('%j → %s', (value, expected) => {
    expect(isSecretRef(value)).toBe(expected);
  });
});

describe('mapSecretFields', () => {
  it('只处理密钥字段（顶层、分组内、数组元素内），给出不带下标的路径；不改入参，没变化时原样返回', () => {
    const config = {
      apiKey: 'a',
      plain: { $secret: 'not-a-secret-field' },
      group: { token: 't', user: 'u' },
      list: [{ url: 'x', accessToken: 'b' }, 'bad', { url: 'y' }],
    };
    const seen: string[] = [];
    const out = mapSecretFields(SCHEMA, config, (value, at) => {
      seen.push(`${at.path}${at.inArray ? '[]' : ''}=${String(value)}`);
      return `<${String(value)}>`;
    });
    expect(seen).toEqual(['apiKey=a', 'group.token=t', 'list.accessToken[]=b']);
    expect(out).toEqual({
      apiKey: '<a>',
      plain: { $secret: 'not-a-secret-field' },
      group: { token: '<t>', user: 'u' },
      list: [{ url: 'x', accessToken: '<b>' }, 'bad', { url: 'y' }],
    });
    expect(config.apiKey).toBe('a');
    expect(mapSecretFields(SCHEMA, config, value => value)).toBe(config);
  });

  it('回调返回 undefined 时删掉这个键', () => {
    expect(mapSecretFields(SCHEMA, { apiKey: 'a', plain: {} }, () => undefined)).toEqual({ plain: {} });
  });
});

describe('validateConfig 与 parseConfig 对引用的处理', () => {
  it('validateConfig：密钥字段上的引用合法（含 map 与数组元素内），别的字段上的引用照常按类型判', () => {
    const doc = {
      apiKey: { $secret: 'k1' },
      env: { $secret: 'k2' },
      group: { token: { $secret: 'k3' }, user: { $secret: 'k4' } },
      list: [{ url: 'x', accessToken: { $secret: 'k5' } }],
    };
    expect(validateConfig(SCHEMA, doc)).toEqual([
      { path: 'group.user', message: '期望 string，得到 object', kind: 'invalid' },
    ]);
  });

  it('parseConfig：顶层密钥字段上还是引用时拒绝，即使有 default 也不回落，消息点名键名', () => {
    expect(() => parseConfig(SCHEMA, { apiKey: 'sk-PLACEHOLDER', uri: { $secret: 'mongo.uri' } })).toThrow(
      '配置项 uri 引用的密钥 mongo.uri 不在宿主的密钥存储里',
    );
    let thrown: Error | undefined;
    try {
      parseConfig(SCHEMA, { apiKey: { $secret: 'llm.apiKey' } });
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.name).toBe('ConfigError');
    expect(thrown?.message).toContain('llm.apiKey');
  });

  it('parseConfig：map 密钥字段上的引用不当成一个名为 $secret 的映射交给插件', () => {
    expect(() => parseConfig(SCHEMA, { apiKey: 'x', env: { $secret: 'mcp.env' } })).toThrow('mcp.env');
  });

  it('parseConfig：数组元素里的悬空引用让整次解析失败，不只丢掉这一条元素', () => {
    expect(() =>
      parseConfig(SCHEMA, {
        apiKey: 'x',
        list: [
          { url: 'a', accessToken: 'tok-PLACEHOLDER' },
          { url: 'b', accessToken: { $secret: 'onebot.token' } },
        ],
      }),
    ).toThrow('onebot.token');
  });

  it('parseConfig：解析过的原值照常可用，密钥字段缺失时仍用 default', () => {
    expect(parseConfig(SCHEMA, { apiKey: 'sk-PLACEHOLDER' })).toMatchObject({
      apiKey: 'sk-PLACEHOLDER',
      uri: 'mongodb://localhost:27017',
      env: { A: '1' },
    });
  });
});

describe('defaultsFrom', () => {
  it('不收密钥字段：默认值不写进文档，map 的默认值也不会被深合并进引用对象', () => {
    expect(defaultsFrom(SCHEMA)).toEqual({ group: {} });
  });
});
