import { describe, expect, it } from 'vitest';
import {
  type ConfigSchema,
  defaultsFrom,
  isSessionField,
  parseConfig,
  readFieldValue,
  type SchemaField,
  validateConfig,
} from '../../packages/schema-config/src/index.js';
import { defineTexts, resolveText } from '../../packages/schema-i18n/src/index.js';

// ════════════════════════════════════════════════════════════
// 可按会话覆盖的字段（session）与字段自己的取值校验（validate）
//
// 顶层带 session 的字段不由插件配置交出：parseConfig 不产出、不补 default，插件经会话设置的读取器读；
// validateConfig 与 defaultsFrom 照常把它当 schema 字段（全局层的值就在配置文档里）。类型层见 schema-config-types。
// validate 在类型与约束之后调，拿换算后的取值，返回原因或抛错都算不合法、不向外抛；readFieldValue 是单个值的同一套判定。
// ════════════════════════════════════════════════════════════

const t = defineTexts({ ns: '@zz/schema-session-fields', language: 'zh-CN', source: { notRef: '不是模型引用' } });

const field = (type: string, extra?: Record<string, unknown>) => ({ type, label: 'F', ...extra }) as SchemaField;

function parse(schema: ConfigSchema, raw: unknown) {
  const warns: string[] = [];
  const config = parseConfig(schema, raw, { warn: message => void warns.push(message) });
  return { config, warns };
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('预期抛错，实际没有');
}

const boom = () => {
  throw new Error('sk-probe-0000');
};

describe('isSessionField', () => {
  it('只认写了 session 的字段：没写或写成 undefined 的不算，分组与数组上写了也不算', () => {
    expect(isSessionField(field('string', { session: {} }))).toBe(true);
    expect(isSessionField(field('llm-ref', { session: {} }))).toBe(true);
    expect(isSessionField(field('string'))).toBe(false);
    expect(isSessionField(field('string', { session: undefined }))).toBe(false);
    expect(isSessionField({ label: 'G', session: {}, fields: { x: field('string', { session: {} }) } })).toBe(false);
    expect(isSessionField({ type: 'array', label: 'A', session: {}, items: {} })).toBe(false);
    for (const odd of [undefined, null, 'session', [{ session: {} }]]) expect(isSessionField(odd)).toBe(false);
  });
});

describe('parseConfig 跳过带 session 的顶层字段', () => {
  it('不产出、不补 default；文档里有这个键也不告警；这类字段的 validate 不由它调', () => {
    let calls = 0;
    const schema: ConfigSchema = {
      think: field('select', { session: {}, default: 'low', options: [{ label: 'L', value: 'low' }] }),
      llm: field('llm-ref', {
        session: {},
        validate: () => {
          calls++;
          return '不是模型引用';
        },
      }),
      limit: field('number', { default: 30 }),
    };
    expect(parse(schema, { think: 'high', llm: { provider: 'p', model: 'm' }, limit: 5 })).toEqual({
      config: { limit: 5 },
      warns: [],
    });
    expect(parse(schema, {})).toEqual({ config: { limit: 30 }, warns: [] });
    expect(calls).toBe(0);
  });

  it('只认顶层：分组与数组元素里写了 session 的字段照常解析', () => {
    const schema: ConfigSchema = {
      audio: { label: 'G', fields: { think: field('boolean', { session: {}, default: true }) } },
      jobs: {
        type: 'array',
        label: 'J',
        default: [{}],
        items: { name: field('string', { session: {}, default: 'x' }) },
      },
    };
    expect(parse(schema, {})).toEqual({ config: { audio: { think: true }, jobs: [{ name: 'x' }] }, warns: [] });
  });

  it('整份配置不是对象：顶层带 session 的严格字段不让它拒绝激活，分组里的照旧算', () => {
    const strict = field('number', { session: {}, onInvalid: 'error' });
    expect(parse({ s: strict, a: field('number', { default: 1 }) }, 'oops')).toEqual({
      config: { a: 1 },
      warns: ['配置整体期望对象，得到 string，已忽略'],
    });
    expect(() => parse({ g: { label: 'G', fields: { s: strict } } }, 'oops')).toThrow('配置整体期望对象');
  });
});

