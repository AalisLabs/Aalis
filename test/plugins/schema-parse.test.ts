import { describe, expect, it } from 'vitest';
import {
  type ConfigSchema,
  defineConfig,
  parseConfig,
  type SchemaField,
} from '../../packages/schema-config/src/index.js';

// ════════════════════════════════════════════════════════════
// parseConfig — 按 schema 解析插件拿到的配置
// 逐字段判定与 validateConfig 共用；能恢复的回落默认值或丢弃并告警，顶层与分组内不可恢复的抛 ConfigError，
// 数组元素内不可恢复的只丢这一条元素。告警只写路径、类型名与约束，不写原值（可能是密钥）。
// ════════════════════════════════════════════════════════════

const SECRET = 'sk-probe-0000';

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

const field = (type: string, extra?: Record<string, unknown>) => ({ type, label: 'F', ...extra }) as SchemaField;

/** 连同不可枚举属性、symbol 键与属性描述符在内的逐层结构快照：toEqual 看不见这些 */
function fullShape(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return {
    proto: Object.getPrototypeOf(value),
    extensible: Object.isExtensible(value),
    props: Reflect.ownKeys(value).map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      return [String(key), d.enumerable, d.writable, d.configurable, fullShape(d.value)];
    }),
  };
}

describe('defineConfig 原样返回', () => {
  // WebUI 经 JSON.stringify 读这个活对象、插件在运行时改写 options、removeExtraFields 按键判定，
  // 三者都要求 schema 就是插件写下的那个普通对象
  it('返回同一个对象：不冻结、不加属性（含不可枚举属性与 symbol 键）、不换原型，调用后仍能改写 options', () => {
    const schema = {
      mode: { type: 'select', label: 'M', default: 'a', options: [{ label: 'A', value: 'a' }] },
      g: { label: 'G', fields: { n: { type: 'number', label: 'N' } } },
      list: { type: 'array', label: 'L', items: { id: { type: 'string', label: 'I' } }, default: [] },
    } satisfies ConfigSchema;
    const before = fullShape(schema);
    const out = defineConfig(schema);
    expect(out).toBe(schema);
    expect(fullShape(schema)).toEqual(before);
    expect(Object.isFrozen(schema)).toBe(false);

    const live: ConfigSchema = out;
    (live.mode as SchemaField).options = [
      { label: 'A', value: 'a' },
      { label: 'B', value: 'b' },
    ];
    expect(schema.mode.options).toHaveLength(2);
    expect(parseConfig(out, { mode: 'b' })).toMatchObject({ mode: 'b' });
  });
});

describe('parseConfig 缺失', () => {
  const schema: ConfigSchema = {
    withDefault: field('number', { default: 3 }),
    optional: field('string'),
    list: field('list', { default: ['a', 'b'] }),
  };

  it('undefined 与 null（YAML 裸键）视为缺失：有 default 用 default，没有就省略该键，均不告警', () => {
    for (const raw of [{}, { withDefault: null, optional: null, list: undefined }]) {
      const { config, warns } = parse(schema, raw);
      expect(config).toEqual({ withDefault: 3, list: ['a', 'b'] });
      expect('optional' in config).toBe(false);
      expect(warns).toEqual([]);
    }
  });

  it('default 按值拷贝：改结果不会改到 schema 里的默认值', () => {
    const { config } = parse(schema, {});
    (config.list as string[]).push('c');
    expect(parse(schema, {}).config.list).toEqual(['a', 'b']);
  });

  it('required 且无 default 缺失：抛 missingConfigError，点名路径', () => {
    const err = thrown(() => parse({ apiKey: field('string', { required: true }) }, { apiKey: null }));
    expect(err.name).toBe('ConfigError');
    expect(err.message).toBe('缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效');
  });

  it('非对象的整体配置按空对象解析并告警', () => {
    const { config, warns } = parse(schema, 'oops');
    expect(config).toEqual({ withDefault: 3, list: ['a', 'b'] });
    expect(warns).toEqual(['配置整体期望对象，得到 string，已忽略']);
    expect(parse(schema, undefined).warns).toEqual([]);
  });

  it('不传 logger 也照常解析', () => {
    expect(parseConfig(schema, { withDefault: 'bad' })).toEqual({ withDefault: 3, list: ['a', 'b'] });
  });
});