describe('字段的 validate', () => {
  it('validateConfig：不合法报 invalid（code 为 validate，原因是字符串或文字对象，原样），合法不报', () => {
    const schema: ConfigSchema = {
      a: field('string', { validate: (v: unknown) => (v === 'ok' ? undefined : '只收 ok') }),
      b: field('llm-ref', { validate: () => t('notRef') }),
    };
    expect(validateConfig(schema, { a: 'ok' })).toEqual([]);
    const issues = validateConfig(schema, { a: 'no', b: { provider: 'p' } });
    expect(issues.map(({ path, kind, code, message }) => ({ path, kind, code, message }))).toEqual([
      { path: 'a', kind: 'invalid', code: 'validate', message: '只收 ok' },
      { path: 'b', kind: 'invalid', code: 'validate', message: '不是模型引用' },
    ]);
    expect(resolveText(issues[0].text, ['en'])).toBe('只收 ok');
    expect(issues[1].text).toEqual(t('notRef'));
  });

  it('validateConfig：拿到换算后的取值；类型或约束不过时不调、只报那一条；没配置的（含外来类型的空串）不调', () => {
    const seen: unknown[] = [];
    const spy = (v: unknown) => void seen.push(v);
    const schema: ConfigSchema = {
      n: field('number', { min: 1, validate: spy }),
      p: field('string', { format: 'absolute-path', validate: spy }),
      m: field('llm-ref', { validate: spy }),
    };
    expect(validateConfig(schema, { n: ' 42 ', p: ' /opt/m.bin ', m: { provider: 'p', model: 'x' } })).toEqual([]);
    expect(seen).toEqual([42, '/opt/m.bin', { provider: 'p', model: 'x' }]);
    seen.length = 0;
    expect(validateConfig(schema, { n: 0, p: 'rel/m.bin', m: '' }).map(i => i.code)).toEqual(['min', 'format']);
    expect(validateConfig(schema, { n: null })).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('validateConfig：validate 抛错按不合法、不向外抛，原因不转述抛出的错；分组与数组元素里同样调；带 session 的照常校验', () => {
    const schema: ConfigSchema = {
      top: field('string', { session: {}, validate: boom }),
      g: {
        label: 'G',
        fields: { inner: field('number', { validate: (v: unknown) => (v === 1 ? undefined : '只收 1') }) },
      },
      list: { type: 'array', label: 'L', items: { id: field('string', { validate: boom }) } },
    };
    const issues = validateConfig(schema, { top: 'x', g: { inner: 2 }, list: [{ id: 'a' }] });
    expect(issues.map(({ path, kind, code, message }) => ({ path, kind, code, message }))).toEqual([
      { path: 'top', kind: 'invalid', code: 'validate', message: '校验时出错' },
      { path: 'g.inner', kind: 'invalid', code: 'validate', message: '只收 1' },
      { path: 'list[0].id', kind: 'invalid', code: 'validate', message: '校验时出错' },
    ]);
    expect(resolveText(issues[0].text, ['en'])).toBe('an error occurred during validation');
  });

  it('validate 返回空串或别的违约值（null、普通对象）同抛错，不拼成半句话', () => {
    for (const bad of ['', null, { message: '只收 ok' }]) {
      const messages = validateConfig({ a: field('string', { validate: () => bad }) }, { a: 'x' }).map(i => i.message);
      expect(messages, JSON.stringify(bad)).toEqual(['校验时出错']);
    }
  });

  it('集合有坏元素：validateConfig 与 readFieldValue 只报元素、不调 validate；parseConfig 先丢坏元素，再拿剩下的值调它', () => {
    const seen: unknown[] = [];
    const atLeastTwo = (v: unknown) => {
      seen.push(v);
      return Array.isArray(v) && v.length >= 2 ? undefined : '至少两项';
    };
    const l = field('list', { validate: atLeastTwo });
    const issues = validateConfig({ l }, { l: ['a', {}] });
    expect(issues.map(({ path, code, message }) => ({ path, code, message }))).toEqual([
      { path: 'l[1]', code: 'type', message: '期望 string 元素，得到 object' },
    ]);
    expect(readFieldValue(l, ['a', {}])).toEqual({ invalid: issues[0].text });
    expect(seen).toEqual([]);
    expect(parse({ l }, { l: ['a', {}] })).toEqual({
      config: {},
      warns: ['配置项 l[1] 期望 string 元素，得到 object，已忽略', '配置项 l 至少两项，已忽略'],
    });
    expect(seen).toEqual([['a']]);
    const strict = field('list', { onInvalid: 'error', validate: atLeastTwo });
    expect(thrown(() => parse({ l: strict }, { l: ['a', {}] })).message).toBe(
      '配置项 l[1] 期望 string 元素，得到 object，在 WebUI 或配置文件中改正后生效',
    );
  });

  it('parseConfig：不合法时有 default 回落并告警、没有 default 省略并告警', () => {
    const reject = () => '只收 ok';
    const { config, warns } = parse(
      { a: field('string', { default: 'd', validate: reject }), b: field('llm-ref', { validate: reject }) },
      { a: 'x', b: { provider: 'p' } },
    );
    expect(config).toEqual({ a: 'd' });
    expect(warns).toEqual(['配置项 a 只收 ok，改用默认值 "d"', '配置项 b 只收 ok，已忽略']);
  });

  it("parseConfig：onInvalid: 'error' 与没有 default 的 required 拒绝激活，原因原样", () => {
    const reject = () => '只收 ok';
    const strict = thrown(() =>
      parse({ a: field('string', { default: 'd', onInvalid: 'error', validate: reject }) }, { a: 'x' }),
    );
    expect(strict.name).toBe('ConfigError');
    expect(strict.message).toBe('配置项 a 只收 ok，在 WebUI 或配置文件中改正后生效');
    expect(() => parse({ a: field('llm-ref', { required: true, validate: reject }) }, { a: {} })).toThrow(
      '配置项 a 只收 ok',
    );
  });

  it('parseConfig：validate 抛错按不合法回落、不向外抛；通过时外来类型的值照旧拷贝交出', () => {
    const value = { provider: 'p', model: 'm' };
    const { config, warns } = parse(
      { a: field('number', { default: 1, validate: boom }), m: field('llm-ref', { validate: () => undefined }) },
      { a: 2, m: value },
    );
    expect(config).toEqual({ a: 1, m: value });
    expect(config.m).not.toBe(value);
    expect(warns).toEqual(['配置项 a 校验时出错，改用默认值 1']);
  });
});

describe('readFieldValue', () => {
  const options = [
    { label: 'A', value: 'a' },
    { label: '二', value: 2 },
  ];
  const CASES: Array<[string, SchemaField, unknown]> = [
    ['类型不符', field('number'), 'abc'],
    ['数字字符串', field('number', { min: 1 }), ' 42 '],
    ['小于下限', field('number', { min: 1 }), 0],
    ['选项外', field('select', { options }), 'z'],
    ['选项归位', field('select', { options }), '2'],
    ['multiselect 有选项外的元素', field('multiselect', { options }), ['a', 'z']],
    ['list 有坏元素', field('list'), ['a', {}]],
    ['不匹配模式', field('string', { pattern: '^\\d+$' }), 'x'],
    ['路径去空白', field('string', { format: 'absolute-path' }), ' /opt/m.bin '],
    ['validate 拒绝', field('string', { validate: () => '只收 ok' }), 'no'],
    ['validate 抛错', field('llm-ref', { validate: boom }), {}],
    ['外来类型通过', field('llm-ref', { validate: () => undefined }), { provider: 'p' }],
    ['没配置', field('number', { default: 3 }), undefined],
    ['YAML 裸键', field('string', { validate: () => '不收' }), null],
    ['外来类型的空串', field('llm-ref', { validate: () => '不收' }), ''],
    ['内置类型的空串', field('string', { validate: () => '不收' }), ''],
    ['必填的空串', field('string', { required: true }), ''],
  ];

  it('与 validateConfig 判定一致：不合法时给出 validateConfig 报的第一条原因', () => {
    let invalidCases = 0;
    for (const [name, f, value] of CASES) {
      const invalid = validateConfig({ f }, { f: value }).filter(issue => issue.kind === 'invalid');
      const result = readFieldValue(f, value);
      if (invalid.length === 0) {
        expect(result, name).not.toHaveProperty('invalid');
      } else {
        invalidCases++;
        expect(result, name).toEqual({ invalid: invalid[0].text });
      }
    }
    expect(invalidCases).toBe(9);
  });

  it('合法给出换算后的取值，没配置的给 undefined；不回落 default；validate 抛错不向外抛', () => {
    expect(readFieldValue(field('number', { min: 1 }), ' 42 ')).toEqual({ value: 42 });
    expect(readFieldValue(field('select', { options }), '2')).toEqual({ value: 2 });
    expect(readFieldValue(field('string', { format: 'absolute-path' }), ' /opt/m.bin ')).toEqual({
      value: '/opt/m.bin',
    });
    for (const unset of [undefined, null]) {
      expect(readFieldValue(field('number', { default: 3 }), unset)).toEqual({ value: undefined });
    }
    expect(readFieldValue(field('llm-ref', { default: { provider: 'p' } }), '')).toEqual({ value: undefined });
    expect(readFieldValue(field('number', { default: 3 }), 'abc')).toEqual({
      invalid: expect.objectContaining({ source: '期望有限数值，得到 string' }),
    });
    expect(readFieldValue(field('llm-ref', { validate: boom }), {})).toEqual({
      invalid: expect.objectContaining({ source: '校验时出错' }),
    });
  });

  it('不拷贝：外来类型的值原样交出', () => {
    const value = { provider: 'p', model: 'm' };
    const result = readFieldValue(field('llm-ref', { validate: () => undefined }), value);
    expect('value' in result && result.value).toBe(value);
  });
});

// ── 回归钉 ──

describe('回归钉', () => {
  it('defaultsFrom 照常产出带 session 字段的 default（作者默认写进配置文档）', () => {
    const schema: ConfigSchema = {
      think: field('string', { session: {}, default: 'low' }),
      groups: field('list', { session: {} }),
    };
    expect(defaultsFrom(schema)).toEqual({ think: 'low' });
  });

  it("format: 'absolute-path' 的字符串字段：校验与交出的值不变", () => {
    const schema: ConfigSchema = { model: field('string', { format: 'absolute-path', default: '' }) };
    expect(validateConfig(schema, { model: 'rel/m.bin' }).map(issue => issue.message)).toEqual(['须为绝对路径']);
    expect(parse(schema, { model: '  /opt/m.bin ' })).toEqual({ config: { model: '/opt/m.bin' }, warns: [] });
  });
});