describe("parseConfig 空串 ''", () => {
  it("required 字段的 '' 视为缺失：有 default 用 default，没有就抛 missingConfigError", () => {
    const schema: ConfigSchema = {
      uri: field('string', { required: true, default: 'mongodb://localhost' }),
      token: field('string', { required: true, default: '' }),
    };
    expect(parse(schema, { uri: '', token: '' }).config).toEqual({ uri: 'mongodb://localhost', token: '' });
    const err = thrown(() => parse({ apiKey: field('string', { required: true }) }, { apiKey: '' }));
    expect(err.message).toBe('缺少配置项 apiKey，在 WebUI 或配置文件中填入后生效');
  });

  it("非 required 的中立类型：'' 是已配置的值，照常判定", () => {
    const schema: ConfigSchema = { prompt: field('string', { default: '默认' }), note: field('textarea') };
    expect(parse(schema, { prompt: '', note: '' })).toEqual({ config: { prompt: '', note: '' }, warns: [] });
  });
});

describe('parseConfig 无效值', () => {
  const schema: ConfigSchema = {
    port: field('number', { default: 8080 }),
    mode: field('select', {
      default: 'a',
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
    }),
    limit: field('number'),
    flag: field('boolean', { default: false }),
  };

  it('有 default 回落并告警，文案写路径、原因与默认值', () => {
    const { config, warns } = parse(schema, { port: SECRET, mode: 'zzz', flag: 'yes' });
    expect(config).toEqual({ port: 8080, mode: 'a', flag: false });
    expect(warns).toEqual([
      '配置项 port 期望有限数值，得到 string，改用默认值 8080',
      '配置项 mode 不是可选值（"a"、"b"）之一，改用默认值 "a"',
      '配置项 flag 期望 boolean，得到 string，改用默认值 false',
    ]);
  });

  it('没有 default 的非必填字段省略该键并告警', () => {
    const { config, warns } = parse(schema, { limit: { v: 1 } });
    expect('limit' in config).toBe(false);
    expect(warns).toEqual(['配置项 limit 期望有限数值，得到 object，已忽略']);
  });

  it('required 且无 default 的无效值抛 configError（不是缺失文案）', () => {
    const err = thrown(() => parse({ port: field('number', { required: true }) }, { port: 'abc' }));
    expect(err.name).toBe('ConfigError');
    expect(err.stack).toBeUndefined();
    expect(err.message).toBe('配置项 port 期望有限数值，得到 string，在 WebUI 或配置文件中改正后生效');
  });

  it('约束键：越界、非整数、不匹配模式都按无效处理', () => {
    const constrained: ConfigSchema = {
      port: field('number', { min: 1, max: 65535, integer: true, default: 80 }),
      ratio: field('number', { min: 0, max: 1 }),
      host: field('string', { pattern: '^[a-z.]+$', default: 'localhost' }),
      bad: field('string', { pattern: '[unclosed' }),
    };
    const { config, warns } = parse(constrained, { port: 1.5, ratio: 2, host: 'BAD HOST', bad: 'anything' });
    expect(config).toEqual({ port: 80, host: 'localhost', bad: 'anything' });
    expect(warns).toEqual([
      '配置项 port 期望整数，改用默认值 80',
      '配置项 ratio 大于上限 1，已忽略',
      '配置项 host 不匹配模式 ^[a-z.]+$，改用默认值 "localhost"',
    ]);
    expect(parse(constrained, { port: 0 }).warns).toEqual(['配置项 port 小于下限 1，改用默认值 80']);
  });

  it('告警与错误文案都不含原值', () => {
    const secretSchema: ConfigSchema = {
      key: field('number', { default: 0 }),
      list: field('list'),
      env: field('map'),
      group: { label: 'G', fields: { n: field('number') } },
      items: { type: 'array', label: 'I', items: { id: field('number', { required: true }) } },
    };
    const { warns } = parse(secretSchema, {
      key: SECRET,
      list: SECRET,
      env: { TOKEN: { value: SECRET } },
      group: { n: SECRET },
      items: [{ id: SECRET }],
      stray: SECRET,
    });
    expect(warns).toHaveLength(6);
    for (const w of warns) expect(w).not.toContain(SECRET);
    const err = thrown(() => parse({ key: field('number', { required: true }) }, { key: SECRET }));
    expect(err.message).not.toContain(SECRET);
  });
});

describe('parseConfig 外来类型（如 llm-ref）', () => {
  const schema = {
    ref: { type: 'llm-ref', label: '模型' },
    withDefault: { type: 'llm-ref', label: '模型', default: { provider: 'p', model: 'm' } },
    required: { type: 'llm-ref', label: '模型', required: true },
  } as unknown as ConfigSchema;

  it("除 '' 外原样透传、不校验，结果是拷贝", () => {
    const ref = { provider: 'openai:main', model: 'gpt' };
    const raw = { ref, withDefault: 42, required: ['legacy'] };
    const { config, warns } = parse(schema, raw);
    expect(config).toEqual({ ref, withDefault: 42, required: ['legacy'] });
    expect(config.ref).not.toBe(ref);
    expect(warns).toEqual([]);
  });

  it("'' 一律视为缺失（WebUI 给未选的 llm-ref 存 ''）：有 default 用 default，没有就省略，required 抛错", () => {
    const { config } = parse(schema, { ref: '', withDefault: '', required: { provider: 'x' } });
    expect(config).toEqual({ withDefault: { provider: 'p', model: 'm' }, required: { provider: 'x' } });
    expect('ref' in config).toBe(false);
    const err = thrown(() => parse(schema, { required: '' }));
    expect(err.message).toBe('缺少配置项 required，在 WebUI 或配置文件中填入后生效');
  });
});

describe('parseConfig list / map / multiselect 逐项丢弃', () => {
  it('list：坏元素逐个丢弃并告警，其余保序保留；有限数字按字符串收', () => {
    const { config, warns } = parse({ args: field('list') }, { args: ['-p', 8080, true, '-p', null] });
    expect(config).toEqual({ args: ['-p', '8080', '-p'] });
    expect(warns).toEqual([
      '配置项 args[2] 期望 string 元素，得到 boolean，已忽略',
      '配置项 args[4] 期望 string 元素，得到 null，已忽略',
    ]);
  });

  it('list 非数组按无效处理', () => {
    const { config, warns } = parse({ args: field('list', { default: [] }) }, { args: '-y pkg' });
    expect(config).toEqual({ args: [] });
    expect(warns).toEqual(['配置项 args 期望数组，得到 string，改用默认值 []']);
  });

  it('map：坏值逐个丢弃并告警；有限数字按字符串收', () => {
    const { config, warns } = parse({ env: field('map') }, { env: { PORT: 8080, DEBUG: true, NAME: 'x' } });
    expect(config).toEqual({ env: { PORT: '8080', NAME: 'x' } });
    expect(warns).toEqual(['配置项 env.DEBUG 期望 string 值，得到 boolean，已忽略']);
  });

  it('map 非对象按无效处理；危险键不进结果', () => {
    expect(parse({ env: field('map') }, { env: ['K=V'] }).warns).toEqual([
      '配置项 env 期望对象（映射），得到 array，已忽略',
    ]);
    const raw = JSON.parse('{"env":{"__proto__":"x","constructor":"y","prototype":"z","A":"1"}}');
    const { config } = parse({ env: field('map') }, raw);
    expect(config.env).toEqual({ A: '1' });
    expect(Object.getOwnPropertyNames(config.env)).toEqual(['A']);
    expect(Object.getPrototypeOf(config.env)).toBe(Object.prototype);
  });

  it('multiselect：类型不对或不在选项内的元素逐个丢弃，数字选项归位为声明的原值', () => {
    const schema: ConfigSchema = {
      m: field('multiselect', {
        options: [
          { label: 'A', value: 'a' },
          { label: '八', value: 8 },
        ],
      }),
    };
    const { config, warns } = parse(schema, { m: ['a', '8', { x: 1 }, 'zzz'] });
    expect(config).toEqual({ m: ['a', 8] });
    expect(warns).toEqual([
      '配置项 m[2] 期望 string 或 number 元素，得到 object，已忽略',
      '配置项 m[3] 不是可选值（"a"、8）之一，已忽略',
    ]);
  });
});

describe('parseConfig 标量宽容', () => {
  const schema: ConfigSchema = {
    qq: field('string'),
    code: field('textarea'),
    port: field('number'),
    ratio: field('number'),
    on: field('boolean', { default: false }),
  };

  it('期望字符串的位置收有限数字并转成字符串，期望数字的位置收能完整解析的字符串并转成数字', () => {
    const { config, warns } = parse(schema, { qq: 12345678, code: 0, port: ' 8080 ', ratio: '0.5' });
    expect(config).toEqual({ qq: '12345678', code: '0', port: 8080, ratio: 0.5, on: false });
    expect(warns).toEqual([]);
  });

  it('不换算：NaN / Infinity、空白串、部分数字的串；boolean 不做任何转换', () => {
    const { config, warns } = parse(schema, { qq: Number.NaN, port: '  ', ratio: '1px', on: 'true' });
    expect(config).toEqual({ on: false });
    expect(warns).toEqual([
      '配置项 qq 期望 string，得到 NaN，已忽略',
      '配置项 port 期望有限数值，得到 string，已忽略',
      '配置项 ratio 期望有限数值，得到 string，已忽略',
      '配置项 on 期望 boolean，得到 string，改用默认值 false',
    ]);
    expect(parse(schema, { on: 1 }).config.on).toBe(false);
  });
});

describe('parseConfig select', () => {
  const schema: ConfigSchema = {
    level: field('select', {
      default: 1,
      options: [
        { label: '一', value: 1 },
        { label: '二', value: 2 },
        { label: '自动', value: '' },
      ],
    }),
    free: field('select'),
  };

  it('按字符串比较成员资格，输出选项声明的原值（WebUI 把数字选项存成字符串）', () => {
    expect(parse(schema, { level: '2' }).config.level).toBe(2);
    expect(parse(schema, { level: 2 }).config.level).toBe(2);
    expect(parse(schema, { level: '' }).config.level).toBe('');
  });

  it('选项外的值回落默认值', () => {
    const { config, warns } = parse(schema, { level: 3 });
    expect(config.level).toBe(1);
    expect(warns).toEqual(['配置项 level 不是可选值（1、2、""）之一，改用默认值 1']);
  });

  it('没有静态 options 时只查是 string 或 number，数字转成字符串', () => {
    expect(parse(schema, { free: 7 }).config.free).toBe('7');
    expect(parse(schema, { free: [] }).warns).toEqual(['配置项 free 期望 string 或 number，得到 array，已忽略']);
  });
});

describe('parseConfig dynamicOptions / allowCustom 豁免成员资格', () => {
  const options = [{ label: 'A', value: 'a' }];

  it('select 声明了 dynamicOptions：静态 options 不是取值范围', () => {
    const schema: ConfigSchema = { model: field('select', { dynamicOptions: 'embedding', options }) };
    expect(parse(schema, { model: 'from-service' })).toEqual({ config: { model: 'from-service' }, warns: [] });
  });

  it('multiselect 声明了 allowCustom 或 dynamicOptions：保留选项外的元素，数字转成字符串', () => {
    const schema: ConfigSchema = {
      custom: field('multiselect', { allowCustom: true, options }),
      dyn: field('multiselect', { dynamicOptions: 'toolGroups', options }),
    };
    const { config, warns } = parse(schema, { custom: ['a', 'x', 8], dyn: ['web'] });
    expect(config).toEqual({ custom: ['a', 'x', '8'], dyn: ['web'] });
    expect(warns).toEqual([]);
  });

  it('select 声明了 allowCustom：静态 options 不是取值范围（选项由插件在运行时补全的字段）', () => {
    const schema: ConfigSchema = { s: field('select', { allowCustom: true, options }) };
    expect(parse(schema, { s: 'x' })).toEqual({ config: { s: 'x' }, warns: [] });
  });
});

describe('parseConfig 分组', () => {
  const schema = defineConfig({
    server: {
      label: '服务',
      fields: {
        host: { type: 'string', label: 'H', default: 'localhost' },
        port: { type: 'number', label: 'P' },
      },
    },
  });

  it('分组总是产出对象，子字段按同一规则解析', () => {
    expect(parse(schema, {}).config).toEqual({ server: { host: 'localhost' } });
    expect(parse(schema, { server: { port: '81' } }).config).toEqual({ server: { host: 'localhost', port: 81 } });
  });

  it('分组值不是对象：告警，整组按空对象解析', () => {
    for (const [value, type] of [
      ['oops', 'string'],
      [[1], 'array'],
    ] as const) {
      const { config, warns } = parse(schema, { server: value });
      expect(config).toEqual({ server: { host: 'localhost' } });
      expect(warns).toEqual([`配置项 server 期望对象（分组），得到 ${type}，已忽略`]);
    }
  });

  it('分组内不可恢复：抛错时路径带分组前缀', () => {
    const required: ConfigSchema = { auth: { label: 'A', fields: { token: field('string', { required: true }) } } };
    expect(thrown(() => parse(required, { auth: {} })).message).toBe(
      '缺少配置项 auth.token，在 WebUI 或配置文件中填入后生效',
    );
    expect(thrown(() => parse(required, { auth: 'x' })).message).toContain('auth.token');
  });
});

describe('parseConfig 数组', () => {
  const schema: ConfigSchema = {
    servers: {
      type: 'array',
      label: 'S',
      // port / tags 排在 id 前：元素因 id 被丢弃时，它们先产生的告警不应再报出
      items: {
        port: field('number', { default: 80 }),
        tags: field('list'),
        id: field('string', { required: true }),
        platform: field('string', { required: true, default: 'internal' }),
      },
    },
    jobs: {
      type: 'array',
      label: 'J',
      default: [{ name: 'daily' }],
      items: { name: field('string', { required: true }), enabled: field('boolean', { default: true }) },
    },
  };

  it('元素字段的默认值逐元素补齐（包括数组自身的 default）', () => {
    const { config, warns } = parse(schema, { servers: [{ id: 'a' }, { id: 'b', port: '8080', platform: 'qq' }] });
    expect(config).toEqual({
      servers: [
        { id: 'a', platform: 'internal', port: 80 },
        { id: 'b', platform: 'qq', port: 8080 },
      ],
      jobs: [{ name: 'daily', enabled: true }],
    });
    expect(warns).toEqual([]);
  });

  it('没有 default 且未配置的数组省略该键', () => {
    expect('servers' in parse(schema, {}).config).toBe(false);
  });

  it('元素不是对象：丢弃这条并告警', () => {
    const { config, warns } = parse(schema, { servers: [null, 'x', { id: 'ok' }] });
    expect(config.servers).toEqual([{ id: 'ok', platform: 'internal', port: 80 }]);
    expect(warns).toEqual([
      '配置项 servers[0] 已忽略：期望对象元素，得到 null',
      '配置项 servers[1] 已忽略：期望对象元素，得到 string',
    ]);
  });

  it('元素内不可恢复：只丢这一条元素，告警点名字段与原因，不连带报元素内的其它告警', () => {
    const { config, warns } = parse(schema, {
      servers: [{ port: 'bad', tags: [true] }, { id: { v: 1 } }, { id: 'ok', tags: ['x', false] }],
    });
    expect(config.servers).toEqual([{ id: 'ok', platform: 'internal', port: 80, tags: ['x'] }]);
    expect(warns).toEqual([
      '配置项 servers[0] 已忽略：id 必填字段缺失',
      '配置项 servers[1] 已忽略：id 期望 string，得到 object',
      '配置项 servers[2].tags[1] 期望 string 元素，得到 boolean，已忽略',
    ]);
  });

  it('值不是数组按无效处理：有 default 回落，没有就省略', () => {
    const { config, warns } = parse(schema, { servers: { id: 'a' }, jobs: 'x' });
    expect(config).toEqual({ jobs: [{ name: 'daily', enabled: true }] });
    expect(warns).toEqual([
      '配置项 servers 期望数组，得到 object，已忽略',
      '配置项 jobs 期望数组，得到 string，改用默认值 [{"name":"daily"}]',
    ]);
  });
});

describe('parseConfig schema 外的键', () => {
  it('顶层、分组内、数组元素内的未知键丢弃并告警', () => {
    const schema: ConfigSchema = {
      a: field('string'),
      g: { label: 'G', fields: { b: field('string') } },
      list: { type: 'array', label: 'L', items: { c: field('string') } },
    };
    const { config, warns } = parse(schema, {
      a: 'x',
      stray: 1,
      g: { b: 'y', old: 2 },
      list: [{ c: 'z', typo: 3 }],
    });
    expect(config).toEqual({ a: 'x', g: { b: 'y' }, list: [{ c: 'z' }] });
    expect(warns).toEqual([
      '配置项 g.old 不在 schema 中，已忽略',
      '配置项 list[0].typo 不在 schema 中，已忽略',
      '配置项 stray 不在 schema 中，已忽略',
    ]);
  });

  it('只认自有属性：原型上的同名键（toString 等）不算已配置', () => {
    const schema: ConfigSchema = { toString: field('string', { default: 'd' }) };
    expect(parse(schema, {})).toEqual({ config: { toString: 'd' }, warns: [] });
  });

  it('只认 schema 的自有键：配置里与原型同名的键（toString 等）不在 schema 中时照样丢弃并告警', () => {
    const { config, warns } = parse({ a: field('string') }, { toString: 'x', a: 'y' });
    expect(config).toEqual({ a: 'y' });
    expect(Object.hasOwn(config, 'toString')).toBe(false);
    expect(warns).toEqual(['配置项 toString 不在 schema 中，已忽略']);
  });
});

describe('parseConfig 不改入参', () => {
  it('返回新对象：入参与 schema 原样不变，结果里的数组与对象都是新的', () => {
    const schema: ConfigSchema = {
      env: field('map', { default: { A: '1' } }),
      args: field('list'),
      port: field('number', { default: 1 }),
      g: { label: 'G', fields: { n: field('number') } },
      items: { type: 'array', label: 'I', items: { n: field('number', { default: 0 }) } },
    };
    const schemaBefore = structuredClone(schema);
    const raw = { env: { B: 2 }, args: ['x', 1], port: '5', g: { n: '3', extra: 1 }, items: [{}], stray: true };
    const rawBefore = structuredClone(raw);
    const { config } = parse(schema, raw);
    expect(raw).toEqual(rawBefore);
    expect(schema).toEqual(schemaBefore);
    expect(config).toEqual({ env: { B: '2' }, args: ['x', '1'], port: 5, g: { n: 3 }, items: [{ n: 0 }] });
    expect(config).not.toBe(raw);
    expect(config.env).not.toBe(raw.env);
    expect(config.args).not.toBe(raw.args);
    expect(config.g).not.toBe(raw.g);
    expect((config.items as unknown[])[0]).not.toBe(raw.items[0]);
  });
});

describe('parseConfig 畸形 schema 不抛错', () => {
  it('array 缺 items、fields 为 null、条目为 null 或原始值、options 不是数组、type 缺失', () => {
    const weird = {
      arr: { type: 'array', label: 'x' },
      g: { label: 'x', fields: null },
      nil: null,
      str: 'oops',
      sel: { type: 'select', label: 'S', options: 'a,b' },
      ms: { type: 'multiselect', label: 'M', options: [null, 1, { value: 'a' }] },
      notype: { label: 'N' },
      badDefault: { type: 'array', label: 'B', items: {}, default: 'x' },
    } as unknown as ConfigSchema;
    const { config } = parse(weird, {
      arr: [{ k: 1 }],
      g: { k: 1 },
      sel: 'z',
      ms: ['a', 'b'],
      notype: { any: 1 },
    });
    expect(config).toEqual({ arr: [{}], g: {}, sel: 'z', ms: ['a'], notype: { any: 1 } });
    expect(() => parse(weird, 42)).not.toThrow();
  });
});

describe("parseConfig onInvalid: 'error'", () => {
  const strict = field('number', { default: 80, onInvalid: 'error' });

  it('缺省和 null 仍用 default；显式坏值即使有 default 也在副作用前拒绝，且不泄露值', () => {
    const schema: ConfigSchema = { port: strict };
    expect(parse(schema, {}).config).toEqual({ port: 80 });
    expect(parse(schema, { port: null }).config).toEqual({ port: 80 });
    let sideEffects = 0;
    const apply = (raw: unknown) => {
      parseConfig(schema, raw);
      sideEffects++;
    };
    const err = thrown(() => apply({ port: SECRET }));
    expect(sideEffects).toBe(0);
    expect(err.name).toBe('ConfigError');
    expect(err.message).toContain('port');
    expect(err.message).not.toContain(SECRET);
  });

  it('required 仍只决定缺省：严格可选字段缺省省略，严格必填缺省仍报 missing', () => {
    const optional: ConfigSchema = { token: field('string', { onInvalid: 'error' }) };
    expect(parse(optional, {}).config).toEqual({});
    expect(thrown(() => parse(optional, { token: false })).message).toContain('配置项 token');
    const required: ConfigSchema = { token: field('string', { required: true, onInvalid: 'error' }) };
    expect(thrown(() => parse(required, {})).message).toContain('缺少配置项 token');
  });

  it('list、map、multiselect 的坏成员不能部分丢弃后成功', () => {
    const options = [{ label: 'A', value: 'a' }];
    const cases: Array<[SchemaField, unknown]> = [
      [field('list', { default: ['fallback'], onInvalid: 'error' }), ['ok', false]],
      [field('map', { default: { A: 'fallback' }, onInvalid: 'error' }), { A: 'ok', [SECRET]: false }],
      [field('multiselect', { default: ['a'], options, onInvalid: 'error' }), ['a', SECRET]],
    ];
    for (const [definition, value] of cases) {
      const err = thrown(() => parse({ choice: definition }, { choice: value }));
      expect(err.name).toBe('ConfigError');
      expect(err.message).toContain('choice');
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('map 保留键与稀疏 list/multiselect 位置同样触发严格拒绝，普通字段逐项告警', () => {
    const unsafeMap = JSON.parse('{"GOOD":"ok","__proto__":"bad"}') as Record<string, unknown>;
    const list = ['first'];
    list[2] = 'third';
    const choices = ['a'];
    choices[2] = 'b';
    const strictCases: Array<[SchemaField, unknown, string]> = [
      [field('map', { onInvalid: 'error' }), unsafeMap, 'env'],
      [field('list', { onInvalid: 'error' }), list, 'env[1]'],
      [field('multiselect', { onInvalid: 'error' }), choices, 'env[1]'],
    ];
    for (const [definition, value, path] of strictCases) {
      const err = thrown(() => parse({ env: definition }, { env: value }));
      expect(err.name).toBe('ConfigError');
      expect(err.message).toContain(path);
    }
    expect(parse({ env: field('map') }, { env: unsafeMap })).toEqual({
      config: { env: { GOOD: 'ok' } },
      warns: ['配置项 env.__proto__ 保留键不可用，已忽略'],
    });
    expect(parse({ env: field('list') }, { env: list })).toEqual({
      config: { env: ['first', 'third'] },
      warns: ['配置项 env[1] 期望 string 元素，得到 undefined，已忽略'],
    });
    expect(parse({ env: field('multiselect') }, { env: choices })).toEqual({
      config: { env: ['a', 'b'] },
      warns: ['配置项 env[1] 期望 string 或 number 元素，得到 undefined，已忽略'],
    });
  });

  it('数组元素内的严格字段只丢该元素，邻居 server 仍能成功', () => {
    const schema: ConfigSchema = {
      servers: {
        type: 'array',
        label: 'S',
        items: {
          port: strict,
          host: field('string', { default: 'local' }),
        },
      },
    };
    const { config, warns } = parse(schema, { servers: [{ port: SECRET }, { port: 81 }, {}] });
    expect(config.servers).toEqual([
      { port: 81, host: 'local' },
      { port: 80, host: 'local' },
    ]);
    expect(warns).toEqual(['配置项 servers[0] 已忽略：port 期望有限数值，得到 string']);
    expect(JSON.stringify(warns)).not.toContain(SECRET);
  });

  it('严格数组不把坏根丢成空数组后启动默认根；普通数组仍可逐项恢复', () => {
    const roots = {
      type: 'array' as const,
      label: 'Roots',
      onInvalid: 'error' as const,
      default: [{ path: 'workspace' }],
      items: { path: field('string', { required: true, onInvalid: 'error' }) },
    };
    for (const value of [false, [false], [{}], [{ path: false }], [{ path: 'valid' }, {}], new Array(1)]) {
      expect(() => parse({ roots }, { roots: value })).toThrow();
    }
    expect(() => parse({ roots }, false)).toThrow();
    expect(parse({ roots }, {}).config.roots).toEqual([{ path: 'workspace' }]);
    expect(parse({ roots }, { roots: [] }).config.roots).toEqual([]);
    expect(
      parse({ roots: { ...roots, onInvalid: undefined } }, { roots: [{ path: false }, { path: 'valid' }] }).config
        .roots,
    ).toEqual([{ path: 'valid' }]);
  });

  it('显式无效的整体、分组与数组容器不能绕过严格字段；缺省容器仍正常', () => {
    const schema: ConfigSchema = {
      server: { fields: { port: strict } },
      servers: { type: 'array', label: 'S', items: { port: strict } },
    };
    expect(parse(schema, {}).config).toEqual({ server: { port: 80 } });
    expect(parse(schema, { server: null }).config).toEqual({ server: { port: 80 } });
    for (const [raw, path] of [
      ['bad', '配置整体'],
      [{ server: SECRET }, 'server'],
      [{ servers: SECRET }, 'servers'],
    ] as const) {
      const err = thrown(() => parse(schema, raw));
      expect(err.message).toContain(path);
      expect(err.message).not.toContain(SECRET);
    }
  });

  it('严格错误指出安全的判定原因，不列出静态选项、正则或无效数值', () => {
    const selected = thrown(() =>
      parse(
        {
          mode: field('select', {
            onInvalid: 'error',
            options: [{ label: 'Secret', value: SECRET }],
          }),
        },
        { mode: 'other' },
      ),
    );
    expect(selected.message).toContain('mode 不是可选值');
    expect(selected.message).not.toContain(SECRET);
    const pattern = thrown(() =>
      parse(
        {
          token: field('string', {
            onInvalid: 'error',
            pattern: SECRET,
          }),
        },
        { token: 'other' },
      ),
    );
    expect(pattern.message).toContain('token 不匹配模式');
    expect(pattern.message).not.toContain(SECRET);
    const nan = thrown(() => parse({ port: strict }, { port: Number.NaN }));
    expect(nan.message).toContain('期望有限数值，得到 number');
    expect(nan.message).not.toContain('NaN');
  });
});
